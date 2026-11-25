import type { Account, Card, Instrument, Ticket } from '../shared/api'
import { exact, percent, pnl, price, ticker } from '../shared/format'
import { bigNumber, priceChart } from './chart'
import type { GlassPage } from './glasses'
import { actionIcon, coinIcon, outcomes, type ActionName } from './icons'
import { HOLD_MS, secondsLeft, type Choice, type Screen } from './state'

export type Data = { account?: Account; markets: Map<string, Instrument>; live: boolean; micLevel?: number }
type Row = { label: string; choice: Choice }
export type View = GlassPage & { rows?: Row[] }

const groups: Record<Card['kind'], string> = {
  liq_before_stop: 'Needs you', no_stop: 'Needs you', thin_buffer: 'Needs you', stop_to_entry: 'Needs you',
  position: 'Positions', close_all: 'Positions', step_away: 'Positions', watch: 'Markets', sample: 'Sample account', idle: '',
}
const marks: Partial<Record<Card['kind'], ActionName>> = {
  liq_before_stop: 'unprotected', no_stop: 'unprotected', thin_buffer: 'nearLiquidation',
  stop_to_entry: 'moveStop', step_away: 'stepAway', close_all: 'closeAll', sample: 'notPaired',
}
const clean = (line: string) => line.trim().replace(/\.+$/, '').replace(/\bcanceled\b/gi, word => word[0] === 'C' ? 'Cancelled' : 'cancelled')
function marketIcon(market: Pick<Instrument, 'kind' | 'symbol'>) {
  if (market.kind === 'outcome') return /\bno$/i.test(market.symbol) ? outcomes.no : /\byes$/i.test(market.symbol) ? outcomes.yes : undefined
  return coinIcon(ticker(market.symbol))
}
function cardPage(card: Card, cards: Card[], market?: Instrument): View {
  const group = groups[card.kind], peers = cards.filter(c => groups[c.kind] === group)
  const mark = marks[card.kind]
  const position = peers.findIndex(c => c.id === card.id)
  const single = card.symbol && (card.kind === 'position' || card.kind === 'watch')
  const side = card.action?.type === 'open_market' && card.action.instrumentId.startsWith('#')
  return {
    line1: clean(card.line1), line2: clean(card.line2), detail: card.detail && clean(card.detail),
    frame: group === 'Needs you', footLeft: group,
    footRight: group && card.kind !== 'sample' && position >= 0 ? `${position + 1}/${peers.length}` : '',
    icon: mark ? actionIcon(mark) : single ? marketIcon(market ?? { symbol: card.symbol!, kind: side ? 'outcome' : 'spot' }) : undefined,
  }
}
function bar(fraction: number, steps = 12) {
  const n = Math.floor(Math.min(1, Math.max(0, fraction)) * steps)
  return '━'.repeat(n) + '─'.repeat(steps - n)
}
// The hour's change in words. The graph itself is a drawn line (chart.ts), not text.
function trend(change?: number) {
  if (change === undefined || !Number.isFinite(change)) return ''
  // percent() is for whole-percent gauges; the hour change retains one decimal point.
  const tenths = Math.round(change * 1000)
  return (tenths > 0 ? '+' : '') + price(tenths / 10) + '% 1h'
}
// Where a price sits on a market's graph scale, 0 (bottom) to 1 (top).
function onScale(value: string | undefined, low?: string, high?: string) {
  const v = Number(value), a = Number(low), b = Number(high)
  return b > a && Number.isFinite(v) ? (v - a) / (b - a) : undefined
}
// Each bar glyph is 20 px wide. Beside a graph the column is 232 px, so the gauge gets five steps
// and its words go on a second line; on a full-width line it gets eleven.
function stopGauge(share: number, narrow = false) {
  const steps = narrow ? 5 : 11
  const at = Math.round(Math.min(1, Math.max(0, share)) * steps)
  const gauge = '━'.repeat(at) + '●' + '─'.repeat(steps - at)
  return narrow ? gauge + '\nStop to target' : 'Stop ' + gauge + ' Target'
}
function liquidationGauge(card: Card, account?: Account) {
  const id = card.action && 'instrumentId' in card.action ? card.action.instrumentId : undefined
  const position = account?.positions.find(p => p.instrumentId === id)
  const mark = Number(position?.markPx), liquidation = Number(position?.liqPx)
  if (mark > 0 && liquidation > 0) {
    const distance = Math.abs(mark - liquidation) / mark
    return bar(distance) + ' ' + percent(distance) + ' from liquidation'
  }
  // Card.buffer is normalized between entry and liquidation, not a relative price change.
  return bar(card.buffer!) + ' ' + percent(card.buffer!) + ' of buffer left'
}
function odds(m: Instrument) {
  if (m.kind !== 'outcome' || m.mid === null) return ''
  const side = /\b(yes|no)\b/i.exec(m.symbol)?.[1]?.toLowerCase()
  if (!side) return ''
  const yes = Math.min(1, Math.max(0, side === 'no' ? 1 - Number(m.mid) : Number(m.mid)))
  if (!Number.isFinite(yes)) return ''
  const lit = Math.round(yes * 10)
  return 'Yes ' + percent(yes) + ' ' + '█'.repeat(lit) + ' '.repeat(10 - lit) + ' No ' + percent(1 - yes)
}

