import type { Card, Instrument, OrderIntent, OrderResult, PairStart, SayResult, Ticket } from '../shared/api'
import { ticker } from '../shared/format'
import type { Gesture } from './glasses'

export const HOLD_MS = 2000
export const secondsLeft = (ticket: Ticket, now: number) => Math.max(0, Math.ceil((ticket.expiresAt - now) / 1000))

type Hold = { heldAt?: number; hint?: string; hintUntil?: number }
type Home = { view: 'home'; cards: Card[]; activeId?: string } & Hold
type Cancel = { view: 'cancel'; market: Instrument } & Hold
type Choices = { view: 'choices'; reply: string; choices: NonNullable<SayResult['choices']>; focus: number; heard?: string; back?: Screen }
type QuoteContext = { intent?: OrderIntent; originalUsd?: string; back?: Screen; heard?: string; closeId?: string }
type Confirm = { view: 'confirm'; ticket: Ticket } & QuoteContext

export type Screen =
  | { view: 'loading'; text: string; pricing?: QuoteContext; sending?: Confirm; back?: Screen; pairing?: true }
  | { view: 'pair'; pair: PairStart }
  | Home | Cancel | Choices | Confirm
  | { view: 'market'; market: Instrument }
  | { view: 'acting'; line1: string; line2: string; card?: Card; back: Home | Cancel; held: boolean }
  | { view: 'result'; result: OrderResult; ticket: Ticket }
  | { view: 'voice'; back: Screen }
  | { view: 'expired'; previous: Confirm }
  | { view: 'reply'; text: string; card?: Card; back?: Screen; failure?: boolean; refreshStack?: boolean }
  | { view: 'error'; text: string }

export type Choice =
  | { kind: 'market'; id: string }
  | { kind: 'quote'; intent: OrderIntent }
  | { kind: 'close' | 'cancel'; id: string }

export type Effect = Choice | { kind: 'act'; id: string } | { kind: 'confirm'; ticket: Ticket }
  | { kind: 'record' | 'send' | 'retry' | 'exit' | 'pair' }
type Move = { screen: Screen; effect?: Effect }
type Conditions = { live?: boolean; sample?: boolean }
type Event =
  | ({ type: 'input'; gesture: Gesture; choice?: Choice; cards?: Card[]; homeId?: string } & Conditions)
  | { type: 'next'; cards: Card[] }
  | { type: 'voice'; answer: SayResult }
  | { type: 'opened'; market: Instrument }
  | { type: 'priced'; ticket: Ticket }
  | { type: 'settled'; result: OrderResult }
  | ({ type: 'clock' } & Conditions)

export function home(cards: Card[] = [], preferredId?: string): Home {
  const activeId = cards.find(card => card.id === preferredId)?.id ?? cards[0]?.id
  return { view: 'home', cards, activeId }
}

function goBack(previous: Screen | undefined, cards: Card[] | undefined, homeId: string | undefined, now: number): Screen {
  if (!previous || previous.view === 'home') return home(cards, previous?.activeId ?? homeId)
  if (previous.view === 'cancel') return { view: 'cancel', market: previous.market }
  if (previous.view === 'confirm' && !secondsLeft(previous.ticket, now)) return { view: 'expired', previous }
  return previous
}

export const loading = (text = 'Loading…'): Screen => ({ view: 'loading', text })

function quote(intent: OrderIntent, context: QuoteContext): Move {
  return { screen: { view: 'loading', text: 'Loading…', pricing: { ...context, intent } }, effect: { kind: 'quote', intent } }
}

function confirm(ticket: Ticket, now: number, context: QuoteContext = {}): Move {
  const previous: Confirm = { ...context, view: 'confirm', ticket, originalUsd: context.originalUsd ?? context.intent?.usd ?? ticket.notionalUsd }
  return { screen: secondsLeft(ticket, now) ? previous : { view: 'expired', previous } }
}

// For a voice ticket the contract omits the originating order type. Preserve the quoted price bound.
function ticketIntent(screen: Confirm): OrderIntent {
  const t = screen.ticket
  const intent = screen.intent ? { ...screen.intent } : {
    instrumentId: t.instrument.id, side: t.side, reduceOnly: t.reduceOnly, limitPx: t.px, size: t.size,
  } as OrderIntent
  if (t.leverage !== undefined) intent.leverage ??= t.leverage
  if (t.stopPx !== undefined) intent.stopPx ??= t.stopPx
  if (t.targetPx !== undefined) intent.targetPx ??= t.targetPx
  if (!screen.intent && t.instrument.kind === 'perp' && !t.reduceOnly && !t.stopPx && !t.targetPx) intent.bracket = false
  return intent
}

