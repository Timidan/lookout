import { randomUUID } from 'node:crypto'
import { cancelByCloid } from '@nktkas/hyperliquid/api/exchange'
import { signL1Action } from '@nktkas/hyperliquid/signing'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { type Address } from 'viem'
import { approvalData, clientOrderId, submitApproval, submitOrder, submitStop, transport } from './signing.js'
import { book, markets } from './venue.js'
import { sampleTickets } from './probe.js'
import { priceTicket } from './pricing.js'

// Observe the response body before the production SDK parses it or shortens a
// rejection. Do not log requests, signatures or private keys.
const realFetch = globalThis.fetch
let exchangeResponse: {status:number; body:string} | undefined
globalThis.fetch = async (input, init) => {
  const response = await realFetch(input, init)
  const url = input instanceof Request ? input.url : String(input)
  if (url === 'https://api.hyperliquid-testnet.xyz/exchange') {
    exchangeResponse = { status: response.status, body: await response.clone().text() }
  }
  return response
}

async function check(label: string, signer: Address, submit: () => Promise<unknown>) {
  exchangeResponse = undefined
  let failure = ''
  try { await submit() } catch (e) { failure = e instanceof Error ? e.message : 'Request failed' }
  const raw = exchangeResponse as {status:number; body:string} | undefined
  if (!raw) throw new Error(`${label}: no venue response (${failure})`)
  console.log(`${label} HTTP ${raw.status}\n${raw.body}`)
  let named: string[] = []
  try {
    const body = JSON.parse(raw.body)
    const message = body.status === 'err' ? body.response : body.response?.data?.statuses?.[0]?.error
    if (typeof message === 'string') named = message.match(/0x[0-9a-f]{40}\b/ig) ?? []
  } catch { /* A malformed-action HTTP response may be plain text. */ }
  const matches = named.length === 1 && named[0].toLowerCase() === signer.toLowerCase()
  console.log(`${matches ? 'MATCH' : 'MISMATCH'} expected ${signer.toLowerCase()} recovered ${named.join(', ') || '(no rejection address)'}`)
  if (!matches) process.exitCode = 1
}

const owner = privateKeyToAccount(generatePrivateKey())
const key = generatePrivateKey()
const signer = privateKeyToAccount(key)
const approval = approvalData(signer.address, 421614, Date.now())
await check('approveAgent', owner.address, async () => submitApproval(approval, await owner.signTypedData(approval)))
const samples = await sampleTickets(await markets())
for (const { market } of samples) {
  const intent = { instrumentId: market.id, side: 'buy' as const, usd: '20', bracket:false as const }
  const ticket = priceTicket(market, await book(market.id), intent)
  await check(`${market.kind} ${market.id} IOC ${ticket.size} @ ${ticket.px}`, signer.address,
    () => submitOrder(key, market, ticket, false))
}

const btc = samples.find(s => s.market.id === 'BTC')!.market
const levels = await book(btc.id)
const basis = Number(levels.levels[1][0].px)
const stopPx = String(Math.floor(basis * 0.97)), targetPx = String(Math.ceil(basis * 1.06))
const ticket = priceTicket(btc, levels, {instrumentId:'BTC',side:'buy',usd:'20',bracket:false})
const stopId = randomUUID()
await check('standalone stop trigger (na, reduce-only)', signer.address,
  () => submitStop(key,btc,false,stopPx,ticket.size,stopId))
await check('perp entry + TP + SL (normalTpsl)', signer.address,
  () => submitOrder(key,btc,{...ticket,stopPx,targetPx},false))
await check('native trailingStop (1% retracement)', signer.address, async () => {
  // SDK 0.33.3 has no trailingStop method. The venue documents this as a separate L1 action.
  const action = {type:'trailingStop', asset:btc.asset, isBuy:false, sz:ticket.size,
    reduceOnly:true, retracement:{pct:'1%'}, activationPx:null}
  const nonce = Date.now(), expiresAfter = nonce + 30_000
  const signature = await signL1Action({wallet:signer,action,nonce,expiresAfter,isTestnet:true})
  return transport.request('exchange',{action,nonce,expiresAfter,signature})
})
await check('cancel by client order ID', signer.address,
  () => cancelByCloid({wallet:signer,transport},{cancels:[{asset:btc.asset,cloid:clientOrderId(stopId)}]}))
await check('position TP/SL (positionTpsl, size 0, reduce-only)', signer.address,
  () => submitStop(key,btc,false,stopPx,'0',randomUUID()))
