import { createHash } from 'node:crypto'
import { HttpTransport } from '@nktkas/hyperliquid'
import {
  ApiRequestError, ApproveAgentTypes, cancel as cancelOrder, order, updateLeverage, type OrderParameters, type OrderResponse,
} from '@nktkas/hyperliquid/api/exchange'
import { clearinghouseState, orderStatus, userFillsByTime } from '@nktkas/hyperliquid/api/info'
import { HTTPException } from 'hono/http-exception'
import { formatUnits, parseSignature, parseUnits, zeroAddress, type Address, type Hex, type TypedData } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import type { OrderResult, Ticket } from '../shared/api.js'
import type { Market } from './venue.js'
import { roundVenuePrice } from './pricing.js'

export const transport = new HttpTransport({ isTestnet: true, apiUrl: 'https://api.hyperliquid-testnet.xyz', fetchOptions: { redirect: 'error' } })
export const agentExpiresAt = (nonce: number) => nonce + 7 * 24 * 60 * 60 * 1000

// The wallet signs only the fields declared in ApproveAgentTypes. The venue
// also requires the action discriminator and signatureChainId on the wire.
export function approvalData(agentAddress: Address, chainId: number, nonce: number) {
  return {
    domain: { name: 'HyperliquidSignTransaction', version: '1', chainId, verifyingContract: zeroAddress },
    types: {
      EIP712Domain: [
        { name: 'name', type: 'string' }, { name: 'version', type: 'string' },
        { name: 'chainId', type: 'uint256' }, { name: 'verifyingContract', type: 'address' },
      ],
      ...ApproveAgentTypes,
    } as TypedData,
    primaryType: 'HyperliquidTransaction:ApproveAgent' as const,
    message: {
      hyperliquidChain: 'Testnet', agentAddress: agentAddress.toLowerCase() as Address,
      agentName: `Glasses-${agentAddress.slice(2, 8).toLowerCase()} valid_until ${agentExpiresAt(nonce)}`, nonce,
    },
  }
}

export function submitApproval(data: ReturnType<typeof approvalData>, signed: Hex) {
  const { r, s, yParity } = parseSignature(signed)
  return transport.request<{status:'err';response:string} | {status:'ok';response:{type:string}}>('exchange', {
    action: { type: 'approveAgent', signatureChainId: `0x${data.domain.chainId.toString(16)}`, ...data.message },
    nonce: data.message.nonce,
    signature: { r, s, v: 27 + yParity },
  })
}

export function clientOrderId(uuid: string, child?: 'sl' | 'tp'): Hex {
  // Preserve parent IDs from tickets issued before brackets existed.
  return child ? `0x${createHash('sha256').update(uuid + ':' + child).digest('hex').slice(0, 32)}`
    : `0x${uuid.replaceAll('-', '')}`
}

function trigger(m: Market, isBuy: boolean, px: string, size: string, tpsl: 'sl'|'tp', cloid: Hex) {
  if (m.kind !== 'perp') throw new HTTPException(400, { message: 'Perp market required for a protective order.' })
  // The venue's market TP/SL uses a 10% execution band around the mark trigger.
  const bound = formatUnits(parseUnits(px,18) * (isBuy ? 11n : 9n) / 10n,18)
  const limitPx = roundVenuePrice(m,bound,'down')
  return { a:m.asset, b:isBuy, p:limitPx, s:size, r:true, t:{ trigger:{ isMarket:true, triggerPx:px, tpsl } }, c:cloid }
}

export function submitOrder(key: Hex, m: Market, ticket: Ticket, isLimit: boolean) {
  const buy = ticket.side === 'buy'
  const orders: OrderParameters['orders'] = [{
    a: m.asset, b: buy, p: ticket.px, s: ticket.size,
    r: ticket.reduceOnly && m.kind === 'perp', t: { limit: { tif: isLimit ? 'Gtc' : 'Ioc' } },
    c: clientOrderId(ticket.id),
  }]
  if (ticket.stopPx || ticket.targetPx) {
    if (!ticket.stopPx || !ticket.targetPx || ticket.reduceOnly) throw new Error('Incomplete entry bracket')
    orders.push(trigger(m, !buy, ticket.targetPx, ticket.size, 'tp', clientOrderId(ticket.id, 'tp')),
      trigger(m, !buy, ticket.stopPx, ticket.size, 'sl', clientOrderId(ticket.id, 'sl')))
  }
  return order({ wallet: privateKeyToAccount(key), transport }, {
    orders, grouping: orders.length > 1 ? 'normalTpsl' : 'na',
  }, { expiresAfter: ticket.expiresAt })
}

