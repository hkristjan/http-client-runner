import * as crypto from 'crypto';
import type { CacheAdapter, CachedResponse } from './types';

/**
 * Default in-memory cache adapter.
 * Stores cached responses in a Map with TTL-based expiration.
 */
export class MemoryCacheAdapter implements CacheAdapter {
  private _store = new Map<string, { value: CachedResponse; expiresAt: number }>();

  async get(key: string): Promise<CachedResponse | undefined> {
    const entry = this._store.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this._store.delete(key);
      return undefined;
    }
    return clone(entry.value);
  }

  async set(key: string, value: CachedResponse, ttlMs: number): Promise<void> {
    this._pruneExpired();
    this._store.set(key, { value: clone(value), expiresAt: Date.now() + ttlMs });
  }

  private _pruneExpired(): void {
    const now = Date.now();
    for (const [k, entry] of this._store) {
      if (now > entry.expiresAt) this._store.delete(k);
    }
  }

  async delete(key: string): Promise<boolean> {
    return this._store.delete(key);
  }

  async clear(): Promise<void> {
    this._store.clear();
  }
}

/**
 * Compute a deterministic cache key from resolved request properties.
 * Used when no explicit `key` is provided in the @cache directive.
 */
export function computeCacheKey(
  method: string,
  url: string,
  headers: Record<string, string>,
  body: string | undefined,
): string {
  const sortedHeaders = Object.keys(headers)
    .map((k) => `${k.toLowerCase()}=${headers[k]}`)
    .sort()
    .join('&');
  const raw = `${method}|${url}|${sortedHeaders}|${body ?? ''}`;
  return crypto.createHash('sha256').update(raw).digest('hex');
}

function clone(value: CachedResponse): CachedResponse {
  return JSON.parse(JSON.stringify(value));
}
