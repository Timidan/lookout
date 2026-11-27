import {
  AudioInputSource, AudioSpeakerRole, CreateStartUpPageContainer, ImageContainerProperty, ImageRawDataUpdate, ImageRawDataUpdateResult, ListContainerProperty,
  ListItemContainerProperty, MenuContainerProperty, MenuItemProperty, OsEventTypeList as EventType, RebuildPageContainer,
  StartUpPageCreateResult, TextContainerProperty, TextContainerUpgrade, waitForEvenAppBridge,
} from '@evenrealities/even_hub_sdk'

import { NUMBER_HEIGHT, NUMBER_WIDTH, type Chart } from './chart'
import { iconRowBytes, type Icon } from './icons'

export type Gesture = 'click' | 'back' | 'up' | 'down' | 'hold' | 'release'
export type GlassPage = {
  line1: string
  line2?: string
  detail?: string
  footLeft?: string
  footRight?: string
  frame?: boolean
  icon?: Icon
  items?: string[]
  chart?: Chart
  // The card's one number, drawn large. The same number stays in the text, which is what a tap waits for.
  big?: Chart
}

const gestures: Partial<Record<EventType, Gesture>> = {
  [EventType.CLICK_EVENT]: 'click',
  [EventType.DOUBLE_CLICK_EVENT]: 'back',
  [EventType.SCROLL_TOP_EVENT]: 'up',
  [EventType.SCROLL_BOTTOM_EVENT]: 'down',
  [EventType.LONG_PRESS_EVENT]: 'hold',
  [EventType.LONG_PRESS_RELEASE_EVENT]: 'release',
}
// The glasses' own menu. Every entry only moves to a card; anything that sends an order still
// needs that card's tap or hold. Names are at most 32 bytes. Sent with every page build, because a
// build without a menu clears it.
export const menuItems = [
  { itemID: 1, itemName: 'Needs you' },
  { itemID: 2, itemName: 'Positions' },
  { itemID: 3, itemName: 'Markets' },
  { itemID: 4, itemName: 'Close all positions' },
  { itemID: 5, itemName: 'Cancel waiting orders' },
] as const
export type MenuChoice = (typeof menuItems)[number]['itemID']
const menuObject = new MenuContainerProperty({ menuItems: menuItems.map(item => new MenuItemProperty(item)) })
export type Launch = 'appMenu' | 'glassesMenu' | undefined
const blankIcon = new Uint8Array(72)
const encoder = new TextEncoder()
const decoder = new TextDecoder()

// encodeInto stops before an incomplete UTF-8 character.
function fit(text: string, bytes: number) {
  const buffer = new Uint8Array(bytes)
  const { written } = encoder.encodeInto(text, buffer)
  return decoder.decode(buffer.subarray(0, written))
}

type TextKey = 'line1' | 'line2' | 'detail' | 'footLeft' | 'footRight'
const regions: [TextKey, number, number, number, number, number][] = [
  ['line1', 64, 38, 484, 32, 4],
  ['line2', 64, 72, 484, 32, 4],
  ['detail', 64, 110, 484, 60, 2],
  ['footLeft', 24, 240, 430, 30, 2],
  ['footRight', 470, 240, 90, 30, 2],
]

// With a large number, the text below it moves down and the first line dims a step.
const underBig: Partial<Record<TextKey, object>> = { line1: { textColor: 3 }, line2: { yPosition: 130 }, detail: { yPosition: 162, height: 62 } }

function containers(frame: boolean, values: string[], items: string[], iconID: number, chartID: number, bigID: number) {
  const common = { borderWidth: 0, paddingLength: 0, isEventCapture: 0 }
  const textObject = [new TextContainerProperty({
    ...common, xPosition: 12, yPosition: 24, width: 552, height: 200,
    borderWidth: frame ? 2 : 0, borderColor: 12, borderRadius: 8,
    containerID: 1, containerName: 'frame', zOrderIndex: 1, content: ' ', isEventCapture: items.length ? 0 : 1,
  })]
  for (const [i, [key, xPosition, yPosition, width, height, textColor]] of regions.entries()) {
    if (items.length && (key === 'footLeft' || key === 'footRight')) continue
    textObject.push(new TextContainerProperty({
      ...common, xPosition, yPosition, width, height, textColor,
      ...(bigID ? underBig[key] : {}),
      ...(chartID && !bigID && key === 'detail' ? { xPosition: 316, yPosition: 104, width: 232, height: 64 } : {}),
      containerID: 3 + i, containerName: key, zOrderIndex: 3 + i, content: values[i],
    }))
  }
  const imageObject = [new ImageContainerProperty({
    containerID: iconID, containerName: 'icon' + iconID, zOrderIndex: 2, xPosition: 30, yPosition: 42, width: 24, height: 24,
  })]
  if (bigID) imageObject.push(new ImageContainerProperty({
    containerID: bigID, containerName: 'big' + bigID, zOrderIndex: 10, xPosition: 61, yPosition: 68, width: NUMBER_WIDTH, height: NUMBER_HEIGHT,
  }))
  if (chartID) imageObject.push(new ImageContainerProperty({
    containerID: chartID, containerName: 'chart' + chartID, zOrderIndex: 9, width: 240, height: 64,
    // Beside a large number the graph sits to its right; otherwise it sits under the text.
    ...(bigID ? { xPosition: 316, yPosition: 66 } : { xPosition: 64, yPosition: 104 }),
  }))
  const listObject = items.length ? [new ListContainerProperty({
    ...common, xPosition: 12, yPosition: 168, width: 552, height: 120,
    containerID: 8, containerName: 'actions', zOrderIndex: 8, isEventCapture: 1,
    itemContainer: new ListItemContainerProperty({
      itemCount: items.length, itemWidth: 0, isItemSelectBorderEn: 1, itemName: items,
    }),
  })] : []
  return { containerTotalNum: textObject.length + listObject.length + imageObject.length, textObject, listObject, imageObject, menuObject }
}

