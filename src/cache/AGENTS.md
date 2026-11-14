# Cache — Official Query-Cache Extension

**Location:** `src/cache/`
**Layer:** L10

## Purpose

The cache layer owns portable detached result snapshots, TTL/SWR
orchestration, invalidation, and cache-backend storage. It does not own SQL
construction, provider execution, core result parsing, transaction commit,
read identity (the prepared call's `key(run)` is), or the application of
other extensions.

The cache is an ordinary extension written with the public contract (root
Rule 6), applied in one step:

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
The chain names nothing of the cache, the engine names nothing of it, and
the client holds no cache capability, lookup or trigger point: what the
cache needs that a third party could not take is a public word to add, not
a friend import. Its remaining private reads are listed in
`tests/contracts/public-client/extension-imports.core.test.ts` (`PENDING`):
a call's execution context and driver (`callOf`/`scopeOf`, `originOf`),
whether its chain observes units, a method's operation context, the clock,
private validation helpers.

## Owners

| Owner | Responsibility |
|---|---|
| `src/cache/extension.ts` | `cache(config)`: the configuration read once (a `CacheDriver`, a string or finite `version`, a function `waitUntil`, else `CacheConfigurationError`), and the extension `viborm.cache`: `args` (`cache` on `writes`; `cacheRead`, `bound`, which `$withCache()` binds), a `call` on `target(writes)` whose `settled` invalidates, an `around` on `target(reads)` with `{ inner: true }`, and `methods` (`$withCache`, `$invalidate`) |
| `driver.ts` | `CacheDriver`: get/set/SWR/invalidation orchestration; `serveOfficialRead` (one read through the store) and `invalidateOfficialCache` (a write's or `$invalidate`'s targets, validated whole before any backend effect) |
| `key.ts` | The official namespace (`createOfficialCacheNamespace`), its injective encoding, and the hash that names an entry inside it |
| `result-codec.ts` | `cacheCodec`: the call's `codec(run)` with its failures made the cache's (`CacheConfigurationError`, naming the step, exposing no value); the value codecs are `query-engine/result/cache-value-codecs.ts`, `recursiveRelationCodec` included |
| `units.ts`, `unit-facts.ts` | The cache's own `cache` units (`get`, `set`, `invalidate`, `revalidate`, and an invalidation's `delete` and `clear`), emitted with `work` and noted with `note`; `cacheFacts` and `cacheOutcomes`, which an observer reads, in a module that does not import the driver |
| `cache-background.ts` | The stale hit's one background promise |
| `schema.ts`, `ttl.ts` | Per-read options and mutation invalidation options; TTL parsing |
| `drivers/*` | Backend-only get/set/delete/clear primitives |
| `src/extensions/query.ts` | The single ordered write-outcome rail `settled` registers on |

There is no second cache manager, mutable cache-driver version, client-config
fallback, mutation-wrapper registry, or native-batch invalidation owner.

## Key identity and scope

A read is keyed by the prepared call: `key(run)` (`src/extensions/key.ts`)
serializes the model, the operation, the validated arguments and the
statement the engine will send (text and parameters), and `run()` then sends
exactly that preparation. A rule enters the key through the statement it
produces, an extension argument through the rule that reads it; an argument
read only by a part's own code does not, and must be declared `.volatile()`
when answers depend on it. `key(run)` is `undefined` for a raw statement, a
chain with a rewriting unit, a call carrying a value of a `.volatile()`
argument, and an operation that is not one statement: the read then runs
uncached, without an error (`permissions`' actor is volatile unless the
policy says `cache: "allow"`). `CacheReadOptions.key` contributes a suffix;
it never replaces that identity. The entry's name inside the namespace is
`model:operation:hash(key)[:suffix]`, and the full identity is verified
before materialization.

