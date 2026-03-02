import type { Candle } from '../types';

export class Indicators {

  // ── EMA ──────────────────────────────────────────────────────────
  static ema(candles: Candle[], period: number): number[] {
    const closes = candles.map(c => c.close);
    if (closes.length < period) return [];
    const k = 2 / (period + 1);
    const result: number[] = [];

    // Seed with SMA
    let prev = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
    result.push(prev);

    for (let i = period; i < closes.length; i++) {
      prev = closes[i] * k + prev * (1 - k);
      result.push(prev);
    }
    return result;
  }

  // ── SMA ──────────────────────────────────────────────────────────
  static sma(values: number[], period: number): number[] {
    const result: number[] = [];
    for (let i = period - 1; i < values.length; i++) {
      const sum = values.slice(i - period + 1, i + 1).reduce((a, b) => a + b, 0);
      result.push(sum / period);
    }
    return result;
  }

  // ── Volume MA ────────────────────────────────────────────────────
  static volumeMA(candles: Candle[], period: number): number[] {
    return this.sma(candles.map(c => c.volume), period);
  }

  // ── RSI ──────────────────────────────────────────────────────────
  static rsi(candles: Candle[], period = 14): number[] {
    const closes = candles.map(c => c.close);
    const gains: number[] = [];
    const losses: number[] = [];

    for (let i = 1; i < closes.length; i++) {
      const diff = closes[i] - closes[i - 1];
      gains.push(diff > 0 ? diff : 0);
      losses.push(diff < 0 ? -diff : 0);
    }

    if (gains.length < period) return [];

    const avgGains: number[] = [];
    const avgLosses: number[] = [];

    let ag = gains.slice(0, period).reduce((a, b) => a + b, 0) / period;
    let al = losses.slice(0, period).reduce((a, b) => a + b, 0) / period;
    avgGains.push(ag);
    avgLosses.push(al);

    for (let i = period; i < gains.length; i++) {
      ag = (ag * (period - 1) + gains[i]) / period;
      al = (al * (period - 1) + losses[i]) / period;
      avgGains.push(ag);
      avgLosses.push(al);
    }

    return avgGains.map((g, i) => {
      const rs = al === 0 ? 100 : g / avgLosses[i];
      return 100 - 100 / (1 + rs);
    });
  }

  // ── ADX ──────────────────────────────────────────────────────────
  static adx(candles: Candle[], period = 14): number[] {
    if (candles.length < period * 2) return [];

    const trs: number[] = [];
    const plusDM: number[] = [];
    const minusDM: number[] = [];

    for (let i = 1; i < candles.length; i++) {
      const h = candles[i].high,  l = candles[i].low;
      const ph = candles[i - 1].high, pl = candles[i - 1].low, pc = candles[i - 1].close;

      trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));

      const up = h - ph;
      const dn = pl - l;
      plusDM.push(up > dn && up > 0 ? up : 0);
      minusDM.push(dn > up && dn > 0 ? dn : 0);
    }

    // Wilder smooth
    const smooth = (arr: number[]) => {
      const res: number[] = [arr.slice(0, period).reduce((a, b) => a + b, 0)];
      for (let i = period; i < arr.length; i++) {
        res.push(res[res.length - 1] - res[res.length - 1] / period + arr[i]);
      }
      return res;
    };

    const sTR  = smooth(trs);
    const sPlus  = smooth(plusDM);
    const sMinus = smooth(minusDM);

    const DIs = sTR.map((tr, i) => ({
      plus:  tr ? (sPlus[i]  / tr) * 100 : 0,
      minus: tr ? (sMinus[i] / tr) * 100 : 0,
    }));

    const DXs = DIs.map(({ plus, minus }) => {
      const sum = plus + minus;
      return sum ? (Math.abs(plus - minus) / sum) * 100 : 0;
    });

    // ADX = Wilder smooth of DX
    const result: number[] = [];
    let adxVal = DXs.slice(0, period).reduce((a, b) => a + b, 0) / period;
    result.push(adxVal);
    for (let i = period; i < DXs.length; i++) {
      adxVal = (adxVal * (period - 1) + DXs[i]) / period;
      result.push(adxVal);
    }
    return result;
  }

  // ── Order book imbalance ──────────────────────────────────────────
  static orderBookImbalance(
    bids: [number, number][],
    asks: [number, number][],
    midPrice: number
  ): number {
    if (!bids.length || !asks.length) return 0;
    const wBid = bids.reduce((s, [p, q]) => s + q / (midPrice - p + 1), 0);
    const wAsk = asks.reduce((s, [p, q]) => s + q / (p - midPrice + 1), 0);
    const total = wBid + wAsk;
    return total ? (wBid - wAsk) / total : 0;
  }

  // ── EMA crossover check ───────────────────────────────────────────
  static emaCrossover(
    candles: Candle[],
    fast: number,
    slow: number
  ): { crossOver: boolean; crossUnder: boolean; fastVal: number; slowVal: number } {
    const fastEMA = this.ema(candles, fast);
    const slowEMA = this.ema(candles, slow);

    const minLen = Math.min(fastEMA.length, slowEMA.length);
    if (minLen < 2) return { crossOver: false, crossUnder: false, fastVal: 0, slowVal: 0 };

    const f1 = fastEMA[minLen - 1], f0 = fastEMA[minLen - 2];
    const s1 = slowEMA[minLen - 1], s0 = slowEMA[minLen - 2];

    return {
      crossOver:  f0 <= s0 && f1 > s1,
      crossUnder: f0 >= s0 && f1 < s1,
      fastVal: f1,
      slowVal: s1,
    };
  }

  // ── Volume spike check ────────────────────────────────────────────
  static volumeSpike(
    candles: Candle[],
    period: number,
    threshold: number
  ): { spike: boolean; ratio: number; currentVol: number; avgVol: number } {
    const vma = this.volumeMA(candles.slice(0, -1), period); // avg excl current
    if (!vma.length) return { spike: false, ratio: 0, currentVol: 0, avgVol: 0 };
    const avgVol = vma[vma.length - 1];
    const currentVol = candles[candles.length - 1].volume;
    const ratio = avgVol > 0 ? currentVol / avgVol : 0;
    return { spike: ratio >= threshold, ratio, currentVol, avgVol };
  }
}
