import crypto from 'crypto';
import axios, { type AxiosInstance } from 'axios';
import { config } from '../config';
import { logger } from '../logger';
import type { Candle, OrderBookData, SymbolInfo } from '../types';

// ─────────────────────────────────────────────────────────────────
// Base signed client
// ─────────────────────────────────────────────────────────────────

class BinanceClient {
  protected http: AxiosInstance;
  private apiSecret: string;

  constructor(baseURL: string, apiKey: string, apiSecret: string) {
    this.apiSecret = apiSecret;
    this.http = axios.create({
      baseURL,
      timeout: 12_000,
      headers: {
        'X-MBX-APIKEY': apiKey,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
    });
  }

  protected sign(params: Record<string, string | number>): string {
    const qs = new URLSearchParams(
      Object.entries(params).map(([k, v]) => [k, String(v)])
    ).toString();
    return crypto.createHmac('sha256', this.apiSecret).update(qs).digest('hex');
  }

  protected signed(params: Record<string, string | number>) {
    const p = { ...params, timestamp: Date.now() };
    return { ...p, signature: this.sign(p) };
  }

  protected toForm(params: Record<string, string | number>): URLSearchParams {
    return new URLSearchParams(
      Object.entries(params).map(([k, v]) => [k, String(v)])
    );
  }

  sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }
}

// ─────────────────────────────────────────────────────────────────
// SCAN CLIENT — Binance Testnet
// Handles all read-only / public data fetching
// ─────────────────────────────────────────────────────────────────

class ScanClient extends BinanceClient {
  // Cache symbol info to avoid repeated fetches
  private symbolInfoCache: Map<string, SymbolInfo> = new Map();
  private symbolListCache: string[] = [];
  private symbolListFetchedAt = 0;

  constructor() {
    super(config.scanBaseUrl, config.scanApiKey, config.scanApiSecret);
  }

  async getSymbols(): Promise<string[]> {
    // Cache for 10 minutes
    if (this.symbolListCache.length && Date.now() - this.symbolListFetchedAt < 600_000) {
      return this.symbolListCache;
    }
    try {
      const { data } = await this.http.get('/fapi/v1/exchangeInfo');
      this.symbolListCache = data.symbols
        .filter((s: any) => s.quoteAsset === 'USDT' && s.status === 'TRADING')
        .map((s: any) => s.symbol as string);
      this.symbolListFetchedAt = Date.now();

      // Also populate symbol info cache while we have the data
      for (const s of data.symbols) {
        if (s.quoteAsset !== 'USDT' || s.status !== 'TRADING') continue;
        const lotFilter  = s.filters.find((f: any) => f.filterType === 'LOT_SIZE');
        const notFilter  = s.filters.find((f: any) => f.filterType === 'MIN_NOTIONAL');
        this.symbolInfoCache.set(s.symbol, {
          symbol:            s.symbol,
          pricePrecision:    s.pricePrecision,
          quantityPrecision: s.quantityPrecision,
          minQty:            lotFilter ? parseFloat(lotFilter.minQty) : 0.001,
          minNotional:       notFilter ? parseFloat(notFilter.notional) : 5,
        });
      }

      logger.info(`Exchange info: ${this.symbolListCache.length} USDT pairs cached`);
      return this.symbolListCache;
    } catch (err) {
      logger.error(`getSymbols failed: ${err}`);
      return [];
    }
  }

  async getSymbolInfo(symbol: string): Promise<SymbolInfo | null> {
    if (!this.symbolInfoCache.has(symbol)) await this.getSymbols();
    return this.symbolInfoCache.get(symbol) ?? null;
  }

  async getKlines(symbol: string, interval: string, limit = 100): Promise<Candle[]> {
    try {
      const { data } = await this.http.get('/fapi/v1/klines', {
        params: { symbol, interval, limit },
      });
      return data.map((k: any[]) => ({
        timestamp: k[0],
        open:   parseFloat(k[1]),
        high:   parseFloat(k[2]),
        low:    parseFloat(k[3]),
        close:  parseFloat(k[4]),
        volume: parseFloat(k[5]),
      }));
    } catch (err) {
      logger.error(`getKlines ${symbol} ${interval}: ${err}`);
      return [];
    }
  }

