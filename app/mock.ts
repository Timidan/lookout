// Development only. Canned local responses for the G2 simulator.
import { createServer } from 'node:http'
import { buffer } from 'node:stream/consumers'
import { createHash } from 'node:crypto'
import { exact, pnl, price, ticker, usd } from '../shared/format'
import type { Account, Card, CardAction, Instrument, Kind, OrderIntent, StreamEvent, Ticket } from '../shared/api'
const base = 'http://localhost:8788', code = 'SX3XG9', token = 'g2-local-demo'
const sampleAddress = process.env.SAMPLE_ADDRESS
// Optional demo latency makes loading and pending confirmations visible in the simulator.
const latency = Math.max(0, Number(process.env.MOCK_LATENCY_MS ?? 200) || 0)
let paired = false, pairExpiry = 0, lastOid = 71
function market(id: string, kind: Kind, symbol: string, bid: string, ask: string, szDecimals: number): Instrument {
  return { id, kind, symbol, title: symbol, bid, ask, mid: String((Number(bid) + Number(ask)) / 2), szDecimals,
    ...(kind === 'outcome' && { expiresAt: Date.now() + 86400000 }) }
}
const markets = [
  market('BTC','perp','BTC','61223','61283',5), market('ETH','perp','ETH','3089','3093',4),
  market('SOL','perp','SOL','70','70.2',3), market('xyz:NVDA','perp','NVDA','273.5','273.6',3),
  market('HYPE','perp','HYPE','28.9','29.1',3), market('PURR/USDC','spot','PURR','0.09','0.10',0),
  market('#100','outcome','BAL v HOU Yes','0.61','0.63',0), market('#102','outcome','Snow on Friday Yes','0.2','0.3',0),
]
// Generate one close per five-minute bucket. Shared buckets keep their values when the window advances.
let lastBucket = -1
function updateHour() {
  const bucket = Math.floor(Date.now() / 300000)
  if (lastBucket === bucket) return
  lastBucket = bucket
  for (const [index, m] of markets.entries()) {
    if (m.kind === 'outcome') continue
    const amplitude = m.kind === 'spot' ? 0.0002 : 0.012
    const closes = Array.from({ length: 12 }, (_, i) => Number(m.mid) *
      (1 + amplitude * (Math.sin((bucket - 11 + i + index) * 0.41) + 0.3 * Math.sin((bucket - 11 + i) * 0.83))))
    const high = Math.max(...closes), low = Math.min(...closes), minimumBand = Number(m.mid) * 0.003
    const band = Math.max(minimumBand, high - low)
    const floor = high - low < minimumBand ? Number(m.mid) - band / 2 : low
    m.spark = closes.map(value => '▁▂▃▄▅▆▇█'[Math.min(7, Math.max(0, Math.round((value-floor)*7/band)))]).join('')
    m.change1h = closes[11]! / closes[0]! - 1
    m.trend = closes.map(value => Math.round(1000 * Math.min(1, Math.max(0, (value-floor)/band))) / 1000)
    m.trendLow = String(floor)
    m.trendHigh = String(floor + band)
  }
}
updateHour()
const account: Account = { address: '0x0000000000000000000000000000000000000001', equityUsd: '1000', freeUsd: '900',
  updatedAt: Date.now(), positions: [], openOrders: [] }
for (const [id, size, entryPx, liqPx, leverage] of [
  ['SOL','2','71','68',10], ['xyz:NVDA','22','274.1','258',20], ['BTC','0.0016','62500','60640',10],
  ['ETH','1','3050','2800',5], ['HYPE','5','28.95','20',5],
] as const) {
  const m = markets.find(item => item.id === id)!, markPx = m.mid!
  account.positions.push({ instrumentId: id, kind: m.kind, symbol: m.symbol, size, entryPx, markPx, liqPx, leverage,
    valueUsd: String(+size * +markPx), pnlUsd: (+size * (+markPx - +entryPx)).toFixed(2), pnlPct: String((+markPx / +entryPx - 1) * 100) })
}
for (const [id, side, px, reduceOnly] of [
  ['BTC','buy','60400',false], ['ETH','buy','3020',false], ['HYPE','buy','28.5',false],
  ['SOL','sell','66',true], ['ETH','sell','2990',true], ['HYPE','sell','26',true], ['HYPE','sell','32',true],
] as const) account.openOrders.push({ oid: ++lastOid, instrumentId: id, symbol: id, side, size: '1', px, reduceOnly })

