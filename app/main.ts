import type { Account, Card, PairStart } from '../shared/api'
import { base, createApi, RequestError } from './api'
import { connectGlasses, type Gesture, type MenuChoice } from './glasses'
import { render, type Data, type View } from './render'
import { HOLD_MS, home, loading, secondsLeft, transition, type Effect, type Screen } from './state'

const api = createApi()
const storageKey = 'trader.pair.' + base
const data: Data = { markets: new Map(), live: true }
const status = document.querySelector<HTMLElement>('#status')!
const pairCode = document.querySelector<HTMLElement>('#pair-code')!
const pairLink = document.querySelector<HTMLAnchorElement>('#pair-link')!
let pairRecord: PairStart | undefined
let sample = false
let session = 0
let loadingVisible = false
let glasses: Awaited<ReturnType<typeof connectGlasses>>
let screen: Screen = loading()
let displayed: { screen: Screen; view: View } | undefined
let source: EventSource | undefined
let watchKey = ''
let cards: Card[] = []
let lastHomeId: string | undefined
let stackRevision = 0
let timer: number | undefined
let livePaint: number | undefined
let frames: Array<Uint8Array<ArrayBuffer>> | undefined
let audioBytes = 0
// Frames the app's audio model attributed to someone other than the wearer during this recording.
let otherVoices = 0
let micReady: Promise<void> = Promise.resolve()
const errorText = (error: unknown) => error instanceof Error ? error.message.replace(/\.+$/, '') : 'Request failed'
const uncertain = (error: unknown) => !(error instanceof RequestError) || error.status === 0 || error.status === 408 || error.status >= 500

async function paint() {
  const current = screen
  const view = render(current.view === 'loading' && !loadingVisible ? { ...current, text: '' } : current, data, Date.now())
  await glasses.draw(view)
  if (current === screen) displayed = { screen: current, view }
}

function draw() {
  void paint().catch(error => { status.textContent = errorText(error); console.error('Glasses display update failed') })
}

function apply(move: ReturnType<typeof transition>) {
  if (move.screen !== screen) go(move.screen)
  if (move.effect) void perform(move.effect, move.screen)
}

function microphone(on: boolean) {
  micReady = micReady.catch(() => {}).then(() => glasses.mic(on))
  return micReady
}

function watchFor(s: Screen): string {
  if (s.view === 'market') return s.market.id
  if (s.view === 'confirm') return s.ticket.instrument.id
  if (s.view === 'home') {
    const card = s.cards.find(c => c.id === s.activeId)
    if (card?.kind === 'watch' && card.action?.type === 'open_market') {
      const id = card.action.instrumentId
      if (id.startsWith('#') || data.markets.get(id)?.kind === 'outcome') return id
    }
  }
  return ''
}

function go(next: Screen) {
  const previous = screen.view
  screen = next
  if (previous === 'voice' && !(next.view === 'loading' && next.back)) {
    frames = undefined
    void microphone(false).catch(() => {})
  }
  if (next.view === 'home') lastHomeId = next.activeId
  window.clearTimeout(timer)
  if (previous !== next.view) console.info('[trader] Screen ' + next.view)
  if (next.view === 'loading') {
    loadingVisible = false
    if (!displayed) draw()
    timer = window.setTimeout(() => { loadingVisible = true; draw() }, 300)
    return
  }
  if (source && ['home', 'market', 'confirm'].includes(next.view)) subscribe(watchFor(next))
  if (next.view === 'voice') data.micLevel = 0
  draw()
  if ((next.view === 'home' || next.view === 'cancel') && next.heldAt !== undefined) {
    const deadline = next.heldAt + HOLD_MS
    const tick = () => {
      if (screen !== next) return
      const remaining = deadline - Date.now()
      if (remaining <= 0) { apply(transition(next, { type: 'clock', live: data.live, sample }, Date.now())); return }
      draw()
      timer = window.setTimeout(tick, Math.min(100, remaining))
    }
    timer = window.setTimeout(tick, Math.max(0, Math.min(100, deadline - Date.now())))
  } else if ((next.view === 'home' || next.view === 'cancel') && next.hint) {
    timer = window.setTimeout(() => go({ ...next, hint: undefined, hintUntil: undefined }), Math.max(0, (next.hintUntil ?? Date.now()) - Date.now()))
  } else if (next.view === 'confirm') {
    // Wake on the next displayed second, including a final wake at the actual expiry.
    const tick = () => {
      if (screen !== next) return
      const now = Date.now()
      const seconds = secondsLeft(next.ticket, now)
      if (!seconds) { apply(transition(next, { type: 'clock' }, now)); return }
      draw()
      timer = window.setTimeout(tick, Math.max(1, next.ticket.expiresAt - now - (seconds - 1) * 1000))
    }
    const remaining = next.ticket.expiresAt - Date.now()
    timer = window.setTimeout(tick, remaining > 0 ? ((remaining - 1) % 1000) + 1 : 0)
  } else if (next.view === 'reply' && !next.failure) {
    timer = window.setTimeout(() => next.refreshStack ? void freshHome(next) : go(home(cards, lastHomeId)), next.refreshStack ? 2000 : 3500)
  } else if (next.view === 'result' && next.result.status !== 'rejected') {
    timer = window.setTimeout(() => go(home(cards, lastHomeId)), 2500)
  } else if (next.view === 'voice') {
    timer = window.setTimeout(() => {
      go({ view: 'reply', text: 'Recording ended · hold to try again' })
    }, 30000)
  }
}

