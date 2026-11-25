// The contract between the backend (server/) and the glasses client (app/).
// Both sides import this file. All money and size values are decimal strings.

export type Kind = 'perp' | 'spot' | 'outcome';

/** One tradable thing. For outcome markets each side (Yes, No) is its own instrument. */
export interface Instrument {
  /** Venue coin id, passed back unchanged: "BTC", "xyz:TSLA", "PURR/USDC", "@476", "#2731500". */
  id: string;
  kind: Kind;
  /** Short name for display and speech: "BTC", "PURR", "BAL v HOU Yes". */
  symbol: string;
  /** One line, at most 40 characters, for the glasses. */
  title: string;
  bid: string | null;
  ask: string | null;
  mid: string | null;
  szDecimals: number;
  /** Perps only. */
  maxLeverage?: number;
  /** Outcome markets only, unix ms. */
  expiresAt?: number;
  /**
   * The last hour as a text sparkline: 12 characters from "▁▂▃▄▅▆▇█", oldest first, scaled to the
   * hour's own low and high. Present where candles exist. The glasses' font draws these for free.
   */
  spark?: string;
  /** Change over that hour, signed, as a share: 0.018 = +1.8%. */
  change1h?: number;
  /**
   * The same hour for a line graph: twelve five-minute closes, oldest first, each 0 (bottom of the
   * scale) to 1 (top). `trendLow` and `trendHigh` are the prices at the bottom and top of that scale,
   * so a level such as an entry price can be drawn on the same graph. The glasses draw this as a
   * line. `spark` is the same hour as text; the glasses client does not show it today.
   */
  trend?: number[];
  trendLow?: string;
  trendHigh?: string;
}

/**
 * What the user asked for. Give at most one of `usd` or `size`; with neither, the server uses the
 * user's usual size for that market. No `limitPx` means a market order.
 */
export interface OrderIntent {
  instrumentId: string;
  side: 'buy' | 'sell';
  usd?: string;
  size?: string;
  limitPx?: string;
  reduceOnly?: boolean;
  /** Perps only. Applied before the order when it differs from the current setting. */
  leverage?: number;
  /**
   * Perp entries carry a stop and a target by default (server defaults, as a percentage from entry).
   * Give prices to override, or `bracket: false` to send the entry alone.
   */
  stopPx?: string;
  targetPx?: string;
  bracket?: false;
}

/** A priced, bounded order waiting for one confirm. Nothing is sent to the venue until it is confirmed. */
export interface Ticket {
  id: string;
  expiresAt: number;
  instrument: Instrument;
  side: 'buy' | 'sell';
  size: string;
  /** Worst price the order may fill at (the limit price actually sent). */
  px: string;
  /** Expected average fill price from the live book. */
  estPx: string;
  notionalUsd: string;
  marginUsd?: string;
  leverage?: number;
  reduceOnly: boolean;
  /** Present when the entry carries a stop and a target. */
  stopPx?: string;
  targetPx?: string;
  /** What the server filled in for the user, for the glasses to mark: "your usual", "default size". */
  assumed?: string;
  /** One line for the glasses, at most 40 characters: "Buy 0.0016 BTC ~$97 5x". */
  summary: string;
  /** Short plain warnings, e.g. "Book is thin: fills 60% at this price". */
  warnings: string[];
}

export interface OrderResult {
  status: 'filled' | 'partial' | 'resting' | 'rejected';
  oid?: number;
  filledSize: string;
  avgPx?: string;
  /** Venue message on rejection, shortened for the glasses. */
  message?: string;
}

export interface Position {
  instrumentId: string;
  kind: Kind;
  symbol: string;
  /** Signed for perps (negative = short). */
  size: string;
  entryPx: string;
  markPx: string;
  valueUsd: string;
  pnlUsd: string;
  pnlPct: string;
  leverage?: number;
  liqPx?: string;
}

export interface OpenOrder {
  oid: number;
  instrumentId: string;
  symbol: string;
  side: 'buy' | 'sell';
  size: string;
  px: string;
  reduceOnly: boolean;
}

export interface Account {
  address: string;
  equityUsd: string;
  freeUsd: string;
  positions: Position[];
  openOrders: OpenOrder[];
  updatedAt: number;
}

export interface ApiError {
  error: { code: string; /** At most 60 characters, shown on the glasses. */ message: string };
}

// ---- Pairing: the glasses show a code, the owner approves a trading key in a browser ----

export interface PairStart { code: string; deviceToken: string; pairUrl: string; expiresAt: number }
/** `sample` is true when this unpaired device is being shown the read-only sample account. */
export interface PairStatus { paired: boolean; address?: string; sample?: boolean }

// ---- Voice and text commands ----

export interface SayResult {
  transcript: string;
  /** Present when the command parsed into an order. */
  ticket?: Ticket;
  /** Present when it did not: a short line to show, e.g. "Which market?" */
  reply?: string;
  /**
   * Present when speech may have misheard a number (15 and 50 sound alike). The glasses show
   * `reply` ("$15 or $50?") and the user swipes to one; the client then posts that intent to /api/tickets.
   */
  choices?: { label: string; intent: OrderIntent }[];
}

