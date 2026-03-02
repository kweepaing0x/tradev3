import fs from 'fs';
import path from 'path';
import { logger } from '../logger';
import { scanClient, tradeClient } from './binance';
import { telegram } from './telegram';
import { config } from '../config';
import type { ActivePosition, Direction } from '../types';

const DATA_DIR  = path.join(process.cwd(), 'data');
const FILE_PATH = path.join(DATA_DIR, 'position.json');

// How long to wait for a limit entry to fill (minutes)
const ENTRY_FILL_TIMEOUT_MINUTES = 15;

export interface PositionCheckResult {
  action: 'NONE' | 'PARTIAL_CLOSE' | 'FULL_CLOSE_TP' | 'FULL_CLOSE_SL' | 'UPDATE' | 'ENTRY_CANCELLED';
  message: string;
}

class PositionManager {
  private position: ActivePosition | null = null;

  constructor() {
    this.ensureDir();
    this.load();
  }

  private ensureDir() {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  }

  private load() {
    try {
      if (fs.existsSync(FILE_PATH)) {
        this.position = JSON.parse(fs.readFileSync(FILE_PATH, 'utf8'));
        if (this.position) {
          logger.info(`Resumed position: ${this.position.direction} ${this.position.symbol} @ $${this.position.entryPrice}`);
        }
      }
    } catch (err) {
      logger.error(`Failed to load position: ${err}`);
      this.position = null;
    }
  }

  private save() {
    try {
      if (this.position) {
        fs.writeFileSync(FILE_PATH, JSON.stringify(this.position, null, 2));
      } else {
        if (fs.existsSync(FILE_PATH)) fs.unlinkSync(FILE_PATH);
      }
    } catch (err) {
      logger.error(`Failed to save position: ${err}`);
    }
  }

  get(): ActivePosition | null {
    return this.position;
  }

  hasPosition(): boolean {
    return this.position !== null;
  }

  // ── Open position with limit order ─────────────────────────────

  async open(params: {
    symbol: string;
    direction: Direction;
    entryPrice: number;
  }): Promise<boolean> {
    const { symbol, direction, entryPrice } = params;
    const isLong = direction === 'LONG';

    // Get symbol precision info from exchange
    const info = await scanClient.getSymbolInfo(symbol);
    if (!info) {
      logger.error(`No symbol info for ${symbol} — cannot open position`);
      return false;
    }

    // Calculate quantity from margin + leverage
    const rawQty = (config.marginUsdt * config.leverage) / entryPrice;
    const quantity = Math.max(
      parseFloat(rawQty.toFixed(info.quantityPrecision)),
      info.minQty
    );

    // Validate minimum notional ($10 * 20 = $200, well above minimums)
    if (quantity * entryPrice < info.minNotional) {
      logger.error(`Order too small: ${quantity} * ${entryPrice} < minNotional ${info.minNotional}`);
      return false;
    }

    const tpPrice     = round(entryPrice * (1 + (isLong ? 1 : -1) * config.tpPercent / 100),     info.pricePrecision);
    const slPrice     = round(entryPrice * (1 - (isLong ? 1 : -1) * config.slPercent / 100),     info.pricePrecision);
    const halfCloseAt = round(entryPrice * (1 + (isLong ? 1 : -1) * config.halfClosePercent / 100), info.pricePrecision);

    logger.info(`Opening ${direction} ${symbol}: qty=${quantity} entry=$${entryPrice} TP=$${tpPrice} SL=$${slPrice}`);

    // Set leverage on live account
    await tradeClient.setLeverage(symbol, config.leverage);

    // Place LIMIT entry at current price
    const entrySide = isLong ? 'BUY' : 'SELL';
    const entryOrder = await tradeClient.placeLimit({
      symbol,
      side:              entrySide,
      quantity,
      price:             entryPrice,
      pricePrecision:    info.pricePrecision,
      quantityPrecision: info.quantityPrecision,
    });

    if (!entryOrder) {
      logger.error(`Entry limit order failed for ${symbol}`);
      return false;
    }

    // Place TP
    const tpOrder = await tradeClient.placeStop({
      symbol,
      side:           isLong ? 'SELL' : 'BUY',
      type:           'TAKE_PROFIT_MARKET',
      stopPrice:      tpPrice,
      pricePrecision: info.pricePrecision,
      closePosition:  true,
    });

    // Place SL
    const slOrder = await tradeClient.placeStop({
      symbol,
      side:           isLong ? 'SELL' : 'BUY',
      type:           'STOP_MARKET',
      stopPrice:      slPrice,
      pricePrecision: info.pricePrecision,
      closePosition:  true,
    });

    this.position = {
      symbol,
      direction,
      entryPrice,
      quantity,
      margin:    config.marginUsdt,
      leverage:  config.leverage,
      tpPrice,
      slPrice,
      halfCloseAt,
      halfClosed: false,
      openedAt:   Date.now(),
      entryOrderId: entryOrder.orderId,
      tpOrderId:    tpOrder?.orderId,
      slOrderId:    slOrder?.orderId,
      pricePrecision:    info.pricePrecision,
      quantityPrecision: info.quantityPrecision,
    };
    this.save();

    const msg =
      `🚀 <b>Limit Entry Placed</b>\n\n` +
      `Symbol: <b>${symbol}</b>\n` +
      `Direction: <b>${direction}</b>\n` +
      `Entry (limit): $${entryPrice.toFixed(info.pricePrecision)}\n` +
      `Qty: ${quantity} (${config.marginUsdt}$ × ${config.leverage}x)\n` +
      `TP: $${tpPrice.toFixed(info.pricePrecision)} (+${config.tpPercent}%)\n` +
      `SL: $${slPrice.toFixed(info.pricePrecision)} (-${config.slPercent}%)\n` +
      `Half-close at: $${halfCloseAt.toFixed(info.pricePrecision)} (+${config.halfClosePercent}%)\n` +
      `⏳ Fill timeout: ${ENTRY_FILL_TIMEOUT_MINUTES} min` +
      (config.dryRun ? '\n\n⚠️ <b>DRY RUN — no real order placed</b>' : '');

    await telegram.send(msg);
    logger.info(`Limit entry placed: ${direction} ${symbol} @ $${entryPrice}`);
    return true;
  }

