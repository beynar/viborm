# Cache - Caching Layer for Query Results

**Location:** `src/cache/`
**Layer:** L10 - Cache (see [root AGENTS.md](../../AGENTS.md))

## Purpose

Provides a caching abstraction for ORM query results with support for multiple cache backends, TTL management, and stale-while-revalidate (SWR) patterns.

## Why This Layer Exists

Database queries are often repeated with identical parameters. Caching these results improves performance, reduces database load, and enables edge deployments (Cloudflare Workers). This layer:

1. **Abstracts cache backends** - Memory, Cloudflare KV, Redis (future)
2. **Handles invalidation** - Automatic on mutations, manual via keys/prefixes
3. **Supports SWR** - Returns stale data immediately while revalidating in background
4. **Generates deterministic keys** - From model, operation, and args

```typescript
// Cache read queries with automatic key generation
const users = await orm.$withCache({ ttl: "1 hour", swr: true })
  .user.findMany({ where: { active: true } });

// Mutations automatically invalidate related cache
await orm.user.update({
  where: { id: "123" },
  data: { name: "Alice" },
  cache: { invalidate: ["user:*"] }  // Clear all user cache
});
```

---

## Entry Points

| File | Purpose | Modify When |
|------|---------|-------------|
| `driver.ts` | Abstract CacheDriver base class | Adding cache driver methods |
| `client.ts` | CachedClient proxy for cached queries | Changing cached query behavior |
| `key.ts` | Cache key generation (deterministic hashing) | Changing key format |
| `ttl.ts` | TTL string parsing ("1 hour" → ms) | Adding time units |
| `schema.ts` | Cache invalidation options schema | Adding invalidation options |
| `types.ts` | TypeScript types for cache options | Adding cache options |
| `index.ts` | Public exports | Adding new exports |
| `drivers/memory.ts` | In-memory cache implementation | Memory-specific fixes |
| `drivers/cloudflare-kv.ts` | Cloudflare KV implementation | KV-specific fixes |

---

## Core Concepts

### Cache Driver Abstraction

All cache backends extend the abstract `CacheDriver` class:

```typescript
abstract class CacheDriver {
  // Abstract methods - implement per backend
  protected abstract get<T>(key: string): Promise<CacheEntry<T> | null>;
  protected abstract set<T>(key: string, ttl: number, entry: CacheEntry<T>): Promise<void>;
  protected abstract delete(keys: string[]): Promise<void>;
  protected abstract clear(prefix: string): Promise<void>;

  // Public API - handles prefixing, instrumentation
  async _get<T>(key: string): Promise<CacheEntry<T> | null>;
  async _set<T>(key: string, value: T, options: CacheSetOptions): Promise<void>;
  async _invalidate(modelName: string, options?: CacheInvalidationOptions): Promise<void>;
}
```

**Why underscore prefix:** Public methods (`_get`, `_set`) handle cross-cutting concerns (key prefixing, instrumentation). Protected methods (`get`, `set`) are pure backend operations.

### Deterministic Cache Keys

Keys are generated from operation parameters:

```
viborm:<model>:<operation>:<hash>
viborm:user:findMany:abc123def456...
```

The hash uses a fast non-cryptographic algorithm (djb2 variant) on stable-stringified args. Stability means `{a: 1, b: 2}` and `{b: 2, a: 1}` produce the same hash.

> **TODO: Reconsider operation in cache key**
>
> Including the operation name in the key may not be ideal. Different operations with the same args (e.g., `findFirst` vs `findUnique` with identical where clause) generate the same SQL but produce different cache keys. This prevents cache sharing between semantically equivalent queries. Consider removing the operation from the key and relying solely on `model:hash` — the hash already encodes all query parameters that affect the result.

### Stale-While-Revalidate (SWR)

When `swr: true`:
1. Fresh hit → return immediately
2. Stale hit → return immediately, revalidate in background
3. Miss → execute query, cache result

The `_markRevalidating` method prevents thundering herd - only one request revalidates.

**Serverless environments:** Configure `waitUntil` at the client level to keep the runtime alive during background revalidation:

