import { createHash } from 'node:crypto'
import { parseUnits } from 'viem'
import type { FrontendOpenOrdersResponse } from '@nktkas/hyperliquid/api/info'
import type { Account, Card, CardAction, Instrument, Position } from '../shared/api.js'
import { exact, pnl, price, ticker } from '../shared/format.js'
import { readAccountSnapshot } from './account.js'
import { defaultStopPx, roundVenuePrice } from './pricing.js'
import { decimal, hydrateQuotes, marketHistory, markets, type Market } from './venue.js'

type VenueOrder = FrontendOpenOrdersResponse[number]
type Stop = { oid: number; instrumentId: string; triggerPx: string; size: string; positionTpsl: boolean }
type Entry = { oid: number; instrumentId: string; market: Market; side: 'buy' | 'sell'; size: string; px: string }
export interface CardSnapshot {
  account: Account | null
  entries: Entry[]
  stops: Record<string, Stop>
  activeStopCount: number
}
const priority: Card['kind'][] = ['liq_before_stop','no_stop','thin_buffer','stop_to_entry','position','step_away','close_all','idle','watch']
function card(content: Omit<Card,'id'|'confirm'>, state?: unknown): Card {
  const {kind, action, line1, line2, detail} = content
  // Proposed stop prices can move with the mark. Identify the underlying position and its resting orders.
  const identity = action && 'triggerPx' in action ? [action.type, action.instrumentId] : action
  const hash = createHash('sha256').update(JSON.stringify([identity ?? null, state ?? null])).digest('hex').slice(0, 24)
  const result: Card = { ...content, id: `${kind}:${hash}`, line1: line1.slice(0, 40), line2: line2.slice(0, 40) }
  if (detail) result.detail = detail.slice(0, 44)
  if (action) {
    result.action = action
    result.confirm = ['cancel_entries','close_all','reduce'].includes(action.type) ? 'hold' : 'tap'
  }
  return result
}

export function watchCard(m: Instrument): Card {
  const symbol = ticker(m.symbol)
  return card({kind:'watch', symbol, spark:m.spark, change1h:m.change1h, trend:m.trend, trendLow:m.trendLow, trendHigh:m.trendHigh, line1:`${symbol} ${price(m.mid)}`, line2:`Tap to trade ${symbol}`,
    detail:`Bid ${price(m.bid)} · ask ${price(m.ask)}`, action:{type:'open_market',instrumentId:m.id}})
}

function isClosingTrigger(o: VenueOrder, p: Position) {
  return o.coin === p.instrumentId && p.kind === 'perp' && o.isTrigger && o.reduceOnly &&
    o.side === (Number(p.size) > 0 ? 'A' : 'B') && Number(o.triggerPx) > 0 && (Number(o.sz) > 0 || o.isPositionTpsl)
}

function between(m: Instrument, mark: number, liq: number, long: boolean) {
  if (liq <= 0 || (long ? liq >= mark : liq <= mark)) return undefined
  const halfway = decimal((liq + mark) / 2)
  for (const direction of [long ? 'up' : 'down', long ? 'down' : 'up'] as const) {
    try {
      const trigger = roundVenuePrice(m, halfway, direction)
      if (Number(trigger) > Math.min(liq,mark) && Number(trigger) < Math.max(liq,mark)) return trigger
    } catch { /* rounding below one tick */ }
  }
}

