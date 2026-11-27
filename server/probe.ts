import { pathToFileURL } from 'node:url'
import { HTTPException } from 'hono/http-exception'
import type { Ticket } from '../shared/api.js'
import { book, markets, type Market } from './venue.js'
import { priceTicket } from './pricing.js'
import { nextStack } from './cards.js'

export async function sampleTickets(list: Market[]): Promise<{ market: Market; ticket: Ticket }[]> {
  const preview = (market: Market, snapshot: Awaited<ReturnType<typeof book>>) => {
    const ticket = priceTicket(market, snapshot, { instrumentId: market.id, side: 'buy', usd: '15' })
    return { market, ticket }
  }
  const regular = (id: string) => {
    const found = list.find(m => m.id === id)
    if (!found) throw new Error(`Missing testnet market: ${id}`)
    return book(found.id).then(snapshot => preview(found, snapshot))
  }
  const outcome = async () => {
    const outcomes = list.filter(m => m.kind === 'outcome' && m.quoteUsd !== null)
    const liquidExamples = ['#273150', '#272670', '#273151']
    const candidates = [...new Set([...liquidExamples.map(id => outcomes.find(m => m.id === id)).filter((m): m is Market => !!m),
      ...outcomes.filter(m => m.mid || m.ask), ...outcomes])]
    // ponytail: bound the number of thin books sampled by this diagnostic.
    for (const market of candidates.slice(0, 30)) {
      const snapshot = await book(market.id).catch(error => {
        if (error instanceof HTTPException && error.status === 404) return null
        throw error
      })
      if (!snapshot?.levels[0].length || !snapshot.levels[1].length) continue
      return preview(market, snapshot)
    }
    throw new Error('No two-sided outcome book in the first 30 candidates')
  }
  return Promise.all([regular('BTC'), regular('PURR/USDC'), outcome()])
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const list = await markets()
  const outcomeSides = list.filter(m => m.kind === 'outcome')
  console.log(JSON.stringify({
    perps: list.filter(m => m.kind === 'perp').length,
    builderPerps: list.filter(m => m.kind === 'perp' && m.id.includes(':')).length,
    spot: list.filter(m => m.kind === 'spot').length,
    openOutcomeMarkets: new Set(outcomeSides.map(m => m.id.slice(0, -1))).size,
    outcomeSideInstruments: outcomeSides.length,
  }))
  for (const { ticket } of await sampleTickets(list)) console.log(JSON.stringify(ticket))
  const owner = process.env.SAMPLE_ADDRESS
  if (!owner) throw new Error('Set SAMPLE_ADDRESS to probe an account')
  const { cards, snapshot } = await nextStack(owner)
  const a = snapshot.account!
  console.log(JSON.stringify({ owner, positions:a.positions.length, openOrders:a.openOrders.length, activeStops:snapshot.activeStopCount,
    eligibleEntries:snapshot.entries.length, cards:cards.map(({kind,symbol,line1,line2,detail,spark,change1h,toTarget}) =>
      ({kind,symbol,line1,line2,detail,spark,change1h,toTarget})) }))
}
