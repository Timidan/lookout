import { strict as assert } from 'node:assert'
import test from 'node:test'
import type { Instrument } from '../shared/api.js'
import { numberChoices, parseCommand, searchMarkets } from './commands.js'
import { quoteOrder } from './pricing.js'

const btc: Instrument = { id: 'BTC', symbol: 'BTC', title: 'Bitcoin perp', kind: 'perp', bid: null, ask: null, mid: null, szDecimals: 5, maxLeverage: 40 }
const spot: Instrument = { ...btc, id: 'PURR/USDC', symbol: 'PURR', title: 'PURR/USDC', kind: 'spot', szDecimals: 0, maxLeverage: undefined }
const eth: Instrument = { ...btc, id: 'ETH', symbol: 'ETH', title: 'Ethereum perp' }
const yes: Instrument = { ...spot, id: '#273150', symbol: 'BAL v HOU Yes', title: 'Baltimore Ravens Yes', kind: 'outcome' }
const no: Instrument = { ...yes, id: '#273151', symbol: 'BAL v HOU No', title: 'Baltimore Ravens No' }
const list = [btc, spot, eth, yes, no]

test('commands resolve the brief examples and ask which market on a tie', () => {
  assert.deepEqual(parseCommand('buy 50 dollars of purr', list), { type: 'order', intent: { instrumentId: spot.id, side: 'buy', usd: '50' } })
  assert.deepEqual(parseCommand('long bitcoin 100 dollars 5x', list), { type: 'order', intent: { instrumentId: btc.id, side: 'buy', usd: '100', leverage: 5 } })
  assert.deepEqual(parseCommand('long btc stop 59,800 target 65,000', list), { type: 'order', intent: { instrumentId: 'BTC', side: 'buy', stopPx: '59800', targetPx: '65000' } })
  assert.deepEqual(parseCommand('buy purr', [...list, { ...btc, id: 'PURR', symbol: 'PURR' }]), { type: 'order', intent: { instrumentId: spot.id, side: 'buy' } })
  assert.deepEqual(parseCommand('short eth 0.05', list), { type: 'order', intent: { instrumentId: eth.id, side: 'sell', size: '0.05' } })
  assert.deepEqual(parseCommand('close half my btc', list), { type: 'close', instrumentId: btc.id, fraction: 0.5 })
  assert.deepEqual(parseCommand('close eth', list), { type: 'close', instrumentId: eth.id, fraction: 1 })
  assert.deepEqual(parseCommand('yes on ravens 20 shares', list), { type: 'order', intent: { instrumentId: yes.id, side: 'buy', size: '20' } })
  assert.deepEqual(parseCommand('cancel my btc orders', list), { type: 'cancel', instrumentId: btc.id })
  const teamBook = [
    { ...yes, outcomeSide: 0 as const, searchText: 'Baltimore Ravens Houston Texans', yesFor: 'Ravens BAL', noFor: 'Texans HOU' },
    { ...no, outcomeSide: 1 as const, searchText: 'Baltimore Ravens Houston Texans', yesFor: 'Texans HOU', noFor: 'Ravens BAL' },
  ]
  assert.deepEqual(parseCommand('no on ravens 20 shares', teamBook), { type: 'order', intent: { instrumentId: no.id, side: 'buy', size: '20' } })
  assert.deepEqual(parseCommand('yes on texans 20 shares', teamBook), { type: 'order', intent: { instrumentId: no.id, side: 'buy', size: '20' } })
  assert.equal(parseCommand('buy ravens 20 shares', list).type, 'reply')
  assert.equal(parseCommand('maybe buy something', list).type, 'reply')
  assert.deepEqual(searchMarkets('b t c', list), [btc])
})

test('voice checks teen/tens pairs only for the spoken quantity', () => {
  const cmd = parseCommand('long btc fifteen dollars 5x stop sixty thousand', list)
  assert.equal(cmd.type, 'order')
  if (cmd.type !== 'order') return
  assert.deepEqual(numberChoices(cmd.intent), {
    reply: '$15 or $50?',
    choices: ['15', '50'].map(usd => ({ label: '$' + usd, intent: { instrumentId: 'BTC', side: 'buy', usd, leverage: 5, stopPx: '60000' } })),
  })
  assert.equal(numberChoices({ instrumentId: 'BTC', side: 'buy', leverage: 15, targetPx: '50' }), undefined)
})

// First two levels from testnet l2Book BTC, at 1795391357842 ms.
const snapshot: Parameters<typeof quoteOrder>[1] = { levels: [
  [{ px: '61114.0', sz: '0.00163' }, { px: '61101.0', sz: '0.0075' }],
  [{ px: '61160.0', sz: '0.001' }, { px: '61179.0', sz: '0.0049' }],
] }

test('pricing uses live depth, floors size, respects directional ticks and caps', () => {
  const buy = quoteOrder(btc, snapshot, { instrumentId: 'BTC', side: 'buy', usd: '150', leverage: 5 }, '200', 100)
  assert.equal(buy.px, '61771')
  assert.equal(buy.size, '0.00242')
  assert.ok(Number(buy.estPx) > 61160 && Number(buy.estPx) < 61179)
  assert.ok(Number(buy.size) * Number(buy.px) <= 150)
  assert.deepEqual(buy.warnings, [])
  assert.ok(Number(buy.stopPx) < Number(buy.estPx) && Number(buy.targetPx) > Number(buy.estPx))
  assert.equal(quoteOrder(btc, snapshot, {instrumentId: 'BTC', side: 'buy'}, '200', 100).assumed, 'default size')
  assert.equal(quoteOrder(btc, snapshot, {instrumentId: 'BTC', side: 'sell', size: '0.05', reduceOnly: true}, '200', 100).stopPx, undefined)
  assert.throws(() => quoteOrder(btc, snapshot, {instrumentId: 'BTC', side: 'buy', stopPx: '65000'}, '200', 100), /stop/)
  const sell = quoteOrder(btc, snapshot, { instrumentId: 'BTC', side: 'sell', size: '0.001639999' }, '200', 100)
  assert.equal(sell.px, '60503')
  assert.equal(sell.size, '0.00163')
  assert.equal(sell.estPx, '61114')
  assert.throws(() => quoteOrder(btc, snapshot, { instrumentId: 'BTC', side: 'sell', size: '0.00328' }, '200', 100), /cap/)

  // Testnet #272670 returned 20 contracts at 0.49 bid / 0.51 ask.
  const outcomeBook: typeof snapshot = { levels: [[{ px: '0.49', sz: '20.0' }], [{ px: '0.51', sz: '20.0' }]] }
  const partial = quoteOrder(yes, outcomeBook, { instrumentId: yes.id, side: 'buy', size: '25.9' }, '200', 100)
  assert.equal(partial.size, '25')
  assert.equal(partial.px, '0.5151')
  assert.ok(partial.warnings[0].includes('80%'))
  const resting = quoteOrder(yes, outcomeBook, { instrumentId: yes.id, side: 'buy', size: '20', limitPx: '0.4987654' }, '200', 100)
  assert.equal(resting.px, '0.49876')
  assert.ok(resting.warnings[0].includes('rest'))
})