function positionCard(p: Position, m: Market | undefined, protective: VenueOrder[], targets: VenueOrder[], snapshot: CardSnapshot, thinPct: number, stopPct: string, now: number) {
  const id = p.instrumentId, long = Number(p.size) > 0, mark = Number(p.markPx), entry = Number(p.entryPx), liq = Number(p.liqPx)
  const direction = long ? 1 : -1
  const reduce: CardAction = { type:'reduce', instrumentId:id, fraction:0.5 }
  const size = Math.abs(Number(p.size))
  const stopState = protective.map(o => [o.oid, o.triggerPx, o.sz, o.isPositionTpsl, o.orderType]).sort((a,b) => Number(a[0])-Number(b[0]))
  const state = [id, p.size, p.entryPx, stopState]
  const symbol = ticker(p.symbol), profit = pnl(p.pnlUsd)
  const holding = p.kind === 'perp' ? `${symbol} ${long ? 'long' : 'short'}` : symbol
  const leveraged = p.leverage ? `${holding} ${exact(p.leverage)}x` : holding
  const tradable = m && !m.accountOnly && (!m.expiresAt || m.expiresAt > now)
  const normal = (stop?: string) => {
    const detail = [stop ? `Stop ${exact(stop)}` : '', liq > 0 ? `liquidation ${price(p.liqPx)}` : ''].filter(Boolean).join(' · ')
    return card({kind:'position', symbol, line1:`${holding} ${exact(p.size.replace(/^-/,''))} · ${profit}`,
      line2:tradable ? `Tap to trade ${symbol}` : 'Hold to speak a trade',
      ...(detail && {detail:detail.charAt(0).toUpperCase()+detail.slice(1)}),
      ...(tradable && {action:{type:'open_market',instrumentId:id}})}, state)
  }
  if (p.kind !== 'perp' || !m || !tradable) return normal()
  const validLiq = Number.isFinite(liq) && liq > 0
  const buffer = validLiq && (entry-liq)*direction > 0 ? Math.max(0,Math.min(1,(mark-liq)/(entry-liq))) : undefined
  const fullSize = parseUnits(p.size.replace(/^-/,'') ,m.szDecimals)
  const orderSize = (o:VenueOrder) => o.isPositionTpsl && Number(o.sz)===0 ? fullSize : parseUnits(o.sz,m.szDecimals)
  const sorted = [...protective].sort((a,b) => direction*(Number(b.triggerPx)-Number(a.triggerPx)) || a.oid-b.oid)
  // The threshold at which the entire position is covered, including multiple smaller stops.
  let remaining = fullSize
  const threshold = sorted.find(o => {
    remaining -= orderSize(o)
    return remaining <= 0n
  })
  const stop = threshold ? Number(threshold.triggerPx) : undefined
  // Moving an individual full-size static stop preserves independently placed partial/trailing orders.
  const movable = threshold && orderSize(threshold) >= fullSize && !threshold.orderType.startsWith('Trailing') ? threshold : undefined
  if (movable) snapshot.stops[id] = { oid: movable.oid, instrumentId: id, triggerPx: movable.triggerPx, size: movable.sz, positionTpsl: movable.isPositionTpsl }
  const reduceLine = 'Hold to reduce by half'
  const wantStop = (kind: 'liq_before_stop' | 'no_stop', trigger: string | undefined) => {
    const line1 = kind === 'no_stop' ? `${leveraged} has ${protective.length ? 'a partial stop' : 'no stop'}` : `${leveraged} · stop is too far`
    const detail = kind === 'no_stop' ? `Entry ${price(p.entryPx)} · now ${price(p.markPx)} · ${profit}` :
      `Liquidation ${price(p.liqPx)} comes before stop ${exact(threshold!.triggerPx)}`
    if (!trigger) return card({kind, symbol, line1, detail, line2:reduceLine, action:reduce}, state)
    const type = kind === 'no_stop' || !movable ? 'add_stop' : 'move_stop'
    return card({kind, symbol, line1, detail, line2:`Tap to ${type === 'add_stop' ? 'set stop at' : 'move stop to'} ${exact(trigger)}`,
      action:{type,instrumentId:id,triggerPx:trigger}}, state)
  }
  let result: Card
  if (stop !== undefined && validLiq && (stop-liq)*direction <= 0) {
    result = wantStop('liq_before_stop', between(m,mark,liq,long))
  } else if (stop === undefined) {
    let trigger: string | undefined
    try {
      trigger = defaultStopPx(m,p.entryPx,long ? 'buy' : 'sell',stopPct)
      // A crossed entry-based stop would fire immediately. Use the same distance from mark.
      if ((mark-Number(trigger))*direction <= 0) trigger = defaultStopPx(m,p.markPx,long ? 'buy' : 'sell',stopPct)
      if (validLiq && (Number(trigger)-liq)*direction <= 0) trigger = between(m,mark,liq,long)
    } catch {
      // A coarse venue tick can leave no valid protective price.
      trigger = undefined
    }
    result = wantStop('no_stop', trigger)
  } else if (validLiq && (mark-liq)*direction <= mark*thinPct/100) {
    result = card({kind:'thin_buffer', symbol, line1:`${leveraged} is near liquidation`, line2:reduceLine,
      detail:`Now ${price(p.markPx)} · liquidation ${price(p.liqPx)}`, action:reduce}, state)
  } else if ((entry-stop)*direction > 0 && (mark-entry)*direction > 0 && Number(p.pnlUsd) >= Math.abs(entry-stop)*size*Number(m.quoteUsd)) {
    const triggerPx = roundVenuePrice(m,p.entryPx,long ? 'up' : 'down')
    if ((mark-Number(triggerPx))*direction > 0) result = card({kind:'stop_to_entry', symbol, line1:`${holding} is up ${profit}`,
      line2:`Tap to move stop to entry ${exact(triggerPx)}`, detail:`Stop now ${exact(threshold!.triggerPx)}`,
      action:{type:movable ? 'move_stop' : 'add_stop', instrumentId:id, triggerPx}}, state)
    else result = normal(threshold?.triggerPx)
  } else result = normal(threshold?.triggerPx)
  const gaugeStop = stop ?? Number(sorted[0]?.triggerPx)
  const targetPrices = targets.map(o => Number(o.triggerPx)).filter(px => (px-gaugeStop)*direction > 0)
  if (targetPrices.length && mark > 0) {
    const target = long ? Math.min(...targetPrices) : Math.max(...targetPrices)
    result.toTarget = Math.max(0,Math.min(1,(mark-gaugeStop)/(target-gaugeStop)))
  }
  return { ...result, ...(buffer === undefined ? {} : {buffer}) }
}