export async function connectGlasses(
  onInput: (gesture: Gesture, index?: number) => void,
  // `fromOthers` is true when the app's audio model says someone other than the wearer is speaking.
  onAudio: (pcm: Uint8Array, fromOthers: boolean) => void,
  onSuspend: () => void,
  onMenu: (choice: MenuChoice) => void,
) {
  const bridge = await waitForEvenAppBridge()
  // The host announces once, just after loading, whether the app was opened from the glasses or the phone.
  let launch: Launch
  const stopLaunch = bridge.onLaunchSource(source => { launch = source })
  let queue = Promise.resolve()
  function serial<T>(work: () => Promise<T>) {
    const next = queue.then(work)
    queue = next.then(() => {}, () => {})
    return next
  }

  let shownLayout = ''
  let shownText: string[] = []
  let shownIcon: Icon | undefined
  let shownChart: string | undefined
  let shownChartId: string | undefined
  let shownBig: string | undefined
  let iconID = 0
  let chartID = 0
  let bigID = 0
  let pageGeneration = 0
  let images: GlassPage | undefined
  let sendingImageID = 0
  let imageTimer: number | undefined
  let lastImageAt = -Infinity
  let lastChartAt = -Infinity
  let lastWasBig = false

  // Pictures share one paced lane. Text, navigation and list input never wait for a picture.
  function sendImages() {
    window.clearTimeout(imageTimer)
    if (sendingImageID || !images) return
    const page = images
    const icon = page.icon ?? blankIcon
    const iconChanged = shownIcon ? shownIcon !== icon && !shownIcon.every((b, i) => b === icon[i]) : !!page.icon
    // The large number goes first: it is what the wearer reads. A later number (a price tick) waits
    // until the icon and graph are on screen, so a fast-moving price never holds them back.
    // A price that ticks every second would otherwise hold a due graph back for good: after a number,
    // a graph that is 2 s old goes next.
    const now = performance.now()
    const chartDue = !!page.chart && !!shownChart && page.chart.key !== shownChart && now >= lastChartAt + 2_000
    const big = page.big && page.big.key !== shownBig && (!shownBig || !iconChanged && (!page.chart || !!shownChart))
      && !(chartDue && lastWasBig) ? page.big : undefined
    const chart = big || iconChanged ? undefined : page.chart
    if (!big && !iconChanged && (!chart || chart.key === shownChart)) return
    // A market's live graph redraws at most every 2 s; the price number above it still goes first.
    const delay = Math.max(lastImageAt + 100, chart && chart.id === shownChartId ? lastChartAt + 2_000 : 0) - now
    if (delay > 0) { imageTimer = window.setTimeout(sendImages, delay); return }
    const generation = pageGeneration
    const update = big ? { containerID: bigID, containerName: 'big' + bigID, imageData: big.pixels } : chart
      ? { containerID: chartID, containerName: 'chart' + chartID, imageData: chart.pixels }
      : { containerID: iconID, containerName: 'icon' + iconID, imageData: iconRowBytes([icon]) }
    sendingImageID = update.containerID
    lastImageAt = now
    lastWasBig = !!big
    if (chart) lastChartAt = now
    void bridge.updateImageRawData(new ImageRawDataUpdate(update)).then(result => {
      if (generation !== pageGeneration) return
      if (result !== ImageRawDataUpdateResult.success) throw new Error('Image transfer failed')
      if (big) shownBig = big.key
      else if (chart) {
        shownChart = chart.key
        shownChartId = chart.id
        if (import.meta.env.DEV) console.info(`[trader] Chart ${chart.pixels.length} bytes in ${Math.round(performance.now() - now)} ms`)
      } else shownIcon = icon
    }).catch(error => {
      if (images === page) images = undefined
      console.warn('Glasses image unavailable', error)
    }).finally(() => { sendingImageID = 0; sendImages() })
  }
  let requested = 0
  let painted = 0
  let micOn = false
  let receivedAudio = false
  const unsubscribe = bridge.onEvenHubEvent(event => {
    if (event.audioEvent) {
      receivedAudio = true
      onAudio(event.audioEvent.audioPcm, event.audioEvent.speakerRole === AudioSpeakerRole.Other)
      return
    }
    if (event.menuItemClickEvent) {
      const id = event.menuItemClickEvent.itemID
      if (menuItems.some(item => item.itemID === id)) onMenu(id as MenuChoice)
      return
    }
    const envelope = event.listEvent ?? event.textEvent ?? event.sysEvent
    if (!envelope) return
    // Protobuf may omit a zero-valued click or first list index.
    const type = envelope.eventType ?? EventType.CLICK_EVENT
    if (type === EventType.FOREGROUND_EXIT_EVENT) { onSuspend(); return }
    if (type === EventType.SYSTEM_EXIT_EVENT || type === EventType.ABNORMAL_EXIT_EVENT) {
      cleanup()
      return
    }
    const gesture = gestures[type]
    if (!gesture || ((gesture === 'click' || gesture === 'hold') && requested !== painted)) return
    onInput(gesture, event.listEvent ? event.listEvent.currentSelectItemIndex ?? 0 : undefined)
  })
  function cleanup() {
    images = undefined
    window.clearTimeout(imageTimer)
    onSuspend()
    unsubscribe()
    stopLaunch()
    if (micOn) void bridge.audioControl(false).catch(() => {})
    window.removeEventListener('pagehide', cleanup)
  }
  window.addEventListener('pagehide', cleanup)

  return {
    draw(page: GlassPage) {
      const items = page.items?.slice(0, 20).map(item => fit(item, 63)) ?? []
      const values = regions.map(([key]) => fit(page[key] || ' ', 999))
      // Another card's number rebuilds the page, so it is never left on screen. The same card's new
      // number (a price tick, a resize) replaces the picture in place, first in the picture lane.
      const layout = JSON.stringify([!!page.frame, items, !!page.chart, page.big?.id ?? ''])
      const revision = ++requested
      images = undefined
      return serial(async () => {
        if (revision !== requested) return
        if (layout !== shownLayout) {
          // In-flight pictures can only address the native page that requested them.
          pageGeneration++
          // Only one transfer can be in flight. Two sets of IDs keep even long sessions bounded.
          const alternate = sendingImageID ? sendingImageID <= 11 : iconID === 9
          iconID = alternate ? 12 : 9
          bigID = page.big ? iconID + 1 : 0
          chartID = page.chart ? iconID + 2 : 0
          if (!chartID) lastChartAt = -Infinity
          const payload = containers(!!page.frame, values, items, iconID, chartID, bigID)
          if (!shownLayout) {
            const result = await bridge.createStartUpPageContainer(new CreateStartUpPageContainer(payload))
            if (result !== StartUpPageCreateResult.success && (result !== StartUpPageCreateResult.invalid ||
                !await bridge.rebuildPageContainer(new RebuildPageContainer(payload)))) throw new Error('Could not display the glasses page')
          } else if (!await bridge.rebuildPageContainer(new RebuildPageContainer(payload))) {
            throw new Error('Could not update the glasses page')
          }
          shownLayout = layout
          shownText = [...values]
          // A rebuild creates a fresh native image placeholder even if the icon is unchanged.
          shownIcon = undefined
          shownChart = undefined
          shownChartId = undefined
          shownBig = undefined
        } else {
          const textCount = items.length ? 3 : regions.length
          for (let i = 0; i < textCount; i++) {
            if (values[i] === shownText[i]) continue
            const update = new TextContainerUpgrade({ containerID: 3 + i, containerName: regions[i]![0],
              content: values[i], contentOffset: 0, contentLength: 0 })
            if (!await bridge.textContainerUpgrade(update)) throw new Error('Could not update the glasses text')
            shownText[i] = values[i]!
          }
        }
        painted = revision
        if (revision === requested) { images = page; sendImages() }
      })
    },
    exit: () => serial(() => bridge.shutDownPageContainer(1)),
    launch: () => launch,
    get: (key: string) => serial(() => bridge.getLocalStorage(key)),
    set: (key: string, value: string) => serial(async () => {
      if (!await bridge.setLocalStorage(key, value)) throw new Error('Device storage unavailable')
    }),
    mic: (enabled: boolean) => serial(async () => {
      if (enabled) {
        receivedAudio = false
        const opened = await bridge.audioControl(true, AudioInputSource.Glasses)
        if (!opened && !receivedAudio) {
          await bridge.audioControl(false)
          throw new Error('Glasses microphone unavailable')
        }
      } else {
        // Simulator 0.9.5 resolves false after it successfully closes the source.
        await bridge.audioControl(false)
      }
      micOn = enabled
    }),
  }
}
