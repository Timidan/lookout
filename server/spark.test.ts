import assert from 'node:assert/strict'
import test from 'node:test'
import { liveHistory, recordTick, sparkline, withLive } from './venue.js'

test('a market graph follows the last 90 seconds of live ticks', () => {
  const now = Date.now()
  for (const [s, px] of [[120, 90], [60, 100], [40, 102], [20, 101], [0, 104]] as const) recordTick('TEST', now - s * 1000, px, false)
  const live = liveHistory('TEST', {}, '104', 5)
  // The tick from 120 s ago has left the window; the graph starts at the oldest tick inside it.
  assert.deepEqual(live.trend, [0, 0, 0.5, 0.25, 1])
  assert.deepEqual([live.trendLow, live.trendHigh], ['100', '104'])
})

test('the graph ends on the live price, widening the scale when it leaves the range', () => {
  const hour = { trend: [0, 0.5, 1], trendLow: '100', trendHigh: '110' }
  assert.deepEqual(withLive(hour, '102').trend, [0, 0.5, 0.2])
  assert.deepEqual(withLive(hour, '120'), { trend: [0, 0.25, 1], trendLow: '100', trendHigh: '120' })
  assert.equal(withLive({}, '102').trend, undefined)
})

test('12 closes span the hour, with a centred minimum range for a quiet hour', () => {
  const bars = Array.from({length:12}, (_,i) => {
    const px = String(100+i)
    return {t:i*300_000, o:px, c:px, l:px, h:px}
  })
  const rising = sparkline(bars,0)
  assert.equal(rising.spark,'▁▂▂▃▄▄▅▅▆▇▇█')
  assert.equal(rising.change1h,0.11)
  // The line graph shares the text graph's scale: the low close sits at 0 and the high close at 1.
  assert.deepEqual([rising.trend?.[0], rising.trend?.[11], rising.trendLow, rising.trendHigh],[0,1,'100','111'])
  const quiet = bars.map((bar,i) => {
    const px = i % 2 ? '100' : '100.01'
    return {...bar,o:px,c:px,l:px,h:px}
  })
  assert.equal(sparkline(quiet,0).spark,'▅▄▅▄▅▄▅▄▅▄▅▄')
  assert.deepEqual(sparkline(bars.slice(1),0),{})
  assert.equal(sparkline([{...bars[0],t:-300_000},bars[11]],0).spark,'▁▁▁▁▁▁▁▁▁▁▁█')
})
