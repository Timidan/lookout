// Vite dev entry at /icons.html. The trading app and its production build do not import this page.
import {
  CreateStartUpPageContainer, ImageContainerProperty, ImageRawDataUpdate, ImageRawDataUpdateResult,
  OsEventTypeList as Gesture, RebuildPageContainer, StartUpPageCreateResult, TextContainerProperty, TextContainerUpgrade,
  waitForEvenAppBridge,
} from '@evenrealities/even_hub_sdk'
import { actionIcon, actionLabel, actionNames, coinIcon, coinNames, iconRowBytes, outcomes, type Icon } from './icons'

type Page = { title: string; detail: string; icons: Icon[] }
const cards: Page[] = [
  { title: '▲ BTC long +$41', detail: 'Tap to open BTC', icons: [coinIcon('BTC')] },
  { title: 'ETH has no stop', detail: 'Tap to set a stop at $2,850', icons: [actionIcon('unprotected')] },
  { title: 'Hold: close all', detail: '2 open positions', icons: [actionIcon('closeAll')] },
]
const pages = cards.concat(
  [
    { title: 'NVDA market', detail: 'Watchlist', icons: [coinIcon('xyz:NVDA')] },
    { title: 'BTC, ETH and SOL', detail: 'Three markets on your watchlist', icons: ['BTC', 'ETH', 'SOL'].map(coinIcon) },
  ],
  coinNames.filter(name => name !== 'BTC').map(name => ({ title: name, detail: 'Coin market', icons: [coinIcon(name)] })),
  ['TSLA', 'GOLD', 'OIL'].map(name => ({ title: name, detail: 'Market monogram', icons: [coinIcon(name)] })),
  Object.entries(outcomes).map(([side, icon]) => ({ title: side === 'yes' ? 'Yes' : 'No', detail: 'Outcome market', icons: [icon] })),
  actionNames.filter(name => name !== 'unprotected' && name !== 'closeAll').map(name => ({
    title: actionLabel(name), detail: 'Action icon', icons: [actionIcon(name)],
  })),
)

async function start() {
  const bridge = await waitForEvenAppBridge()
  const imageID = { containerID: 2, containerName: 'mark' }
  const textID = { containerID: 1, containerName: 'caption' }
  const status = document.querySelector<HTMLElement>('#gallery-status')!
  const value = new URLSearchParams(location.search).get('brightness')
  const brightness = value === null ? 15 : Number(value)
  if (!Number.isInteger(brightness) || brightness < 0 || brightness > 15) throw new Error('Use a brightness from 0 to 15.')
  let page = 0, alternate = false, width = 0, uploads = 0
  let shownIcons: readonly Icon[] = []
  let queue = Promise.resolve()

  async function show(index: number, secondary: boolean) {
    const current = pages[index]!
    const nextWidth = 24 * current.icons.length
    const lines = secondary ? `${current.detail}\n${current.title}` : `${current.title}\n${current.detail}`
    const text = index < cards.length ? lines : `${lines}\n\n${index + 1}/${pages.length}`
    const layout = { containerTotalNum: 2,
      imageObject: [new ImageContainerProperty({ ...imageID, xPosition: 16, yPosition: 56, width: nextWidth, height: 24 })],
      textObject: [new TextContainerProperty({ ...textID, xPosition: 26 + nextWidth, yPosition: 52, width: 538 - nextWidth, height: 218,
        isEventCapture: 1, borderWidth: 0, paddingLength: 0, content: text })],
    }
    if (!width) {
      const created = await bridge.createStartUpPageContainer(new CreateStartUpPageContainer(layout))
      if (created !== StartUpPageCreateResult.success &&
          !(created === StartUpPageCreateResult.invalid && await bridge.rebuildPageContainer(new RebuildPageContainer(layout)))) throw new Error('Gallery page failed')
    } else if (width !== nextWidth) {
      if (!await bridge.rebuildPageContainer(new RebuildPageContainer(layout))) throw new Error('Gallery layout failed')
      shownIcons = []
    } else if (!await bridge.textContainerUpgrade(new TextContainerUpgrade({ ...textID, content: text, contentOffset: 0, contentLength: 0 }))) {
      throw new Error('Caption update failed')
    }
    width = nextWidth
    const changed = current.icons.length !== shownIcons.length || current.icons.some((icon, i) =>
      icon !== shownIcons[i] && !icon.every((byte, j) => byte === shownIcons[i]![j]))
    if (changed) {
      const bytes = iconRowBytes(current.icons, brightness)
      const before = performance.now()
      const result = await bridge.updateImageRawData(new ImageRawDataUpdate({ ...imageID, imageData: bytes }))
      const elapsed = performance.now() - before
      if (result !== ImageRawDataUpdateResult.success) throw new Error(`Image update failed: ${result}`)
      shownIcons = current.icons
      console.info(`[icon-upload] page=${index} bytes=${bytes.length} ms=${elapsed.toFixed(2)} count=${++uploads}`)
    }
    status.textContent = `${index + 1}/${pages.length} · ${lines}`
    console.info(`[icon-page] page=${index} alternate=${secondary} count=${uploads}`)
  }

  function draw() {
    const index = page, secondary = alternate
    queue = queue.then(() => show(index, secondary)).catch(error => { status.textContent = String(error); console.error(error) })
  }
  const unsubscribe = bridge.onEvenHubEvent(event => {
    const envelope = event.textEvent ?? event.sysEvent
    if (!envelope) return
    switch (envelope.eventType ?? Gesture.CLICK_EVENT) {
      case Gesture.SCROLL_TOP_EVENT: page = (page + pages.length - 1) % pages.length; alternate = false; break
      case Gesture.SCROLL_BOTTOM_EVENT: page = (page + 1) % pages.length; alternate = false; break
      case Gesture.CLICK_EVENT: alternate = !alternate; break
      case Gesture.DOUBLE_CLICK_EVENT: void queue.then(() => bridge.shutDownPageContainer(1)); return
      default: return
    }
    draw()
  })
  window.addEventListener('pagehide', unsubscribe, { once: true })
  draw()
}

void start().catch(error => { document.querySelector('#gallery-status')!.textContent = String(error); console.error(error) })
