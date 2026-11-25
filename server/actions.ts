import { createHash, randomUUID } from 'node:crypto'
import { HTTPException } from 'hono/http-exception'
import type { ActResult, Card, OrderResult } from '../shared/api.js'
import { exact, ticker } from '../shared/format.js'
import { nextStack, type CardSnapshot } from './cards.js'
import { agent, db, sampleAddress, sampleWarning, type device } from './pair.js'
import { cancel, placePositionStop, recoverOrder, venueReason } from './signing.js'
import { closePosition, confirmLocked, owner, withOwnerAction } from './tickets.js'
import { market } from './venue.js'

type Device = ReturnType<typeof device>
type Run = { nonce:string; result:string|null }
db.exec('CREATE TABLE IF NOT EXISTS card_runs(owner TEXT, card TEXT, nonce TEXT NOT NULL, result TEXT, PRIMARY KEY(owner,card))')
const changed = () => new HTTPException(409,{message:'That changed. Showing the latest'})
const sampleCard: Card = {id:'sample',kind:'sample',line1:'Sample account · read-only',line2:'Tap to pair your wallet',
  action:{type:'pair'},confirm:'tap'}

// A stable card ID identifies the position. Keep its displayed stop until that price becomes unsafe.
const shown = new Map<string,{time:number; stops:Map<string,Card>}>()
function safeStop(card: Card, snapshot: CardSnapshot) {
  const action = card.action
  if (!action || !('triggerPx' in action)) return false
  const p = snapshot.account?.positions.find(p => p.instrumentId === action.instrumentId)
  if (!p) return false
  const sign = Math.sign(Number(p.size)), trigger = Number(action.triggerPx)
  return (Number(p.markPx)-trigger)*sign > 0 && (!p.liqPx || (trigger-Number(p.liqPx))*sign > 0)
}

export function displayedCards(deviceId:string, stack:Awaited<ReturnType<typeof nextStack>>) {
  const now = Date.now()
  for (const [id,item] of shown) if (now-item.time > 600_000) shown.delete(id)
  if (stack.cards[0]?.kind === 'sample') { shown.delete(deviceId); return stack.cards }
  const previous = shown.get(deviceId)?.stops, stops = new Map<string,Card>()
  const cards = stack.cards.map(card => {
    if (!card.action || !('triggerPx' in card.action)) return card
    const old = previous?.get(card.id)
    const display = old && safeStop(old,stack.snapshot) ? {...card,line2:old.line2,action:old.action} : card
    stops.set(card.id,display)
    return display
  })
  if (stops.size) shown.set(deviceId,{time:now,stops})
  else shown.delete(deviceId)
  return cards
}

export async function currentStack(address: string | null) {
  const stack = await nextStack(address ?? sampleAddress ?? null)
  if (!address && sampleAddress) stack.cards.unshift(sampleCard)
  if (address) {
    // A later occurrence of the same condition is a new actionable card once its prior occurrence disappeared.
    const ids = new Set(stack.cards.map(c => c.id))
    for (const row of db.prepare('SELECT card FROM card_runs WHERE owner=? AND result IS NOT NULL').all(address)) {
      if (!ids.has(String(row.card))) db.prepare('DELETE FROM card_runs WHERE owner=? AND card=? AND result IS NOT NULL').run(address,row.card)
    }
  }
  return stack
}

