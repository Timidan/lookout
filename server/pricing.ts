import { randomUUID } from 'node:crypto'
import { formatUnits, parseUnits } from 'viem'
import type { Instrument, OrderIntent, Ticket } from '../shared/api.js'
import { exact, percent, ticker, usd as dollars } from '../shared/format.js'
import { publicInstrument } from './venue.js'

type Level = { px: string; sz: string }
type Book = { levels: [Level[], Level[]] }
type PricedInstrument = Instrument & { quoteUsd?: string | null }
type QuoteOptions = { defaultUsd?: string; stopPct?: string; targetPct?: string; closing?: boolean; assumed?: string }
const one = 10n ** 18n
const print = (value: bigint) => formatUnits(value, 18)
const min = (a: bigint, b: bigint) => a < b ? a : b
const max = (a: bigint, b: bigint) => a > b ? a : b

function positive(value: unknown, label: string): bigint {
  if (typeof value !== 'string' || value.length > 48 || !/^(?:\d+(?:\.\d{1,18})?|\.\d{1,18})$/.test(value)) {
    throw new Error(`Check the ${label}`)
  }
  const parsed = parseUnits(value, 18)
  if (parsed <= 0n) throw new Error(`Use a positive ${label}`)
  return parsed
}

function roundPrice(px: bigint, instrument: Instrument, buy: boolean) {
  const magnitude = px.toString().length - 19
  const maxDecimals = (instrument.kind === 'perp' ? 6 : 8) - instrument.szDecimals
  // Integer prices are always valid, including prices with six or more digits.
  const places = Math.max(0, Math.min(4 - magnitude, maxDecimals))
  const tick = 10n ** BigInt(18 - places)
  return ((px + (buy ? 0n : tick - 1n)) / tick) * tick
}

export function roundVenuePrice(instrument: Instrument, value: string, direction: 'up' | 'down'): string {
  const px = roundPrice(positive(value, 'price'), instrument, direction === 'down')
  if (!px) throw new Error('Price too low. Try a higher price')
  return print(px)
}

function trigger(instrument: Instrument, entry: bigint, buy: boolean, stop: boolean, pct: string, override?: string): string {
  const label = stop ? 'stop' : 'target'
  let desired: bigint
  if (override !== undefined) desired = positive(override, label)
  else {
    const distance = positive(pct, label + ' percent')
    const lower = buy === stop
    if (lower && distance >= 100n * one) throw new Error(`Choose a smaller ${label} distance`)
    desired = entry * (100n * one + (lower ? -distance : distance)) / (100n * one)
  }
  const rounded = roundPrice(desired, instrument, !buy)
  if (!rounded || (buy === stop ? max(desired, rounded) >= entry : min(desired, rounded) <= entry)) {
    throw new Error(`Set the ${label} ${buy === stop ? 'below' : 'above'} entry`)
  }
  return print(rounded)
}

export function defaultStopPx(instrument: Instrument, entryPx: string, side: 'buy' | 'sell', stopPct = process.env.STOP_PCT ?? '2'): string {
  return trigger(instrument, positive(entryPx, 'entry price'), side === 'buy', true, stopPct)
}

