import type { Instrument, OrderIntent, SayResult } from '../shared/api.js'
import { exact, percent, usd } from '../shared/format.js'

type Searchable = Instrument & { searchText?: string; outcomeSide?: 0 | 1; yesFor?: string; noFor?: string }
type OutcomeAnswer = 'yes' | 'no'

type Command =
  | { type: 'order'; intent: OrderIntent }
  | { type: 'close'; instrumentId: string; fraction: number }
  | { type: 'cancel'; instrumentId: string }
  | { type: 'reply'; reply: string }

function words(text: string) {
  return text.toLowerCase().normalize('NFKD').replace(/\p{Mark}/gu, '')
    .replace(/[^a-z0-9]+/g, ' ').trim()
    .replace(/\b(bitcoin|b t c)\b/g, 'btc').replace(/\b(ethereum|ether|e t h)\b/g, 'eth')
    .replace(/\btesla\b/g, 'tsla')
}

function matches<T extends Searchable>(query: string, instruments: readonly T[], answer?: OutcomeAnswer) {
  const q = words(query)
  if (!q) return []
  const parts = q.split(' ')
  return instruments.map(market => {
    const labels = [market.id, market.symbol, market.title].map(words)
    let score = 0
    if (answer) {
      if (market.kind !== 'outcome') return { market, score }
      const target = answer === 'yes' ? market.yesFor : market.noFor
      if (target && !query.startsWith('#')) {
        const names = words(target).split(' ')
        if (!parts.some(part => names.some(name => name.startsWith(part)))) return { market, score }
      } else {
        const sideMatches = market.outcomeSide === undefined
          ? labels.some(label => label.split(' ').at(-1) === answer)
          : market.outcomeSide === (answer === 'yes' ? 0 : 1)
        if (!sideMatches) return { market, score }
      }
    }
    if (/^[@#]/.test(query)) score = query === market.id ? 5 : 0
    else if (labels.includes(q)) score = 4
    else {
      const tokens = [...labels, words(market.searchText ?? '')].join(' ').split(' ')
      if (parts.every(part => tokens.includes(part))) score = 3
      else if (parts.every(part => tokens.some(token => token.startsWith(part)))) score = 2
      else if (q.length > 2 && labels.some(label => label.includes(q))) score = 1
    }
    return { market, score }
  }).filter(result => result.score).sort((a, b) => b.score - a.score)
}

export function searchMarkets<T extends Instrument>(query: string, instruments: readonly T[]): T[] {
  return query.trim() ? matches(query.trim(), instruments).map(result => result.market) : [...instruments]
}

const reply = (message: string): Command => ({ type: 'reply', reply: message })

function resolve(query: string, markets: readonly Searchable[], command: (m: Instrument) => Command, answer?: OutcomeAnswer, preferSpot = false): Command {
  const ranked = matches(query.trim(), markets, answer)
  if (!ranked.length) return reply('Market not found. Try its ticker')
  const tied = ranked.filter(hit => hit.score === ranked[0].score).map(hit => hit.market)
  if (tied.length === 1) return command(tied[0])
  if (preferSpot) {
    const usdc = tied.filter(m => m.kind === 'spot' && words(m.symbol) === words(query) && words(m.title) === words(query + ' USDC'))
    const canonical = usdc.find(m => words(m.id) === words(query + ' USDC'))
    if (canonical || usdc.length === 1) return command(canonical ?? usdc[0])
  }
  // Builder-deployed perp exchanges reuse tickers (testnet lists ten BTC perps as "BTC"); the main exchange's is meant.
  const main = tied.filter(m => !m.id.includes(':'))
  if (main.length === 1 && tied.every(m => m.kind === main[0].kind)) return command(main[0])
  if (answer) {
    // A named team's next head-to-head game takes precedence over a season book.
    const games = tied.filter(m => m.yesFor && m.noFor && m.expiresAt).sort((a, b) => a.expiresAt! - b.expiresAt!)
    const teams = new Set(games.map(m => words((answer === 'yes' ? m.yesFor : m.noFor)!)))
    const named = games.length && words(query).split(' ').some(part => part.length >= 3 && [...teams][0].split(' ').includes(part))
    if (named && teams.size === 1 && games[0].expiresAt !== games[1]?.expiresAt) return command(games[0])
  }
  return reply('Which market? Give its full ticker')
}

const digitNames = 'zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen'.split(' ')
const tens = 'twenty thirty forty fifty sixty seventy eighty ninety'.split(' ')
const wordValues = new Map([...digitNames.map((name, n) => [name, n] as const), ...tens.map((name, n) => [name, 20 + 10 * n] as const)])
const numberWord = '(?:' + [...wordValues.keys(), 'hundred', 'thousand', 'point'].join('|') + ')'
const wordGroup = new RegExp('\\b' + numberWord + '(?:[ -]+(?:and )?' + numberWord + ')*\\b', 'g')

// ponytail: English spoken numbers support thousands and decimal digits.
function spokenNumbers(body: string): string {
  return body.replace(wordGroup, (phrase: string, at: number) => {
    if (phrase === body) return phrase // A two-word trade may name a token like ONE.
    const before = body.slice(0, at), after = body.slice(at + phrase.length)
    if (!before && /\d/.test(after) && !/^\s+(?:dollars?|usd|units?|shares?|tokens?)\b/.test(after)) return phrase
    if (!after && /\d/.test(before) && !/(?:stop|target|at|point)\s+$/.test(before)) return phrase
    const tokens = phrase.split(/[ -]+/)
    const point = tokens.indexOf('point')
    const fraction = point === -1 ? [] : tokens.splice(point).slice(1)
    if (point !== -1 && (!fraction.length || fraction.some(t => !digitNames.slice(0, 10).includes(t)))) return phrase
    let total = 0, group = 0, previous: number | undefined
    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i]
      if (token === 'and' && ['hundred', 'thousand'].includes(tokens[i-1])) continue
      if (token === 'hundred' && previous === group && group >= 1 && group <= 9) { group *= 100; previous = undefined; continue }
      if (token === 'thousand' && group > 0 && total === 0) { total = group * 1000; group = 0; previous = undefined; continue }
      const n = wordValues.get(token)
      if (n === undefined || (previous !== undefined && !(previous >= 20 && previous % 10 === 0 && n > 0 && n < 10))) return phrase
      group += n
      previous = n
    }
    return String(total + group) + (fraction.length ? '.' + fraction.map(t => wordValues.get(t)).join('') : '')
  })
}

