import assert from 'node:assert/strict'
import test from 'node:test'
import type { Card } from '../shared/api'
import { bigNumber, CHART_HEIGHT, CHART_WIDTH, priceChart } from './chart'
import type { Screen } from './state'

test('a rising hour draws from bottom left to top right, and bad data draws nothing', () => {
  const lit = (pixels: Uint8Array, x: number, y: number) => (pixels[y * (CHART_WIDTH / 2) + (x >> 1)]! & (x % 2 ? 0x0f : 0xf0)) !== 0
  const chart = priceChart('BTC', [0, 0.25, 0.5, 0.75, 1])!
  assert.equal(chart.pixels.length, CHART_WIDTH * CHART_HEIGHT / 2)
  assert.ok(lit(chart.pixels, 0, CHART_HEIGHT - 2) && lit(chart.pixels, CHART_WIDTH - 2, 0))
  assert.ok(!lit(chart.pixels, 0, 0) && !lit(chart.pixels, CHART_WIDTH - 2, CHART_HEIGHT - 2))
  // The entry line is drawn dim (level 2) so the price line (level 15) stays the brightest thing.
  const level = (pixels: Uint8Array, x: number, y: number) => (pixels[y * (CHART_WIDTH / 2) + (x >> 1)]! >> (x % 2 ? 0 : 4)) & 0x0f
  const marked = priceChart('ETH', [1, 1, 1], 0.5)!
  assert.deepEqual([level(marked.pixels, 0, 31), level(marked.pixels, 0, 0)], [2, 15])
  assert.equal(priceChart('BTC', [0.5]), undefined)
  assert.equal(priceChart('BTC', [0, Number.NaN]), undefined)
})

test('the large number copies the stop price in the text, or is not drawn', async () => {
  const { render } = await import('./render')
  assert.ok(bigNumber('272.23', 'a') && bigNumber('$1,240', 'a'))
  assert.equal(bigNumber('1 2', 'a'), undefined)
  assert.equal(bigNumber('8'.repeat(12), 'a'), undefined)
  const card = (line2: string) => ({ id: 'no_stop:NVDA', kind: 'no_stop', line1: 'NVDA long 20x has no stop', line2,
    action: { type: 'add_stop', instrumentId: 'xyz:NVDA', triggerPx: '272.23' } }) as Card
  const view = (c: Card) => render({ view: 'home', cards: [c], activeId: c.id } as Screen, { markets: new Map(), live: true }, 0)
  assert.equal(view(card('Tap to set stop at 272.23')).big?.key, 'no_stop:xyz:NVDA:272.23')
  assert.equal(view(card('Tap to set stop at 272.2')).big, undefined)
})
