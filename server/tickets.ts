import { HTTPException } from 'hono/http-exception'
import { formatUnits, parseUnits } from 'viem'
import type { SpotClearinghouseStateResponse, UserFillsResponse } from '@nktkas/hyperliquid/api/info'
import type { Account, OrderIntent, OrderResult, Ticket } from '../shared/api.js'
import { db, agent, sampleAddress, sampleWarning, type device } from './pair.js'
import { account, book, collateralWarnings, info, market, marketHistory, type Market } from './venue.js'
import { priceTicket } from './pricing.js'
import { leverage, place, recoverOrder } from './signing.js'

type Device = ReturnType<typeof device>
const unit = 10n ** 18n
const dec = (s: string) => parseUnits(s, 18)
export function owner(session: Device): string {
  if (!session.address) throw new HTTPException(403, {message: sampleAddress ? sampleWarning : 'Pair your wallet to trade'})
  return session.address
}

db.exec(`CREATE TABLE IF NOT EXISTS tickets (
  id TEXT PRIMARY KEY, device TEXT NOT NULL, ticket TEXT NOT NULL, is_limit INTEGER NOT NULL,
  expires INTEGER NOT NULL, state TEXT NOT NULL DEFAULT 'ready', result TEXT
)`)
const active = new Map<string, Promise<OrderResult>>()
const trading = new Set<string>()
type Row = { ticket: string; is_limit: number; expires: number; state: string; result: string | null }

export async function withOwnerAction<T>(address: string, run: () => Promise<T>): Promise<T> {
  if (trading.has(address)) throw new HTTPException(409, {message:'Another action is running. Try again shortly'})
  trading.add(address)
  try { return await run() } finally { trading.delete(address) }
}

async function usualUsd(address: string, m: Market): Promise<string | undefined> {
  const amounts: bigint[] = []
  let endTime = Date.now()
  // ponytail: testnet retains only the latest 10,000 fills per owner, across all markets.
  for (let page = 0; page < 5 && amounts.length < 10; page++) {
    const fills = await info<UserFillsResponse>({type:'userFillsByTime',user:address,startTime:0,endTime,reversed:true})
    if (!fills.length) break
    fills.sort((a,b) => b.time - a.time || b.tid - a.tid)
    for (const f of fills) {
      if (f.coin !== m.id || (m.kind !== 'perp' && f.side !== 'B')) continue
      const size = dec(f.sz), start = dec(f.startPosition)
      // A flip first closes the opposite position. Only its new exposure sizes the next entry.
      const opposite = m.kind === 'perp' && (f.side === 'B' ? start < 0n : start > 0n)
      const opening = opposite ? size - (start < 0n ? -start : start) : size
      if (opening > 0n) amounts.push(opening * dec(f.px) * dec(m.quoteUsd ?? '0') / (unit * unit))
      if (amounts.length === 10) break
    }
    if (fills.length < 2000) break
    endTime = fills.at(-1)!.time - 1
  }
  if (!amounts.length) return
  amounts.sort((a,b) => a < b ? -1 : a > b ? 1 : 0)
  return formatUnits((amounts[(amounts.length - 1) >> 1] + amounts[amounts.length >> 1]) / 2n, 18)
}

function aboveCap(m: Market, t: Ticket) {
  const bound = dec(t.px), bid = dec(m.bid ?? '0')
  const px = t.side === 'sell' && bid > bound ? bid : bound
  return dec(t.size) * px * dec(m.quoteUsd ?? '0') > dec(process.env.MAX_ORDER_USD ?? '200') * unit * unit
}

async function verifyCashExit(address: string, m: Market, t: Ticket) {
  const spot = await info<SpotClearinghouseStateResponse>({type:'spotClearinghouseState',user:address})
  const held = spot.balances.find(b => m.kind === 'outcome' ? b.coin === '+' + m.id.slice(1) : 'token' in b && b.token === m.baseIndex)
  if (!held || dec(held.total) - dec(held.hold) < dec(t.size)) {
    throw new HTTPException(400, {message:'Over the cap. Sell only your available holdings'})
  }
}

export async function preview(session: Device, intent: OrderIntent, fixedId?: string): Promise<Ticket> {
  if (typeof intent?.instrumentId !== 'string' || !intent.instrumentId) throw new HTTPException(400, {message:'Choose a market'})
  const m = await market(intent.instrumentId)
  let assumed: string | undefined
  if (intent.size === undefined && intent.usd === undefined) {
    const usual = session.address ? await usualUsd(session.address, m) : undefined
    assumed = usual === undefined ? 'default size' : 'your usual'
    intent = {...intent, usd:usual ?? process.env.DEFAULT_USD ?? '50'}
  }
  const [levels,history] = await Promise.all([book(m.id), fixedId ? {} : marketHistory(m.id)])
  const cashSell = !!session.address && m.kind !== 'perp' && intent.side === 'sell'
  let ticket: Ticket
  try {
    ticket = priceTicket({...m,...history}, levels, intent, {assumed, closing:cashSell})
  } catch (err) {
    throw new HTTPException(400, {message: err instanceof Error ? err.message : 'Check the order details'})
  }
  if (fixedId) ticket.id = fixedId
  if (cashSell && (aboveCap(m,ticket) || dec(intent.usd ?? '0') > dec(process.env.MAX_ORDER_USD ?? '200'))) {
    await verifyCashExit(session.address!,m,ticket)
  }
  if (session.address) ticket.warnings.push(...await collateralWarnings(session.address, m, ticket))
  else if (sampleAddress) ticket.warnings.unshift(sampleWarning)
  else ticket.warnings.push('Pair your wallet to check collateral')
  if (ticket.expiresAt <= Date.now()) throw new HTTPException(409, {message: 'Price expired'})
  // Only a paired owner can confirm, so a preview from an unpaired device is never stored.
  if (!session.address) return ticket
  db.prepare("DELETE FROM tickets WHERE expires < ? AND state IN ('ready','done','failed')").run(Date.now() - 86_400_000)
  db.prepare('INSERT INTO tickets(id,device,ticket,is_limit,expires) VALUES(?,?,?,?,?)')
    .run(ticket.id, session.id, JSON.stringify(ticket), Number(intent.limitPx !== undefined), ticket.expiresAt)
  return ticket
}

