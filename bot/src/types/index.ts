// ── Candle ────────────────────────────────────────────────────────
export interface Candle {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

// ── Order Book ────────────────────────────────────────────────────
export interface OrderBookData {
  bids: [number, number][];
  asks: [number, number][];
  timestamp: number;
}

// ── Watchlist ─────────────────────────────────────────────────────
export interface WatchlistEntry {
  symbol: string;
  addedAt: number;
  expiresAt: number;
  score: number;
  rsi4H: number;
  adx4H: number;
  imbalance4H: number;
  volumeRatio5m: number;
  price: number;
}

// ── Pending Entry ─────────────────────────────────────────────────
// Set when EMA cross detected but imbalance not yet confirmed.
// Rechecked on every 15m candle. Abandoned after MAX_RECHECK attempts.
export interface PendingEntry {
  symbol: string;
  direction: 'LONG' | 'SHORT';
  crossDetectedAt: number;
  rechecks: number;
  lastRecheckAt: number;
  emaFastVal: number;
  emaSlowVal: number;
}

// ── Position ──────────────────────────────────────────────────────
export type Direction = 'LONG' | 'SHORT';

export interface ActivePosition {
  symbol: string;
  direction: Direction;
  entryPrice: number;
  quantity: number;
  margin: number;
  leverage: number;
  tpPrice: number;
  slPrice: number;
  halfCloseAt: number;
  halfClosed: boolean;
  openedAt: number;
  entryOrderId?: string;
  tpOrderId?: string;
  slOrderId?: string;
  pricePrecision: number;
  quantityPrecision: number;
}

// ── Scan ──────────────────────────────────────────────────────────
export interface VolumeScanResult {
  symbol: string;
  volumeRatio: number;
  price: number;
  scannedAt: number;
}

export interface ConfirmedCandidate {
  symbol: string;
  score: number;
  rsi4H: number;
  adx4H: number;
  imbalance4H: number;
  volumeRatio5m: number;
  price: number;
}

// ── Bot Phase ─────────────────────────────────────────────────────
export type BotPhase =
  | 'IDLE'
  | 'MARKET_SCAN'
  | 'CONFIRM_SCAN'
  | 'WATCHLIST_SCAN'
  | 'IN_POSITION'
  | 'STOPPED';

// ── Symbol precision ──────────────────────────────────────────────
export interface SymbolInfo {
  symbol: string;
  pricePrecision: number;
  quantityPrecision: number;
  minQty: number;
  minNotional: number;
}

// ── Config ────────────────────────────────────────────────────────
export interface BotConfig {
  // Scan — Binance Testnet
  scanBaseUrl: string;
  scanApiKey: string;
  scanApiSecret: string;

  // Trade — Binance Live Futures
  tradeBaseUrl: string;
  tradeApiKey: string;
  tradeApiSecret: string;

  // Trading
  marginUsdt: number;
  leverage: number;
  tpPercent: number;
  slPercent: number;
  halfClosePercent: number;
  dryRun: boolean;

  // Scanner
  volumeSpikeThreshold: number;
  volumeMaPeriod: number;
  rsiMin: number;
  rsiMax: number;
  adxMin: number;
  emaFast: number;
  emaSlow: number;
  watchlistExpiryDays: number;

  // Entry confluence
  entryImbalanceMin: number;   // e.g. 0.10 = 10%
  entryMaxRechecks: number;    // e.g. 3 = wait max 3 x 15m candles

  // Telegram
  telegramToken: string;
  telegramChatId: string;
}
