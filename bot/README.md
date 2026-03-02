# Binance Futures Auto-Trading Bot

A Node.js trading bot that runs on a VPS, scanning Binance Futures for high-potential pairs and auto-trading with risk management.

## Strategy

```
Every 4H UTC (00:00, 04:00, 08:00, 12:00, 16:00, 20:00):
  1. Volume Spike Scan   — all USDT pairs on 5m, find spikes > 2x avg
  2. 4H Confirmation     — RSI 40-70, ADX > 20, order book imbalance check
  3. Watchlist Scan      — 8/21 EMA crossover on 15m → entry

On entry:
  - $10 margin × 20x leverage = $200 notional
  - TP: +20%, SL: -20% (set as exchange orders)
  - At +10%: close 50%, move SL to breakeven
  - At TP: close remaining 50% fully

While position open:
  - Monitor every 1 hour
  - ALL scanning stopped
  - Resume normal cycle after close

Watchlist:
  - All confirmed pairs added (no cap)
  - Entries expire after 5 days
```

## Setup

### 1. Install dependencies

```bash
cd bot
npm install
```

### 2. Configure environment

```bash
cp .env.example .env
nano .env
```

Fill in:
- `BINANCE_API_KEY` / `BINANCE_API_SECRET`
- `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID`
- Set `DRY_RUN=false` when ready for live trading
- For testnet: keep `BINANCE_BASE_URL=https://testnet.binancefuture.com`
- For live: change to `BINANCE_BASE_URL=https://fapi.binance.com`

### 3. Build

```bash
npm run build
```

### 4. Run with PM2 (recommended for VPS)

```bash
npm install -g pm2
pm2 start dist/index.js --name trading-bot --restart-delay=5000
pm2 save
pm2 startup   # auto-start on reboot
```

### 5. Monitor

```bash
pm2 logs trading-bot        # live logs
pm2 status                  # status
tail -f logs/bot.log        # raw log file
cat data/position.json      # current position
cat data/watchlist.json     # current watchlist
```

### 6. Stop

```bash
pm2 stop trading-bot
# or
pm2 delete trading-bot
```

## File Structure

```
bot/
├── src/
│   ├── index.ts              # Entry point + scheduler
│   ├── config.ts             # Loads .env config
│   ├── logger.ts             # File + console logging
│   ├── types/index.ts        # TypeScript types
│   └── services/
│       ├── binance.ts        # Binance Futures REST API
│       ├── indicators.ts     # RSI, ADX, EMA, Volume
│       ├── scanner.ts        # Phase 1 & 2 scan logic
│       ├── trader.ts         # Phase 3 + position monitor
│       ├── position.ts       # Position state + close logic
│       ├── watchlist.ts      # Persistent watchlist (JSON)
│       └── telegram.ts       # Telegram notifications
├── data/
│   ├── watchlist.json        # Auto-created
│   └── position.json         # Auto-created when position opens
├── logs/
│   └── bot.log               # Auto-created
├── .env                      # Your config (never commit this)
├── .env.example              # Template
├── package.json
└── tsconfig.json
```

## Important Notes

- **DRY_RUN=true** by default — no real orders will be placed
- Position state survives bot restarts (saved to `data/position.json`)
- Watchlist survives restarts (saved to `data/watchlist.json`)
- On restart with open position → bot immediately resumes 1hr monitoring
- All actions sent to Telegram
- Logs rotate to `logs/bot.log`

## Binance Testnet

Get testnet API keys at: https://testnet.binancefuture.com
Use base URL: `https://testnet.binancefuture.com`

## Binance Live

API keys at: https://www.binance.com/en/my/settings/api-management
Enable: **Futures trading** permission only (no withdrawals)
Use base URL: `https://fapi.binance.com`
