import { CacheDriver, CacheOptions } from "./types";
import { KVNamespace } from "@cloudflare/workers-types";

export class CloudflareKVCache implements CacheDriver {
  constructor(private readonly kv: KVNamespace) {}

  async get(key: string): Promise<unknown> {
    return this.kv.get(key);
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