  // ── Check if limit entry was filled ──────────────────────────────

  async checkEntryFill(): Promise<'FILLED' | 'PENDING' | 'CANCELLED'> {
    if (!this.position?.entryOrderId) return 'FILLED'; // dry run or already tracked
    const status = await tradeClient.getOrderStatus(
      this.position.symbol,
      this.position.entryOrderId
    );

    if (status === 'FILLED') return 'FILLED';
    if (status === 'CANCELED' || status === 'EXPIRED') return 'CANCELLED';

    // Check if entry timed out
    const elapsed = Date.now() - this.position.openedAt;
    if (elapsed > ENTRY_FILL_TIMEOUT_MINUTES * 60 * 1000) {
      logger.warn(`Entry limit order not filled after ${ENTRY_FILL_TIMEOUT_MINUTES}min — cancelling`);
      await tradeClient.cancelOrder(this.position.symbol, this.position.entryOrderId);
      await tradeClient.cancelAllOrders(this.position.symbol); // also cancel TP/SL
      this.position = null;
      this.save();
      await telegram.send(
        `⏰ <b>Entry Cancelled</b>\n` +
        `Limit order not filled within ${ENTRY_FILL_TIMEOUT_MINUTES} minutes\n` +
        `Symbol: ${this.position?.symbol ?? 'N/A'}\nResuming scan cycle`
      );
      return 'CANCELLED';
    }

    return 'PENDING';
  }

  // ── Monitor open position ─────────────────────────────────────────

