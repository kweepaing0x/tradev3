import { scanClient as binance } from './binance';
import { Indicators } from './indicators';
import { watchlist } from './watchlist';
import { telegram } from './telegram';
import { config } from '../config';
import { logger } from '../logger';
import type { VolumeScanResult, ConfirmedCandidate, WatchlistEntry } from '../types';

// ── Phase 1: Volume spike scan on 5m ─────────────────────────────

export async function runVolumeScan(): Promise<VolumeScanResult[]> {
  logger.info('=== Phase 1: Volume spike scan (5m) ===');
  const symbols = await binance.getExchangeInfo();
  logger.info(`Scanning ${symbols.length} USDT futures pairs...`);

  const results: VolumeScanResult[] = [];
  const BATCH = 10;

  for (let i = 0; i < symbols.length; i += BATCH) {
    const batch = symbols.slice(i, i + BATCH);

    await Promise.allSettled(
      batch.map(async (symbol) => {
        try {
          const klines = await binance.getKlines(symbol, '5m', 50);
          if (klines.length < 25) return;

          const { spike, ratio } = Indicators.volumeSpike(
            klines,
            config.volumeMaPeriod,
            config.volumeSpikeThreshold
          );

          if (!spike) return;

          results.push({
            symbol,
            volumeRatio: ratio,
            price: klines[klines.length - 1].close,
            scannedAt: Date.now(),
          });
        } catch {
          // silently skip
        }
      })
    );

    // ~300ms between batches to stay under rate limits
    await binance.sleep(300);

    if ((i / BATCH) % 5 === 0) {
      logger.info(`  Scanned ${Math.min(i + BATCH, symbols.length)}/${symbols.length}...`);
    }
  }

  results.sort((a, b) => b.volumeRatio - a.volumeRatio);
  logger.info(`Phase 1 done: ${results.length} volume spike candidates`);
  return results;
}

// ── Phase 2: Confirm with 4H RSI / ADX / Imbalance ───────────────

export async function runConfirmScan(
  candidates: VolumeScanResult[]
): Promise<WatchlistEntry[]> {
  logger.info(`=== Phase 2: 4H confirmation for ${candidates.length} candidates ===`);

  const confirmed: WatchlistEntry[] = [];
  const expiresAt = Date.now() + config.watchlistExpiryDays * 24 * 60 * 60 * 1000;

  for (const candidate of candidates) {
    try {
      const klines = await binance.getKlines(candidate.symbol, '4h', 100);
      if (klines.length < 30) continue;

      const rsiValues = Indicators.rsi(klines, 14);
      const adxValues = Indicators.adx(klines, 14);

      const currentRSI = rsiValues[rsiValues.length - 1];
      const currentADX = adxValues[adxValues.length - 1];

      if (
        isNaN(currentRSI) || isNaN(currentADX) ||
        currentRSI < config.rsiMin || currentRSI > config.rsiMax ||
        currentADX < config.adxMin
      ) {
        await binance.sleep(150);
        continue;
      }

      // Order book imbalance
      const ob = await binance.getOrderBook(candidate.symbol, 50);
      const midPrice = ob.bids.length && ob.asks.length
        ? (ob.bids[0][0] + ob.asks[0][0]) / 2
        : candidate.price;
      const imbalance = Indicators.orderBookImbalance(ob.bids, ob.asks, midPrice);

      // Score: 0–10
      let score = 0;
      if (currentRSI >= 45 && currentRSI <= 65) score += 3; else score += 1;
      if (currentADX > 30) score += 3; else if (currentADX > 20) score += 2;
      if (Math.abs(imbalance) > 0.15) score += 2; else if (Math.abs(imbalance) > 0.05) score += 1;
      if (candidate.volumeRatio > 4) score += 2; else if (candidate.volumeRatio > 2) score += 1;

      confirmed.push({
        symbol:       candidate.symbol,
        addedAt:      Date.now(),
        expiresAt,
        score,
        rsi4H:        currentRSI,
        adx4H:        currentADX,
        imbalance4H:  imbalance,
        volumeRatio5m: candidate.volumeRatio,
        price:        candidate.price,
      });

      logger.info(
        `  ✓ ${candidate.symbol} | RSI=${currentRSI.toFixed(1)} ADX=${currentADX.toFixed(1)} Imb=${(imbalance * 100).toFixed(1)}% Score=${score}`
      );

      await binance.sleep(200);
    } catch (err) {
      logger.error(`Confirm scan error ${candidate.symbol}: ${err}`);
    }
  }

  // Add all confirmed to watchlist
  watchlist.upsertBatch(confirmed);

  const summary =
    `🔬 <b>Scan Cycle Complete</b>\n\n` +
    `Candidates: ${candidates.length}\n` +
    `Confirmed: ${confirmed.length}\n` +
    `Watchlist total: ${watchlist.count()} active\n\n` +
    confirmed
      .slice(0, 8)
      .map(e => `• ${e.symbol} | RSI ${e.rsi4H.toFixed(0)} | ADX ${e.adx4H.toFixed(0)} | Score ${e.score}/10`)
      .join('\n');

  await telegram.send(summary);
  logger.info(`Phase 2 done: ${confirmed.length} confirmed to watchlist`);
  return confirmed;
}