  async getOrderBook(symbol: string, limit = 50): Promise<OrderBookData> {
    try {
      const { data } = await this.http.get('/fapi/v1/depth', {
        params: { symbol, limit },
      });
      return {
        bids: data.bids.map((b: string[]) => [parseFloat(b[0]), parseFloat(b[1])]),
        asks: data.asks.map((a: string[]) => [parseFloat(a[0]), parseFloat(a[1])]),
        timestamp: Date.now(),
      };
    } catch (err) {
      logger.error(`getOrderBook ${symbol}: ${err}`);
      return { bids: [], asks: [], timestamp: Date.now() };
    }
  }

  /**
   * Get mark price from LIVE exchange (not testnet) so the monitor
   * checks against real market price. Falls back to testnet if live fails.
   */
  async getMarkPrice(symbol: string): Promise<number> {
    // Try live price first for accuracy during position monitoring
    try {
      const { data } = await axios.get(
        `https://fapi.binance.com/fapi/v1/premiumIndex`,
        { params: { symbol }, timeout: 8000 }
      );
      return parseFloat(data.markPrice);
    } catch {
      // Fall back to testnet
      try {
        const { data } = await this.http.get('/fapi/v1/premiumIndex', {
          params: { symbol },
        });
        return parseFloat(data.markPrice);
      } catch (err) {
        logger.error(`getMarkPrice ${symbol}: ${err}`);
        return 0;
      }
    }
  }
}

// ─────────────────────────────────────────────────────────────────
// TRADE CLIENT — Binance Live Futures
// Handles all order placement (real money)
// ─────────────────────────────────────────────────────────────────

class TradeClient extends BinanceClient {
  constructor() {
    super(config.tradeBaseUrl, config.tradeApiKey, config.tradeApiSecret);
  }

  async setLeverage(symbol: string, leverage: number): Promise<boolean> {
    if (config.dryRun) {
      logger.info(`[DRY RUN] setLeverage ${symbol} ${leverage}x`);
      return true;
    }
    try {
      await this.http.post(
        '/fapi/v1/leverage',
        this.toForm(this.signed({ symbol, leverage }))
      );
      logger.info(`Leverage set: ${symbol} ${leverage}x`);
      return true;
    } catch (err: any) {
      logger.error(`setLeverage ${symbol}: ${err?.response?.data?.msg ?? err}`);
      return false;
    }
  }

  /**
   * Place a LIMIT entry order at the given price.
   * Uses GTC (Good Till Cancelled) — stays open until filled or cancelled.
   */
  async placeLimit(params: {
    symbol: string;
    side: 'BUY' | 'SELL';
    quantity: number;
    price: number;
    pricePrecision: number;
    quantityPrecision: number;
    reduceOnly?: boolean;
  }): Promise<{ orderId: string; price: number } | null> {
    const priceStr = params.price.toFixed(params.pricePrecision);
    const qtyStr   = params.quantity.toFixed(params.quantityPrecision);

    const body: Record<string, string | number> = {
      symbol:      params.symbol,
      side:        params.side,
      type:        'LIMIT',
      price:       priceStr,
      quantity:    qtyStr,
      timeInForce: 'GTC',
    };
    if (params.reduceOnly) body.reduceOnly = 'true';

    if (config.dryRun) {
      logger.info(`[DRY RUN] LIMIT ${params.side} ${qtyStr} ${params.symbol} @ $${priceStr}`);
      return { orderId: `DRY_LIMIT_${Date.now()}`, price: params.price };
    }

    try {
      const { data } = await this.http.post(
        '/fapi/v1/order',
        this.toForm(this.signed(body))
      );
      logger.info(`LIMIT order placed: ${params.side} ${qtyStr} ${params.symbol} @ $${priceStr} → orderId=${data.orderId}`);
      return { orderId: String(data.orderId), price: parseFloat(data.price) };
    } catch (err: any) {
      logger.error(`placeLimit failed: ${err?.response?.data?.msg ?? err}`);
      return null;
    }
  }