async function execute(s: Device, card: Card, snapshot: CardSnapshot, nonce: string, replay: boolean): Promise<ActResult> {
  const a = card.action!, address = owner(s), account = snapshot.account!
  if (a.type === 'add_stop' || a.type === 'move_stop') {
    const p = account.positions.find(p => p.instrumentId === a.instrumentId)
    if (!p) throw changed()
    const m = await market(a.instrumentId)
    const result = replay ? await recoverOrder(address,nonce,'0') :
      await placePositionStop(agent(s.id),m,p.size.startsWith('-'),a.triggerPx,nonce,address)
    if (!result) throw new HTTPException(503,{message:'Stop pending. Check open orders'})
    if (result.status !== 'resting' || result.oid === undefined) {
      return {ok:false,message:venueReason(result.message ?? 'Stop unconfirmed. Check open orders'),results:[result]}
    }
    const old = snapshot.stops[m.id]
    if (a.type === 'move_stop' && old && old.oid !== result.oid) {
      try { await cancel(agent(s.id),m,old.oid) }
      catch {
        const after = await nextStack(address)
        if (after.snapshot.account?.openOrders.some(o => o.oid === old.oid)) {
          return {ok:false,message:'Both stops are active. Check open orders',results:[result]}
        }
      }
    }
    return {ok:true,message:replay ? 'Stop active on the exchange' :
      (a.type === 'move_stop' ? 'Stop moved to ' : 'Stop set at ')+exact(a.triggerPx),results:[result]}
  }

  if (a.type === 'cancel_entries') {
    let count = 0, failed = ''
    for (const o of snapshot.entries) {
      try { await cancel(agent(s.id),o.market,o.oid); count++ }
      catch (e) { failed ||= e instanceof HTTPException ? venueReason(e.message) : 'Cancel unconfirmed. Check open orders' }
    }
    const after = await nextStack(address).catch(() => null)
    const stops = after?.snapshot.activeStopCount
    const message = `Cancelled ${exact(count)} order${count === 1 ? '' : 's'} · `+
      (stops === undefined ? 'check stops' : `${exact(stops)} stop${stops === 1 ? '' : 's'} kept`)
    return {ok:!failed && !!after,message:failed || message.slice(0,40)}
  }

  if (a.type !== 'reduce' && a.type !== 'close_all') throw changed()
  const targets = account.positions.filter(p => p.kind === 'perp' && (a.type === 'close_all' || p.instrumentId === a.instrumentId))
    .sort((x,y) => x.instrumentId.localeCompare(y.instrumentId))
  const results: OrderResult[] = []
  let unresolved = 0
  for (const p of targets) {
    const hex = createHash('sha256').update(nonce+'|'+p.instrumentId).digest('hex').slice(0,32)
    const id = [hex.slice(0,8),hex.slice(8,12),hex.slice(12,16),hex.slice(16,20),hex.slice(20)].join('-')
    const existing = db.prepare('SELECT device FROM tickets WHERE id=?').get(id)
    try {
      if (!existing) await closePosition(s,p.instrumentId,a.type === 'reduce' ? a.fraction : 1,account,id)
      const result = await confirmLocked(s,id,existing ? String(existing.device) : s.id)
      results.push({...result,message:(ticker(p.symbol)+(result.message ? ' · '+venueReason(result.message) : '')).slice(0,60)})
    } catch (e) {
      const row = db.prepare('SELECT state FROM tickets WHERE id=?').get(id)
      if (row?.state === 'sending') { unresolved++; continue }
      const message = e instanceof HTTPException ? venueReason(e.message) : 'Close unavailable. Try again'
      results.push({status:'rejected',filledSize:'0',message:(ticker(p.symbol)+' · '+message).slice(0,60)})
    }
  }
  if (unresolved) return {ok:false,message:`${exact(unresolved)} pending. Check open orders`,results}
  const filled = results.filter(r => r.status === 'filled').length
  const failure = results.find(r => r.status !== 'filled')
  const message = failure ? (failure.message?.split(' · ').slice(1).join(' · ') ||
    (failure.status === 'partial' ? 'Partly filled. Check your position' : 'Close unconfirmed. Check open orders'))
    : a.type === 'reduce' ? `Reduced ${card.symbol} by half` : `Closed ${exact(filled)} position${filled === 1 ? '' : 's'}`
  return {ok:targets.length > 0 && filled === targets.length,message:message.slice(0,40),results}
}

export async function actOnCard(s: Device, id: unknown): Promise<ActResult> {
  if (typeof id !== 'string' || !id || id.length > 200) throw new HTTPException(400,{message:'Choose a card.'})
  // Navigation is valid even while the device is waiting for wallet pairing.
  if (!s.address) {
    if (sampleAddress) {
      if (id === sampleCard.id) return {ok:true,message:'Pair your wallet'}
      if (!/^(?:position|watch):/.test(id)) throw new HTTPException(403,{message:sampleWarning})
    }
    const card = (await currentStack(null)).cards.find(c => c.id === id)
    if (card?.action?.type === 'open_market') return {ok:true,message:'Open market'}
    if (sampleAddress) throw new HTTPException(403,{message:sampleWarning})
    if (!card) throw changed()
    throw new HTTPException(403,{message:'Pair your wallet to trade'})
  }
  const address = owner(s)
  return withOwnerAction(address,async () => {
    const {cards,snapshot} = await currentStack(address)
    const card = cards.find(c => c.id === id)
    if (!card) throw changed()
    if (!card.action) throw new HTTPException(400,{message:'This card has no action.'})
    if (card.action.type === 'open_market') return {ok:true,message:'Open market'}
    const previous = db.prepare('SELECT nonce,result FROM card_runs WHERE owner=? AND card=?').get(address,id) as Run|undefined
    if (previous?.result) return JSON.parse(previous.result)
    const nonce = previous?.nonce ?? randomUUID()
    let approved = card
    if (!previous && 'triggerPx' in card.action) {
      const displayed = shown.get(s.id)?.stops.get(id)
      if (!displayed || !safeStop(displayed,snapshot)) throw changed()
      approved = displayed
    }
    if (!previous) db.prepare('INSERT INTO card_runs(owner,card,nonce) VALUES(?,?,?)').run(address,id,nonce)
    const result = await execute(s,approved,snapshot,nonce,!!previous)
    if (result.ok || result.results?.some(r => r.status !== 'rejected') && !result.message.includes('pending')) {
      db.prepare('UPDATE card_runs SET result=? WHERE owner=? AND card=?').run(JSON.stringify(result),address,id)
    } else if (!result.message.includes('pending')) {
      db.prepare('DELETE FROM card_runs WHERE owner=? AND card=?').run(address,id)
    }
    return result
  })
}