```typescript
// Cloudflare Workers
export default {
  async fetch(request, env, ctx) {
    const client = createClient({
      schema,
      driver,
      cache: new CloudflareKVCache(env.CACHE),
      waitUntil: ctx.waitUntil.bind(ctx),
    });
    return client.$withCache({ swr: true }).user.findMany({});
  }
}

// Vercel Edge
import { waitUntil } from '@vercel/functions';
const client = createClient({ schema, driver, cache, waitUntil });
const cached = client.$withCache({ swr: true });
```

### Cache Invalidation

Two patterns:
- **Automatic:** After mutations, clear model's cache prefix (opt-in via `autoInvalidate: true`)
- **Manual:** Specify keys or prefixes in mutation's `cache.invalidate` option

```typescript
// Clear specific key
cache: { invalidate: ["user:findUnique:abc123"] }

// Clear by prefix (note the *)
cache: { invalidate: ["user:*"] }
```

---

## Core Rules

### Rule 1: Prefix All Keys
All cache keys must be prefixed with `viborm:` to avoid collisions with other cache users. The base class handles this automatically.

### Rule 2: Double TTL for Storage
Storage TTL is 2x the user's TTL to allow SWR to serve stale content. The entry's `ttl` field stores the original value for staleness checks.

### Rule 3: Async-Only Operations
All cache operations are async. Even in-memory cache returns Promises for interface consistency.

### Rule 4: Instrumentation Support
All public methods support OpenTelemetry tracing via `this.instrumentation`. Cache operations appear as spans.

---

## Anti-Patterns

### Hardcoded Backend Logic in Client
Put backend-specific code in driver implementations, not in `client.ts`. The client should be backend-agnostic.

### Synchronous Cache Operations
Even if the backend is synchronous (memory), wrap in Promise. Interface consistency matters.

### Mutable Cache Entries
Cache entries should be treated as immutable. Don't modify returned values.

### Missing Revalidating Key Cleanup
Always call `_clearRevalidating` after background revalidation, even on error. Otherwise, the key stays locked.

### Unbounded Memory Cache
The memory cache doesn't implement TTL eviction at the storage level. It relies on staleness checks at read time. For production, use external caches.

---

## Adding New Cache Backend

1. **Create `drivers/{name}.ts`**:
   ```typescript
   import { CacheDriver, type CacheEntry } from "../driver";

   export class MyCache extends CacheDriver {
     constructor(/* backend-specific config */) {
       super("my-cache");
     }

     protected async get<T>(key: string): Promise<CacheEntry<T> | null> { ... }
     protected async set<T>(key: string, storageTtl: number, entry: CacheEntry<T>): Promise<void> { ... }
     protected async delete(keys: string[]): Promise<void> { ... }
     protected async clear(prefix: string): Promise<void> { ... }
   }
   ```

2. **Export from `index.ts`**:
   ```typescript
   export { MyCache } from "./driver/my-cache";
   ```

3. **Export from `src/index.ts`** (main package)

4. **Add tests**

---

## Invisible Knowledge

### Why Double TTL for Storage
Users expect "1 hour TTL" to mean "fresh for 1 hour". With SWR, we need to serve stale content past that point. Storing for 2x TTL ensures the entry exists for SWR while the entry's internal `ttl` field tracks actual freshness.

### Why Key Prefix Pattern
`viborm:user:*` as invalidation pattern uses `*` suffix to indicate "clear by prefix". Without `*`, it's a specific key. This matches Redis/Cloudflare KV prefix operations.

### Why Stable Stringify
Object key order in JavaScript is insertion-order, not alphabetical. `{a:1, b:2}` and `{b:2, a:1}` would hash differently without sorting keys first. Our `stableStringify` sorts keys.

### Why No TTL Eviction in Memory Cache
Implementing proper TTL eviction requires timers or periodic sweeps. For development/testing, staleness checks at read time are sufficient. Production should use Redis/KV with native TTL.

---

## Related Layers

| Layer | Relationship |
|-------|--------------|
| **Client** ([client/AGENTS.md](../client/AGENTS.md)) | Creates CachedClient via `$withCache()` |
| **Instrumentation** | Cache operations emit spans and logs |
| **Schema** | `cacheSchema` validates invalidation options in mutations |
