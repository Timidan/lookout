import assert from 'node:assert/strict'
import test from 'node:test'
import { sparkline } from './venue.js'

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
