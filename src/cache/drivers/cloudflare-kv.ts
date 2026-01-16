/**
 * Cloudflare KV Cache
 *
 * Cache implementation using Cloudflare Workers KV.
 */

import type { KVNamespace } from "@cloudflare/workers-types";
import { CacheDriver, type CacheEntry } from "../driver";

/**
 * Cloudflare KV cache implementation
 */
export class CloudflareKVCache extends CacheDriver {
  private readonly kv: KVNamespace;

  constructor(kv: KVNamespace) {
    super("cloudflare-kv");
    this.kv = kv;
  }

  protected async get<T>(key: string): Promise<CacheEntry<T> | null> {
    const data = await this.kv.get<CacheEntry<T>>(key, "json");
    if (!data) return null;
    return data;
  }

  protected async set<T>(
    key: string,
    storageTtl: number,
    entry: CacheEntry<T>
  ): Promise<void> {
    // KV TTL is in seconds
    const kvTtlSeconds = Math.ceil(storageTtl / 1000);

    await this.kv.put(key, JSON.stringify(entry), {
      expirationTtl: kvTtlSeconds,
    });
  }

  protected async delete(keys: string[]): Promise<void> {
    await Promise.all(keys.map((key) => this.kv.delete(key)));
  }

  protected async clear(prefix: string): Promise<void> {
    const keys = await this.kv.list({ prefix });
    await Promise.all(keys.keys.map((k) => this.kv.delete(k.name)));
  }
}
