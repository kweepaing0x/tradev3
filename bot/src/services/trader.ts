import fs from 'fs';
import path from 'path';
import { scanClient } from './binance';
import { Indicators } from './indicators';
import { watchlist } from './watchlist';
import { positionManager } from './position';
import { telegram } from './telegram';
import { config } from '../config';
import { logger } from '../logger';
import type { PendingEntry } from '../types';

// ── Pending entry persistence ─────────────────────────────────────
// Stored to disk so it survives bot restarts mid-recheck window.

const PENDING_FILE = path.join(process.cwd(), 'data', 'pending.json');

function loadPending(): PendingEntry[] {
  try {
    if (fs.existsSync(PENDING_FILE)) {
      return JSON.parse(fs.readFileSync(PENDING_FILE, 'utf8'));
    }
  } catch { /* ignore */ }
  return [];
}

function savePending(entries: PendingEntry[]): void {
  try {
    fs.mkdirSync(path.dirname(PENDING_FILE), { recursive: true });
    fs.writeFileSync(PENDING_FILE, JSON.stringify(entries, null, 2));
  } catch (err) {
    logger.error(`savePending failed: ${err}`);
  }
}

function clearPending(): void {
  try {
    if (fs.existsSync(PENDING_FILE)) fs.unlinkSync(PENDING_FILE);
  } catch { /* ignore */ }
}

// ── Imbalance direction check ─────────────────────────────────────
// For a LONG: imbalance must be positive (more bids than asks).
// For a SHORT: imbalance must be negative (more asks than bids).

function imbalanceConfirms(
  imbalance: number,
  direction: 'LONG' | 'SHORT',
  threshold: number
): boolean {
  if (direction === 'LONG')  return imbalance >= threshold;
  if (direction === 'SHORT') return imbalance <= -threshold;
  return false;
}

// ── Entry confluence check ────────────────────────────────────────
// Returns the imbalance value (positive = bullish, negative = bearish)
// so we can log it regardless of pass/fail.

async function checkConfluence(
  symbol: string,
  direction: 'LONG' | 'SHORT'
): Promise<{ pass: boolean; imbalance: number; reason: string }> {
  try {
    const ob = await scanClient.getOrderBook(symbol, 50);
    if (!ob.bids.length || !ob.asks.length) {
      return { pass: false, imbalance: 0, reason: 'empty order book' };
    }

    const mid = (ob.bids[0][0] + ob.asks[0][0]) / 2;
    const imbalance = Indicators.orderBookImbalance(ob.bids, ob.asks, mid);
    const pass = imbalanceConfirms(imbalance, direction, config.entryImbalanceMin);

    const reason = pass
      ? `imbalance ${(imbalance * 100).toFixed(1)}% confirms ${direction}`
      : `imbalance ${(imbalance * 100).toFixed(1)}% — need ${direction === 'LONG' ? '>' : '<'}${(config.entryImbalanceMin * 100).toFixed(0)}%`;

    return { pass, imbalance, reason };
  } catch (err) {
    return { pass: false, imbalance: 0, reason: `order book error: ${err}` };
  }
}

// ── Phase 3: Watchlist scan + pending recheck ─────────────────────