export function numberChoices(intent: OrderIntent): Pick<SayResult, 'choices' | 'reply'> | undefined {
  const key = intent.usd !== undefined ? 'usd' : 'size'
  const raw = intent[key]
  if (!raw || !/^\d+(?:\.0+)?$/.test(raw)) return
  const amount = Number(raw)
  const teen = amount >= 13 && amount <= 19 && Number.isInteger(amount) ? amount
    : amount >= 30 && amount <= 90 && amount % 10 === 0 ? 10 + amount / 10 : undefined
  if (teen === undefined) return
  const choices = [teen, (teen - 10) * 10].map(value => ({
    label: key === 'usd' ? usd(value) : exact(value),
    intent: { ...intent, [key]: String(value) },
  }))
  return { choices, reply: `${choices[0].label} or ${choices[1].label}?` }
}

const number = '(?:\\d+(?:\\.\\d+)?|\\.\\d+)'
const amount = '(\\$?)\\s*(' + number + ')(?:\\s+(usd|dollars?|shares?|units?|tokens?))?'
const amountFirst = new RegExp('^' + amount + '\\s+(?:of\\s+)?(.+)$')
const amountLast = new RegExp('^(.+?)\\s+(?:for\\s+)?' + amount + '$')
const leverageAtEnd = /\s+(\d+)\s*(?:x|times)(?:\s+leverage)?$/

