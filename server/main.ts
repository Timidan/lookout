import { serve } from '@hono/node-server'
import { getConnInfo } from '@hono/node-server/conninfo'
import { serveStatic } from '@hono/node-server/serve-static'
import { Hono, type Context } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { cors } from 'hono/cors'
import { HTTPException } from 'hono/http-exception'
import type { SayResult } from '../shared/api.js'
import { exact, ticker } from '../shared/format.js'
import { numberChoices, parseCommand, searchMarkets } from './commands.js'
import { actOnCard, currentStack, displayedCards } from './actions.js'
import { agent, device, registerPair, sampleAddress } from './pair.js'
import { cancel } from './signing.js'
import { stream } from './stream.js'
import { closePosition, confirm, owner, preview, withOwnerAction } from './tickets.js'
import { account, accountMarkets, hydrateQuotes, market, marketHistory, markets, publicInstrument } from './venue.js'
import { transcribe } from './voice.js'

const app = new Hono()
const allowed = (process.env.ALLOWED_ORIGINS ?? 'http://localhost:5173').split(',').map(s => s.trim()).filter(Boolean)
app.use('/api/*', cors({origin:allowed, allowMethods:['GET','POST','DELETE','OPTIONS'], allowHeaders:['Authorization','Content-Type']}))
app.use('/api/*', async (c, next) => {
  c.header('Cache-Control', 'no-store')
  await next()
})
const tooLarge = () => { throw new HTTPException(413, {message:'Request body is too large.'}) }
app.use('/api/*', (c, next) => bodyLimit({maxSize:c.req.path === '/api/voice' ? 32_000 * 60 : 16_384, onError:tooLarge})(c, next))
// Anyone can start a device session, so each client address gets a per-minute budget: new sessions and
// speech-to-text are the costly calls; everything else is capped so one client can't exhaust the venue's rate limit.
// ponytail: in-memory fixed window, one process; behind the edge proxy the last X-Forwarded-For entry is the client.
const hits = new Map<string,{count:number; reset:number}>()
app.use('/api/*', async (c, next) => {
  const path = c.req.path
  const [group, max] = path === '/api/pair/start' ? ['pair', 10] : path === '/api/voice' ? ['voice', 20] : ['api', 300]
  const ip = c.req.header('X-Forwarded-For')?.split(',').at(-1)?.trim() || getConnInfo(c).remote.address || ''
  const key = group + ' ' + ip, now = Date.now(), hit = hits.get(key)
  if (!hit || hit.reset <= now) {
    if (hits.size > 10_000) for (const [k, h] of hits) if (h.reset <= now) hits.delete(k)
    hits.set(key, {count:1, reset:now + 60_000})
  } else if (++hit.count > max) throw new HTTPException(429, {message:'Too many requests. Wait a minute'})
  await next()
})
const messages: Record<number,string> = {400:'bad_request',401:'invalid_device',403:'forbidden',404:'not_found',
  409:'conflict',410:'expired',413:'too_large',415:'unsupported_media',422:'venue_rejected',429:'rate_limited',
  500:'internal_error',502:'upstream_error',503:'unavailable',504:'timeout'}
app.onError((error, c) => {
  if (!(error instanceof HTTPException)) console.error(c.req.method, c.req.path, error)
  const status = error instanceof HTTPException ? error.status : 500
  const message = error instanceof HTTPException ? error.message : 'Request interrupted. Try again'
  return c.json({error:{code:messages[status] ?? 'request_failed',message:message.replace(/\.+$/,'').slice(0,60).trimEnd()}}, status)
})
app.notFound(c => c.json({error:{code:'not_found',message:'Page not found. Go back'}}, 404))
registerPair(app)

function session(c: Context) {
  return device(/^Bearer ([0-9a-f]{64})$/i.exec(c.req.header('Authorization') ?? '')?.[1] ?? '')
}
async function json(c: Context) {
  const value = await c.req.json().catch(() => null)
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HTTPException(400, {message:'Send a JSON object.'})
  return value
}