function stopCount() {
  return account.openOrders.filter(order => {
    const position = account.positions.find(p => p.instrumentId === order.instrumentId)
    return order.reduceOnly && position && (+position.size > 0 ? +order.px < +position.markPx : +order.px > +position.markPx)
  }).length
}
const dismissed = new Set<string>()
function cards(): Card[] {
  updateHour()
  const stack: Card[] = []
  if (!paired && sampleAddress) stack.push({ id: 'sample', kind: 'sample', line1: 'Sample account · read-only',
    line2: 'Tap to pair your wallet', action: { type: 'pair' }, confirm: 'tap' })
  const pos = account.positions, orders = account.openOrders
  function add(kind: Card['kind'], line1: string, line2: string, action?: CardAction, detail?: string, symbol?: string, buffer?: number) {
    const id = action && 'instrumentId' in action ? action.instrumentId : undefined
    const positions = id ? pos.filter(p => p.instrumentId === id) : pos
    const affected = kind === 'watch' || kind === 'idle' ? [] : positions.map(p => [p.instrumentId, p.size, p.entryPx])
    const relevant = kind === 'watch' || kind === 'idle' ? [] : orders.filter(o => !id || o.instrumentId === id).map(o => [o.oid, o.px])
    const sig = createHash('sha256').update(JSON.stringify([kind, id, affected, relevant])).digest('hex').slice(0, 14)
    const card: Card = { id: kind + '-' + sig, kind, line1, line2, detail, symbol, action, buffer,
      confirm: action && (['reduce','cancel_entries','close_all'].includes(action.type) ? 'hold' : 'tap') }
    if (kind === 'position' || kind === 'watch') {
      const m = markets.find(m => m.id === id)
      card.spark = m?.spark
      card.change1h = m?.change1h
      card.trend = m?.trend
      card.trendLow = m?.trendLow
      card.trendHigh = m?.trendHigh
      if (kind === 'position' && m?.mid) {
        const levels = orders.filter(o => o.instrumentId === id && o.reduceOnly).map(o => +o.px)
        const stop = levels.find(px => px < Number(m.mid)), target = levels.find(px => px > Number(m.mid))
        if (stop !== undefined && target !== undefined) card.toTarget = (+m.mid - stop) / (target-stop)
      }
    }
    if (!dismissed.has(card.id)) stack.push(card)
  }
  for (const [kind, id] of [['liq_before_stop','SOL'], ['no_stop','xyz:NVDA'], ['thin_buffer','BTC'], ['stop_to_entry','ETH'], ['position','HYPE']] as const) {
    const p = pos.find(item => item.instrumentId === id)
    if (!p) continue
    const sym = ticker(p.symbol), name = sym + (+p.size < 0 ? ' short' : ' long')
    const stop = orders.find(o => o.instrumentId === id && o.reduceOnly && +o.px < +p.markPx)
    if (kind === 'liq_before_stop' && stop && +stop.px < +p.liqPx!) add(kind, name + ' ' + p.leverage + 'x · stop is too far', 'Tap to move stop to ' + exact('69.5'), { type:'move_stop', instrumentId:id, triggerPx:'69.5' }, 'Liquidation '+price(p.liqPx)+' comes before stop '+exact(stop.px), sym)
    if (kind === 'no_stop' && !stop) add(kind, name + ' ' + p.leverage + 'x has no stop', 'Tap to set stop at ' + exact('272.23'), {type:'add_stop', instrumentId:id, triggerPx:'272.23'}, 'Entry '+price(p.entryPx)+' · now '+price(p.markPx)+' · '+pnl(p.pnlUsd), sym)
    if (kind === 'thin_buffer' && p.size === '0.0016') add(kind, name + ' ' + p.leverage + 'x is near liquidation', 'Hold to reduce by half', {type:'reduce',instrumentId:id,fraction:0.5}, 'Now '+price(p.markPx)+' · liquidation '+price(p.liqPx), sym, Math.max(0, Math.min(1, (+p.markPx - Number(p.liqPx)) / (+p.entryPx - Number(p.liqPx)))))
    if (kind === 'stop_to_entry' && stop && +stop.px < +p.entryPx) add(kind, name + ' is up ' + pnl(p.pnlUsd), 'Tap to move stop to entry '+exact(p.entryPx), {type:'move_stop',instrumentId:id,triggerPx:p.entryPx}, 'Stop now '+exact(stop.px), sym)
    if (kind === 'position') add(kind, name+' '+exact(p.size)+' · '+pnl(p.pnlUsd), 'Tap to trade '+sym, {type:'open_market', instrumentId:id}, (stop ? 'Stop '+exact(stop.px)+' · ' : '')+'liquidation '+price(p.liqPx), sym)
  }
  const entries = orders.filter(o => !o.reduceOnly).length
  if (entries) add('step_away', entries+' buy orders waiting', 'Hold to cancel them',{type:'cancel_entries'},'Your '+stopCount()+' stops stay on the exchange')
  if (pos.length) add('close_all', pos.length+' positions open · '+pnl(pos.reduce((n,p)=>n + +p.pnlUsd,0)), 'Hold to close all '+pos.length,{type:'close_all'})
  for (const m of markets.filter(m => ['BTC','ETH','PURR/USDC','#100','#102'].includes(m.id))) {
    const sym = ticker(m.symbol)
    add('watch',sym+' '+price(m.mid),'Tap to trade '+sym,{type:'open_market',instrumentId:m.id},'Bid '+price(m.bid)+' · ask '+price(m.ask),sym)
  }
  if (!pos.length && !orders.length) add('idle','Nothing open','Hold to speak a trade')
  return stack
}
function act(action: CardAction): string {
  if (action.type === 'pair') throw Error('Use the pairing screen to connect')
  if (action.type === 'open_market') return 'Opened ' + ticker(action.instrumentId)
  if (action.type === 'close_all') {
    const count = account.positions.length
    account.positions = []
    account.openOrders = account.openOrders.filter(order => !order.reduceOnly)
    return 'Closed ' + count + ' positions'
  }
  if (action.type === 'cancel_entries') {
    const entries = account.openOrders.filter(o => !o.reduceOnly).length
    account.openOrders = account.openOrders.filter(o => o.reduceOnly)
    return `Cancelled ${entries} orders · ${stopCount()} stops kept`
  }
  const position = account.positions.find(p => p.instrumentId === action.instrumentId)
  if (!position) throw Error('Position is already closed')
  if (action.type === 'reduce') {
    position.size = String(Number(position.size) * (1 - action.fraction))
    position.valueUsd = String(Math.abs(Number(position.size)) * Number(position.markPx))
    position.pnlUsd = String(Number(position.size) * (Number(position.markPx) - Number(position.entryPx)))
    return 'Reduced '+ticker(position.symbol)+' by half'
  }
  account.openOrders = account.openOrders.filter(o => o.instrumentId !== position.instrumentId || !o.reduceOnly || +o.px > +position.markPx)
  account.openOrders.push({ oid: ++lastOid, instrumentId: position.instrumentId, symbol: position.symbol, side: 'sell', size: position.size, px: action.triggerPx, reduceOnly: true })
  return `${action.type === 'add_stop' ? 'Stop set' : 'Stop moved'} at ${exact(action.triggerPx)}`
}
const tickets = new Map<string, Ticket>()
function quote(intent: OrderIntent): Ticket {
  const instrument = markets.find(m => m.id === intent.instrumentId)
  if (!instrument) throw Error('Unknown market')
  const px = (intent.side === 'buy' ? instrument.ask : instrument.bid)!
  const amount = intent.usd ?? '15', size = intent.size ?? (Number(amount) / Number(px)).toFixed(instrument.szDecimals)
  if (!(Number(size) > 0)) throw Error('Size is too small')
  const perp = instrument.kind === 'perp' && !intent.reduceOnly, direction = intent.side === 'buy' ? 1 : -1
  const verb = intent.reduceOnly ? 'Close' : perp ? (direction === 1 ? 'Long' : 'Short') : (direction === 1 ? 'Buy' : 'Sell')
  const leverage = intent.leverage ?? 5, entry = Number(px)
  const ticket: Ticket = { id: crypto.randomUUID(), expiresAt: Date.now() + 30000, instrument, side: intent.side, size, px, estPx: px,
    notionalUsd: String(Number(size) * Number(px)), reduceOnly: !!intent.reduceOnly,
    assumed: !intent.usd && !intent.size ? 'your usual' : undefined, leverage: perp ? leverage : undefined,
    ...(perp && intent.bracket !== false && { stopPx: intent.stopPx ?? (entry * (1 - 0.02 * direction)).toFixed(2), targetPx: intent.targetPx ?? (entry * (1 + 0.04 * direction)).toFixed(2) }),
    summary: instrument.kind === 'outcome' ? verb+' '+exact(size)+' '+instrument.symbol.split(' ').at(-1)+' · '+instrument.title.replace(/ (Yes|No)$/, '')
      : verb+' '+ticker(instrument.symbol)+' '+usd(intent.size ? +size*entry : amount)+(perp ? ' · '+leverage+'x' : ''),
    warnings: instrument.id === 'BTC' || instrument.id === '#100' ? ['Thin book · fills may be partial'] : [] }
  tickets.set(ticket.id, ticket); return ticket
}
createServer(async (req, res) => {
  const { pathname: path, searchParams: p } = new URL(req.url!, base), route = req.method + ' ' + path
  res.setHeaders(new Headers({ 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS' }))
  const json = (body: unknown, status = 200) => res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(body))
  const fail = (message: string, status = 400) => json({ error: { code: 'mock_error', message } }, status)
  try {
    if (req.method === 'OPTIONS') return res.writeHead(204).end()
    if (req.method === 'POST' && path !== '/pair' && latency) await new Promise(resolve => setTimeout(resolve, latency))
    if (route === 'POST /api/pair/start') {
      paired = false; pairExpiry = Date.now() + 300000
      return json({ code, deviceToken: token, pairUrl: `${base}/pair?code=${code}`, expiresAt: pairExpiry })
    }
    if (path === '/pair' && p.get('code') === code && Date.now() < pairExpiry) {
      if (req.method === 'POST') paired = true
      return res.writeHead(200, { 'Content-Type': 'text/html' }).end(paired ? 'Demo glasses paired.' : '<form method="post"><button>Pair demo glasses</button></form>')
    }
    if (!pairExpiry || (req.headers.authorization !== 'Bearer ' + token && !(route === 'GET /api/stream' && p.get('token') === token))) return fail('Unknown device', 401)
    if (route === 'GET /api/pair/status') return json(paired ? { paired, address: account.address } : { paired, sample: !!sampleAddress })
    if (route === 'POST /api/unpair') { paired = false; return json({ ok: true }) }
    if (!paired && !sampleAddress) return fail('Pair your wallet to continue', 403)
    if (!paired && req.method !== 'GET') return fail('Sample account. Pair to trade', 403)
    if (route === 'GET /api/next') return json(cards())
    if (route === 'GET /api/account') return json(!paired && sampleAddress ? { ...account, address: sampleAddress } : account)
    if (route === 'GET /api/markets') return json(markets.filter(m => (!p.get('kind') || m.kind === p.get('kind')) &&
      (m.id + m.symbol).toLowerCase().includes((p.get('q') || '').toLowerCase())).slice(0, Number(p.get('limit') || 20)))
    if (route.startsWith('GET /api/markets/')) {
      updateHour()
      const found = markets.find(m => m.id === decodeURIComponent(path.slice(13)))
      return found ? json(found) : fail('Unknown market', 404)
    }
    if (route === 'GET /api/stream') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
      const send = (event: StreamEvent) => res.write('data: ' + JSON.stringify(event) + '\n\n')
      const tick = () => { send({ type: 'next', cards: cards() }); send({ type: 'account', account: !paired && sampleAddress ? { ...account, address: sampleAddress } : account }); for (const instrument of markets) if (p.get('watch')?.split(',').includes(instrument.id)) send({ type: 'quote', instrument }) }
      tick(); const timer = setInterval(tick, 3000); res.on('close', () => clearInterval(timer)); return
    }
    if (route.startsWith('DELETE /api/orders/')) {
      const index = account.openOrders.findIndex(o => String(o.oid) === path.slice(12) && o.instrumentId === p.get('instrumentId'))
      if (index < 0) return fail('Order not found', 404)
      account.openOrders.splice(index, 1); return json({ ok: true })
    }
    const raw = await buffer(req)
    if (route === 'POST /api/say') {
      const { text } = JSON.parse(raw.toString()) as { text?: string }
      return json({ transcript: text ?? '', ticket: quote({ instrumentId: 'BTC', side: 'buy' }) })
    }
    if (route === 'POST /api/voice') {
      if (req.headers['content-type'] !== 'application/octet-stream' || raw.length % 2) return fail('Expected 16-bit PCM')
      if (raw.length < 9600) return json({ transcript: '', reply: 'Please speak again' })
      const intent: OrderIntent = { instrumentId: 'BTC', side: 'buy' }
      if (raw.length < 38400) return json({ transcript: 'Buy fifteen or fifty', reply: '$15 or $50?', choices: ['15', '50'].map(amount => ({ label: usd(amount), intent: { ...intent, usd: amount } })) })
      return json({ transcript: 'Long BTC', ticket: quote(intent) })
    }
    const body = raw.length ? JSON.parse(raw.toString()) : {}
    if (route === 'POST /api/cards/act') {
      const current = cards().find(c => c.id === body.id)
      if (!current) return fail('That changed. Showing the latest', 409)
      if (!current.action) return fail('No action on this card')
      if (current.action.type === process.env.MOCK_REJECT_ACTION) return json({ ok: false, message: 'The stop price moved' })
      const message = act(current.action)
      dismissed.add(current.id)
      account.updatedAt = Date.now()
      return json({ ok: true, message })
    }
    if (route === 'POST /api/tickets') return json(quote(body))
    if (route === 'POST /api/positions/close') {
      const position = account.positions.find(x => x.instrumentId === body.instrumentId)
      if (!position) return fail('No position')
      return json(quote({ instrumentId: position.instrumentId, side: Number(position.size) < 0 ? 'buy' : 'sell', size: String(Math.abs(Number(position.size)) * (body.fraction ?? 1)), reduceOnly: true }))
    }
    if (/^POST \/api\/tickets\/[^/]+\/confirm$/.test(route)) {
      const ticket = tickets.get(path.split('/')[3]!)
      if (!ticket || Date.now() >= ticket.expiresAt) return fail('Price expired', 410)
      tickets.delete(ticket.id)
      const { instrument: m, side, size, px } = ticket, position = account.positions.find(x => x.instrumentId === m.id)
      const buying = side === 'buy' && !ticket.reduceOnly
      if (buying && m.id === '#102') return json({ status: 'rejected', filledSize: '0', message: 'Not enough free collateral' })
      if (buying && m.id === 'ETH' && size === (20 / Number(px)).toFixed(m.szDecimals)) {
        account.openOrders.push({ oid: ++lastOid, instrumentId: m.id, symbol: m.symbol, side, size, px, reduceOnly: false })
        return json({ status: 'resting', oid: lastOid, filledSize: '0', message: 'Resting on the demo book' })
      }
      const partial = buying && m.id === '#100' && Number(size) > 1
      const filledSize = partial ? String(Math.floor(Number(size) / 2)) : size
      const nextSize = Number(((Number(position?.size) || 0) + Number(filledSize) * (side === 'buy' ? 1 : -1)).toFixed(m.szDecimals))
      account.positions = account.positions.filter(x => x.instrumentId !== m.id)
      if (nextSize) account.positions.unshift({ instrumentId: m.id, kind: m.kind, symbol: m.symbol, size: String(nextSize), entryPx: px, markPx: px, leverage: ticket.leverage, valueUsd: String(Math.abs(nextSize) * Number(px)), pnlUsd: '0', pnlPct: '0' })
      if (ticket.stopPx && ticket.targetPx && nextSize) {
        for (const level of [ticket.stopPx, ticket.targetPx]) account.openOrders.push({
          oid: ++lastOid, instrumentId: m.id, symbol: m.symbol, side: side === 'buy' ? 'sell' : 'buy', size: filledSize, px: level, reduceOnly: true })
      }
      account.updatedAt = Date.now()
      return json({ status: partial ? 'partial' : 'filled', filledSize, avgPx: px, message: ticket.stopPx && ticket.targetPx && nextSize ? 'Stop and target set' : partial ? 'Only part of the size was available' : undefined })
    }
    return fail('Route not found', 404)
  } catch (error) { return fail(error instanceof Error ? error.message : 'Bad request') }
}).listen(8788, 'localhost', () => console.log('Development mock listening at ' + base))