/** Fixed-point pricing. The caller supplies the book and configuration. */
export function quoteOrder(instrument: PricedInstrument, book: Book, intent: OrderIntent, maxUsd: string, slippageBps: number, options: QuoteOptions = {}): Omit<Ticket, 'id' | 'expiresAt'> {
  if (!intent || intent.instrumentId !== instrument.id || !['buy', 'sell'].includes(intent.side)) throw new Error('Choose a market and an order side')
  if (intent.size !== undefined && intent.usd !== undefined) throw new Error('Choose dollars or units')
  if (intent.reduceOnly !== undefined && typeof intent.reduceOnly !== 'boolean') throw new Error('Choose whether to close the position')
  if (intent.reduceOnly && instrument.kind !== 'perp') throw new Error('Use a sell order to close this holding')
  if (intent.bracket !== undefined && intent.bracket !== false) throw new Error('Check the stop and target settings')
  const bracket = instrument.kind === 'perp' && !intent.reduceOnly && intent.bracket !== false
  if (!bracket && (intent.stopPx !== undefined || intent.targetPx !== undefined)) throw new Error('Set stops and targets on a new long or short')
  const lev = intent.leverage
  if (lev !== undefined && (instrument.kind !== 'perp' || !Number.isInteger(lev) || lev < 1 || lev > (instrument.maxLeverage ?? 1))) {
    throw new Error('Choose a supported leverage for this market')
  }
  if (!Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps >= 10000) throw new Error('Price settings unavailable. Try again later')
  const cap = positive(maxUsd, 'order cap')
  if (instrument.quoteUsd === null) throw new Error('Dollar price unavailable. Try another market')
  const rate = positive(instrument.quoteUsd ?? '1', 'quote USD rate')
  const buy = intent.side === 'buy'
  const levels = book.levels[buy ? 1 : 0]
  const best = levels.length ? positive(levels[0].px, 'book price') : 0n
  const limit = intent.limitPx !== undefined
  if (!limit && !best) throw new Error('No orders on this side. Try a limit price')
  const bps = BigInt(10000 + (buy ? slippageBps : -slippageBps))
  let bound = limit ? positive(intent.limitPx, 'limit price') : (best * bps + (buy ? 0n : 9999n)) / 10000n
  if (instrument.kind === 'outcome' && bound >= one) {
    if (limit) throw new Error(`Choose an outcome price below ${exact(1)}`)
    bound = one - 1n
  }
  const px = roundPrice(bound, instrument, buy)
  if (!px || (instrument.kind === 'outcome' && px >= one)) throw new Error('Price outside the range. Choose another price')

  // A sell can execute above its limit. Check the best visible bid as well.
  const unitValue = (buy ? px : max(best, px)) * rate
  const lot = 10n ** BigInt(18 - instrument.szDecimals)
  const assumedAmount = intent.usd === undefined && intent.size === undefined
  const usd = intent.size === undefined ? positive(assumedAmount ? (options.defaultUsd ?? '50') : intent.usd, 'USD amount') : undefined
  const enforceCap = !intent.reduceOnly && !(options.closing && instrument.kind !== 'perp' && !buy && !limit)
  const overCap = () => new Error(`Order exceeds the ${dollars(maxUsd)} cap. Reduce size`)
  if (enforceCap && usd !== undefined && usd > cap) throw overCap()
  const requested = usd === undefined ? positive(intent.size, 'size') : usd * one * one / unitValue
  const size = requested / lot * lot
  if (!size) throw new Error('Order too small. Increase the size')
  if (enforceCap && size * unitValue > cap * one * one) throw overCap()

  let filled = 0n, cost = 0n
  for (const level of levels) {
    const price = positive(level.px, 'book price')
    if (buy ? price > px : price < px) break
    const take = min(size - filled, positive(level.sz, 'book size'))
    filled += take
    cost += price * take
    if (filled === size) break
  }
  const warnings: string[] = []
  if (filled < size) {
    if (limit) warnings.push('Unfilled size may rest on the book')
    else warnings.push(`Book is thin · ${percent(Number(filled) / Number(size))} can fill at this price`)
  }
  const est = filled ? cost / filled : px
  const notional = filled ? size * cost * rate / (filled * one * one) : size * px * rate / (one * one)
  const bid = book.levels[0][0]?.px ?? null
  const ask = book.levels[1][0]?.px ?? null
  const mid = bid && ask ? print((positive(bid, 'bid') + positive(ask, 'ask')) / 2n) : null
  const symbol = ticker(instrument.symbol)
  const side = buy ? 'Buy' : 'Sell'
  const direction = intent.reduceOnly ? (buy ? 'Close short' : 'Close long') : (buy ? 'Long' : 'Short')
  const amount = dollars(print(usd ?? notional))
  let summary = instrument.kind === 'perp'
    ? `${direction} ${symbol} ${amount}${lev ? ` · ${exact(lev)}x` : ''}`
    : `${side} ${symbol} ${amount}`
  if (instrument.kind === 'outcome') {
    const match = /^(.+) (Yes|No)$/.exec(symbol)
    if (match) summary = `${side} ${exact(print(size))} ${match[2]} · ${match[1]}`
  }
  return {
    instrument: { ...publicInstrument(instrument), bid, ask, mid },
    side: intent.side, size: print(size), px: print(px), estPx: print(est),
    notionalUsd: print(notional), reduceOnly: intent.reduceOnly ?? false,
    ...(bracket && {
      stopPx: trigger(instrument, est, buy, true, options.stopPct ?? '2', intent.stopPx),
      targetPx: trigger(instrument, est, buy, false, options.targetPct ?? '4', intent.targetPx),
    }),
    ...(assumedAmount || options.assumed ? {assumed: options.assumed ?? 'default size'} : {}),
    ...(lev === undefined ? {} : { leverage: lev, marginUsd: print(notional / BigInt(lev)) }),
    summary: summary.slice(0, 40), warnings,
  }
}

export function priceTicket(instrument: PricedInstrument, book: Book, intent: OrderIntent, options: Pick<QuoteOptions, 'closing'|'assumed'> = {}): Ticket {
  const now = Date.now()
  if (instrument.expiresAt !== undefined && instrument.expiresAt <= now) throw new Error('Market expired. Choose another market')
  return {
    ...quoteOrder(instrument, book, intent, process.env.MAX_ORDER_USD ?? '200', Number(process.env.SLIPPAGE_BPS ?? '100'), {
      ...options, defaultUsd: process.env.DEFAULT_USD, stopPct: process.env.STOP_PCT, targetPct: process.env.TARGET_PCT,
    }),
    id: randomUUID(), expiresAt: Math.min(now + 30_000, instrument.expiresAt ?? Infinity),
  }
}
