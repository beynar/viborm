# Cache — Official Query-Cache Extension

**Location:** `src/cache/`
**Layer:** L10

## Purpose

The cache layer owns deterministic read identity, portable detached result
snapshots, TTL/SWR orchestration, invalidation, and cache-backend storage. It
does not own SQL construction, provider execution, core result parsing,
transaction commit, or query-interceptor application.

Caching is installed only through the authenticated fixed-name extension:

```ts
const cached = createClient({ schema, driver }).$extends(
  cache({
    driver: new MemoryCache(),
    version: "r2",
    waitUntil,
  })
);
```

Base and ordinary-derived clients have no `$withCache` or `$invalidate` surface.
Never restore `cache`, `cacheVersion`, or `waitUntil` to `createClient()`.

## Owners

| Owner | Responsibility |
|---|---|
| `src/cache/extension.ts` | Hostile-safe config snapshot, fixed-name provenance, the definition/bound capability split, and the one client-bound scope binder |
| `driver.ts` | Get/set/SWR/invalidation orchestration and the authenticated official scope friend |
| `key.ts` | Canonical keys, official namespace encoding, legacy key helpers |
| `schema.ts` | Per-read cache options and mutation invalidation options |
| `cache-instrumentation.ts` | Cache presentation facts consumed by protected instrumentation |
| `query-engine/result/cache-result-codec.ts` | Shape-compiled detached snapshot/materialization codec |
| `query-engine/cache-flow.ts` | Official inner-core read attachment and detached snapshot execution |
| `drivers/*` | Backend-only get/set/delete/clear primitives |
| `client/client.ts` | Authenticated capability lookup and the irreducible client-view/cache trigger points |
| `src/extensions/query.ts` | The single ordered write-outcome rail used for durability-bound invalidation |

There is no second cache manager, mutable cache-driver version, client-config
fallback, mutation-wrapper registry, or native-batch invalidation owner.

## Key identity and scope

Official read identity is canonical post-request validated input plus model,
operation, projection, version namespace, and the private snapshot-format
revision. `CacheExecutionOptions.key` contributes a suffix; it never replaces
that identity.

Official namespaces are injectively encoded and authenticated by a private
capability. Public/unscoped driver methods must refuse the reserved
`viborm:cache:` namespace before backend or executor effects. Other
legacy-prefixed `viborm:*` storage keys retain their public backend contract.

The official scope is a PURE function of four facts: the private snapshot
revision, the cache `version`, the driver dialect, and `adapter.namespace`.
`cache()` produces a DEFINITION with no scope — one definition may be appended
to several clients — and the client composition root (`$extends`, the one place
holding both the resolved chain and the concrete driver) calls
`bindOfficialCacheChain` for a chain that carries the official cache. Generic
extension-chain code sees only `getOfficialCacheChainDefinition`; no dialect
condition enters it, and an ordinary extension makes no bind call.

Because the derivation is pure, re-appending an extension retains the scope by
VALUE. Never introduce a registry keyed on chain or client identity to hand an
old scope back, and never let a transaction view mint its own — views reuse
their chain and therefore its scope.

Every component of the namespace is fixed-width-hex encoded behind a
discriminator letter, and the separator never appears inside a body. That is
what makes the join injective: an absent namespace is a bare token no string can
spell, so a database named `undefined` cannot collide with an unbound one, and a
PostgreSQL schema `billing` cannot collide with a MySQL database `billing`.
Extend `createOfficialCacheNamespace`'s facts; never string-append at a call
site. Bump the snapshot revision whenever the derivation changes meaning, and
re-pin the exact-byte tests deliberately in the same change.

No connection string, host, username, or credential enters cache identity, and
the SQL namespace never appears in a public cache key or an operation argument.

Official `$invalidate` and mutation `cache.invalidate` accept relative exact
keys or `*` suffix prefixes. Validate the complete target list before starting
any delete or clear. `autoInvalidate` clears `${modelName}:`, including the
delimiter, inside the exact official namespace.

## Result snapshots

Cache storage never owns provider rows. The official wrapper receives the
normally parsed core result, snapshots it synchronously before outer query
post-work, and materializes a fresh graph on every hit. The compiled codec is
shape-directed and shares raw-column and aggregate-leaf classification with the
normal result parser. Do not add a generic serializer or route hits back through
`ResultParser`.

Snapshots are hostile input on materialization. Exact node kinds, keys,
cardinality, dimensions, prototypes, and dense-array structure are validated at
that boundary. Errors expose no cached values. Custom JSON validation runs on
the provider result only, not again on a hit.

Decimal snapshot leaves use the scalar's canonical private logical string. A
cache entry never stores a `Decimal` instance, its constructor state, or a
JavaScript number. Materialization validates that text against the compiled
descriptor and creates a fresh public `Decimal` for each result leaf. Decimal
lists apply the same rule member by member. Keep this logic in the shape-compiled
cache result codec; do not add a general-purpose Decimal serializer.

## SWR

A stale hit synchronously gives one complete background promise to the exact
chain's `waitUntil`. That promise owns marker acquisition, inner core replay,
snapshot, set, and cleanup. Background replay does not rerun request transforms,
ordinary query interceptors, or a second logical operation.

Marker get-then-set is best-effort and is not an atomic distributed claim.
Always clear the marker. Worker failure stays primary over cleanup failure;
both are retained for protected lifecycle presentation. Scheduling, work,
storage, and cleanup failures never alter the stale application result or leak
an unhandled rejection.

## Invalidation

Package cache invalidation is a pre-registered entry on the existing ordered
`TransactionWriteOutcomes` rail. It is seeded before public listeners and
published once for committed or possibly committed writes. Rollback and
savepoint rollback discard it; savepoint success promotes it to the parent.
The registration owns its `CacheConfigurationError` boundary and adds exact
commit certainty while later listeners are still attempted.

Every cache-capable mutation registers the invalidator even when the normalized
option is absent. This preserves the observable default invalidation lifecycle.
Do not reintroduce executor wrappers, per-mutation WeakMaps, or native/fallback
publication branches.

## Deliberate read bypass

Official caching is bypassed for callback/nested transactions, public array
transactions, statement-transform chains, safe and unsafe raw operations, and
the existing no-cache execution context. Query interceptors stay outside the
cache wrapper, independent of extension declaration order. Cache-managed reads
are always borrowed and never claim consumable provider rows.

## Instrumentation and privacy

Cache get, set, invalidate, and actual revalidation work emit protected cache
lifecycle facts only when observers exist. Marker clear/delete helpers are not
fictional public cache units. Official instrumentation may present its private
facts, but ordinary observers see only the frozen public unit and completion.
Cache keys and suffixes never reach units, spans, logs, errors, or correlation.

## Backend rules

- Backends implement asynchronous `get`, `set`, `delete`, and `clear` only.
- Memory timers use the complete storage TTL and are `unref()`'d.
- Cloudflare KV listing follows cursors until complete.
- Backend code does not apply versioning, canonical identity, SWR policy,
  instrumentation policy, or transaction semantics.
- Do not mutate a returned cache entry or application result graph.

## Validation

Run the focused cache/client contract first, then the cache, client,
query-engine, driver, and instrumentation layer gates sequentially. Never
overlap Vitest or TypeScript processes.