/** Pure ranking over one owner snapshot. Only top-level stops are active at the venue. */
export function rankCards(account: Account | null, orders: FrontendOpenOrdersResponse, catalog: Market[], watch: Market[], thinPct = 10, stopPct = '2', now = account?.updatedAt ?? 0) {
  const snapshot: CardSnapshot = { account, entries:[], stops:Object.create(null), activeStopCount:0 }
  const byId = new Map(catalog.map(m => [m.id,m]))
  const activeIds = new Set<number>()
  const ranked: { card: Card; pnl: number }[] = []
  const positions = account?.positions ?? []
  for (const p of positions) {
    const closing = orders.filter(o => isClosingTrigger(o,p))
    const protective = closing.filter(o => /^(?:Trailing )?Stop (?:Limit|Market)$/.test(o.orderType))
    const targets = closing.filter(o => /^Take Profit (?:Limit|Market)$/.test(o.orderType))
    protective.forEach(o => activeIds.add(o.oid))
    const market = byId.get(p.instrumentId)
    const card = positionCard(p,market,protective,targets,snapshot,thinPct,stopPct,now)
    if (market?.spark) Object.assign(card,{spark:market.spark, change1h:market.change1h, trend:market.trend, trendLow:market.trendLow, trendHigh:market.trendHigh})
    ranked.push({card, pnl:Math.abs(Number(p.pnlUsd))})
  }
  snapshot.activeStopCount = activeIds.size
  const activeProtectiveIds = new Set(orders.filter(o => o.reduceOnly && o.isTrigger).map(o => o.oid))
  const containsActive = (o: VenueOrder): boolean => o.children?.some(c => activeProtectiveIds.has(c.oid) || containsActive(c)) ?? false
  for (const o of orders) {
    const m = byId.get(o.coin)
    if (!m || o.isTrigger || o.isPositionTpsl || o.reduceOnly || o.orderType !== 'Limit' || containsActive(o)) continue
    if (m.kind !== 'perp' && o.side === 'A' && positions.some(p => p.instrumentId === o.coin)) continue
    snapshot.entries.push({ oid:o.oid, instrumentId:o.coin, market:m, side:o.side === 'B' ? 'buy' : 'sell', size:o.sz, px:o.limitPx })
  }
  snapshot.entries.sort((a,b) => a.oid-b.oid)
  const cards = ranked.sort((a,b) => priority.indexOf(a.card.kind)-priority.indexOf(b.card.kind) || b.pnl-a.pnl || a.card.id.localeCompare(b.card.id)).map(x => x.card)
  if (snapshot.entries.length) {
    const entries = snapshot.entries
    const buys = entries.filter(o => o.side==='buy').length
    const group = buys === entries.length ? 'buy ' : buys === 0 ? 'sell ' : ''
    cards.push(card({kind:'step_away', line1:`${exact(entries.length)} ${group}order${entries.length === 1 ? '' : 's'} waiting`,
      line2:`Hold to cancel ${entries.length === 1 ? 'it' : 'them'}`,
      detail:`Your ${exact(activeIds.size)} ${activeIds.size === 1 ? 'stop stays' : 'stops stay'} on the exchange`,
      action:{type:'cancel_entries'}}, [entries.map(o => [o.oid,o.instrumentId,o.side,o.size,o.px]),[...activeIds].sort((a,b)=>a-b)]))
  }
  const perps = positions.filter(p => p.kind === 'perp').sort((a,b) => a.instrumentId.localeCompare(b.instrumentId))
  if (perps.length) cards.push(card({kind:'close_all',
    line1:`${exact(perps.length)} position${perps.length === 1 ? '' : 's'} open · ${pnl(perps.reduce((sum,p)=>sum+Number(p.pnlUsd),0))}`,
    line2:`Hold to close all ${exact(perps.length)}`, action:{type:'close_all'}},perps.map(p => [p.instrumentId,p.size,p.entryPx])))
  if (!cards.length) cards.push(card({kind:'idle',line1:'Nothing open',line2:'Hold to speak a trade'}))
  cards.push(...watch.map(watchCard))
  return { cards, snapshot }
}

