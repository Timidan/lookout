// The last hour as a line graph: twelve five-minute closes, each 0 (bottom of the scale) to 1 (top),
// drawn as a 2 px line into a 240 x 64 picture at 4 bits per pixel, the format the glasses take.
// `level` is an optional price mark on the same scale (the wearer's entry), drawn as a dim dashed
// line so it never competes with the price. The display has 16 levels; the price is drawn at 15.
import { glyphs } from './digits'

const PRICE = 15, ENTRY = 2
export type Chart = { key: string; id: string; pixels: Uint8Array }
export const CHART_WIDTH = 240, CHART_HEIGHT = 64, NUMBER_WIDTH = 240, NUMBER_HEIGHT = 60
let previous: Chart | undefined

// The brighter of two overlapping marks wins, so a line stays whole where it crosses another.
function plotter(pixels: Uint8Array, width: number, height: number) {
  return (x: number, y: number, level = PRICE) => {
    if (x < 0 || x >= width || y < 0 || y >= height) return
    const i = y * (width / 2) + (x >> 1), shift = x % 2 ? 0 : 4
    if (((pixels[i]! >> shift) & 0x0f) < level) pixels[i] = (pixels[i]! & ~(0x0f << shift)) | (level << shift)
  }
}

// The one number a card is about, about three times the height of the glasses' text.
// `id` names the card it belongs to. Undefined when a character has no glyph or it is too wide.
export function bigNumber(text: string, id: string): Chart | undefined {
  const pixels = new Uint8Array(NUMBER_WIDTH * NUMBER_HEIGHT / 2)
  const plot = plotter(pixels, NUMBER_WIDTH, NUMBER_HEIGHT)
  let pen = 0
  for (const ch of text) {
    const glyph = glyphs[ch]
    if (!glyph) return
    const [advance, x0, y0, w, hex] = glyph
    if (pen + x0 + w > NUMBER_WIDTH) return
    for (let i = 0; i < hex.length; i++) plot(pen + x0 + i % w, y0 + Math.floor(i / w), parseInt(hex[i]!, 16))
    pen += advance
  }
  return { key: id + ':' + text, id, pixels }
}

export function priceChart(id: string, trend?: number[], level?: number): Chart | undefined {
  if (!trend || trend.length < 2 || trend.some(v => !Number.isFinite(v))) return
  const mark = level !== undefined && level >= 0 && level <= 1 ? level : undefined
  const key = id + ':' + trend.join(',') + ':' + (mark ?? '')
  if (previous?.key === key) return previous
  const width = CHART_WIDTH, height = CHART_HEIGHT
  const pixels = new Uint8Array(width * height / 2)
  const plot = plotter(pixels, width, height)
  const top = (share: number) => Math.round((1 - Math.min(1, Math.max(0, share))) * (height - 2))
  if (mark !== undefined) for (let x = 0; x < width; x += 8) for (let d = 0; d < 4; d++) { plot(x + d, top(mark), ENTRY); plot(x + d, top(mark) + 1, ENTRY) }
  const last = trend.length - 1
  for (let i = 1; i <= last; i++) {
    const x0 = Math.round((i - 1) * (width - 2) / last), x1 = Math.round(i * (width - 2) / last)
    const y0 = top(trend[i - 1]!), y1 = top(trend[i]!)
    const steps = Math.max(1, x1 - x0, Math.abs(y1 - y0))
    for (let j = 0; j <= steps; j++) {
      const x = Math.round(x0 + (x1 - x0) * j / steps), y = Math.round(y0 + (y1 - y0) * j / steps)
      plot(x, y); plot(x + 1, y); plot(x, y + 1); plot(x + 1, y + 1)
    }
  }
  previous = { key, id, pixels }
  return previous
}
