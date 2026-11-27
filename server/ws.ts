// The venue multiplexes each named channel by coin or by owner address.
type Subscription = { type: string; coin?: string; user?: string; dex?: string }
type Listener = (data: any) => void
type Feed = { sub: Subscription; listeners: Set<Listener>; latest?: unknown }
const feeds = new Map<string, Feed>()
const endpoint = 'wss://api.hyperliquid-testnet.xyz/ws'
let socket: WebSocket | undefined
let reconnect: NodeJS.Timeout | undefined
let failures = 0
let idle: NodeJS.Timeout | undefined

function feedKey(type: string, coin?: string, user?: string, dex?: string) {
  return JSON.stringify([type, coin ?? '', user?.toLowerCase() ?? '', dex ?? ''])
}

function send(method: 'subscribe' | 'unsubscribe', subscription: Subscription) {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ method, subscription }))
}

function connect() {
  if (socket || reconnect || !feeds.size) return
  const ws = new WebSocket(endpoint)
  socket = ws
  let lastMessage = Date.now()
  const heartbeat = setInterval(() => {
    if (Date.now() - lastMessage > 65_000) ws.close()
    else if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ method: 'ping' }))
  }, 25_000)
  ws.onopen = () => {
    if (socket !== ws) return
    for (const {sub} of feeds.values()) send('subscribe', sub)
  }
  ws.onmessage = event => {
    if (socket !== ws || typeof event.data !== 'string') return
    lastMessage = Date.now()
    failures = 0
    // A throw inside a WebSocket handler is an uncaught exception in Node and would stop the server.
    try {
      const {channel, data} = JSON.parse(event.data)
      if (!data || !channel) return
      const feed = feeds.get(feedKey(channel, data.coin, data.user, data.dex))
      if (!feed) return
      if (channel !== 'userFills') feed.latest = data
      for (const listener of [...feed.listeners]) {
        try { listener(data) } catch (error) { console.error('Feed listener failed', channel, error) }
      }
    } catch (error) { console.error('Unreadable feed message', error) }
  }
  ws.onerror = () => ws.close()
  ws.onclose = () => {
    clearInterval(heartbeat)
    if (socket !== ws) return
    socket = undefined
    for (const feed of feeds.values()) delete feed.latest
    if (feeds.size) {
      reconnect = setTimeout(() => {
        reconnect = undefined
        connect()
      }, Math.min(15_000, 500 * 2 ** Math.min(failures++, 5)))
    }
  }
}

export function subscribe(sub: Subscription, listener: Listener): () => void {
  clearTimeout(idle)
  const key = feedKey(sub.type, sub.coin, sub.user, sub.dex)
  let feed = feeds.get(key)
  if (!feed) {
    feed = {sub, listeners: new Set()}
    feeds.set(key, feed)
    send('subscribe', sub)
  }
  feed.listeners.add(listener)
  if (feed.latest !== undefined) {
    const current = feed
    // The replay runs outside the socket handler's guard; a throw here would also stop the server.
    queueMicrotask(() => {
      if (!current.listeners.has(listener) || current.latest === undefined) return
      try { listener(current.latest) } catch (error) { console.error('Feed listener failed', sub.type, error) }
    })
  }
  connect()
  return () => {
    if (!feed.listeners.delete(listener) || feed.listeners.size) return
    feeds.delete(key)
    send('unsubscribe', sub)
    if (!feeds.size) {
      clearTimeout(reconnect)
      reconnect = undefined
      idle = setTimeout(() => {
        if (feeds.size) return
        socket?.close()
        socket = undefined
      }, 5000)
      idle.unref()
    }
  }
}