export async function closePosition(session: Device, id: string, fraction: unknown = 1, snapshot?: Account | null, fixedId?: string) {
  if (typeof id !== 'string' || !id) throw new HTTPException(400, {message:'Choose a position'})
  if (typeof fraction !== 'number' || !Number.isFinite(fraction) || fraction <= 0 || fraction > 1) {
    throw new HTTPException(400, {message:'Choose part or all of your position'})
  }
  const p = (snapshot ?? await account(owner(session))).positions.find(p => p.instrumentId === id)
  if (!p || Number(p.size) === 0) throw new HTTPException(404, {message:'No position here. Choose an open position'})
  const ratio = String(fraction).includes('e') ? fraction.toFixed(18) : String(fraction)
  const size = formatUnits(dec(p.size.replace(/^-/, '')) * dec(ratio) / unit, 18)
  return preview(session, {instrumentId:id, side: p.kind === 'perp' && p.size.startsWith('-') ? 'buy' : 'sell',
    size, reduceOnly:p.kind === 'perp'}, fixedId)
}

function saveResult(id: string, result: OrderResult) {
  db.prepare("UPDATE tickets SET state='done',result=? WHERE id=?").run(JSON.stringify(result),id)
  return result
}

async function reconcile(address: string, t: Ticket): Promise<OrderResult> {
  const recovered = await recoverOrder(address,t.id,t.size,Boolean(t.stopPx && t.targetPx))
  if (recovered) return saveResult(t.id,recovered)
  throw new HTTPException(503,{message:'Order status pending. Check again shortly'})
}

// A card can hold the owner lock across multiple close tickets.
export async function confirmLocked(session: Device, id: string, sourceDevice = session.id): Promise<OrderResult> {
  const address = owner(session)
  const row = db.prepare('SELECT * FROM tickets WHERE id=? AND device=?').get(id, sourceDevice) as Row | undefined
  if (!row) throw new HTTPException(404, {message:'Ticket not found. Get a fresh price'})
  const ticket: Ticket = JSON.parse(row.ticket)
  // A preview created in sample mode stays read-only if the device pairs before it expires.
  if (ticket.warnings.includes(sampleWarning)) throw new HTTPException(403, {message:sampleWarning})
  if (row.result) {
    const saved = JSON.parse(row.result)
    if (row.state === 'failed') {
      if (saved.message?.includes('outcome unknown')) return reconcile(address,ticket)
      throw new HTTPException(saved.status, {message:saved.message})
    }
    return saved
  }
  if (row.state !== 'ready') return reconcile(address,ticket)
  const ensureFresh = () => {
    if (ticket.expiresAt <= Date.now()) throw new HTTPException(410, {message:'Price expired'})
  }
  ensureFresh()
  const m = await market(ticket.instrument.id)
  if (!ticket.reduceOnly && aboveCap(m,ticket)) {
    if (m.kind !== 'perp' && ticket.side === 'sell') await verifyCashExit(address,m,ticket)
    else throw new HTTPException(409, {message:'Order exceeds the cap. Try a smaller size'})
  }
  if (ticket.leverage !== undefined) {
    const data = await info<{leverage:{type:'isolated'|'cross';value:number}}>({type:'activeAssetData',user:address,coin:m.id})
    if (!data?.leverage || !['isolated','cross'].includes(data.leverage.type)) throw new HTTPException(502,{message:'Leverage unavailable. Try again shortly'})
    if (data.leverage.value !== ticket.leverage) {
      ensureFresh()
      await leverage(agent(session.id),m,ticket.leverage,data.leverage.type === 'cross')
    }
  }
  ensureFresh()
  const key = agent(session.id)
  const claimed = db.prepare("UPDATE tickets SET state='sending' WHERE id=? AND state='ready'").run(id)
  if (!claimed.changes) return reconcile(address,ticket)
  try {
    return saveResult(id, await place(key,m,ticket,!!row.is_limit))
  } catch {
    // Keep the durable claim. Every retry uses orderStatus, including after a process restart.
    return reconcile(address,ticket)
  }
}

export async function confirm(session: Device, id: string): Promise<OrderResult> {
  const address = owner(session)
  const key = session.id + '/' + id
  const pending = active.get(key)
  if (pending) return pending
  const result = withOwnerAction(address, () => confirmLocked(session,id))
  active.set(key,result)
  try { return await result } finally { active.delete(key) }
}
