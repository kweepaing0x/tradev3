import { config } from './config';
import { logger } from './logger';
import { telegram } from './services/telegram';
import { positionManager } from './services/position';
import { watchlist } from './services/watchlist';
import { runVolumeScan, runConfirmScan } from './services/scanner';
import { runWatchlistScan, monitorPosition } from './services/trader';

// ── State ─────────────────────────────────────────────────────────
let cycleTimer: NodeJS.Timeout | null = null;
let positionMonitorTimer: NodeJS.Timeout | null = null;
let isRunningCycle = false;

// ── Scheduling helpers ────────────────────────────────────────────

/** Milliseconds until the next 4-hour UTC boundary */
function msUntilNext4H(): number {
  const now = new Date();
  const totalMins = now.getUTCHours() * 60 + now.getUTCMinutes();
  const minsIntoCycle = totalMins % 240;
  const minsRemaining = minsIntoCycle === 0 ? 0 : 240 - minsIntoCycle;
  const ms =
    minsRemaining * 60 * 1000 -
    now.getUTCSeconds() * 1000 -
    now.getUTCMilliseconds();
  // If we're within 30s of a boundary, treat as now
  return ms < 30_000 ? 2_000 : ms;
}

function formatMs(ms: number): string {
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  return `${h}h ${m}m ${s}s`;
}

// ── Main scan cycle (runs every 4H UTC) ──────────────────────────

async function runScanCycle(): Promise<void> {
  if (isRunningCycle) {
    logger.warn('Cycle already running — skipping');
    return;
  }

  isRunningCycle = true;
  logger.info('');
  logger.info('════════════════════════════════════════');
  logger.info('  4H SCAN CYCLE STARTED');
  logger.info(`  ${new Date().toUTCString()}`);
  logger.info('════════════════════════════════════════');

  try {
    // ── If position is open, skip scanning entirely ───────────────
    if (positionManager.hasPosition()) {
      const pos = positionManager.get()!;
      logger.info(`Active position on ${pos.symbol} — skipping scan cycle`);
      await telegram.send(
        `⏭️ <b>Scan skipped</b> — position open on <b>${pos.symbol}</b>\n` +
        `Monitor running every 1hr`
      );
      scheduleNext();
      return;
    }

    // ── Phase 1: Volume spike scan ────────────────────────────────
    const candidates = await runVolumeScan();

    if (candidates.length === 0) {
      logger.info('No volume spike candidates found — waiting for next cycle');
      await telegram.send('🔍 Scan complete — no volume spikes found this cycle');
      scheduleNext();
      return;
    }

    // ── Phase 2: 4H confirmation ──────────────────────────────────
    await runConfirmScan(candidates);

    // ── Phase 3: Watchlist entry scan ─────────────────────────────
    if (watchlist.count() > 0) {
      await runWatchlistScan();
    } else {
      logger.info('Watchlist empty — skipping Phase 3');
    }

    // ── If position opened, start hourly monitor ──────────────────
    if (positionManager.hasPosition()) {
      startPositionMonitor();
    }

  } catch (err) {
    logger.error(`Cycle error: ${err}`);
    await telegram.send(`❌ <b>Bot Error</b>\n${err}`);
  } finally {
    isRunningCycle = false;
    scheduleNext();
  }
}

// ── Position monitor loop (every 1hr) ────────────────────────────

function startPositionMonitor(): void {
  stopPositionMonitor();

  logger.info('Starting position monitor (every 1hr)');

  positionMonitorTimer = setInterval(async () => {
    try {
      const stillOpen = await monitorPosition();
      if (!stillOpen) {
        logger.info('Position closed — stopping hourly monitor');
        stopPositionMonitor();
      }
    } catch (err) {
      logger.error(`Position monitor error: ${err}`);
    }
  }, 60 * 60 * 1000); // 1 hour
}

function stopPositionMonitor(): void {
  if (positionMonitorTimer) {
    clearInterval(positionMonitorTimer);
    positionMonitorTimer = null;
  }
}

// ── Next cycle scheduling ─────────────────────────────────────────

function scheduleNext(): void {
  if (cycleTimer) clearTimeout(cycleTimer);
  const ms = msUntilNext4H();
  logger.info(`Next scan cycle in ${formatMs(ms)}`);
  cycleTimer = setTimeout(runScanCycle, ms);
}

// ── Graceful shutdown ─────────────────────────────────────────────

async function shutdown(signal: string): Promise<void> {
  logger.info(`Received ${signal} — shutting down gracefully`);
  if (cycleTimer) clearTimeout(cycleTimer);
  stopPositionMonitor();

  if (positionManager.hasPosition()) {
    logger.warn('Bot stopped with an open position — position data saved to data/position.json');
    await telegram.send(
      `⚠️ <b>Bot Stopped</b> (${signal})\n\n` +
      `Open position preserved in data/position.json\n` +
      `Restart bot to resume monitoring`
    );
  } else {
    await telegram.send(`🤖 <b>Bot stopped</b> (${signal})`);
  }

  process.exit(0);
}

process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('uncaughtException', async (err) => {
  logger.error(`Uncaught exception: ${err}`);
  await telegram.send(`💥 <b>Bot crashed</b>\n${err.message}`);
  process.exit(1);
});

// ── Startup ───────────────────────────────────────────────────────

async function main(): Promise<void> {
  logger.info('');
  logger.info('╔════════════════════════════════════════╗');
  logger.info('║   BINANCE FUTURES AUTO-TRADING BOT     ║');
  logger.info('╚════════════════════════════════════════╝');
  logger.info(`Mode:       ${config.dryRun ? 'DRY RUN (no real orders)' : '🔴 LIVE TRADING'}`);
  logger.info(`Base URL:   ${config.baseUrl}`);
  logger.info(`Margin:     $${config.marginUsdt} × ${config.leverage}x`);
  logger.info(`TP/SL:      ${config.tpPercent}% / ${config.slPercent}%`);
  logger.info(`Half-close: ${config.halfClosePercent}%`);
  logger.info(`Watchlist:  ${watchlist.count()} active pairs`);
  logger.info('');

  await telegram.send(
    `🤖 <b>Bot Started</b>\n\n` +
    `Mode: ${config.dryRun ? '🧪 Dry Run' : '🔴 Live'}\n` +
    `Margin: $${config.marginUsdt} × ${config.leverage}x\n` +
    `TP: ${config.tpPercent}% | SL: ${config.slPercent}%\n` +
    `Half-close: ${config.halfClosePercent}%\n` +
    `Watchlist: ${watchlist.count()} pairs`
  );

  // If a position was open before restart, resume monitoring
  if (positionManager.hasPosition()) {
    const pos = positionManager.get()!;
    logger.info(`Resuming monitor for existing position: ${pos.direction} ${pos.symbol}`);
    await telegram.send(
      `🔄 <b>Resuming position monitor</b>\n` +
      `${pos.direction} ${pos.symbol} @ $${pos.entryPrice.toFixed(6)}\n` +
      `TP: $${pos.tpPrice.toFixed(4)} | SL: $${pos.slPrice.toFixed(4)}`
    );
    startPositionMonitor();
  }

  // Prune expired watchlist entries
  watchlist.pruneExpired();

  // Schedule first cycle
  const ms = msUntilNext4H();
  logger.info(`First scan cycle in ${formatMs(ms)}`);
  cycleTimer = setTimeout(runScanCycle, ms);
}

main().catch(async (err) => {
  logger.error(`Startup failed: ${err}`);
  await telegram.send(`💥 <b>Startup failed</b>\n${err}`);
  process.exit(1);
});
