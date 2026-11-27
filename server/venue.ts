import { HttpRequestError, HttpTransport } from '@nktkas/hyperliquid'
import type { AllPerpMetasResponse, CandleSnapshotResponse, L2BookResponse, OutcomeMetaResponse, SpotMetaAndAssetCtxsResponse } from '@nktkas/hyperliquid/api/info'
import { HTTPException } from 'hono/http-exception'
import type { Instrument } from '../shared/api.js'
import { price, ticker } from '../shared/format.js'

const transport = new HttpTransport({ isTestnet: true, apiUrl: 'https://api.hyperliquid-testnet.xyz', timeout: 8_000, fetchOptions: { redirect: 'error' } })
export async function info<T>(body: Record<string, unknown>): Promise<T> {
  try {
    return await transport.request<T>('info', body)
  } catch (error) {
    // The testnet responds to an absent book with HTTP 500 and the JSON literal null.
    if (body.type === 'l2Book' && error instanceof HttpRequestError && error.response?.status === 500 &&
      (await error.response.text()).trim() === 'null') return null as T
    throw new HTTPException(502, { message: 'Wait for live prices' })
  }
}

export interface Market extends Instrument {
  asset: number
  quoteToken: string
  quoteUsd: string | null
  quoteIndex: number | null
  baseIndex?: number
  mark?: string
  accountOnly?: boolean
  tokenId?: string
  searchText?: string
  yesFor?: string
  noFor?: string
  outcomeSide?: 0 | 1
}

export function publicInstrument(m: Instrument): Instrument {
  const { id, kind, symbol, title, bid, ask, mid, szDecimals, maxLeverage, expiresAt, spark, change1h, trend, trendLow, trendHigh } = m
  return { id, kind, symbol: ticker(symbol), title: kind === 'spot' ? ticker(title) : title, bid, ask, mid, szDecimals, spark, change1h, trend, trendLow, trendHigh,
    ...(maxLeverage === undefined ? {} : { maxLeverage }), ...(expiresAt === undefined ? {} : { expiresAt }) }
}

function fields(description: string): Record<string, string> {
  return Object.fromEntries(description.split('|').flatMap(part => {
    const at = part.indexOf(':')
    return at < 1 ? [] : [[part.slice(0, at), part.slice(at + 1).trim()]]
  }))
}

function expiry(f: Record<string, string>): number | undefined {
  for (const value of [f.expiry, f.resolutionDeadline, f.decisionDeadline, f.listingDeadline, f.deadline, f.time, f.dateTime]) {
    const match = value?.match(/^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})$/)
    if (match) return Date.UTC(+match[1], +match[2]-1, +match[3], +match[4], +match[5])
  }
}

function outcomeLabel(name: string, questionName: string, f: Record<string, string>, side: 0 | 1) {
  const answer = side === 0 ? 'Yes' : 'No'
  const a = f.shortNameA || f.participantA
  const b = f.shortNameB || f.participantB
  const game = a && b ? `${a} v ${b}` : ''
  const priceMarket = f.shortName || f.underlying || f.perp
  let topic: string
  if (f.participant) topic = f.participant
  else if (/ContestDraw/.test(name)) topic = `${game} draw`
  else if (game) topic = game
  else if (priceMarket) {
    const thresholds = f.priceThresholds?.split(',').map(value => price(value))
    const bucket = thresholds && ['< '+thresholds[0], thresholds.join('–'), '≥ '+thresholds[1]][Number(f.index)]
    const target = f.targetPrice || f.threshold || f.target
    topic = [ticker(priceMarket), bucket || (target && price(target)) || (f.low && f.high && `${price(f.low)}–${price(f.high)}`)].filter(Boolean).join(' ')
  } else if (f.person || f.company) topic = [f.company, f.person || f.marketCapThresholdB && `>${f.marketCapThresholdB}B` || f.role].filter(Boolean).join(' ')
  else if (f.candidate || f.award) topic = [f.award, f.candidate || 'other'].filter(Boolean).join(' ')
  else if (f.decisionLabel) topic = `${f.decisionLabel} ${name.replace(/.*policyRate|\d+$/g, '')}`
  else topic = name.startsWith('template:') ? (questionName || name).replace(/^template:/, '') : name
  const teams = f.participant ? [] : [f.participantA, f.participantB, f.shortNameA, f.shortNameB]
  const short = `${topic.slice(0, 35).trimEnd()} ${answer}`
  return { symbol: short, title: short, searchText: [topic, f.participant, ...teams, f.stage, f.season, f.competition, f.sport, f.underlying, questionName].filter(Boolean).join(' ') }
}

