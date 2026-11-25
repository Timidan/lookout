// Development only. Draw the exact 1-bit pixels used by the gallery at each integer scale.
import { execFileSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { actionIcon, actionLabel, actionNames, coinIcon, coinNames, isLit, monogram, outcomes, storeIcons, type Icon } from '../icons'

type Mark = { label: string; icon: Icon }
const sections: { title: string; marks: Mark[] }[] = [
  { title: 'Coin markets', marks: coinNames.map(name => ({ label: name, icon: coinIcon(name) })) },
  { title: 'Outcomes and actions', marks: [
    { label: 'Yes', icon: outcomes.yes }, { label: 'No', icon: outcomes.no },
    ...actionNames.map(name => ({ label: actionLabel(name), icon: actionIcon(name) })),
  ] },
  { title: 'Market badges', marks: ['NVDA', 'TSLA', 'GOLD', 'OIL'].map(name => ({ label: name, icon: monogram(name) })) },
  { title: 'Store candidates', marks: [
    { label: 'Shield and wedge (lead)', icon: storeIcons.shield },
    { label: 'Wedge over bar', icon: storeIcons.wedge },
    { label: 'Candlesticks', icon: storeIcons.candles },
  ] },
]

const width = 1248, nativeX = 60, detailX = 286, cell = 234, row = 180
const sectionHeight = (count: number) => 54 + Math.max(count * 44, Math.ceil(count / 4) * row)
const height = 120 + sections.reduce((h, section) => h + sectionHeight(section.marks.length), 0)
const rgb = Buffer.alloc(width * height * 3)
const text: string[] = []
function label(x: number, y: number, value: string, size = 15, color = '#dce9de') {
  text.push('-fill', color, '-pointsize', String(size), '-annotate', `+${x}+${y}`, value)
}
function stamp(icon: Icon, left: number, top: number, scale: number) {
  for (let y = 0; y < 24; y++) for (let x = 0; x < 24; x++) {
    if (!isLit(icon, x, y)) continue
    for (let dy = 0; dy < scale; dy++) for (let dx = 0; dx < scale; dx++) {
      rgb[((top + y * scale + dy) * width + left + x * scale + dx) * 3 + 1] = 255
    }
  }
}
label(30, 44, 'G2 trading icons', 32)
label(30, 80, '1×   24 px', 18)
label(detailX, 80, 'Detail views     2×   48 px       /       6×   144 px', 18)
let top = 94
for (const section of sections) {
  // Leave the first 132 pixels entirely black except for the native icon column.
  label(143, top + 28, section.title, 14, '#a5bda8')
  for (const [i, mark] of section.marks.entries()) {
    const y = top + 48 + i * 44
    stamp(mark.icon, nativeX, y, 1)
    label(143, y + 18, mark.label)
    const x = detailX + (i % 4) * cell, detailY = top + 44 + Math.floor(i / 4) * row
    label(x + 2, detailY + 14, mark.label)
    stamp(mark.icon, x + 3, detailY + 73, 2)
    stamp(mark.icon, x + 70, detailY + 25, 6)
  }
  top += sectionHeight(section.marks.length)
}
mkdirSync('shots/icons', { recursive: true })
execFileSync('magick', ['-size', `${width}x${height}`, '-depth', '8', 'rgb:-', '-font', 'DejaVu-Sans',
  ...text, '-strip', 'PNG24:shots/icons/sheet-2.png'], { input: rgb })