app.get('/api/markets', async c => {
  session(c)
  const {q = '', kind, limit = '12'} = c.req.query()
  if (kind && !['spot','perp','outcome'].includes(kind)) throw new HTTPException(400, {message:'Unknown market kind.'})
  if (!/^\d+$/.test(limit) || Number(limit) > 100) throw new HTTPException(400, {message:'Choose a market limit from 0 to 100.'})
  const list = await markets()
  const matches = searchMarkets(q, kind ? list.filter(m => m.kind === kind) : list)
  return c.json((await hydrateQuotes(matches.slice(0, Number(limit)))).map(publicInstrument))
})
app.get('/api/markets/:id{.+}', async c => {
  session(c)
  const m = await market(c.req.param('id'))
  return c.json(publicInstrument({...m,...await marketHistory(m.id)}))
})
app.get('/api/next', async c => {
  const s = session(c)
  return c.json(displayedCards(s.id,await currentStack(s.address)))
})
app.post('/api/cards/act', async c => c.json(await actOnCard(session(c),(await json(c)).id)))
app.get('/api/account', async c => {
  const s = session(c)
  // An unpaired device may read the sample account. Every write still requires a paired owner.
  return c.json(await account(s.address ?? sampleAddress ?? owner(s)))
})
app.post('/api/tickets', async c => c.json(await preview(session(c), await json(c))))
app.post('/api/tickets/:id/confirm', async c => c.json(await confirm(session(c), c.req.param('id'))))
app.post('/api/positions/close', async c => {
  const s = session(c)
  const body = await json(c)
  return c.json(await closePosition(s, body.instrumentId, body.fraction))
})
app.delete('/api/orders/:oid', async c => {
  const s = session(c)
  owner(s)
  const id = c.req.query('instrumentId')
  const raw = c.req.param('oid')
  const oid = Number(raw)
  if (!id || !/^\d+$/.test(raw) || !Number.isSafeInteger(oid) || oid < 1) {
    throw new HTTPException(400, {message:'Give a valid order ID and instrument.'})
  }
  const m = (await accountMarkets()).find(item => item.id === id && item.asset >= 0)
  if (!m) throw new HTTPException(404, {message:'Unknown order instrument.'})
  await withOwnerAction(owner(s), () => cancel(agent(s.id), m, oid))
  return c.json({ok:true})
})

async function say(s: ReturnType<typeof device>, transcript: unknown, voice = false): Promise<SayResult> {
  if (typeof transcript !== 'string' || transcript.length > 512) throw new HTTPException(400, {message:'Use a short text command.'})
  let list = await markets()
  const isClose = /^\s*close\b/i.test(transcript)
  const isCancel = /^\s*cancel\b/i.test(transcript)
  const snapshot = s.address && (isClose || isCancel) ? await account(s.address) : null
  if (snapshot) {
    const ids = new Set((isClose ? snapshot.positions : snapshot.openOrders).map(p => p.instrumentId))
    if (!ids.size) return {transcript,reply:isClose ? 'No open positions' : 'No open orders'}
    list = list.filter(m => ids.has(m.id))
  }
  const command = parseCommand(transcript, list)
  if (command.type === 'order') {
    const check = voice && numberChoices(command.intent)
    if (check) return {transcript,...check}
    return {transcript,ticket:await preview(s, command.intent)}
  }
  if (command.type === 'close') return {transcript,ticket:await closePosition(s, command.instrumentId, command.fraction, snapshot)}
  if (command.type === 'cancel') {
    owner(s)
    const orders = snapshot!.openOrders.filter(o => o.instrumentId === command.instrumentId)
    if (!orders.length) return {transcript,reply:'No matching open orders'}
    // The contract represents cancellation only via DELETE /api/orders/:oid.
    const which = exact(orders.length)+' '+ticker(orders[0].symbol)+(orders.length === 1 ? ' order' : ' orders')
    return {transcript,reply:('Open orders to cancel ' + which).slice(0,60)}
  }
  return {transcript,reply:command.reply}
}
app.post('/api/say', async c => {
  const s = session(c)
  return c.json(await say(s, (await json(c)).text))
})
app.post('/api/voice', async c => {
  const s = session(c)
  if (c.req.header('Content-Type')?.split(';')[0].trim().toLowerCase() !== 'application/octet-stream') {
    throw new HTTPException(415, {message:'Send audio as application/octet-stream.'})
  }
  return c.json(await say(s, await transcribe(await c.req.arrayBuffer()), true))
})
app.get('/api/stream', async c => {
  const token = c.req.query('token') ?? ''
  const watch = [...new Set((c.req.query('watch') ?? '').split(',').map(s => s.trim()).filter(Boolean))]
  return stream(token, watch, c.req.raw.signal)
})

// The hosted build serves the glasses app from the same origin as the API.
if (process.env.STATIC_DIR) app.use('*', serveStatic({root:process.env.STATIC_DIR}))

const port = Number(process.env.PORT ?? 8790)
if (!Number.isInteger(port) || port < 1 || port > 65535 || port === 8788) throw new Error('Invalid server PORT. Port 8788 is reserved for the mock.')
if (!/^(?:\d+(?:\.\d{1,18})?|\.\d{1,18})$/.test(process.env.MAX_ORDER_USD ?? '200') || Number(process.env.MAX_ORDER_USD ?? '200') <= 0) throw new Error('MAX_ORDER_USD must be positive.')
const slippage = Number(process.env.SLIPPAGE_BPS ?? 100)
if (!Number.isInteger(slippage) || slippage < 0 || slippage >= 10_000) throw new Error('SLIPPAGE_BPS must be 0 to 9999.')
serve({fetch:app.fetch, port}, () => console.log('Hyperliquid testnet backend listening on port ' + port))
