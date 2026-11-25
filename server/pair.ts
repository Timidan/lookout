import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto'
import { closeSync, openSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { isDeepStrictEqual } from 'node:util'
import type { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { isAddress, recoverTypedDataAddress, type Address, type Hex } from 'viem'
import { generatePrivateKey, privateKeyToAddress } from 'viem/accounts'
import { approvalData, agentExpiresAt, submitApproval, venueReason } from './signing.js'

export const sampleAddress = process.env.SAMPLE_ADDRESS?.trim() || undefined
export const sampleWarning = 'Sample account. Pair to trade'
if (sampleAddress && !isAddress(sampleAddress)) throw new Error('SAMPLE_ADDRESS must be a wallet address')

const secret = process.env.APP_SECRET || ''
if (!/^[0-9a-f]{64}$/i.test(secret)) throw new Error('APP_SECRET must contain 32 random bytes as 64 hex digits')
const aesKey = Buffer.from(secret, 'hex')
const path = process.env.DB_PATH || './glasses.db'
if (path !== ':memory:') closeSync(openSync(path, 'a', 0o600))
export const db = new DatabaseSync(path)
db.exec(`PRAGMA journal_mode=WAL;
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, code TEXT UNIQUE,
    encrypted_key BLOB NOT NULL, agent_address TEXT NOT NULL, code_expires INTEGER NOT NULL,
    requested_by TEXT, chain_id INTEGER, nonce INTEGER, paired_owner TEXT, expires INTEGER
  );`)

function encrypt(id: string, key: Hex) {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', aesKey, iv)
  cipher.setAAD(Buffer.from(id))
  const ciphertext = Buffer.concat([cipher.update(Buffer.from(key.slice(2), 'hex')), cipher.final()])
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext])
}

export function agent(id: string): Hex {
  const row = db.prepare('SELECT encrypted_key FROM sessions WHERE id=? AND paired_owner IS NOT NULL AND expires>?')
    .get(id, Date.now())
  if (!row) throw new HTTPException(403, { message: 'Pair your wallet to trade' })
  const blob = Buffer.from(row.encrypted_key as Uint8Array)
  const decipher = createDecipheriv('aes-256-gcm', aesKey, blob.subarray(0, 12))
  decipher.setAAD(Buffer.from(id))
  decipher.setAuthTag(blob.subarray(12, 28))
  return `0x${Buffer.concat([decipher.update(blob.subarray(28)), decipher.final()]).toString('hex')}`
}

const digest = (token: string) => createHash('sha256').update(token).digest('hex')
export function device(token: string): {id:string; address:string|null} {
  const row = /^[0-9a-f]{64}$/.test(token) && db.prepare(
    'SELECT id, paired_owner FROM sessions WHERE token_hash=? AND COALESCE(expires, code_expires)>?',
  ).get(digest(token), Date.now())
  if (!row) throw new HTTPException(401, { message: 'Device session ended. Pair again' })
  return { id: row.id as string, address: row.paired_owner as string|null }
}

function bearer(header: string | undefined) {
  return device(/^Bearer ([0-9a-f]{64})$/i.exec(header || '')?.[1] || '')
}

function pending(code: string) {
  const row = db.prepare('SELECT * FROM sessions WHERE code=? AND code_expires>? AND paired_owner IS NULL')
    .get(code.toUpperCase(), Date.now())
  if (!row) throw new HTTPException(404, { message: 'Code unavailable. Get a new pairing code' })
  return row
}

// ponytail: one server process owns pairing in flight. A restarted process may replay the same signed nonce.
const submitting = new Set<string>()