function refreshView() {
  if (livePaint !== undefined || (screen.view !== 'market' && screen.view !== 'home' && screen.view !== 'confirm')) return
  livePaint = window.setTimeout(() => {
    livePaint = undefined
    if (screen.view === 'home' || screen.view === 'market' || screen.view === 'confirm') draw()
  }, 350)
}

function updateAccount(account: Account) {
  if (data.account && account.updatedAt < data.account.updatedAt) return
  data.account = account
  const current = screen
  if (current.view === 'market' || (current.view === 'home' && current.heldAt === undefined &&
    current.cards.some(card => card.id === current.activeId && card.buffer !== undefined))) refreshView()
}

function updateCards(incoming: Card[]) {
  stackRevision++
  if (JSON.stringify(incoming) === JSON.stringify(cards)) return
  cards = incoming
  apply(transition(screen, { type: 'next', cards }, Date.now()))
}

async function reloadCards() {
  const revision = stackRevision
  const next = await api.next()
  // A stream snapshot received while the request was in flight is newer.
  if (revision === stackRevision) updateCards(next)
}

async function freshHome(feedback?: Extract<Screen, { view: 'reply' }>) {
  const origin = feedback?.back
  const following = origin?.view === 'home' ? origin.cards[origin.cards.findIndex(c => c.id === origin.activeId) + 1]?.id : undefined
  const pending = loading()
  go(pending)
  try {
    await reloadCards()
    if (screen === pending) go(home(cards, following))
  } catch (error) {
    if (screen === pending) go({ view: 'error', text: errorText(error) })
  }
}

function subscribe(marketId = '') {
  if (source && marketId === watchKey) return
  source?.close()
  watchKey = marketId
  const ids = marketId ? [marketId] : []
  const connection = api.stream(ids, event => {
    if (source !== connection) return
    if (event.type === 'next') updateCards(event.cards)
    if (event.type === 'account') updateAccount(event.account)
    if (event.type === 'quote') {
      data.markets.set(event.instrument.id, event.instrument)
      if (watchFor(screen) === event.instrument.id) refreshView()
    }
    if (event.type === 'fill') refreshAccount()
  }, live => {
    if (source !== connection) return
    if (live && !data.live) {
      refreshAccount(); void reloadCards().catch(() => {})
      // Prices are back, so the message asking to wait for them closes as a tap would close it.
      if (screen.view === 'reply' && screen.failure && screen.text === 'Wait for live prices')
        apply(transition(screen, { type: 'input', gesture: 'click', cards, homeId: lastHomeId, live, sample }, Date.now()))
    }
    // The browser stops retrying for good after an error reply (a proxy's 502 during a restart, a 429).
    if (!live && connection.readyState === EventSource.CLOSED) window.setTimeout(() => {
      if (source === connection) { source = undefined; subscribe(watchKey) }
    }, 5000)
    data.live = live
    if (!live && (screen.view === 'home' || screen.view === 'cancel') && screen.heldAt !== undefined)
      go({ ...screen, heldAt: undefined, hint: 'Wait for live prices', hintUntil: Date.now() + 2000 })
    refreshView()
  })
  source = connection
}