export async function nextStack(owner: string | null) {
  const [raw, list] = await Promise.all([owner ? readAccountSnapshot(owner) : null, markets()])
  const outcome = list.find(m => m.kind === 'outcome' && m.id === '#273150') ?? list.find(m => m.kind === 'outcome' && m.mid) ?? list.find(m => m.kind === 'outcome')
  const ids = ['BTC','ETH','PURR/USDC',outcome?.id]
  const watch = await hydrateQuotes(ids.flatMap(id => { const m=list.find(m=>m.id===id); return m ? [m] : [] }))
  const stack = rankCards(raw?.account ?? null, raw?.orders ?? [], raw?.catalog ?? list, watch, Number(process.env.THIN_BUFFER_PCT ?? 10), process.env.STOP_PCT ?? '2')
  // Only tradeable holdings and watches have a market action. Several cards can share its candles.
  const byMarket = new Map<string,Card[]>()
  for (const c of stack.cards) {
    if (!c.action || !('instrumentId' in c.action)) continue
    const id = c.action.instrumentId
    if (!byMarket.has(id)) byMarket.set(id,[])
    byMarket.get(id)!.push(c)
  }
  const groups = [...byMarket]
  for (let i = 0; i < groups.length; i += 8) {
    await Promise.all(groups.slice(i,i+8).map(async ([id,cards]) => {
      const history = await marketHistory(id)
      for (const c of cards) Object.assign(c,history)
    }))
  }
  return stack
}