// ---- Next move: the home screen is a ranked stack of cards, most urgent first ----

/**
 * What a card's tap or hold does. The server executes it only if the card is still current,
 * so the action is always bound to what the glasses showed.
 */
export type CardAction =
  | { type: 'add_stop'; instrumentId: string; triggerPx: string }
  | { type: 'move_stop'; instrumentId: string; triggerPx: string }
  | { type: 'reduce'; instrumentId: string; fraction: number }
  | { type: 'cancel_entries' }
  | { type: 'close_all' }
  | { type: 'open_market'; instrumentId: string }
  | { type: 'pair' };

export interface Card {
  /** Stable while the situation lasts, e.g. "no_stop:BTC". Changes when the action's numbers change. */
  id: string;
  kind:
    | 'liq_before_stop'   // liquidation would come before the stop
    | 'no_stop'           // a perp position with no stop on the exchange
    | 'thin_buffer'       // price is close to liquidation
    | 'stop_to_entry'     // in profit by at least the original risk; stop still behind entry
    | 'position'          // a holding that needs nothing right now
    | 'step_away'         // waiting entry orders that can be cancelled while stops stay
    | 'close_all'
    | 'watch'             // a market from the watchlist
    | 'sample'            // first card when a read-only sample account is shown: offers pairing
    | 'idle';             // nothing open
  /**
   * Two lines for the glasses, each at most 40 characters. `line1` is the fact. `line2` is the action
   * and always starts "Tap to " or "Hold to ". Wording rules are in ideation/ux-spec.md.
   */
  line1: string;
  line2: string;
  /** A third, dimmer line of supporting numbers, at most 44 characters. */
  detail?: string;
  /** The market's plain ticker ("NVDA", "BTC"), for the icon. Absent on cards about no single market. */
  symbol?: string;
  /** The market's last hour, as on Instrument. Position and watch cards. */
  spark?: string;
  change1h?: number;
  trend?: number[];
  trendLow?: string;
  trendHigh?: string;
  /** Where the price sits from stop (0) to target (1). Only when the position has both. */
  toTarget?: number;
  action?: CardAction;
  /** 'tap' for small actions, 'hold' for big ones (reduce, cancel_entries, close_all). */
  confirm?: 'tap' | 'hold';
  /** Share of the way from liquidation (0) to entry-or-better (1), for a bar. Perp positions only. */
  buffer?: number;
}

export interface ActResult {
  ok: boolean;
  /** At most 40 characters: "Stop set at 59,800", "Cancelled 3 buys · 2 stops kept". */
  message: string;
  results?: OrderResult[];
}

// ---- Live stream (Server-Sent Events) ----

export type StreamEvent =
  | { type: 'account'; account: Account }
  | { type: 'next'; cards: Card[] }
  | { type: 'quote'; instrument: Instrument }
  | { type: 'fill'; instrumentId: string; symbol: string; side: 'buy' | 'sell'; size: string; px: string; time: number };

/*
Routes. "device" = `Authorization: Bearer <deviceToken>`. Errors are ApiError with a 4xx/5xx status.

POST   /api/pair/start                      -> PairStart                  (no auth)
GET    /api/pair/status                     -> PairStatus                 (device)
POST   /api/unpair                          -> { ok: true }               (device)
GET    /api/markets?kind=&q=&limit=         -> Instrument[]               (device)
GET    /api/markets/:id                     -> Instrument                 (device)
GET    /api/account                         -> Account                    (device)
GET    /api/next                            -> Card[]                     (device; ranked, most urgent first; never empty)
POST   /api/cards/act        { id }         -> ActResult                  (device; 409 with a short message if that card is no longer current)
POST   /api/tickets            OrderIntent  -> Ticket                     (device)
POST   /api/tickets/:id/confirm             -> OrderResult                (device)
POST   /api/positions/close  { instrumentId, fraction?: number }  -> Ticket   (device; reduce-only market ticket, default fraction 1)
DELETE /api/orders/:oid?instrumentId=       -> { ok: true }               (device)
POST   /api/say              { text }       -> SayResult                  (device)
POST   /api/voice   body: raw PCM, 16 kHz, signed 16-bit LE, mono; Content-Type: application/octet-stream -> SayResult (device)
GET    /api/stream?token=<deviceToken>&watch=<id,id>   -> text/event-stream of StreamEvent (JSON in `data:`)

Pairing page (served by the server, used in a normal browser, not on the glasses):
GET    /pair?code=XXXXXX                    -> HTML page
GET    /api/pair/:code/request?address=&chainId=   -> { agentAddress, typedData }   (typedData is passed to eth_signTypedData_v4)
POST   /api/pair/:code/complete  { address, signature, typedData }  -> { ok: true }
*/