async function discover(): Promise<Market[]> {
  const [perps, [spot, ctxs], outcomes] = await Promise.all([
    info<AllPerpMetasResponse>({ type: 'allPerpMetas' }),
    info<SpotMetaAndAssetCtxsResponse>({ type: 'spotMetaAndAssetCtxs' }),
    info<OutcomeMetaResponse>({ type: 'outcomeMeta' }),
  ])
  const byToken = new Map(spot.tokens.map(t => [t.index, t]))
  const byName = new Map(spot.tokens.map(t => [t.name, t]))
  const contexts = new Map(ctxs.map(c => [c.coin, c]))
  const usd = new Map<number, string>([[0, '1']])
  for (const pair of spot.universe) {
    const rate = contexts.get(pair.name)?.markPx
    if (pair.tokens[1] === 0 && Number(rate) > 0) usd.set(pair.tokens[0], rate!)
  }
  const empty = { bid: null, ask: null, mid: null }
  const result: Market[] = []
  perps.forEach((meta, dexIndex) => meta.universe.forEach((p, i) => {
    const quote = meta.collateralToken
    const symbol = ticker(p.name)
    result.push({ ...empty, kind: 'perp', id: p.name, symbol, title: symbol.slice(0, 40), searchText: p.name+' perp', szDecimals: p.szDecimals,
      maxLeverage: p.maxLeverage, accountOnly: p.isDelisted, asset: dexIndex === 0 ? i : 100_000 + dexIndex * 10_000 + i,
      quoteIndex: quote, quoteToken: byToken.get(quote)?.name ?? `token ${quote}`, quoteUsd: usd.get(quote) ?? null })
  }))
  for (const pair of spot.universe) {
    const [baseIdx, quoteIdx] = pair.tokens
    const base = byToken.get(baseIdx), quote = byToken.get(quoteIdx)
    if (!base || !quote) continue
    const ctx = contexts.get(pair.name)
    result.push({ ...empty, kind: 'spot', id: pair.name, symbol: base.name, title: `${base.name}/${quote.name}`.slice(0, 40),
      mid: ctx?.midPx ?? null, mark: ctx?.markPx, szDecimals: base.szDecimals, asset: 10_000 + pair.index,
      baseIndex: baseIdx, quoteIndex: quoteIdx, quoteToken: quote.name, quoteUsd: usd.get(quoteIdx) ?? null })
  }
  // A token can be held without a listed pair. Keep its balance visible without inventing a tradeable book.
  const listedBases = new Set(spot.universe.map(p => p.tokens[0]))
  for (const t of spot.tokens) if (t.index !== 0 && !listedBases.has(t.index)) {
    result.push({ ...empty, id: `token:${t.index}`, kind: 'spot', symbol: t.name, title: t.name.slice(0, 40),
      szDecimals: t.szDecimals, asset: -1, baseIndex: t.index, tokenId: t.tokenId, accountOnly: true,
      quoteIndex: 0, quoteToken: 'USDC', quoteUsd: '1' })
  }
  const questions = new Map(outcomes.questions.flatMap(q => q.namedOutcomes.map(id => [id, q] as const)))
  const excluded = new Set(outcomes.questions.flatMap(q => [q.fallbackOutcome, ...q.settledNamedOutcomes]))
  for (const o of outcomes.outcomes) {
    const q = questions.get(o.outcome)
    const f = { ...fields(q?.description ?? ''), ...fields(o.description) }
    const expiresAt = expiry(f)
    // ponytail: omit unstructured deadlines; an undated market cannot be proven open.
    for (const side of [0, 1] as const) {
      if (!o.sideSpecs[side]) continue
      const encoding = 10 * o.outcome + side
      const id = `#${encoding}`, ctx = contexts.get(id)
      const quoteIdx = byName.get(o.quoteToken)?.index ?? null
      const teamMarket = /ContestWinner/.test(o.name) && f.participantA && f.participantB
      const teamA = teamMarket ? [f.participantA, f.shortNameA].filter(Boolean).join(' ') : undefined
      const teamB = teamMarket ? [f.participantB, f.shortNameB].filter(Boolean).join(' ') : undefined
      // The venue's trading UI uses whole outcome shares; its live books have up to 5 price decimals.
      const label = outcomeLabel(o.name, q?.name ?? '', f, side)
      if (teamMarket && /\{shortName[AB]\}/.test(o.sideSpecs[side].name)) {
        const a = f.shortNameA || f.participantA, b = f.shortNameB || f.participantB
        label.symbol = `${(a+' v '+b).slice(0,35).trimEnd()} ${side === 0 ? 'Yes' : 'No'}`
        label.title = `${side === 0 ? f.participantA : f.participantB} wins`.slice(0, 40)
      }
      result.push({ ...empty, ...label, kind: 'outcome', id, asset: 100_000_000 + encoding, accountOnly: !expiresAt || excluded.has(o.outcome),
        szDecimals: 0, mid: ctx?.midPx ?? null, mark: ctx?.markPx, expiresAt, outcomeSide: side,
        yesFor: side === 0 ? teamA : teamB, noFor: side === 0 ? teamB : teamA,
        quoteIndex: quoteIdx, quoteToken: o.quoteToken, quoteUsd: quoteIdx === null ? null : usd.get(quoteIdx) ?? null })
    }
  }
  return result
}