function resize(screen: Confirm, step: number): Move {
  const original = screen.originalUsd ?? screen.ticket.notionalUsd
  const amounts = ['20', '50', '100']
  const preset = amounts.findIndex(value => Number(value) === Number(original))
  if (preset < 0) amounts.push(original)
  else amounts[preset] = original
  const current = amounts.findIndex(value => Number(value) === Number(screen.intent?.usd ?? original))
  const intent = ticketIntent(screen)
  delete intent.size
  intent.usd = amounts[(current + amounts.length + step) % amounts.length]
  return quote(intent, { back: screen.back, heard: screen.heard, originalUsd: original })
}

// `browsing` covers looking at a market and pricing or resizing a ticket. The sample account may do
// those; it may never send. Nothing is allowed without live prices.
function checkTrade(back: Screen, conditions: Conditions, browsing = false): Move | undefined {
  const text = conditions.live === false ? 'Wait for live prices' : conditions.sample && !browsing ? 'Sample account. Pair to trade' : ''
  if (!text) return
  const card = back.view === 'home' ? back.cards.find(c => c.id === back.activeId) : undefined
  return { screen: { view: 'reply', text, card, back, failure: true } }
}

function act(screen: Home, card: Card, held: boolean): Move {
  const pending = { add_stop: 'Setting stop…', move_stop: 'Moving stop…', reduce: 'Reducing position…',
    cancel_entries: 'Cancelling orders…', close_all: 'Closing positions…', open_market: 'Opening market…', pair: 'Pairing…' }
  return {
    screen: { view: 'acting', line1: card.line1, line2: pending[card.action!.type], card, back: screen, held },
    effect: { kind: 'act', id: card.id },
  }
}

