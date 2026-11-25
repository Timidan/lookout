import assert from 'node:assert/strict'
import test from 'node:test'
import { bitmap, coinIcon, monogram, storeIcons, validStoreIcon } from './icons'

test('reject malformed source pixels and resolve prefixed or quoted symbols', () => {
  const rows = Array<string>(24).fill('.'.repeat(24))
  assert.throws(() => bitmap([...rows.slice(1), '.'.repeat(23)].join('\n')), /24 columns/)
  assert.throws(() => bitmap([...rows.slice(1), '.'.repeat(23) + 'x'].join('\n')), /Invalid pixel/)
  assert.deepEqual(coinIcon('xyz:NVDA'), monogram('NVDA'))
  assert.strictEqual(coinIcon('PURR/USDC'), coinIcon('PURR'))
  assert.notDeepEqual(coinIcon('PURR'), monogram('PURR'))
})

test('store art covers every lit pixel with a 2 × 2 block at any grid offset', () => {
  for (const icon of Object.values(storeIcons)) assert.ok(validStoreIcon(icon))
  const rows = Array<string>(24).fill('.'.repeat(24))
  rows[1] = rows[2] = '.##'.padEnd(24, '.')
  assert.ok(validStoreIcon(bitmap(rows.join('\n'))))
  rows[1] = '.###'.padEnd(24, '.')
  assert.equal(validStoreIcon(bitmap(rows.join('\n'))), false)
})