export function parseCommand(text: string, instruments: readonly Searchable[]): Command {
  const line = text.trim().toLowerCase().replace(/(\d),(?=\d{3}\b)/g, '$1').replace(/,/g, ' ').replace(/\s+/g, ' ').replace(/[?!.]$/, '')
  const closeText = line.startsWith('close ') ? 'close ' + spokenNumbers(line.slice(6)).replace(/(\d)\s+percent\b/, '$1%') : line
  const close = closeText.match(/^close\s+(?:(half|quarter|all|\d+(?:\.\d+)?%)\s+(?:of\s+)?)?(?:my\s+)?(.+)$/)
  if (close) {
    const part = close[1]
    const fraction = !part || part === 'all' ? 1 : part === 'half' ? 0.5 : part === 'quarter' ? 0.25 : Number(part.slice(0, -1)) / 100
    if (!(fraction > 0 && fraction <= 1)) return reply(`Choose a share above ${percent(0)} and up to ${percent(1)}`)
    return resolve(close[2], instruments, m => ({ type: 'close', instrumentId: m.id, fraction }))
  }
  const cancel = line.match(/^cancel\s+(?:my\s+)?(.+?)\s+orders?$/)
  if (cancel) return resolve(cancel[1], instruments, m => ({ type: 'cancel', instrumentId: m.id }))

  const order = line.match(/^(buy|sell|long|short|yes|no)\s+(.+)$/)
  if (!order) return reply('Try “buy PURR” or “long BTC”')
  const verb = order[1]
  const answer = verb === 'yes' || verb === 'no' ? verb : undefined
  let body = spokenNumbers(answer ? order[2].replace(/^on\s+/, '') : order[2])
  const extras: Pick<OrderIntent, 'leverage' | 'stopPx' | 'targetPx'> = {}
  for (;;) {
    const trigger = body.match(/\s+(stop(?: loss)?|target)\s+(?:at\s+)?\$?(\d+(?:\.\d+)?|\.\d+)$/)
    const leverage = body.match(leverageAtEnd)
    if (trigger) {
      const key = trigger[1] === 'target' ? 'targetPx' : 'stopPx'
      if (extras[key] !== undefined) return reply('Give one stop and one target')
      extras[key] = trigger[2]
      body = body.slice(0, trigger.index)
    } else if (leverage && extras.leverage === undefined) {
      extras.leverage = Number(leverage[1])
      body = body.slice(0, leverage.index)
    } else break
  }
  const first = body.match(amountFirst)
  const last = first ? undefined : body.match(amountLast)
  const [dollar, quantity, unit, query] = first
    ? [first[1], first[2], first[3], first[4]]
    : last ? [last[2], last[3], last[4], last[1]] : ['', '', '', body]
  if (quantity && (!(Number(quantity) > 0) || !Number.isFinite(Number(quantity)))) return reply('Give a positive amount')
  const usd = dollar === '$' || unit === 'usd' || unit?.startsWith('dollar')
  if (dollar && unit && !/^(?:usd|dollars?)$/.test(unit)) return reply('Use dollars or units')
  let candidates = instruments
  if (verb === 'long' || verb === 'short' || Object.keys(extras).length) candidates = candidates.filter(m => m.kind === 'perp')
  return resolve(query, candidates, market => {
    const lev = extras.leverage
    if (lev !== undefined && (lev < 1 || lev > (market.maxLeverage ?? 1))) return reply(`Choose leverage from ${exact(1)}x to ${exact(market.maxLeverage ?? 1)}x`)
    return { type: 'order', intent: {
      instrumentId: market.id, side: verb === 'sell' || verb === 'short' ? 'sell' : 'buy',
      ...(quantity ? (usd ? { usd: quantity } : { size: quantity }) : {}), ...extras,
    } }
  }, answer, verb === 'buy' || verb === 'sell')
}