let catalog: { time: number; data: Promise<Market[]> } | undefined
export function accountMarkets(): Promise<Market[]> {
  if (!catalog || Date.now() - catalog.time > 15_000) {
    const data = discover()
    catalog = { time: Date.now(), data }
    data.catch(() => { if (catalog?.data === data) catalog = undefined })
  }
  return catalog.data
}

export async function markets(): Promise<Market[]> {
  return (await accountMarkets()).filter(m => !m.accountOnly && (!m.expiresAt || m.expiresAt > Date.now()))
}

type Book = NonNullable<L2BookResponse>
const books = new Map<string, Promise<L2BookResponse>>()
function rawBook(id: string): Promise<L2BookResponse> {
  const previous = books.get(id)
  if (previous) return previous
  const data = info<L2BookResponse>({ type: 'l2Book', coin: id })
  books.set(id, data)
  const release = () => { if (books.get(id) === data) books.delete(id) }
  void data.then(() => { setTimeout(release, 650).unref() }, release)
  return data
}

export async function book(id: string): Promise<Book> {
  const snapshot = await rawBook(id)
  if (!snapshot) throw new HTTPException(404, { message: 'Wait for live prices' })
  return snapshot
}

export async function hydrateQuotes(items: Market[]): Promise<Market[]> {
  const output: Market[] = []
  for (let i = 0; i < items.length; i += 8) {
    output.push(...await Promise.all(items.slice(i, i + 8).map(async m => {
      const snapshot = await rawBook(m.id)
      const bid = snapshot?.levels[0][0]?.px ?? null, ask = snapshot?.levels[1][0]?.px ?? null
      return { ...m, bid, ask, mid: bid && ask ? decimal((Number(bid) + Number(ask)) / 2) : null }
    })))
  }
  return output
}

export async function market(id: string): Promise<Market> {
  const m = (await markets()).find(item => item.id === id)
  if (!m) throw new HTTPException(404, { message: 'Market unavailable. Choose another market' })
  return (await hydrateQuotes([m]))[0]
}

const fiveMinutes = 300_000
type History = Pick<Instrument, 'spark' | 'change1h' | 'trend' | 'trendLow' | 'trendHigh'>
type Candle = Pick<CandleSnapshotResponse[number], 't' | 'l' | 'h' | 'o' | 'c'>

export function sparkline(candles: Candle[], start: number): History {
  const byTime = new Map(candles.map(b => [b.t,b]))
  let last = Number(candles.filter(b => b.t < start).sort((a,b) => b.t-a.t)[0]?.c)
  let traded = false
  const bars = []
  // No trades in a bucket: carry the last observed close. Never backfill an unknown opening price.
  for (let i = 0; i < 12; i++) {
    const b = byTime.get(start + i*fiveMinutes)
    const open = Number(b?.o ?? last), close = Number(b?.c ?? last)
    const low = Number(b?.l ?? last), high = Number(b?.h ?? last)
    if (!(low > 0 && low <= Math.min(open,close) && Math.max(open,close) <= high && Number.isFinite(high))) return {}
    bars.push({open,close,low,high})
    traded ||= !!b
    last = close
  }
  if (!traded) return {}
  const low = Math.min(...bars.map(b => b.low)), high = Math.max(...bars.map(b => b.high))
  const mid = (high + low) / 2, width = Math.max(high - low, mid * 0.003)
  const glyphs = '▁▂▃▄▅▆▇█'
  const spark = bars.map(b => glyphs[Math.round(7 * ((b.close-mid)/width + 0.5))]).join('')
  // The line graph uses the same scale as the text graph, so a quiet hour is flat in both.
  const trend = bars.map(b => Math.round(1000 * Math.min(1, Math.max(0, (b.close-mid)/width + 0.5))) / 1000)
  return {spark, trend, trendLow: decimal(mid - width/2), trendHigh: decimal(mid + width/2),
    change1h: (bars[11].close - bars[0].open) / bars[0].open}
}