export function transition(screen: Screen, event: Event, now: number): Move {
  if (event.type === 'next') {
    if (screen.view !== 'home') return { screen }
    const present = event.cards.find(card => card.id === screen.activeId)
    if (!present) return { screen: home(event.cards) }
    return { screen: { ...screen, cards: event.cards, heldAt: present.confirm === 'hold' && present.action ? screen.heldAt : undefined } }
  }
  if (event.type === 'priced') {
    const context = screen.view === 'loading' ? screen.pricing : undefined
    if (context?.closeId) return confirm(event.ticket, now, { ...context,
      intent: { instrumentId: context.closeId, side: event.ticket.side, reduceOnly: true } })
    return confirm(event.ticket, now, context)
  }
  if (event.type === 'voice') {
    const { ticket, reply, choices, transcript: heard } = event.answer
    const back = screen.view === 'loading' ? screen.back : undefined
    if (choices?.length) return { screen: { view: 'choices', reply: reply || 'Which trade?', choices, focus: 0, heard, back } }
    if (ticket) return confirm(ticket, now, { back, heard })
    return { screen: { view: 'reply', text: reply || 'Hold to speak again', back } }
  }
  if (event.type === 'opened') return { screen: { view: 'market', market: event.market } }
  if (event.type === 'settled') {
    return screen.view === 'loading' && screen.sending
      ? { screen: { view: 'result', result: event.result, ticket: screen.sending.ticket } } : { screen }
  }
  if (screen.view === 'confirm' && !secondsLeft(screen.ticket, now)) return { screen: { view: 'expired', previous: screen } }
  if ((screen.view === 'home' || screen.view === 'cancel') && screen.heldAt !== undefined) {
    if (event.type === 'clock' || event.gesture === 'release') {
      if (now - screen.heldAt >= HOLD_MS) {
        const blocked = checkTrade(screen, event)
        if (blocked) return blocked
        if (screen.view === 'cancel') return { screen: { view: 'acting', line1: ticker(screen.market.symbol),
          line2: 'Cancelling orders…', back: screen, held: true }, effect: { kind: 'cancel', id: screen.market.id } }
        const card = screen.cards.find(c => c.id === screen.activeId)
        if (card?.action && card.confirm === 'hold') return act(screen, card, true)
        return { screen: { ...screen, heldAt: undefined } }
      }
      if (event.type === 'input') return { screen: { ...screen, heldAt: undefined, hint: 'Cancelled, nothing sent', hintUntil: now + 1000 } }
    }
    if (event.type !== 'input' || event.gesture !== 'back') return { screen }
  }
  if (event.type !== 'input') return { screen }
  const { gesture, choice, cards, homeId } = event
  const step = gesture === 'down' ? 1 : gesture === 'up' ? -1 : 0
  const back = (previous?: Screen): Move => ({ screen: goBack(previous, cards, homeId, now) })
  if ((screen.view === 'result' && screen.result.status === 'rejected') || (screen.view === 'reply' && screen.failure)) {
    return gesture === 'click' ? back(screen.view === 'reply' ? screen.back : undefined) : { screen }
  }
  if (gesture === 'hold' && ['market', 'confirm', 'choices', 'result', 'expired', 'reply'].includes(screen.view))
    return { screen: { view: 'voice', back: screen }, effect: { kind: 'record' } }

  switch (screen.view) {
    case 'result': case 'reply':
      return gesture === 'release' ? { screen } : back(screen.view === 'reply' ? screen.back : undefined)
    case 'expired': {
      const ticket = screen.previous
      if (gesture === 'back') return back(ticket.back)
      if (gesture !== 'click') break
      const blocked = checkTrade(screen, event, true)
      if (blocked) return blocked
      const context = { back: ticket.back, originalUsd: ticket.originalUsd, heard: ticket.heard }
      if (ticket.closeId) return { screen: { view: 'loading', text: 'Loading…', pricing: { ...context, closeId: ticket.closeId } },
        effect: { kind: 'close', id: ticket.closeId } }
      return quote(ticketIntent(ticket), context)
    }
    case 'pair':
      if (gesture === 'back' && event.sample) return back()
      break
    case 'loading':
      if (gesture === 'back' && !screen.sending && (screen.pricing || screen.back)) return back(screen.pricing?.back ?? screen.back)
      break
    case 'error':
      if (gesture === 'back' && cards?.length) return back()
      if (gesture === 'click') return { screen: loading(), effect: { kind: 'retry' } }
      break
    case 'voice':
      if (gesture === 'back') return back(screen.back)
      if (gesture === 'release') return { screen: { view: 'loading', text: 'Loading…', back: screen.back }, effect: { kind: 'send' } }
      break
    case 'choices':
      if (gesture === 'back') return back(screen.back)
      if (step) return { screen: { ...screen, focus: Math.max(0, Math.min(screen.choices.length - 1, screen.focus + step)) } }
      if (gesture === 'click') {
        const selected = screen.choices[screen.focus]
        if (selected) return checkTrade(screen, event, true) ?? quote(selected.intent, { back: screen, heard: screen.heard })
      }
      break
    case 'confirm':
      if (gesture === 'back') return back(screen.back)
      if (gesture === 'click') return checkTrade(screen, event) ?? {
        screen: { view: 'loading', text: 'Loading…', sending: screen }, effect: { kind: 'confirm', ticket: screen.ticket } }
      if (step) return checkTrade(screen, event, true) ?? resize(screen, step)
      break
    case 'cancel':
      if (gesture === 'back') return { screen: { view: 'market', market: screen.market } }
      if (gesture === 'click') return { screen: { ...screen, hint: 'Hold to confirm', hintUntil: now + 2000 } }
      if (gesture === 'hold') return checkTrade(screen, event) ?? { screen: { ...screen, heldAt: now, hint: undefined } }
      break
    case 'market': {
      if (gesture === 'back') return back()
      if (gesture !== 'click' || !choice) break
      const blocked = checkTrade(screen, event, choice.kind === 'quote')
      if (blocked) return blocked
      if (choice.kind === 'cancel') return { screen: { view: 'cancel', market: screen.market } }
      if (choice.kind === 'quote') return quote(choice.intent, { back: screen })
      if (choice.kind === 'close') return { screen: { view: 'loading', text: 'Loading…', pricing: { back: screen, closeId: choice.id } },
        effect: choice }
      break
    }
    case 'home': {
      if (gesture === 'back') return { screen: { ...screen, heldAt: undefined }, effect: { kind: 'exit' } }
      const index = screen.cards.findIndex(card => card.id === screen.activeId)
      const card = screen.cards[index]
      if (step && card) {
        const next = Math.max(0, Math.min(screen.cards.length - 1, index + step))
        return { screen: home(screen.cards, screen.cards[next]?.id) }
      }
      if (gesture === 'hold') {
        if (card?.action && card.confirm === 'hold') return checkTrade(screen, event) ?? { screen: { ...screen, heldAt: now, hint: undefined } }
        return { screen: { view: 'voice', back: screen }, effect: { kind: 'record' } }
      }
      if (gesture !== 'click' || !card?.action) break
      if (card.action.type === 'pair') return { screen, effect: { kind: 'pair' } }
      if (card.action.type === 'open_market') return checkTrade(screen, event, true) ??
        { screen: { view: 'loading', text: 'Loading…', back: screen }, effect: { kind: 'market', id: card.action.instrumentId } }
      const blocked = checkTrade(screen, event)
      if (blocked) return blocked
      if (card.confirm === 'hold') return { screen: { ...screen, hint: 'Hold to confirm', hintUntil: now + 2000 } }
      if (card.confirm === 'tap') return act(screen, card, false)
      break
    }
  }
  return { screen }
}