The mutation `cache` argument is the cache's own declared argument on writes:
taken out of the arguments before any first moment, admitted once, shown
only to the cache's parts. `$withCache(options)` is `scope.$bind({
cacheRead })`: a bound client every read of which the `around` serves; a
write through it is refused (`validateCacheableOperation`).

The official scope is a PURE function of four facts: the private snapshot
revision (`r5`), the cache `version`, the database's dialect and its SQL
namespace (`database(x)`: `adapter.namespace`). `cache(config)` makes one
extension value that may be applied to several clients; each read derives
its scope from the database of the call, memoized by those facts inside the
extension. Never introduce a registry keyed on chain or client identity to
hand an old scope back, and never let a transaction view mint its own.

Every component of the namespace is fixed-width-hex encoded behind a
discriminator letter, and the separator never appears inside a body. That is
what makes the join injective: an absent namespace is a bare token no string can
spell, so a database named `undefined` cannot collide with an unbound one, and a
PostgreSQL schema `billing` cannot collide with a MySQL database `billing`.
Extend `createOfficialCacheNamespace`'s facts; never string-append at a call
site. Bump the snapshot revision whenever the derivation or the key changes
meaning, and re-pin the exact-byte tests deliberately in the same change.

No connection string, host, username, or credential enters cache identity, and
the SQL namespace never appears in a public cache key or an operation argument.
Public/unscoped driver methods refuse keys beginning with `viborm:` before
backend or executor effects.

Official `$invalidate` and mutation `cache.invalidate` accept relative exact
keys or `*` suffix prefixes. Validate the complete target list before starting
any delete or clear. By default, `autoInvalidate` clears the entire bound
official namespace, including cached relation reads; `false` opts out.

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
snapshot, set, and cleanup. Background replay is the `around`'s late `run()`:
the core alone, with no first or second moment of any part and no second
logical operation.

Marker get-then-set is best-effort and is not an atomic distributed claim.
Always clear the marker. Worker failure stays primary over cleanup failure;
both are retained for protected lifecycle presentation. Scheduling, work,
storage, and cleanup failures never alter the stale application result or leak
an unhandled rejection.

## Invalidation

A write's invalidation is a `settled` function of the cache's `call` on
`target(writes)`: told after the outermost commit, never after a rollback;
savepoint success promotes it to the parent; a write that may have committed
is told too. A backend failure there is a `CacheConfigurationError` carrying
the commit certainty, which rejects the write's promise (the write is not
undone); `settled` functions run in chain order and all run, so `cache()`
applied before `on()` invalidates before the hooks. `$invalidate()` is
`settled(scope, …)`: at once outside a transaction, after the outermost
commit inside one (`tx.$invalidate()`); a key it refuses is refused as it
is, a backend failure is a `CacheConfigurationError`. A write with no
invalidation work registers nothing. Do not reintroduce executor wrappers,
per-mutation WeakMaps, or native/fallback publication branches.

## Deliberate read bypass

The `around` returns `run()` untouched for a call outside the `$withCache()`
view, a call in a callback or nested transaction or in a public array
(`run.mode !== "direct"`), and a call `key(run)` cannot key (above). Every
other part's `around` stays outside the cache, whatever the chain's order
(`{ inner: true }`), so each sees every call, hits and misses alike.
Cache-managed reads are always borrowed and never claim consumable provider
rows.

## Instrumentation and privacy

Cache get, set, invalidate, and actual revalidation work are `cache` units
the cache emits with `work` (`units.ts`), only when the chain observes units
(an unobserved step builds no unit), seen by every `unit` part that listens
to that kind; a read's outcome (`hit`, stale `hit`, `miss`, `bypass`,
`cache-set-failed`) is noted on the call's `operation` unit. Core contains no
observer's faults and selects no trusted observer: official instrumentation
reads `cacheFacts`/`cacheOutcomes` like any extension could.
Cache keys and suffixes never reach units, spans, logs, errors, or correlation.

## Backend rules

- Backends implement asynchronous `get`, `set`, `delete`, and `clear` only.
- MemoryCache defaults to a 1024-entry LRU bound; `maxEntries` is its only
  public construction option. One `unref()` sweep timer expires entries by
  their absolute storage deadline, including TTLs above the host timer range.
- KV clamps physical expiry to 60 seconds. CacheDriver enforces logical fresh
  and stale deadlines and the revalidation marker's own age.
- Official entries verify full canonical identity before materialization; the
  private snapshot revision is r5. Durable mutations invalidate the complete
  bound scope by default; `autoInvalidate: false` opts out.
- Invalidation suppresses earlier fills on the same CacheDriver instance,
  including fills whose backend set finishes late. Generic KV is eventual:
  this is not a cross-process linearizability guarantee.
- Cloudflare KV listing follows cursors until complete.
- Backend code does not apply versioning, canonical identity, SWR policy,
  instrumentation policy, or transaction semantics.
- Do not mutate a returned cache entry or application result graph.

## Validation

Cache `*.core.test.ts` files must not allocate a live database provider. Use a
deterministic recording driver for cache semantics and keep provider-backed
witnesses in the adjacent extended/provider lane. A suite that supplies a
provider transport owns closing it; client `$disconnect()` does not transfer
that ownership.

Run the focused cache/client contract first, then the cache, client,
query-engine, driver, and instrumentation layer gates sequentially. Never
overlap Vitest or TypeScript processes. `pnpm test:coverage:cache` is the exact
cache-subsystem report. Its `coverage-cache` project admits every cache core
file plus the deterministic official extension, instrumentation, SWR, and
protected-observer public contracts, and rejects resource-owning imports. It
requires 98% in all four metrics and writes `coverage/cache/index.html`.
