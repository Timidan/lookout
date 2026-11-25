import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { FrontendOpenOrdersResponse } from '@nktkas/hyperliquid/api/info'
import type { Account, Position } from '../shared/api.js'
import { rankCards } from './cards.js'
import type { Market } from './venue.js'

test('one risk card per position, ordered before entries, portfolio actions and watch', () => {
  const position = (coin:string, size:string, mark:string, liq:string, pnl:string):Position => ({
    instrumentId:coin, symbol:coin, kind:'perp', size, entryPx:'100', markPx:mark, liqPx:liq, leverage:5,
    pnlUsd:pnl, pnlPct:'0', valueUsd:'100',
  })
  const positions = [position('A','-2','105','110','-10'), position('B','2','100','99','0'),
    position('C','2','91','88','-18'), position('D','-2','80','150','40'), position('E','2','102','50','4')]
  const catalog:Market[] = positions.map((p,asset)=>({ id:p.symbol, symbol:p.symbol, title:p.symbol, kind:'perp', asset,
    szDecimals:2, bid:null, ask:null, mid:null, quoteToken:'USDC', quoteIndex:0, quoteUsd:'1' }))
  const account:Account = { positions, address:'test owner', openOrders:[], equityUsd:'1000', freeUsd:'100', updatedAt:10 }
  const stop = (coin:string, oid:number, side:'A'|'B', triggerPx:string):FrontendOpenOrdersResponse[number] => ({
    oid,coin,side,triggerPx,isTrigger:true,orderType:'Stop Market',reduceOnly:true,sz:'2',origSz:'2',limitPx:triggerPx,
    isPositionTpsl:false,children:[],cloid:null,tif:null,triggerCondition:'trigger',timestamp:1,
  })
  const orders = [stop('A',1,'B','115'),stop('C',2,'A','89'),stop('D',3,'B','110'),stop('E',4,'A','90')]
  const parent:FrontendOpenOrdersResponse[number] = { ...stop('B',5,'B','0'), isTrigger:false, reduceOnly:false, orderType:'Limit',
    children:[stop('B',6,'A','97')] }
  // A child appearing as a separately active trigger excludes its linked parent from bulk cancellation.
  const retained = { ...parent, oid:7, children:[orders[0]] }
  const {cards,snapshot} = rankCards(account,[...orders,parent,retained],catalog,[catalog[0]])
  assert.deepEqual(cards.map(c=>c.kind),['liq_before_stop','no_stop','thin_buffer','stop_to_entry','position','step_away','close_all','watch'])
  assert.deepEqual(cards.slice(0,4).map(c=>c.action),[
    {type:'move_stop',instrumentId:'A',triggerPx:'107.5'}, {type:'add_stop',instrumentId:'B',triggerPx:'99.5'},
    {type:'reduce',instrumentId:'C',fraction:0.5}, {type:'move_stop',instrumentId:'D',triggerPx:'100'},
  ])
  assert.deepEqual(snapshot.entries.map(o=>o.oid),[5])
  assert.equal(snapshot.activeStopCount,4)
  assert.equal(snapshot.stops.A.oid,1)
  assert.equal(cards[2].buffer,0.25)
  assert.ok(cards.every(c=>c.line1.length<=40 && c.line2.length<=40))
  const resized = rankCards({...account,positions:[{...positions[1],size:'1'}]},[],catalog,[]).cards[0]
  assert.notEqual(resized.id,cards[1].id)
  assert.deepEqual(rankCards(null,[],catalog,[catalog[0]]).cards.map(c=>c.kind),['idle','watch'])
})

test('a price tick keeps the card id and changing its resting stop replaces it', () => {
  const market: Market = {id:'xyz:SOL', symbol:'xyz:SOL', title:'SOL', kind:'perp', asset:1, szDecimals:2,
    bid:null, ask:null, mid:null, quoteIndex:0, quoteToken:'USDC', quoteUsd:'1'}
  const position: Position = {instrumentId:market.id, symbol:market.symbol, kind:'perp', size:'1', entryPx:'77',
    markPx:'71', liqPx:'68', pnlUsd:'-6', pnlPct:'0', valueUsd:'71', leverage:10}
  const stop: FrontendOpenOrdersResponse[number] = {oid:1, coin:market.id, side:'A', triggerPx:'66', isTrigger:true,
    orderType:'Stop Market', reduceOnly:true, sz:'1', origSz:'1', limitPx:'66', isPositionTpsl:false,
    children:[], cloid:null, tif:null, triggerCondition:'trigger', timestamp:1}
  const account: Account = {address:'owner', equityUsd:'100', freeUsd:'90', updatedAt:1, positions:[position], openOrders:[]}
  const rank = (markPx:string, triggerPx:string) => rankCards({...account,positions:[{...position, markPx}]},
    [{...stop, triggerPx}], [market], []).cards[0]
  const first = rank('71', '66')
  assert.equal(first.line1, 'SOL long 10x · stop is too far')
  assert.equal(first.line2, 'Tap to move stop to 69.5')
  assert.equal(first.detail, 'Liquidation 68 comes before stop 66')
  assert.equal(first.id, rank('71.5','66').id)
  assert.notEqual(first.id, rank('71.5','67').id)
})