function refreshAccount() {
  const connection = source
  void api.account().then(account => { if (connection && connection === source) updateAccount(account) })
    .catch(() => {}) // The stream retries independently. Never retry an order here.
}

async function loadHome(run: number) {
  // A stream opened for a sample address may still send that account after the phone pairs.
  closeStream()
  stackRevision++
  go(loading())
  const next = await api.next()
  if (run !== session) return
  data.markets.clear()
  data.account = undefined
  data.live = true
  cards = next
  stackRevision++
  // Opened from the glasses' own menu, the wearer wants what needs them, not the sample or setup card.
  go(home(cards, glasses.launch() === 'glassesMenu' ? cards.find(card => menuKinds[1].includes(card.kind))?.id : undefined))
  subscribe(watchFor(screen))
  refreshAccount()
}

function phone(message: string, pair?: PairStart) {
  status.textContent = message
  pairCode.textContent = pair ? 'Code ' + pair.code : ''
  pairCode.hidden = !pair
  pairLink.hidden = !pair
  if (pair) pairLink.href = pair.pairUrl
  else pairLink.removeAttribute('href')
}

function closeStream() {
  source?.close()
  source = undefined
}

async function start() {
  const run = ++session
  closeStream()
  stackRevision++
  sample = false
  data.live = false
  pairRecord = undefined
  let pair: PairStart | undefined
  let renewedAfterDenial = false
  const renew = () => {
    pairRecord = pair = undefined
    closeStream()
    stackRevision++
    data.live = false
    phone('Getting a new pairing code')
    if (screen.view === 'pair') go({ view: 'loading', text: 'Loading…', pairing: true, back: sample ? home(cards, lastHomeId) : undefined })
    else refreshView()
  }
  phone('Checking wallet pairing')
  try {
    const stored = await glasses.get(storageKey)
    if (stored) {
      try { pair = JSON.parse(stored) } catch { /* Replace an unreadable pairing record. */ }
    }
    while (run === session) {
      if (!pair?.deviceToken) {
        pair = await api.startPair()
        if (run !== session) return
        await glasses.set(storageKey, JSON.stringify(pair))
      }
      if (run !== session) return
      api.useToken(pair.deviceToken)
      let state
      try { state = await api.status() } catch (error) {
        if (run !== session) return
        if (!renewedAfterDenial && error instanceof RequestError && [401, 403].includes(error.status)) {
          renewedAfterDenial = true
          renew()
          continue
        }
        if (sample && source && screen.view !== 'pair') {
          await new Promise(resolve => window.setTimeout(resolve, 1500))
          continue
        }
        throw error
      }
      if (run !== session) return
      renewedAfterDenial = false
      if (state.paired) {
        sample = false
        phone('Wallet paired')
        await loadHome(run)
        return
      }
      if (pair.expiresAt <= Date.now()) {
        renew()
        continue
      }
      pairRecord = pair
      phone(state.sample ? 'Sample account · wallet unpaired' : 'Wallet unpaired', pair)
      if (state.sample && !sample) {
        sample = true
        const pairing = screen.view === 'pair' || (screen.view === 'loading' && screen.pairing)
        await loadHome(run)
        if (pairing && run === session) go({ view: 'pair', pair })
      } else if (sample && state.sample && !source) {
        // The sample account stays the same when its pairing code rotates.
        await reloadCards()
        if (run !== session) return
        subscribe(watchFor(screen))
        refreshAccount()
      }
      if (!state.sample || screen.view === 'pair' || (screen.view === 'loading' && screen.pairing)) {
        if (!state.sample && sample) { closeStream(); cards = []; stackRevision++; sample = false }
        if (screen.view !== 'pair' || screen.pair.code !== pair.code) go({ view: 'pair', pair })
      }
      await new Promise(resolve => window.setTimeout(resolve, Math.min(1500, Math.max(0, pair!.expiresAt - Date.now()))))
    }
  } catch (error) {
    if (run !== session) return
    phone("Can't reach the server")
    go({ view: 'error', text: errorText(error) })
  }
}