  /**
   * Place a stop/TP order (STOP_MARKET or TAKE_PROFIT_MARKET).
   * closePosition=true closes the entire position when triggered.
   */
  async placeStop(params: {
    symbol: string;
    side: 'BUY' | 'SELL';
    type: 'STOP_MARKET' | 'TAKE_PROFIT_MARKET';
    stopPrice: number;
    pricePrecision: number;
    closePosition?: boolean;
  }): Promise<{ orderId: string } | null> {
    const stopPriceStr = params.stopPrice.toFixed(params.pricePrecision);

    const body: Record<string, string | number> = {
      symbol:        params.symbol,
      side:          params.side,
      type:          params.type,
      stopPrice:     stopPriceStr,
      closePosition: params.closePosition ? 'true' : 'false',
    };

    if (config.dryRun) {
      logger.info(`[DRY RUN] ${params.type} ${params.side} ${params.symbol} @ $${stopPriceStr}`);
      return { orderId: `DRY_${params.type}_${Date.now()}` };
    }

    try {
      const { data } = await this.http.post(
        '/fapi/v1/order',
        this.toForm(this.signed(body))
      );
      logger.info(`${params.type} placed: ${params.symbol} trigger=$${stopPriceStr} → orderId=${data.orderId}`);
      return { orderId: String(data.orderId) };
    } catch (err: any) {
      logger.error(`placeStop failed: ${err?.response?.data?.msg ?? err}`);
      return null;
    }
  }

  /**
   * Cancel an open order by ID.
   */
  async cancelOrder(symbol: string, orderId: string): Promise<boolean> {
    if (config.dryRun) {
      logger.info(`[DRY RUN] cancelOrder ${orderId}`);
      return true;
    }
    try {
      await this.http.delete(
        '/fapi/v1/order',
        { params: this.signed({ symbol, orderId }) }
      );
      logger.info(`Order cancelled: ${orderId}`);
      return true;
    } catch (err: any) {
      // -2011 = unknown order — already filled or cancelled, not an error
      const code = err?.response?.data?.code;
      if (code === -2011) {
        logger.warn(`cancelOrder ${orderId}: already filled/cancelled`);
        return true;
      }
      logger.error(`cancelOrder ${orderId}: ${err?.response?.data?.msg ?? err}`);
      return false;
    }
  }

  /**
   * Check if a limit order has been filled.
   */
  async getOrderStatus(symbol: string, orderId: string): Promise<'NEW' | 'FILLED' | 'CANCELED' | 'EXPIRED' | 'UNKNOWN'> {
    if (config.dryRun) return 'FILLED'; // dry run: assume always filled
    try {
      const { data } = await this.http.get(
        '/fapi/v1/order',
        { params: this.signed({ symbol, orderId }) }
      );
      return data.status;
    } catch (err: any) {
      logger.error(`getOrderStatus ${orderId}: ${err?.response?.data?.msg ?? err}`);
      return 'UNKNOWN';
    }
  }

  /**
   * Cancel all open orders for a symbol (cleanup on close).
   */
  async cancelAllOrders(symbol: string): Promise<void> {
    if (config.dryRun) { logger.info(`[DRY RUN] cancelAllOrders ${symbol}`); return; }
    try {
      await this.http.delete(
        '/fapi/v1/allOpenOrders',
        { params: this.signed({ symbol }) }
      );
      logger.info(`All open orders cancelled for ${symbol}`);
    } catch (err: any) {
      logger.error(`cancelAllOrders ${symbol}: ${err?.response?.data?.msg ?? err}`);
    }
  }

  /**
   * Get current open positions for a symbol from live account.
   */
  async getPosition(symbol: string): Promise<{ size: number; entryPrice: number } | null> {
    if (config.dryRun) return null;
    try {
      const { data } = await this.http.get(
        '/fapi/v2/positionRisk',
        { params: this.signed({ symbol }) }
      );
      const pos = data.find((p: any) => parseFloat(p.positionAmt) !== 0);
      if (!pos) return null;
      return {
        size:       Math.abs(parseFloat(pos.positionAmt)),
        entryPrice: parseFloat(pos.entryPrice),
      };
    } catch (err) {
      logger.error(`getPosition ${symbol}: ${err}`);
      return null;
    }
  }
}

// ─────────────────────────────────────────────────────────────────
// Exports — two separate singletons
// ─────────────────────────────────────────────────────────────────

export const scanClient  = new ScanClient();   // testnet — read only
export const tradeClient = new TradeClient();  // live    — orders only
