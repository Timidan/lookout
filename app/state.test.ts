import assert from 'node:assert/strict'
import test from 'node:test'
import type { Card, Instrument, Ticket } from '../shared/api'
import { HOLD_MS, home, secondsLeft, transition, type Screen } from './state'

const market: Instrument = { id: 'BTC', kind: 'perp', symbol: 'BTC', title: 'Bitcoin', bid: '99', ask: '100', mid: '99.5', szDecimals: 5 }
const ticket: Ticket = { id: 't1', expiresAt: 31000, instrument: market, side: 'buy', size: '0.3',
  px: '101', estPx: '100', notionalUsd: '30', reduceOnly: false, stopPx: '95', targetPx: '110', summary: 'Long BTC $30', warnings: [] }
const watch: Card = { id: 'watch:BTC', kind: 'watch', line1: 'BTC 99.5', line2: 'Tap to trade BTC',
  action: { type: 'open_market', instrumentId: 'BTC' }, confirm: 'tap' }
const reduce: Card = { id: 'reduce:BTC', kind: 'thin_buffer', line1: 'BTC is near liquidation', line2: 'Hold to reduce by half',
  action: { type: 'reduce', instrumentId: 'BTC', fraction: 0.5 }, confirm: 'hold' }

test('open a watch card, price a trade, resize and confirm the displayed ticket once', () => {
  const opened = transition(home([watch]), { type: 'input', gesture: 'click' }, 1000)
  assert.deepEqual(opened.effect, { kind: 'market', id: 'BTC' })
  const marketScreen = transition(opened.screen, { type: 'opened', market }, 1000).screen
  const quote = { kind: 'quote', intent: { instrumentId: 'BTC', side: 'buy' } } as const
  const pricing = transition(marketScreen, { type: 'input', gesture: 'click', choice: quote }, 1000)
  assert.deepEqual(pricing.effect, quote)
  const priced = transition(pricing.screen, { type: 'priced', ticket }, 1000)
  assert.equal(priced.screen.view, 'confirm')
  const resize = transition(priced.screen, { type: 'input', gesture: 'down' }, 1500)
  assert.deepEqual(resize.effect, { kind: 'quote', intent: { ...quote.intent, usd: '20', stopPx: '95', targetPx: '110' } })
  const revised = { ...ticket, id: 't2', size: '0.2', notionalUsd: '20' }
  const displayed = transition(resize.screen, { type: 'priced', ticket: revised }, 1800).screen
  const sending = transition(displayed, { type: 'input', gesture: 'click' }, 2000)
  assert.deepEqual(sending.effect, { kind: 'confirm', ticket: revised })
  assert.equal(transition(sending.screen, { type: 'input', gesture: 'click' }, 2001).effect, undefined)
  const result = { status: 'filled', filledSize: '0.2', avgPx: '100' } as const
  const settled = transition(sending.screen, { type: 'settled', result }, 2100)
  assert.deepEqual(settled.screen, { view: 'result', result, ticket: revised })
  assert.deepEqual(transition(settled.screen, { type: 'input', gesture: 'down', cards: [watch] }, 2200).screen, home([watch]))
})

test('countdown reaches zero and a tap then fetches a fresh price without confirming the expired ticket', () => {
  const screen: Screen = { view: 'confirm', ticket }
  const expired = { screen: { view: 'expired' as const, previous: screen } }
  assert.equal(secondsLeft(ticket, ticket.expiresAt - 1001), 2)
  assert.equal(secondsLeft(ticket, ticket.expiresAt - 1), 1)
  assert.equal(secondsLeft(ticket, ticket.expiresAt), 0)
  const fresh = transition(expired.screen, { type: 'input', gesture: 'click' }, ticket.expiresAt + 1)
  assert.equal(fresh.effect?.kind, 'quote')
  if (fresh.effect?.kind === 'quote') assert.equal(fresh.effect.intent.size, ticket.size)
  assert.deepEqual(transition(screen, { type: 'clock' }, ticket.expiresAt), expired)
  assert.deepEqual(transition(screen, { type: 'input', gesture: 'click' }, ticket.expiresAt), expired)
})

test('early release cancels a hold and a full hold acts exactly once', () => {
  const start = home([reduce])
  const holding = transition(start, { type: 'input', gesture: 'hold' }, 0).screen
  const early = transition(holding, { type: 'input', gesture: 'release' }, HOLD_MS - 1)
  assert.equal(early.screen.view === 'home' && early.screen.hint, 'Cancelled, nothing sent')
  assert.equal(early.effect, undefined)
  assert.equal(transition(early.screen, { type: 'clock' }, HOLD_MS).effect, undefined)
  const second = transition(early.screen, { type: 'input', gesture: 'hold' }, 3000).screen
  const full = transition(second, { type: 'clock' }, 3000 + HOLD_MS)
  assert.deepEqual(full.effect, { kind: 'act', id: reduce.id })
  assert.equal(full.screen.view, 'acting')
  assert.equal(transition(full.screen, { type: 'input', gesture: 'release' }, 5100).effect, undefined)
  assert.equal(transition(full.screen, { type: 'clock' }, 5200).effect, undefined)
})

test('stream reranking keeps the visible card by id and removing it selects the new top', () => {
  const selected = transition(home([watch, reduce]), { type: 'input', gesture: 'down' }, 0).screen
  const held = transition(selected, { type: 'input', gesture: 'hold' }, 10).screen
  const ranked = transition(held, { type: 'next', cards: [reduce, watch] }, 1000).screen
  assert.equal(ranked.view === 'home' && ranked.activeId, reduce.id)
  assert.equal(ranked.view === 'home' && ranked.heldAt, 10)
  const removed = transition(ranked, { type: 'next', cards: [watch] }, 1500).screen
  assert.deepEqual(removed, home([watch]))
  assert.equal(transition(removed, { type: 'input', gesture: 'release' }, 2200).effect, undefined)
})

test('a rejected order and a failed card action stay until tapped', () => {
  const rejected: Screen = { view: 'result', ticket, result: { status: 'rejected', filledSize: '0', message: 'Insufficient collateral' } }
  const failed: Screen = { view: 'reply', text: 'Stop price moved', failure: true, back: home([watch]) }
  for (const failure of [rejected, failed]) {
    assert.equal(transition(failure, { type: 'clock' }, 10000).screen, failure)
    for (const gesture of ['up', 'down', 'back', 'hold', 'release'] as const)
      assert.equal(transition(failure, { type: 'input', gesture }, 10000).screen, failure)
    assert.deepEqual(transition(failure, { type: 'input', gesture: 'click', cards: [watch] }, 10000).screen, home([watch]))
  }
})
