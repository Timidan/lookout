// One number format for everything the glasses show. Used by the backend (card text)
// and the client (tickets, markets), so a price never looks two ways.

function group(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

/** A price: thousands separators, and only as many decimals as the size of the number needs. */
export function price(value: string | number | null | undefined): string {
  const n = Number(value)
  if (value === null || value === undefined || value === '' || !Number.isFinite(n)) return '–'
  const abs = Math.abs(n)
  // ponytail: fixed bands, not the venue's tick size. Switch to per-market ticks if a price looks wrong.
  const decimals = abs >= 1000 ? 0 : abs >= 100 ? 1 : abs >= 1 ? 2 : abs >= 0.01 ? 4 : 6
  const [whole, frac = ''] = abs.toFixed(decimals).split('.')
  const trimmed = frac.replace(/0+$/, '')
  return (n < 0 ? '-' : '') + group(whole) + (trimmed ? '.' + trimmed : '')
}

/**
 * A price an order will actually use (a stop, a target, a limit): every digit the venue gave,
 * with separators. Use this wherever the number is a promise, and `price` where it is a reading.
 */
export function exact(value: string | number): string {
  const [whole, frac = ''] = String(value).replace(/^-/, '').split('.')
  const trimmed = frac.replace(/0+$/, '')
  return (String(value).startsWith('-') ? '-' : '') + group(whole) + (trimmed ? '.' + trimmed : '')
}

/** Dollars: "$15", "$1,240", "$12.10". Cents only below $100. */
export function usd(value: string | number): string {
  const n = Math.abs(Number(value))
  if (!Number.isFinite(n)) return '$–'
  const [whole, frac] = (n < 100 && !Number.isInteger(n) ? n.toFixed(2) : Math.round(n).toString()).split('.')
  return '$' + group(whole) + (frac ? '.' + frac : '')
}

/** Profit or loss, always signed: "+$41", "-$12.10". */
export function pnl(value: string | number): string {
  return (Number(value) < 0 ? '-' : '+') + usd(value)
}

/** A whole percentage from a 0–1 share: 0.14 -> "14%". */
export function percent(share: number): string {
  return Math.round(Math.max(0, share) * 100) + '%'
}

/** The name a trader says: no venue prefix, no quote currency. "xyz:NVDA" -> "NVDA", "PURR/USDC" -> "PURR". */
export function ticker(symbolOrId: string): string {
  return symbolOrId.replace(/^[a-z0-9]+:/i, '').replace(/\/[A-Z0-9]+$/, '')
}
