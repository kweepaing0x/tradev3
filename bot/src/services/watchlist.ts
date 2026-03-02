import fs from 'fs';
import path from 'path';
import { logger } from '../logger';
import type { WatchlistEntry } from '../types';

const DATA_DIR  = path.join(process.cwd(), 'data');
const FILE_PATH = path.join(DATA_DIR, 'watchlist.json');

class WatchlistService {
  private entries: WatchlistEntry[] = [];

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
        this.entries = JSON.parse(fs.readFileSync(FILE_PATH, 'utf8'));
        logger.info(`Watchlist loaded: ${this.entries.length} entries`);
      }
    } catch (err) {
      logger.error(`Failed to load watchlist: ${err}`);
      this.entries = [];
    }
  }

  private save() {
    try {
      fs.writeFileSync(FILE_PATH, JSON.stringify(this.entries, null, 2));
    } catch (err) {
      logger.error(`Failed to save watchlist: ${err}`);
    }
  }

  /** All entries including expired */
  getAll(): WatchlistEntry[] {
    return [...this.entries];
  }

  /** Only non-expired entries, sorted by score desc */
  getActive(): WatchlistEntry[] {
    const now = Date.now();
    return this.entries
      .filter(e => e.expiresAt > now)
      .sort((a, b) => b.score - a.score);
  }

  /** Add or update. If symbol exists, refreshes data but keeps original addedAt */
  upsert(entry: WatchlistEntry) {
    const idx = this.entries.findIndex(e => e.symbol === entry.symbol);
    if (idx >= 0) {
      this.entries[idx] = { ...entry, addedAt: this.entries[idx].addedAt };
    } else {
      this.entries.push(entry);
    }
    this.save();
  }

  /** Batch upsert then prune expired */
  upsertBatch(entries: WatchlistEntry[]) {
    for (const e of entries) this.upsert(e);
    this.pruneExpired();
    logger.info(`Watchlist: ${this.getActive().length} active pairs`);
  }

  remove(symbol: string) {
    this.entries = this.entries.filter(e => e.symbol !== symbol);
    this.save();
  }

  pruneExpired() {
    const before = this.entries.length;
    const now = Date.now();
    this.entries = this.entries.filter(e => e.expiresAt > now);
    const pruned = before - this.entries.length;
    if (pruned > 0) {
      logger.info(`Watchlist: pruned ${pruned} expired entries`);
      this.save();
    }
  }

  has(symbol: string): boolean {
    const now = Date.now();
    return this.entries.some(e => e.symbol === symbol && e.expiresAt > now);
  }

  count(): number {
    return this.getActive().length;
  }

  clear() {
    this.entries = [];
    this.save();
  }
}

export const watchlist = new WatchlistService();