// Market graphs are a live ticker: the last 90 seconds of mid prices, so the line moves with each tick
// and scrolls as time passes. An hour of BTC spans a few hundred dollars, about $6 a pixel, and five
// minutes about $1.50 a pixel, so second-to-second moves barely showed at either.
const liveWindow = 90_000
const ticks = new Map<string, {t: number; px: number}[]>()
let recorded = 0

export function recordTick(id: string, time: number, mid: number, seed = true) {
  if (seed && !ticks.has(id)) seedTicks(id, time)
  const list = ticks.get(id) ?? []
  if (!(mid > 0) || (list.length && time <= list[list.length - 1]!.t)) return
  list.push({t: time, px: mid})
  while (list[0]!.t < time - liveWindow) list.shift()
  ticks.set(id, list)
  // Markets nobody watches stop ticking; drop their last samples now and then instead of keeping them forever.
  if (++recorded % 1000 === 0) for (const [key, kept] of ticks) if (!kept.length || kept[kept.length - 1]!.t < time - liveWindow) ticks.delete(key)
}

// One-minute closes fill the window until live ticks cover it.
function seedTicks(id: string, now: number) {
  ticks.set(id, [])
  void info<CandleSnapshotResponse>({type:'candleSnapshot',req:{coin:id,interval:'1m',startTime:now-liveWindow,endTime:now}})
    .then(rows => {
      const list = ticks.get(id) ?? [], first = list[0]?.t ?? Infinity
      const closes = rows.map(r => ({t: r.t + 60_000, px: Number(r.c)})).filter(p => p.px > 0 && p.t < first && p.t > now - liveWindow)
      ticks.set(id, [...closes, ...list])
    })
    .catch(() => {})
}

export function liveHistory(id: string, history: History, mid: string | null, points = 60): History {
  const list = ticks.get(id) ?? []
  if (list.length < 2) return withLive(history, mid)
  const end = list[list.length - 1]!.t, start = Math.max(list[0]!.t, end - liveWindow)
  const prices: number[] = []
  for (let i = 0, j = 0; i < points; i++) {
    const at = start + (end - start) * i / (points - 1)
    while (j + 1 < list.length && list[j + 1]!.t <= at) j++
    prices.push(list[j]!.px)
  }
  const low = Math.min(...prices), high = Math.max(...prices)
  // A flat market stays a flat line in the middle instead of magnifying cents into swings.
  const width = Math.max(high - low, (high + low) / 2 * 0.0005), mid0 = (high + low) / 2
  return { ...history, trend: prices.map(p => Math.round(1000 * ((p - mid0) / width + 0.5)) / 1000),
    trendLow: decimal(mid0 - width / 2), trendHigh: decimal(mid0 + width / 2) }
}

// The newest point is the live price, so the graph's end moves between candle refreshes.
// A price outside the hour's range widens the scale instead of being clipped.
export function withLive(history: History, mid: string | null): History {
  const { trend, trendLow, trendHigh } = history
  const live = Number(mid)
  if (!trend?.length || !(live > 0) || trendLow === undefined || trendHigh === undefined) return history
  const low = Number(trendLow), high = Number(trendHigh)
  const values = trend.map(t => low + t * (high - low))
  values[values.length - 1] = live
  const bottom = Math.min(low, live), top = Math.max(high, live)
  return { ...history, trend: values.map(v => Math.round(1000 * (v - bottom) / (top - bottom)) / 1000),
    trendLow: decimal(bottom), trendHigh: decimal(top) }
}

const histories = new Map<string, {value: History; pending: Promise<History>}>()

export function cachedHistory(id: string): History {
  return histories.get(id)?.value ?? {}
}

export function marketHistory(id: string): Promise<History> {
  const cached = histories.get(id)
  if (cached) return cached.pending
  const end = Math.floor(Date.now() / fiveMinutes) * fiveMinutes
  const start = end - 12 * fiveMinutes
  const value: History = {}
  // One preceding hour provides the opening reference for sparsely traded instruments.
  const pending = info<CandleSnapshotResponse>({type:'candleSnapshot',req:{coin:id,interval:'5m',startTime:start-12*fiveMinutes,endTime:end-1}})
    .then(rows => Object.assign(value, sparkline(rows,start)))
    .catch(() => value)
    .finally(() => { setTimeout(() => histories.delete(id),60_000).unref() })
  histories.set(id,{value,pending})
  return pending
}

export function decimal(value: number): string {
  return value.toFixed(12).replace(/\.?0+$/, '') || '0'
}
