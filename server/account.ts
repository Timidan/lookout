import { HTTPException } from 'hono/http-exception'
import type { ActiveAssetDataResponse, ClearinghouseStateResponse, FrontendOpenOrdersResponse, PortfolioResponse, SpotClearinghouseStateResponse, TokenDetailsResponse, UserAbstractionResponse } from '@nktkas/hyperliquid/api/info'
import type { Account, Position, Ticket } from '../shared/api.js'
import { price, ticker } from '../shared/format.js'
import { dec as money, min, one as unit, print } from './pricing.js'
import { accountMarkets, decimal, info, type Market } from './venue.js'
import { subscribe } from './ws.js'

type Spot = SpotClearinghouseStateResponse
type Bal = Spot['balances'][number]
type States = [string, ClearinghouseStateResponse][]

function allPerpStates(owner: string): Promise<States> {
  return new Promise((resolve, reject) => {
    const done = subscribe({ type: 'allDexsClearinghouseState', user: owner }, data => {
      clearTimeout(timer)
      done()
      if (Array.isArray(data.clearinghouseStates)) resolve(data.clearinghouseStates)
      else reject(new HTTPException(502, { message: 'Wait for live prices' }))
    })
    const timer = setTimeout(() => { done(); reject(new HTTPException(502, { message: 'Wait for live prices' })) }, 8_000)
  })
}

function available(spot: Spot, balance: Bal | undefined) {
  if (!balance) return 0n
  const cash = money(balance.total) - money(balance.hold)
  const maintenance = 'token' in balance ? spot.tokenToAvailableAfterMaintenance?.find(([i]) => i === balance.token)?.[1] : undefined
  const free = maintenance === undefined ? cash : min(cash, money(maintenance))
  return free > 0n ? free : 0n
}

function spotPosition(balance: Bal, m: Market): Position | undefined {
  const size = Number(balance.total), rate = Number(m.quoteUsd), mark = Number(m.mark)
  if (!size || !rate || !(mark >= 0) || !m.mark) return undefined
  const value = size * mark * rate
  // The venue's spot balance entryNtl is denominated in USDC, including for outcome tokens.
  const cost = Number(balance.entryNtl), pnl = value - cost
  return { instrumentId: m.id, symbol: ticker(m.symbol), kind: m.kind, size: balance.total,
    entryPx: decimal(cost / size / rate), markPx: m.mark, valueUsd: decimal(value),
    pnlUsd: decimal(pnl), pnlPct: decimal(cost ? 100 * pnl / Math.abs(cost) : 0) }
}

export async function readAccountSnapshot(address: string) {
  const [catalog, states, spot, orders, portfolio, btc] = await Promise.all([
    accountMarkets(), allPerpStates(address),
    info<Spot>({ type: 'spotClearinghouseState', user: address }),
    info<FrontendOpenOrdersResponse>({ type: 'frontendOpenOrders', user: address, dex: 'ALL_DEXS' }),
    info<PortfolioResponse>({ type: 'portfolio', user: address }),
    info<ActiveAssetDataResponse>({ type: 'activeAssetData', user: address, coin: 'BTC' }),
  ])
  const byId = new Map(catalog.map(m => [m.id, m]))
  const positions: Position[] = []
  for (const [, state] of states) {
    for (const { position: p } of state.assetPositions) {
      const m = byId.get(p.coin), sz = Number(p.szi)
      if (!sz) continue
      if (!m?.quoteUsd) throw new HTTPException(502, { message: 'Wait for live prices' })
      positions.push({ instrumentId: p.coin, kind: 'perp', symbol: m.symbol, size: p.szi, entryPx: p.entryPx,
        markPx: decimal(Number(p.positionValue) / Math.abs(sz)), valueUsd: decimal(Number(p.positionValue) * Number(m.quoteUsd)),
        pnlUsd: decimal(Number(p.unrealizedPnl) * Number(m.quoteUsd)), pnlPct: decimal(Number(p.returnOnEquity) * 100),
        leverage: p.leverage.value, ...(p.liquidationPx ? { liqPx: p.liquidationPx } : {}) })
    }
  }
  for (const b of spot.balances) {
    if ('token' in b && b.token === 0) continue
    const m = 'token' in b
      ? catalog.find(m => m.baseIndex === b.token && m.quoteIndex === 0) || catalog.find(m => m.baseIndex === b.token && m.quoteUsd)
      : byId.get(b.coin.replace(/^\+/, '#'))
    const priced = m?.tokenId ? { ...m, mark: (await info<TokenDetailsResponse>({ type: 'tokenDetails', tokenId: m.tokenId })).markPx } : m
    const p = priced && spotPosition(b, priced)
    if (p) positions.push(p)
  }
  const openOrders = orders.map(o => ({ oid: o.oid, instrumentId: o.coin, symbol: ticker(byId.get(o.coin)?.symbol ?? o.coin),
    side: o.side === 'B' ? 'buy' as const : 'sell' as const, size: o.sz, px: o.limitPx, reduceOnly: o.reduceOnly ?? false }))
  const equity = portfolio.find(([period]) => period === 'day')?.[1].accountValueHistory.at(-1)?.[1]
  if (equity === undefined) throw new HTTPException(502, { message: 'Wait for live prices' })
  const usdc = available(spot, spot.balances.find(b => 'token' in b && b.token === 0))
  // With no instrument on /account, report the cash usable by both spot USDC and native BTC perps.
  const free = btc.availableToTrade.map(money).reduce(min, usdc)
  const account: Account = { address, equityUsd: equity, freeUsd: print(free > 0n ? free : 0n), positions, openOrders, updatedAt: Date.now() }
  return { account, orders, catalog }
}

export async function account(address: string): Promise<Account> {
  return (await readAccountSnapshot(address)).account
}

export async function collateralWarnings(address: string, m: Market, t: Ticket): Promise<string[]> {
  const [mode, state] = await Promise.all([
    info<UserAbstractionResponse>({ type: 'userAbstraction', user: address }),
    m.kind === 'perp'
      ? info<ActiveAssetDataResponse>({ type: 'activeAssetData', user: address, coin: m.id })
      : info<Spot>({ type: 'spotClearinghouseState', user: address }),
  ])
  const unified = mode === 'unifiedAccount' || mode === 'portfolioMargin'
  const size = money(t.size)
  const cost = (size * money(t.px) + unit - 1n) / unit
  if ('availableToTrade' in state) {
    if (t.reduceOnly) return []
    const side = t.side === 'buy' ? 0 : 1
    if (cost <= money(state.availableToTrade[side]) * BigInt(t.leverage ?? state.leverage.value)) return []
    const balance = unified ? 'balance' : `${m.id.includes(':') ? m.id.split(':')[0]+' ' : ''}margin`
    return [`${price(state.availableToTrade[side])} ${m.quoteToken} available. Fund ${balance}`]
  }
  const buy = t.side === 'buy'
  const balance = buy ? state.balances.find(b => 'token' in b && b.token === m.quoteIndex)
    : state.balances.find(b => m.kind === 'outcome' ? b.coin === '+' + m.id.slice(1) : 'token' in b && b.token === m.baseIndex)
  const free = available(state, balance)
  if (free >= (buy ? cost : size)) return []
  const asset = ticker(buy ? m.quoteToken : m.symbol)
  const amount = `${price(print(free))} ${asset}`
  if (mode === 'portfolioMargin') return [`${amount} free. Borrowing may apply`]
  return [buy ? `${amount} available. Fund ${unified ? 'balance' : 'spot'}` : `Only ${amount} available. Sell less`]
}