async function perform(effect: Effect, from: Screen) {
  const done = (next: Screen) => { if (screen === from) go(next) }
  try {
    switch (effect.kind) {
      case 'retry': await start(); return
      case 'exit': await glasses.exit(); return
      case 'pair':
        if (pairRecord && pairRecord.expiresAt > Date.now()) done({ view: 'pair', pair: pairRecord })
        else done({ view: 'loading', text: 'Loading…', pairing: true, back: from })
        return
      case 'act': {
        const started = performance.now()
        const action = from.view === 'acting' ? from : undefined
        const response = await api.act(effect.id).catch(error => {
          if (error instanceof RequestError && error.status === 409)
            return { ok: true, message: 'That changed. Showing the latest', changed: true }
          throw error
        })
        // The send starts at the deadline. Give the wearer a moment to read the progress acknowledgement.
        await new Promise(resolve => setTimeout(resolve, Math.max(0, 350 - (performance.now() - started))))
        done({ view: 'reply', text: response.message, card: action?.card, back: 'changed' in response ? undefined : action?.back,
          failure: !response.ok, refreshStack: response.ok })
        return
      }
      case 'market': {
        const market = await api.market(effect.id)
        if (screen !== from) return
        data.markets.set(market.id, market)
        done(transition(from, { type: 'opened', market }, Date.now()).screen)
        return
      }
      case 'record':
        frames = []
        audioBytes = 0
        otherVoices = 0
        await microphone(true)
        return
      case 'send': {
        const captured = frames
        frames = undefined
        await microphone(false)
        if (screen !== from) return
        const pcm = new Blob(captured ?? [], { type: 'application/octet-stream' })
        if (sample || !data.live) {
          done({ view: 'reply', text: data.live ? 'Sample account. Pair to trade' : 'Wait for live prices',
            failure: true, back: from.view === 'loading' ? from.back : undefined })
          return
        }
        if (!pcm.size) {
          done({ view: 'reply', text: otherVoices ? 'Only other voices heard · hold to try again' : 'No sound heard · hold to try again' })
          return
        }
        const answer = await api.voice(pcm)
        done(transition(from, { type: 'voice', answer }, Date.now()).screen)
        return
      }
      case 'cancel': {
        const run = session
        const account = await api.account()
        const orders = account.openOrders.filter(order => order.instrumentId === effect.id)
        let count = 0
        for (const order of orders) {
          if (run !== session || screen !== from) return
          if (sample || !data.live) throw new Error((count ? `Cancelled ${count} of ${orders.length} · ` : '') + 'Wait for live prices')
          try {
            await api.cancel(order.oid, effect.id)
            count++
          } catch (error) {
            refreshAccount()
            const problem = uncertain(error) ? 'Check your orders · cancel unconfirmed' : errorText(error)
            throw new Error(count ? `Cancelled ${count} of ${orders.length} · ${problem}` : problem)
          }
        }
        refreshAccount()
        done({ view: 'reply', text: count ? `Cancelled ${count} order${count === 1 ? '' : 's'}` : 'No open orders in this market' })
        return
      }
      case 'close': case 'quote': {
        const ticket = effect.kind === 'quote' ? await api.quote(effect.intent) : await api.close(effect.id)
        done(transition(from, { type: 'priced', ticket }, Date.now()).screen)
        return
      }
      case 'confirm': {
        if (from.view !== 'loading' || !from.sending) return
        if (Date.now() >= effect.ticket.expiresAt) { done({ view: 'expired', previous: from.sending }); return }
        const result = await api.confirm(effect.ticket.id)
        done(transition(from, { type: 'settled', result }, Date.now()).screen)
        refreshAccount()
        return
      }
    }
  } catch (error) {
    if (effect.kind === 'record' && screen === from) frames = undefined
    if (effect.kind === 'confirm' && from.view === 'loading' && from.sending) {
      const reason = error instanceof RequestError ? (error.code ?? '').replace(/[_-]/g, ' ') + ' ' + error.message : ''
      if (error instanceof RequestError && (error.status === 410 ||
        (!uncertain(error) && /(?:ticket|quote|price).{0,24}expir|expir.{0,24}(?:ticket|quote|price)/i.test(reason)))) {
        done({ view: 'expired', previous: from.sending })
      } else if (!uncertain(error) && !/already (?:confirmed|sent|used|executed)|(?:ticket|order) (?:already )?(?:used|consumed)/i.test(reason)) {
        done({ view: 'result', ticket: effect.ticket, result: { status: 'rejected', filledSize: '0', message: errorText(error) } })
      } else {
        done({ view: 'reply', text: 'Order status unknown · check your account', failure: true })
      }
      return
    }
    if (from.view === 'acting') {
      const unknown = effect.kind === 'act' && uncertain(error)
      done({ view: 'reply', text: unknown ? 'Action status unknown · check your account' : errorText(error),
        card: from.card, back: from.back, failure: true })
      return
    }
    const expected = error instanceof RequestError && error.status >= 400 && error.status < 500 &&
      error.status !== 401 && error.status !== 403
    done(expected ? { view: 'reply', text: errorText(error), failure: true, back: from.view === 'loading' ? from.pricing?.back ?? from.back : undefined }
      : { view: 'error', text: errorText(error) })
  }
}