export function submitStop(key: Hex, m: Market, isBuy: boolean, triggerPx: string, size: string, uuid: string) {
  return order({ wallet: privateKeyToAccount(key), transport }, {
    orders:[trigger(m, isBuy, triggerPx, size, 'sl', clientOrderId(uuid))],
    grouping:size === '0' ? 'positionTpsl' : 'na',
  }, {expiresAfter: Date.now() + 30_000})
}

type VenueOrderReply = OrderResponse | {status:'err';response:string}

/** Keep the venue's reason short enough for the glasses; diagnostic scripts retain the raw reply. */
export function venueReason(raw: string): string {
  if (/must deposit|insufficient (?:spot )?(?:margin|balance)|insufficient funds/i.test(raw)) return 'Balance too low. Add funds'
  if (/wallet.*does not exist|agent.*expir/i.test(raw)) return 'Wallet unavailable. Pair again'
  if (/minimum.*(?:value|notional)|order value too small/i.test(raw)) return 'Order too small. Increase the size'
  if (/tick size|invalid price/i.test(raw)) return 'Price unavailable. Get a fresh price'
  if (/reduce.only.*increase/i.test(raw)) return 'Position changed. Check your position'
  if (/could not immediately match|insufficient liquidity/i.test(raw)) return 'No matching orders. Get a fresh price'
  return raw.replace(/^Error(?: in [^:]+)?:\s*/i,'').replace(/\s+asset=\d+.*$/i,'')
    .replace(/canceled/gi,'cancelled').replace(/\.+$/,'').slice(0,40).trimEnd()
}

async function rawOrder(submit: () => Promise<OrderResponse>): Promise<VenueOrderReply> {
  try { return await submit() } catch (e) {
    // A child may reject after its parent filled or rested. Inspect the
    // complete statuses array carried by the SDK's bulk error.
    if (e instanceof ApiRequestError) return e.response as VenueOrderReply
    throw e
  }
}

function entryResult(reply: VenueOrderReply, size: string, bracket: boolean): OrderResult | null {
  const reject = (message: string): OrderResult => ({ status:'rejected', filledSize:'0', message:venueReason(message) })
  if (reply.status === 'err') return reject(reply.response)
  const [item, target, stop] = reply.response.data.statuses
  if (typeof item !== 'object' || !item) return null
  if ('error' in item) return reject(item.error)
  let result: OrderResult
  if ('filled' in item) {
    const {totalSz,avgPx,oid} = item.filled
    result = { status:parseUnits(totalSz,18) < parseUnits(size,18) ? 'partial' : 'filled', filledSize:totalSz, avgPx, oid }
  } else if ('resting' in item) {
    result = {status:'resting', filledSize:'0', oid:item.resting.oid}
  } else return null
  if (bracket) {
    for (const [name, child] of [['Target',target],['Stop',stop]] as const) {
      if (child && typeof child === 'object' && 'error' in child) {
        result.message = 'Check your stop and target'
        break
      }
      if (!child) result.message = name + ' unconfirmed. Check open orders'
    }
    if (result.status === 'partial') result.message = 'Partly filled. Check stop and target'
  }
  return result
}

export async function place(key: Hex, m: Market, ticket: Ticket, isLimit: boolean): Promise<OrderResult> {
  const reply = await rawOrder(() => submitOrder(key,m,ticket,isLimit))
  const result = entryResult(reply,ticket.size,!!ticket.stopPx)
  if (result) return result
  throw new HTTPException(502, { message:'Unknown order outcome. Check orders and fills.' })
}