export function registerPair(app: Hono) {
  app.use('/pair', async (c, next) => {
    c.header('Cache-Control', 'no-store')
    c.header('Referrer-Policy', 'no-referrer')
    await next()
  })
  app.use('/api/pair/*', async (c, next) => { c.header('Cache-Control', 'no-store'); await next() })
  app.post('/api/pair/start', c => {
    db.prepare('DELETE FROM sessions WHERE COALESCE(expires, code_expires)<=?').run(Date.now())
    const id = randomUUID()
    const key = generatePrivateKey()
    const token = randomBytes(32).toString('hex')
    const expiresAt = Date.now() + 10 * 60_000
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
    let code: string
    do {
      code = Array.from(randomBytes(6), byte => alphabet[byte & 31]).join('')
    } while (db.prepare('SELECT 1 FROM sessions WHERE code=?').get(code))
    db.prepare('INSERT INTO sessions(id,token_hash,code,encrypted_key,agent_address,code_expires) VALUES(?,?,?,?,?,?)')
      .run(id, digest(token), code, encrypt(id, key), privateKeyToAddress(key).toLowerCase(), expiresAt)
    const url = new URL('/pair', process.env.PUBLIC_BASE_URL || c.req.url)
    url.searchParams.set('code', code)
    return c.json({ code, deviceToken: token, pairUrl: url.toString(), expiresAt })
  })
  app.get('/api/pair/status', c => {
    const { address } = bearer(c.req.header('Authorization'))
    return c.json(address ? { paired: true, address } : { paired: false, ...(sampleAddress && {sample:true}) })
  })
  app.post('/api/unpair', c => {
    const { id } = bearer(c.req.header('Authorization'))
    db.prepare('DELETE FROM sessions WHERE id=?').run(id)
    return c.json({ ok: true })
  })
  app.get('/api/pair/:code/request', c => {
    const row = pending(c.req.param('code'))
    if (submitting.has(String(row.id))) throw new HTTPException(409, { message: 'Approval in progress.' })
    const owner = c.req.query('address') || ''
    const chain = c.req.query('chainId') || ''
    const chainId = Number(chain)
    if (!isAddress(owner) || !/^(0x[0-9a-f]+|[0-9]+)$/i.test(chain) || !Number.isSafeInteger(chainId) || chainId < 1) {
      throw new HTTPException(400, { message: 'Invalid wallet address or chain ID.' })
    }
    const nonce = row.requested_by === owner.toLowerCase() && row.chain_id === chainId
      ? Number(row.nonce) : Date.now()
    db.prepare('UPDATE sessions SET requested_by=?, chain_id=?, nonce=? WHERE id=?')
      .run(owner.toLowerCase(), chainId, nonce, row.id)
    const typedData = approvalData(row.agent_address as Address, chainId, nonce)
    return c.json({ agentAddress: row.agent_address, typedData })
  })
  app.post('/api/pair/:code/complete', async c => {
    const body = await c.req.json().catch(() => null)
    const row = pending(c.req.param('code'))
    const id = String(row.id)
    if (!row.nonce || typeof body?.address !== 'string' || body.address.toLowerCase() !== row.requested_by ||
        typeof body.signature !== 'string' || !/^0x[0-9a-f]{130}$/i.test(body.signature)) {
      throw new HTTPException(400, { message: 'Invalid pairing approval.' })
    }
    const data = approvalData(row.agent_address as Address, Number(row.chain_id), Number(row.nonce))
    if (!isDeepStrictEqual(body.typedData, data)) throw new HTTPException(400, { message: 'Pairing request changed. Please sign again.' })
    if (submitting.has(id)) throw new HTTPException(409, { message: 'Approval in progress.' })
    submitting.add(id)
    try {
      const signature = body.signature as Hex
      const signer = await recoverTypedDataAddress({ ...data, signature }).catch(() => null)
      if (signer?.toLowerCase() !== row.requested_by) throw new HTTPException(403, { message: 'Wallet signature does not match.' })
      const response = await submitApproval(data, signature)
      if (response.status === 'err') throw new HTTPException(422, { message: venueReason(response.response) })
      if (response.status !== 'ok' || response.response.type !== 'default') throw new HTTPException(502, { message: 'Unknown approval response.' })
      const result = db.prepare('UPDATE sessions SET paired_owner=requested_by, expires=?, code=NULL WHERE id=? AND code IS NOT NULL')
        .run(agentExpiresAt(data.message.nonce), id)
      if (!result.changes) throw new HTTPException(410, { message: 'Device session has ended.' })
      return c.json({ ok: true })
    } finally {
      submitting.delete(id)
    }
  })
  app.get('/pair', c => {
    const nonce = randomBytes(18).toString('base64')
    c.header('Content-Security-Policy', `default-src 'none'; script-src 'nonce-${nonce}'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`)
    return c.html(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Pair your glasses</title><main><h1>Pair your glasses</h1><p>Match this code to the one on your glasses: <strong id="code"></strong></p>
<p>Approve a trading key on Hyperliquid testnet for seven days.</p><button id="approve">Connect wallet and approve</button><p id="status" role="status"></p></main>
<script nonce="${nonce}">
const code = new URLSearchParams(location.search).get('code') || '';
document.getElementById('code').textContent = code;
const button = document.getElementById('approve'), status = document.getElementById('status');
async function api(url, options) { const r = await fetch(url, options); const j = await r.json(); if(!r.ok) throw Error(j.error?.message || 'Pairing request failed'); return j; }
button.onclick = async () => {
  button.disabled = true;
  try {
    if (!window.ethereum) throw Error('Open this page in a browser with an Ethereum wallet.');
    if (!/^[A-Z2-9]{6}$/i.test(code)) throw Error('Open the pairing link from your glasses.');
    const [address] = await window.ethereum.request({method:'eth_requestAccounts'});
    const chainId = await window.ethereum.request({method:'eth_chainId'});
    const path = '/api/pair/' + encodeURIComponent(code);
    const {typedData} = await api(path + '/request?' + new URLSearchParams({address, chainId}));
    status.textContent = 'Check the agent name and approve in your wallet.';
    const signature = await window.ethereum.request({method:'eth_signTypedData_v4', params:[address, JSON.stringify(typedData)]});
    await api(path + '/complete', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({address, signature, typedData})});
    status.textContent = 'Paired. You can return to your glasses.';
  } catch (e) { status.textContent = e.message || 'Approval failed'; button.disabled = false; }
};
</script></html>`)
  })
}
