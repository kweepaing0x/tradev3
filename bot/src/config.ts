import dotenv from 'dotenv';
import type { BotConfig } from './types';

dotenv.config();

function required(key: string): string {
  const val = process.env[key];
  if (!val) throw new Error(`Missing required env variable: ${key}`);
  return val;
}

function num(key: string, fallback: number): number {
  const val = process.env[key];
  return val ? parseFloat(val) : fallback;
}

function bool(key: string, fallback: boolean): boolean {
  const val = process.env[key];
  if (!val) return fallback;
  return val.toLowerCase() === 'true';
}

export const config: BotConfig = {
  // ── Scan client — Binance Testnet ────────────────────────────────
  scanBaseUrl:   process.env.SCAN_BASE_URL    ?? 'https://testnet.binancefuture.com',
  scanApiKey:    process.env.SCAN_API_KEY     ?? '',
  scanApiSecret: process.env.SCAN_API_SECRET  ?? '',

  // ── Trade client — Binance Live Futures ──────────────────────────
  tradeBaseUrl:   process.env.TRADE_BASE_URL    ?? 'https://fapi.binance.com',
  tradeApiKey:    required('TRADE_API_KEY'),
  tradeApiSecret: required('TRADE_API_SECRET'),

  // ── Trading params ────────────────────────────────────────────────
  marginUsdt:       num('MARGIN_USDT', 10),
  leverage:         num('LEVERAGE', 20),
  tpPercent:        num('TP_PERCENT', 20),
  slPercent:        num('SL_PERCENT', 20),
  halfClosePercent: num('HALF_CLOSE_PERCENT', 10),
  dryRun:           bool('DRY_RUN', true),

  // ── Scanner params ────────────────────────────────────────────────
  volumeSpikeThreshold: num('VOLUME_SPIKE_THRESHOLD', 2),
  volumeMaPeriod:       num('VOLUME_MA_PERIOD', 20),
  rsiMin:  num('RSI_MIN', 40),
  rsiMax:  num('RSI_MAX', 70),
  adxMin:  num('ADX_MIN', 20),
  emaFast: num('EMA_FAST', 8),
  emaSlow: num('EMA_SLOW', 21),
  watchlistExpiryDays: num('WATCHLIST_EXPIRY_DAYS', 5),

  // ── Entry confluence ──────────────────────────────────────────────
  // EMA cross detected → also require order book imbalance > this threshold
  // in the same direction before entering. Recheck every 15m candle.
  entryImbalanceMin: num('ENTRY_IMBALANCE_MIN', 0.10),  // 10%
  entryMaxRechecks:  num('ENTRY_MAX_RECHECKS', 3),       // max 3 x 15m = 45min window

  // ── Telegram ──────────────────────────────────────────────────────
  telegramToken:  process.env.TELEGRAM_BOT_TOKEN ?? '',
  telegramChatId: process.env.TELEGRAM_CHAT_ID   ?? '',
};
