import { HTTPException } from 'hono/http-exception'
import type { Card, Instrument, StreamEvent } from '../shared/api.js'
import { currentStack, displayedCards } from './actions.js'
import { watchCard } from './cards.js'
import { cachedHistory, decimal, liveHistory, markets, publicInstrument, recordTick } from './venue.js'
import { device, sampleAddress } from './pair.js'
import { subscribe } from './ws.js'

const reads = new Map<string | null, ReturnType<typeof currentStack>>()
function readStack(address: string | null) {
  const current = reads.get(address)
  if (current) return current
  const pending = currentStack(address).finally(() => reads.delete(address))
  reads.set(address,pending)
  return pending
}

export async function stream(token: string, watch: string[], signal: AbortSignal) {
  const since = Date.now()
  const { id:deviceId, address } = device(token)
  if (watch.length > 40) throw new HTTPException(400, { message:'Watch up to 40 markets.' })
  const [catalog, initial] = await Promise.all([markets(), readStack(address)])
  const byId = new Map(catalog.map(m => [m.id, m]))
  const requested = new Set(watch)
  if (watch.some(id => !byId.has(id))) throw new HTTPException(404, {message:'Unknown instrument in watch list.'})
  const encoder = new TextEncoder()
  let finish = () => {}
  const response = new ReadableStream<Uint8Array>({
    start(controller) {
      const clean: Array<() => void> = []
      let closed = false
      finish = () => {
        if (closed) return
        closed = true
        for (const stop of clean) stop()
        try { controller.close() } catch { /* Reader disconnected. */ }
      }
      const send = (line: string) => {
        if (closed) return
        try {
          if (device(token).address !== address || (controller.desiredSize ?? 0) <= 0) return finish()
          controller.enqueue(encoder.encode(line))
        } catch { finish() }
      }
      const event = (data: StreamEvent) => send('data: ' + JSON.stringify(data) + '\n\n')
      signal.addEventListener('abort', finish, {once:true})
      clean.push(() => signal.removeEventListener('abort', finish))
      if (signal.aborted) return finish()
      send(': connected\n\n')
      if (closed) return

      let cards = initial.cards
      let printed = '', lastNext = 0
      let timer: NodeJS.Timeout | undefined
      const quotes = new Map<string, Instrument>()
      const feeds = new Map<string, () => void>()
      clean.push(() => { clearTimeout(timer); for (const off of feeds.values()) off() })
      const publish = () => {
        timer = undefined
        // Runs from a timer, where a throw would stop the server. Drop this stream instead; the client reconnects.
        try {
          const latest = cards.map(c => {
            const quote = c.kind === 'watch' && c.action?.type === 'open_market' && quotes.get(c.action.instrumentId)
            return quote ? watchCard({...quote,spark:c.spark,change1h:c.change1h,
              ...liveHistory(quote.id,{trend:c.trend,trendLow:c.trendLow,trendHigh:c.trendHigh},quote.mid)}) : c
          })
          const text = JSON.stringify(latest)
          if (printed === text) return
          printed = text
          lastNext = Date.now()
          event({type:'next', cards:latest})
        } catch (error) { console.error('Card update failed', error); finish() }
      }
      const queueNext = () => {
        if (timer || closed) return
        const wait = lastNext + 1000 - Date.now()
        if (wait <= 0) publish()
        else timer = setTimeout(publish,wait)
      }
      const quoteFeeds = (stack: Card[]) => {
        const ids = new Set(requested)
        for (const c of stack) if (c.kind === 'watch' && c.action?.type === 'open_market') ids.add(c.action.instrumentId)
        for (const [id,off] of feeds) if (!ids.has(id)) { off(); feeds.delete(id); quotes.delete(id) }
        for (const id of ids) {
          const m = byId.get(id)
          if (!m || feeds.has(id)) continue
          // Best bid and ask only: on testnet this channel updates about once a second, the full book every 5 s.
          feeds.set(id,subscribe({type:'bbo',coin:id}, data => {
            if (m.expiresAt && m.expiresAt <= Date.now()) return
            const bid:string|null = data.bbo?.[0]?.px ?? null
            const ask:string|null = data.bbo?.[1]?.px ?? null
            const old = quotes.get(id)
            if (old && bid === old.bid && ask === old.ask) return
            const mid = bid && ask ? decimal((Number(bid)+Number(ask))/2) : null
            if (mid) recordTick(id, Number(data.time) || Date.now(), Number(mid))
            const quote = {...publicInstrument(m),...liveHistory(id,cachedHistory(id),mid),bid,ask,mid}
            quotes.set(id,quote)
            if (requested.has(id)) event({type:'quote',instrument:quote})
            queueNext()
          }))
        }
      }

      let previousAccount = ''
      const emit = (stack: typeof initial) => {
        if (closed) return
        const account = stack.snapshot.account
        if (address && account) {
          const fingerprint = JSON.stringify([account.equityUsd,account.freeUsd,account.positions,account.openOrders])
          if (fingerprint !== previousAccount) {
            previousAccount = fingerprint
            event({type:'account',account})
          }
        }
        cards = displayedCards(deviceId,stack)
        quoteFeeds(cards)
        queueNext()
      }
      emit(initial)
      let busy = false, lastUpdate = Date.now()
      let scheduled: NodeJS.Timeout | undefined
      const refresh = async () => {
        if (busy || closed) return
        busy = true
        lastUpdate = Date.now()
        try { emit(await readStack(address)) } catch { finish() }
        finally { busy = false }
      }
      const changed = () => {
        if (scheduled || closed) return
        scheduled = setTimeout(() => {
          scheduled = undefined
          void refresh()
        },Math.max(250,lastUpdate + 5000 - Date.now()))
      }
      const poll = setInterval(() => {send(': heartbeat\n\n'); void refresh()},15_000)
      clean.push(() => { clearInterval(poll); clearTimeout(scheduled) })
      const viewed = address ?? sampleAddress
      if (viewed) {
        for (const sub of [{type:'openOrders',user:viewed,dex:'ALL_DEXS'},{type:'spotState',user:viewed},{type:'allDexsClearinghouseState',user:viewed}]) {
          let previous: string | undefined
          clean.push(subscribe(sub,data => {
            const body = data.orders ?? data.spotState ?? data.clearinghouseStates?.map(([,s]:[string,{assetPositions:unknown[]}]) => s.assetPositions)
            const fingerprint = JSON.stringify(body)
            if (previous !== undefined && previous !== fingerprint) changed()
            previous = fingerprint
          }))
        }
      }
      if (address) {
        const seen = new Set<string>()
        clean.push(subscribe({type:'userFills',user:address},data => {
          for (const fill of data.fills ?? []) {
            if (fill.time < since || (fill.side !== 'A' && fill.side !== 'B')) continue
            const key = JSON.stringify([fill.tid, fill.time, fill.oid, fill.coin, fill.side])
            if (seen.has(key)) continue
            seen.add(key)
            if (seen.size > 1024) seen.delete(seen.values().next().value!)
            event({type:'fill',instrumentId:fill.coin,symbol:byId.get(fill.coin)?.symbol ?? fill.coin,
              side:fill.side === 'B' ? 'buy' : 'sell',size:fill.sz,px:fill.px,time:fill.time})
          }
          if (data.fills?.length && !data.isSnapshot) changed()
        }))
      }
    },
    cancel() { finish() },
  }, {highWaterMark:128})
  return new Response(response,{headers:{'Content-Type':'text/event-stream','Cache-Control':'no-store',
    'X-Accel-Buffering':'no','Referrer-Policy':'no-referrer'}})
}