function hold(start: number, now: number) { return bar((now - start) / HOLD_MS) + ' hold' }
function marketRows(m: Instrument, account?: Account): Row[] {
  const id = m.id, perp = m.kind === 'perp'
  const rows: Row[] = [
    { label: perp ? 'Long' : 'Buy', choice: { kind: 'quote', intent: { instrumentId: id, side: 'buy' } } },
    { label: perp ? 'Short' : 'Sell', choice: { kind: 'quote', intent: { instrumentId: id, side: 'sell' } } },
  ]
  if (account?.positions.some(p => p.instrumentId === id && Number(p.size) !== 0)) rows.push({ label: 'Close position', choice: { kind: 'close', id } })
  if (account?.openOrders.some(o => o.instrumentId === id)) rows.push({ label: 'Cancel orders', choice: { kind: 'cancel', id } })
  return rows
}
// The large number is only ever a copy of a number already in the card's text, never a new one.
function big(value: string | undefined, text: string, id: string) {
  return value && text.split(/\s+/).includes(value) ? bigNumber(value, id) : undefined
}
function brackets(t: Ticket) {
  return [t.stopPx && 'Stop ' + exact(t.stopPx), t.targetPx && (t.stopPx ? 'target ' : 'Target ') + exact(t.targetPx)].filter(Boolean).join(' · ')
}
function ticketPage(t: Ticket, heard: string | undefined, now: number, latest = t.instrument): View {
  const warnings = t.warnings.map(clean).filter(Boolean).join(' · '), levels = brackets(t)
  const spoken = heard && 'Heard: ' + clean(heard)
  const crowded = warnings && levels
  // The fill estimate moves with the live book: by as much as the best price has moved since pricing.
  // Size, stop, target and limit stay as priced, so a tap still sends what was priced.
  const best = t.side === 'buy' ? 'ask' : 'bid', then = Number(t.instrument[best]), current = Number(latest[best])
  const estimate = then && current ? Number(t.estPx) + current - then : t.estPx
  return { icon: marketIcon(t.instrument), line1: clean(t.summary) + (t.assumed ? ' (' + clean(t.assumed) + ')' : ''),
    big: big(/\$[\d,.]+/.exec(t.summary)?.[0], t.summary, 'ticket:' + t.instrument.id),
    line2: 'at about ' + price(estimate), detail: [warnings, levels, !crowded && spoken].filter(Boolean).join('\n'),
    footLeft: crowded && spoken ? spoken : 'Tap to send · swipe to resize', footRight: secondsLeft(t, now) + 's' }
}
export function render(screen: Screen, data: Data, now: number): View {
  switch (screen.view) {
    case 'loading': return { line1: screen.text }
    case 'error': {
      const [reason, instruction] = screen.text.split('\n')
      return { line1: clean(reason || "Can't reach the server"), line2: instruction ? clean(instruction) : 'Tap to retry' }
    }
    case 'pair': return { icon: actionIcon('notPaired'), line1: 'Pair your wallet', line2: 'Code ' + screen.pair.code, detail: 'Finish on your phone' }
    case 'home': {
      const card = screen.cards.find(c => c.id === screen.activeId)
      if (!card) return { line1: 'Nothing open', line2: 'Hold to speak a trade' }
      const market = card.action?.type === 'open_market' ? data.markets.get(card.action.instrumentId) : undefined
      const view = cardPage(card, screen.cards, market)
      if (card.kind === 'watch' && market?.kind === 'outcome') {
        view.line1 = ticker(market.symbol) + ' ' + price(market.mid)
        view.detail = [odds(market), `Bid ${price(market.bid)} · ask ${price(market.ask)}`].filter(Boolean).join('\n')
      }
      // Stop cards: the stop price the tap will set.
      if (card.action?.type === 'add_stop' || card.action?.type === 'move_stop') view.big = big(exact(card.action.triggerPx), view.line2!, card.kind + ':' + card.action.instrumentId)
      // Market cards: the price. Position and close-all cards: profit or loss. Each ends the first line.
      if (card.kind === 'watch' || card.kind === 'position' || card.kind === 'close_all') view.big = big(/\S+$/.exec(view.line1)?.[0], view.line1, card.id)
      const history = trend(card.change1h)
      if ((card.kind === 'watch' || card.kind === 'position') && card.trend && market?.kind !== 'outcome') {
        const marketId = card.action?.type === 'open_market' ? card.action.instrumentId : card.id
        const held = card.kind === 'position' ? data.account?.positions.find(p => p.instrumentId === marketId) : undefined
        view.chart = priceChart(marketId, card.trend, onScale(held?.entryPx, card.trendLow, card.trendHigh))
      }
      // The hour's change belongs to market and position cards. An urgent card's first line is its fact.
      if (history && (card.kind === 'watch' || card.kind === 'position')) view.line1 += '  ' + history
      if (card.kind === 'position' && card.toTarget !== undefined) view.detail = stopGauge(card.toTarget, !!view.chart && !view.big)
      // The liquidation bar appears only on the card that is about liquidation. Elsewhere it is noise.
      if (card.kind === 'thin_buffer' && card.buffer !== undefined) view.detail = [liquidationGauge(card, data.account), view.detail].filter(Boolean).join('\n')
      // Near liquidation: how far away it is.
      if (card.kind === 'thin_buffer') view.big = big(/\d+%/.exec(view.detail ?? '')?.[0], view.detail ?? '', card.id)
      if (screen.heldAt !== undefined) view.detail = hold(screen.heldAt, now)
      if (screen.hint || !data.live) view.footLeft = screen.hint || 'Offline · retrying'
      return view
    }
    case 'cancel': return { icon: marketIcon(screen.market), line1: 'Open orders on ' + ticker(screen.market.symbol), line2: 'Hold to cancel orders',
      detail: screen.heldAt !== undefined ? hold(screen.heldAt, now) : '', footLeft: screen.hint }
    case 'acting': return { ...(screen.card && cardPage(screen.card, screen.back.view === 'home' ? screen.back.cards : [])),
      line1: screen.line1, line2: screen.line2, ...(screen.held && { detail: bar(1) + ' sending' }) }
    case 'market': {
      const m = data.markets.get(screen.market.id) ?? screen.market
      const p = data.account?.positions.find(position => position.instrumentId === m.id && Number(position.size) !== 0)
      const rows = marketRows(m, data.account)
      const name = ticker(m.symbol) + ' ' + price(m.mid)
      const history = trend(m.change1h)
      const holding = p ? `${p.kind === 'perp' ? Number(p.size) < 0 ? 'Short' : 'Long' : 'Holding'} ${exact(p.size.replace(/^-/, ''))} · ${pnl(p.pnlUsd)}` : ''
      // A long header uses the full-width detail line for history; the picture is optional.
      return { icon: marketIcon(m), chart: m.kind !== 'outcome' ? priceChart(m.id, m.trend, onScale(p?.entryPx, m.trendLow, m.trendHigh)) : undefined,
        line1: [name, history].filter(Boolean).join('  '), line2: `Bid ${price(m.bid)} · ask ${price(m.ask)}`,
        detail: [odds(m), holding].filter(Boolean).join('\n'),
        rows, items: rows.map(row => row.label) }
    }
    case 'choices': {
      const first = Math.min(screen.focus, Math.max(0, screen.choices.length - 2))
      const choice = (index: number) => screen.choices[index] ? (index === screen.focus ? '▶ ' : '   ') + screen.choices[index]!.label : ''
      return { line1: clean(screen.reply), line2: choice(first), detail: choice(first + 1), footLeft: 'Swipe to choose · tap to pick' }
    }
    case 'confirm': return ticketPage(screen.ticket, screen.heard, now, data.markets.get(screen.ticket.instrument.id) ?? screen.ticket.instrument)
    case 'expired': return { icon: marketIcon(screen.previous.ticket.instrument), line1: 'Price expired', line2: 'Tap for a fresh price', footRight: '0s' }
    case 'result': {
      const { ticket: t, result: r } = screen
      const icon = marketIcon(t.instrument)
      if (r.status === 'rejected') {
        const reason = clean(r.message || 'The venue rejected the order')
        const split = reason.length > 42 ? reason.lastIndexOf(' ', 42) : -1
        return { line1: 'Not sent', line2: split > 0 ? reason.slice(0, split) : reason,
          detail: split > 0 ? reason.slice(split + 1) : '', footLeft: 'Tap to go back' }
      }
      const status = { filled: 'filled', partial: 'partly filled', resting: 'resting' }[r.status]
      const summary = clean(t.summary).replace(/ · \d+(?:\.\d+)?x$/, '')
      const levels = brackets(t), message = clean(r.message || '')
      const fill = status + (r.avgPx && r.status !== 'resting' ? ' at ' + price(r.avgPx) : '')
      const detail = levels && /^(?:stop and target|brackets?) (?:set|placed)$/i.test(message) ? levels + ' set' : message
      if ((summary + fill).length > 47) return { icon, line1: summary,
        line2: fill[0]!.toUpperCase() + fill.slice(1), detail }
      return { icon, line1: summary + ' ' + fill, line2: detail }
    }
    case 'voice': return { icon: actionIcon('voice'), line1: 'Listening', line2: 'Say: long BTC · close ETH', detail: bar(data.micLevel ?? 0) + ' mic level', footLeft: 'Release to send' }
    case 'reply': {
      const card = screen.card
      const receipt = card && cardPage(card, screen.back?.view === 'home' ? screen.back.cards : [])
      if (receipt && screen.refreshStack && screen.back && !screen.failure) {
        if (card?.action?.type === 'add_stop' || card?.action?.type === 'move_stop') receipt.icon = actionIcon('protected')
        if (card?.action?.type === 'reduce') receipt.icon = card.symbol ? coinIcon(card.symbol) : undefined
      }
      return { ...receipt, line1: clean(screen.text), footLeft: screen.failure ? 'Tap to go back' : '',
        line2: '', detail: '', footRight: '' }
    }
  }
}