export async function placePositionStop(key: Hex, m: Market, isBuy: boolean, px: string, uuid: string, owner: string): Promise<OrderResult> {
  const user = owner as Address
  const state = await clearinghouseState({transport}, {user, dex:m.id.includes(':') ? m.id.split(':')[0] : ''})
    .catch(() => { throw new HTTPException(502,{message:'Wait for live prices'}) })
  const current = state.assetPositions.find(p => p.position.coin === m.id)?.position.szi ?? '0'
  const position = parseUnits(current,18)
  if (!position || (position < 0n) !== isBuy) throw new HTTPException(409,{message:'That changed. Showing the latest'})
  let reply: VenueOrderReply | undefined
  try { reply = await rawOrder(() => submitStop(key,m,isBuy,px,'0',uuid)) } catch {
    // A timeout can follow a successful submit. Lookup only; never send again.
  }
  const acknowledged = reply && entryResult(reply,'0',false)
  if (acknowledged) return acknowledged
  const latest = await orderStatus({transport},{user,oid:clientOrderId(uuid)})
  if (latest.status === 'order' && latest.order.status === 'open' && latest.order.order.isPositionTpsl &&
      latest.order.order.reduceOnly && latest.order.order.coin === m.id) {
    return {status:'resting', filledSize:'0', oid:latest.order.order.oid}
  }
  throw new HTTPException(502,{message:'New stop unconfirmed. Check open orders.'})
}

export async function recoverOrder(owner: string, uuid: string, requestedSize: string, bracket = false): Promise<OrderResult|null> {
  const user = owner as Address
  const latest = await orderStatus({transport},{user,oid:clientOrderId(uuid)})
  if (latest.status !== 'order') return null
  const {order: details,status,statusTimestamp} = latest.order
  const {oid} = details
  const requested = parseUnits(requestedSize,18)
  const executed = parseUnits(details.origSz,18) - parseUnits(details.sz,18)
  if (parseUnits(details.origSz,18) !== requested || executed < 0n || executed > requested) return null
  let result: OrderResult
  if (executed > 0n) {
    // ponytail: recovery reads one venue fill page; an incomplete sum remains unresolved.
    const history = await userFillsByTime({transport},{
      user,startTime:details.timestamp, ...(status === 'open' ? {} : {endTime:statusTimestamp + 1}),
    })
    let volume = 0n, cost = 0n
    for (const f of history) if (f.oid === oid) {
      const qty = parseUnits(f.sz,18)
      volume += qty
      cost += qty * parseUnits(f.px,18)
    }
    if (volume !== executed) return null
    result = {status:volume === requested ? 'filled' : 'partial', oid, filledSize:formatUnits(volume,18), avgPx:formatUnits(cost / volume,18)}
    if (result.status === 'partial' && status === 'open') result.message = 'Remaining order is resting'
  } else if (status === 'open') result = {status:'resting', oid, filledSize:'0'}
  else if (/cancel|reject/i.test(status)) result = {status:'rejected', oid, filledSize:'0', message:venueReason(status.replace(/([a-z])([A-Z])/g,'$1 $2').replace(/^./,c => c.toUpperCase()))}
  else return null

  if (bracket && result.status !== 'rejected') {
    const children = await Promise.all(['tp','sl'].map(side => orderStatus({transport},
      {user,oid:clientOrderId(uuid,side as 'tp'|'sl')}).catch(() => null)))
    if (!children.every(child => child?.status === 'order' && child.order.status === 'open')) {
      result.message = 'Check your stop and target'
    }
  }
  return result
}

export async function cancel(key: Hex, m: Market, oid: number) {
  try {
    await cancelOrder({ wallet: privateKeyToAccount(key), transport }, { cancels: [{ a: m.asset, o: oid }] })
  } catch (e) {
    if (e instanceof ApiRequestError) throw new HTTPException(422, { message: venueReason(e.message) })
    throw e
  }
}

export async function leverage(key: Hex, m: Market, n: number, isCross: boolean) {
  try {
    await updateLeverage({ wallet: privateKeyToAccount(key), transport }, { asset: m.asset, leverage: n, isCross })
  } catch (e) {
    if (e instanceof ApiRequestError) throw new HTTPException(422, { message: venueReason(e.message) })
    throw e
  }
}
