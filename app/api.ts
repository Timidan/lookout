import type {
  Account, ActResult, ApiError, Card, Instrument, OrderIntent, OrderResult, PairStart,
  PairStatus, SayResult, StreamEvent, Ticket,
} from '../shared/api'

export const base = (import.meta.env.VITE_API_BASE as string).replace(/\/+$/, '')

export class RequestError extends Error {
  constructor(message: string, readonly status = 0, readonly code?: string) { super(message) }
}

export function createApi() {
  let token = ''
  async function request<T>(path: string, method = 'GET', body?: object | Blob): Promise<T> {
    const headers = new Headers()
    if (token && path !== '/api/pair/start') headers.set('Authorization', 'Bearer ' + token)
    if (body) headers.set('Content-Type', body instanceof Blob ? 'application/octet-stream' : 'application/json')
    let response: Response
    try {
      response = await fetch(base + path, {
        method, headers, cache: 'no-store', signal: AbortSignal.timeout(12000),
        body: body instanceof Blob ? body : body && JSON.stringify(body),
      })
    } catch {
      throw new RequestError("Can't reach the server")
    }
    if (!response.ok) {
      const error = await response.json().catch(() => null) as ApiError | null
      throw new RequestError(error?.error?.message?.replace(/\.+$/, '') || "Couldn't complete the request", response.status, error?.error?.code)
    }
    try { return await response.json() as T } catch { throw new RequestError("Couldn't read the server reply") }
  }
  return {
    useToken(value: string) { token = value },
    startPair: () => request<PairStart>('/api/pair/start', 'POST'),
    status: () => request<PairStatus>('/api/pair/status'),
    account: () => request<Account>('/api/account'),
    next: () => request<Card[]>('/api/next'),
    act: (id: string) => request<ActResult>('/api/cards/act', 'POST', { id }),
    market: (id: string) => request<Instrument>('/api/markets/' + encodeURIComponent(id)),
    quote: (intent: OrderIntent) => request<Ticket>('/api/tickets', 'POST', intent),
    close: (instrumentId: string) => request<Ticket>('/api/positions/close', 'POST', { instrumentId }),
    confirm: (id: string) => request<OrderResult>('/api/tickets/' + encodeURIComponent(id) + '/confirm', 'POST'),
    cancel: (oid: number, instrumentId: string) => request<{ ok: true }>('/api/orders/' + oid + '?' + new URLSearchParams({ instrumentId }), 'DELETE'),
    voice: (pcm: Blob) => request<SayResult>('/api/voice', 'POST', pcm),
    stream(watch: string[], onEvent: (event: StreamEvent) => void, onLive: (live: boolean) => void) {
      const source = new EventSource(base + '/api/stream?' + new URLSearchParams({ token, watch: watch.join(',') }))
      source.onmessage = message => {
        let event: StreamEvent
        try { event = JSON.parse(message.data) } catch { return }
        onEvent(event)
      }
      source.onopen = () => onLive(true)
      source.onerror = () => onLive(false)
      return source
    },
  }
}