export async function runWatchlistScan(): Promise<void> {
  if (positionManager.hasPosition()) return;

  const active    = watchlist.getActive();
  let pending     = loadPending();
  const now       = Date.now();

  // ── Step A: Recheck pending entries first ─────────────────────
  // These are pairs where EMA crossed but imbalance wasn't ready yet.

  logger.info(`=== Phase 3: Watchlist scan — ${active.length} pairs, ${pending.length} pending ===`);

  const stillPending: PendingEntry[] = [];

  for (const pe of pending) {
    if (positionManager.hasPosition()) break;

    // Drop if watchlist entry expired or symbol removed
    if (!watchlist.has(pe.symbol)) {
      logger.info(`  Pending ${pe.symbol}: watchlist expired — abandoned`);
      continue;
    }

    // Drop if max rechecks exceeded (3 x 15m = 45 min window)
    if (pe.rechecks >= config.entryMaxRechecks) {
      logger.info(`  Pending ${pe.symbol}: max rechecks (${config.entryMaxRechecks}) reached — abandoned`);
      await telegram.send(
        `⚠️ <b>Entry Abandoned</b>: ${pe.symbol}\n` +
        `EMA cross detected but imbalance never confirmed after ${pe.rechecks} rechecks (${pe.rechecks * 15}min)\n` +
        `Moving on`
      );
      continue;
    }

    logger.info(`  Rechecking pending: ${pe.direction} ${pe.symbol} (attempt ${pe.rechecks + 1}/${config.entryMaxRechecks})`);

    // Re-confirm EMA cross is still valid (hasn't reversed)
    const klines = await scanClient.getKlines(pe.symbol, '15m', 100);
    if (!klines.length) { stillPending.push(pe); continue; }

    const { crossOver, crossUnder, fastVal, slowVal } = Indicators.emaCrossover(
      klines, config.emaFast, config.emaSlow
    );

    const crossStillValid = pe.direction === 'LONG' ? fastVal > slowVal : fastVal < slowVal;

    if (!crossStillValid) {
      logger.info(`  Pending ${pe.symbol}: EMA cross reversed — abandoned`);
      await telegram.send(
        `❌ <b>Pending Entry Cancelled</b>: ${pe.symbol}\n` +
        `EMA cross reversed before imbalance confirmed`
      );
      continue;
    }

    // Check imbalance
    const currentPrice = klines[klines.length - 1].close;
    const { pass, imbalance, reason } = await checkConfluence(pe.symbol, pe.direction);

    if (pass) {
      logger.info(`  ✅ ${pe.symbol}: imbalance confirmed on recheck — entering`);
      const entered = await positionManager.open({
        symbol:     pe.symbol,
        direction:  pe.direction,
        entryPrice: currentPrice,
      });
      if (entered) break; // position opened, stop scanning
      // If open failed for some reason, don't keep retrying
      continue;
    }

    // Still not confirmed — keep in pending with incremented count
    logger.info(`  ⏳ ${pe.symbol}: ${reason} (recheck ${pe.rechecks + 1})`);
    stillPending.push({
      ...pe,
      rechecks:      pe.rechecks + 1,
      lastRecheckAt: now,
    });

    await scanClient.sleep(200);
  }

  // Save updated pending list (without entries that were resolved)
  savePending(stillPending);

  if (positionManager.hasPosition()) return;

  // ── Step B: Scan active watchlist for fresh EMA crosses ───────

  // Build set of symbols already in pending to avoid double-adding
  const pendingSymbols = new Set(stillPending.map(p => p.symbol));

  for (const entry of active) {
    if (positionManager.hasPosition()) break;
    if (pendingSymbols.has(entry.symbol)) continue; // already pending

    try {
      const klines = await scanClient.getKlines(entry.symbol, '15m', 100);
      if (klines.length < 30) continue;

      const { crossOver, crossUnder, fastVal, slowVal } = Indicators.emaCrossover(
        klines, config.emaFast, config.emaSlow
      );

      if (!crossOver && !crossUnder) {
        await scanClient.sleep(150);
        continue;
      }

      const direction  = crossOver ? 'LONG' : 'SHORT';
      const currentPrice = klines[klines.length - 1].close;

      logger.info(
        `  EMA cross: ${direction} ${entry.symbol} | ` +
        `EMA${config.emaFast}=${fastVal.toFixed(4)} EMA${config.emaSlow}=${slowVal.toFixed(4)}`
      );

      // Check confluence immediately
      const { pass, imbalance, reason } = await checkConfluence(entry.symbol, direction);

      if (pass) {
        // ── All conditions met — enter now ────────────────────────
        logger.info(`  ✅ ${entry.symbol}: EMA cross + ${reason} → entering ${direction}`);
        const entered = await positionManager.open({
          symbol:     entry.symbol,
          direction,
          entryPrice: currentPrice,
        });
        if (entered) break;
      } else {
        // ── EMA cross valid, imbalance not ready — add to pending ─
        logger.info(`  ⏳ ${entry.symbol}: EMA cross valid but ${reason} — adding to pending`);

        await telegram.send(
          `⏳ <b>Pending Entry</b>: ${entry.symbol}\n` +
          `Direction: ${direction}\n` +
          `EMA${config.emaFast}=${fastVal.toFixed(4)} | EMA${config.emaSlow}=${slowVal.toFixed(4)}\n` +
          `Issue: ${reason}\n` +
          `Will recheck up to ${config.entryMaxRechecks}x (every 15m candle)`
        );

        const updated = [...loadPending()];
        updated.push({
          symbol:           entry.symbol,
          direction,
          crossDetectedAt:  now,
          rechecks:         0,
          lastRecheckAt:    now,
          emaFastVal:       fastVal,
          emaSlowVal:       slowVal,
        });
        savePending(updated);
        pendingSymbols.add(entry.symbol);
      }

      await scanClient.sleep(200);
    } catch (err) {
      logger.error(`Watchlist scan error ${entry.symbol}: ${err}`);
    }
  }

  const finalPending = loadPending();
  logger.info(
    `Phase 3 done — ${positionManager.hasPosition() ? 'position opened' : 'no entry'} | ` +
    `${finalPending.length} pending entries`
  );
}

// ── Position monitor (called every 1hr while in position) ─────────

export async function monitorPosition(): Promise<boolean> {
  const pos = positionManager.get();
  if (!pos) return false;

  logger.info(`=== Position Monitor: ${pos.direction} ${pos.symbol} ===`);

  // Check if limit entry has been filled yet
  const fillStatus = await positionManager.checkEntryFill();

  if (fillStatus === 'CANCELLED') {
    logger.info('Entry order cancelled — position cleared, resuming scan');
    clearPending(); // also clear pending since we're back in scan mode
    return false;
  }

  if (fillStatus === 'PENDING') {
    logger.info(`Entry limit still pending — ${pos.symbol}`);
    await telegram.send(
      `⏳ <b>Waiting for entry fill</b>\n` +
      `${pos.symbol} ${pos.direction} limit @ $${pos.entryPrice.toFixed(pos.pricePrecision)}`
    );
    return true;
  }

  // Entry filled — monitor TP / SL / half-close
  const currentPrice = await scanClient.getMarkPrice(pos.symbol);
  if (!currentPrice) {
    logger.warn('Could not get mark price — skipping this cycle');
    return true;
  }

  logger.info(
    `Mark: $${currentPrice} | Entry: $${pos.entryPrice} | ` +
    `TP: $${pos.tpPrice} | SL: $${pos.slPrice} | ` +
    `Half: $${pos.halfCloseAt} ${pos.halfClosed ? '✅' : '⏳'}`
  );

  const result = await positionManager.check(currentPrice);
  logger.info(`Monitor action: ${result.action}`);

  if (result.action === 'UPDATE') {
    logger.info(result.message.replace(/<[^>]+>/g, ''));
    await telegram.send(result.message);
  }

  // true = still open
  return result.action === 'UPDATE' || result.action === 'PARTIAL_CLOSE';
}