  async check(currentPrice: number): Promise<PositionCheckResult> {
    if (!this.position) return { action: 'NONE', message: '' };
    const pos = this.position;
    const { pricePrecision, quantityPrecision } = pos;
    const isLong = pos.direction === 'LONG';

    const pnlPct = isLong
      ? ((currentPrice - pos.entryPrice) / pos.entryPrice) * 100
      : ((pos.entryPrice - currentPrice) / pos.entryPrice) * 100;

    // ── SL hit ──────────────────────────────────────────────────────
    const hitSL = isLong ? currentPrice <= pos.slPrice : currentPrice >= pos.slPrice;
    if (hitSL) {
      const pnl = this.pnl(pos, currentPrice, pos.quantity);
      await tradeClient.cancelAllOrders(pos.symbol);
      this.position = null;
      this.save();
      const msg =
        `🛑 <b>Stop Loss Hit</b>\n\n` +
        `${pos.symbol} ${pos.direction}\n` +
        `Entry $${pos.entryPrice.toFixed(pricePrecision)} → Exit $${currentPrice.toFixed(pricePrecision)}\n` +
        `P&L: ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)} (${pnlPct.toFixed(2)}%)\n` +
        `Duration: ${this.duration(pos.openedAt)}`;
      await telegram.send(msg);
      return { action: 'FULL_CLOSE_SL', message: msg };
    }

    // ── Half close at +10% ──────────────────────────────────────────
    const hitHalf = isLong ? currentPrice >= pos.halfCloseAt : currentPrice <= pos.halfCloseAt;
    if (hitHalf && !pos.halfClosed) {
      const halfQty = parseFloat((pos.quantity / 2).toFixed(quantityPrecision));
      const halfPnL = this.pnl(pos, currentPrice, halfQty);

      // Place reduce-only limit at current price to close 50%
      await tradeClient.placeLimit({
        symbol:            pos.symbol,
        side:              isLong ? 'SELL' : 'BUY',
        quantity:          halfQty,
        price:             currentPrice,
        pricePrecision,
        quantityPrecision,
        reduceOnly:        true,
      });

      // Cancel existing SL, re-place at breakeven (entry price)
      if (pos.slOrderId) await tradeClient.cancelOrder(pos.symbol, pos.slOrderId);
      const newSL = await tradeClient.placeStop({
        symbol:         pos.symbol,
        side:           isLong ? 'SELL' : 'BUY',
        type:           'STOP_MARKET',
        stopPrice:      pos.entryPrice,
        pricePrecision,
        closePosition:  true,
      });

      this.position = {
        ...pos,
        quantity:   halfQty,
        slPrice:    pos.entryPrice, // breakeven
        halfClosed: true,
        slOrderId:  newSL?.orderId,
      };
      this.save();

      const msg =
        `⚡ <b>Partial Close + SL → Breakeven</b>\n\n` +
        `${pos.symbol} ${pos.direction}\n` +
        `Closed 50% @ $${currentPrice.toFixed(pricePrecision)}\n` +
        `Partial P&L: +$${halfPnL.toFixed(2)}\n` +
        `SL moved to BE: $${pos.entryPrice.toFixed(pricePrecision)}\n` +
        `Remaining: ${halfQty} contracts\n` +
        `TP still at: $${pos.tpPrice.toFixed(pricePrecision)}`;
      await telegram.send(msg);
      return { action: 'PARTIAL_CLOSE', message: msg };
    }

    // ── TP hit ───────────────────────────────────────────────────────
    const hitTP = isLong ? currentPrice >= pos.tpPrice : currentPrice <= pos.tpPrice;
    if (hitTP) {
      const pnl = this.pnl(pos, currentPrice, pos.quantity);
      await tradeClient.cancelAllOrders(pos.symbol);
      this.position = null;
      this.save();
      const msg =
        `🎯 <b>Take Profit Hit</b>\n\n` +
        `${pos.symbol} ${pos.direction}\n` +
        `Entry $${pos.entryPrice.toFixed(pricePrecision)} → Exit $${currentPrice.toFixed(pricePrecision)}\n` +
        `P&L: +$${pnl.toFixed(2)} (${pnlPct.toFixed(2)}%)\n` +
        `Duration: ${this.duration(pos.openedAt)}`;
      await telegram.send(msg);
      return { action: 'FULL_CLOSE_TP', message: msg };
    }

    // ── Still open ───────────────────────────────────────────────────
    const msg =
      `📊 <b>Position Update</b> — ${pos.symbol} ${pos.direction}\n` +
      `Current: $${currentPrice.toFixed(pricePrecision)} | P&L: ${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(2)}%\n` +
      `SL: $${pos.slPrice.toFixed(pricePrecision)} | TP: $${pos.tpPrice.toFixed(pricePrecision)}` +
      (pos.halfClosed
        ? '\n✅ 50% closed at +10%, SL at breakeven'
        : `\n⚡ Half-close trigger: $${pos.halfCloseAt.toFixed(pricePrecision)}`);
    return { action: 'UPDATE', message: msg };
  }

  async forceClose(reason: string): Promise<void> {
    if (!this.position) return;
    const pos = this.position;
    const isLong = pos.direction === 'LONG';

    logger.warn(`Force close ${pos.symbol}: ${reason}`);
    const price = await scanClient.getMarkPrice(pos.symbol);

    // Limit order at market price (effectively instant)
    await tradeClient.placeLimit({
      symbol:            pos.symbol,
      side:              isLong ? 'SELL' : 'BUY',
      quantity:          pos.quantity,
      price:             price || pos.entryPrice,
      pricePrecision:    pos.pricePrecision,
      quantityPrecision: pos.quantityPrecision,
      reduceOnly:        true,
    });
    await tradeClient.cancelAllOrders(pos.symbol);
    this.position = null;
    this.save();
    await telegram.send(`🔴 <b>Force Closed</b>: ${pos.symbol}\nReason: ${reason}`);
  }

  // ── Helpers ────────────────────────────────────────────────────────

  private pnl(pos: ActivePosition, exitPrice: number, qty: number): number {
    return pos.direction === 'LONG'
      ? (exitPrice - pos.entryPrice) * qty
      : (pos.entryPrice - exitPrice) * qty;
  }

  private duration(openedAt: number): string {
    const ms = Date.now() - openedAt;
    const h  = Math.floor(ms / 3600000);
    const m  = Math.floor((ms % 3600000) / 60000);
    return `${h}h ${m}m`;
  }
}

function round(value: number, precision: number): number {
  const factor = Math.pow(10, precision);
  return Math.round(value * factor) / factor;
}

export const positionManager = new PositionManager();
