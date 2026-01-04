import type { KVNamespace } from "@cloudflare/workers-types";
import type { CacheDriver, CacheOptions } from "./types";

export class CloudflareKVCache implements CacheDriver {
  private readonly kv: KVNamespace;
  constructor(kv: KVNamespace) {
    this.kv = kv;
  }

  async get(key: string): Promise<unknown> {
    return await this.kv.get(key);
  }
  async set(key: string, value: unknown, options: CacheOptions): Promise<void> {
    await this.kv.put(key, JSON.stringify(value), {
      expirationTtl: options.ttl,
    });
  }
  async delete(key: string): Promise<void> {
    await this.kv.delete(key);
  }
  async clear(prefix?: string): Promise<void> {
    const prefixKey = prefix ? `VIBORM_CACHE:${prefix}` : "VIBORM_CACHE";
    const keys = await this.kv.list({ prefix: prefixKey });
    await Promise.all(keys.keys.map((key) => this.kv.delete(key.name)));
    return;
  }
}