function input(gesture: Gesture, index?: number) {
  const visible = displayed?.screen === screen ? displayed.view : undefined
  if ((gesture === 'click' || gesture === 'hold') && !visible) return
  if (screen.view === 'reply' && screen.refreshStack) {
    if (gesture === 'release') return
    if (gesture !== 'hold') { void freshHome(screen); return }
    void reloadCards().catch(() => {})
  }
  const choice = index === undefined ? undefined : visible?.rows?.[index]?.choice
  apply(transition(screen, { type: 'input', gesture, choice, cards, homeId: lastHomeId, live: data.live, sample }, Date.now()))
}

// The glasses' menu moves to a group of cards. It never sends anything: the card's own tap or hold does.
const menuKinds: Record<MenuChoice, Card['kind'][]> = {
  1: ['liq_before_stop', 'no_stop', 'thin_buffer', 'stop_to_entry'],
  2: ['position', 'step_away', 'close_all'],
  3: ['watch'],
  4: ['close_all'],
  5: ['step_away'],
}
const menuEmpty: Record<MenuChoice, string> = {
  1: 'Nothing needs you', 2: 'No open positions', 3: 'No markets to show', 4: 'No open positions', 5: 'No waiting orders',
}
function menu(choice: MenuChoice) {
  // Never leave a screen that is sending, listening or still loading.
  if (!['home', 'market', 'confirm', 'choices', 'result', 'expired', 'reply', 'cancel'].includes(screen.view) || !cards.length) return
  const target = cards.find(card => menuKinds[choice].includes(card.kind))
  go(target ? home(cards, target.id) : { ...home(cards, lastHomeId), hint: menuEmpty[choice], hintUntil: Date.now() + 2000 })
}

function suspend() {
  if ((screen.view === 'home' || screen.view === 'cancel') && screen.heldAt !== undefined) {
    go({ ...screen, heldAt: undefined, hint: 'Cancelled, nothing sent', hintUntil: Date.now() + 1000 })
  } else if (screen.view === 'voice') {
    go(home(cards))
  }
}

async function main() {
  glasses = await connectGlasses(input, (pcm, fromOthers) => {
    if (!frames || audioBytes + pcm.byteLength > 30 * 32000) return
    // Someone else talking nearby is not a command. Keep only the wearer's speech, or speech the model could not place.
    // ponytail: trusts the app's speaker model; set VITE_VOICE_FILTER=off if real glasses ever tag the wearer as someone else.
    if (fromOthers && import.meta.env.VITE_VOICE_FILTER !== 'off') { otherVoices++; return }
    frames.push(new Uint8Array(pcm))
    audioBytes += pcm.byteLength
    if (screen.view === 'voice' && pcm.byteLength >= 2) {
      const samples = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength)
      let squareSum = 0
      for (let i = 0; i + 1 < pcm.byteLength; i += 2) squareSum += (samples.getInt16(i, true) / 32768) ** 2
      const rms = Math.sqrt(squareSum / Math.floor(pcm.byteLength / 2))
      // A 48 dB speech range shows both quiet syllables and loud peaks. Silence stays at zero.
      data.micLevel = rms ? Math.max(0, Math.min(1, (20 * Math.log10(rms) + 48) / 48)) : 0
      draw()
    }
  }, suspend, menu)
  go(loading())
  await start()
}
window.addEventListener('pagehide', () => {
  session++
  frames = undefined
  if (screen.view === 'voice') void microphone(false).catch(() => {})
  source?.close()
  window.clearTimeout(timer)
  window.clearTimeout(livePaint)
})
void main().catch(error => { status.textContent = errorText(error); console.error('Glasses startup failed') })
