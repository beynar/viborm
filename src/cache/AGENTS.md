# Cache — Official Query-Cache Extension

**Location:** `src/cache/`
**Layer:** L10

## Purpose

The cache layer owns portable stored driver rows, TTL/SWR
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
a friend import. It imports only public names
(`tests/contracts/public-client/extension-imports.core.test.ts`): its units
belong to the call's `c` or `run`, or to a method's scope (`work`), its
revalidation names the database by `database(run)`, and its time comes from
its own `CacheClock` (`driver.ts`), which a test hands a virtual one.

## Owners

| Owner | Responsibility |
|---|---|
| `src/cache/extension.ts` | `cache(config)`: the configuration read once (a `CacheDriver`, a string or finite `version`, a function `waitUntil`, else `CacheConfigurationError`), and the extension `viborm.cache`: `args` (`cache` on `writes`; `cacheRead`, `bound`, which `$withCache()` binds), a `call` on `target(writes)` whose `settled` invalidates, an `around` on `target(reads)` with `{ inner: true }`, and `methods` (`$withCache`, `$invalidate`) |
| `driver.ts` | `CacheDriver`: get/set/SWR/invalidation orchestration; `[SERVE]` (one read through the store) and `[INVALIDATE]` (a write's or `$invalidate`'s targets, validated whole before any backend effect), methods keyed by symbols no package entry exports, so only the extension calls them and no module holds a friend |
| `key.ts` | The official namespace (`createOfficialCacheNamespace`), its injective encoding, and the hash that names an entry inside it |
| `src/extensions/codec.ts` | `codec(run)`: `run()` keeps the driver's rows for the read's one statement, `snapshot()` gives them as JSON data, `materialize(stored)` decodes them again through the read's own parser |
| `result-codec.ts` | `cacheCodec`: the call's `codec(run)` with its failures made the cache's (`CacheConfigurationError`, naming the step, exposing no value) |
| `units.ts` | The cache's own `cache` units (`get`, `set`, `invalidate`, `revalidate`, and an invalidation's `delete` and `clear`), emitted with `work`; what a presenter shows of each (its span, its attributes, its outcomes as logs) noted with `note`, as an `InstrumentationNote` |
| `revalidate.ts` | `staleWhileRevalidate`: the refresh of a stale entry (marker claim, core replay, store, marker cleanup), a value the cache is configured with (`cache({ driver, swr: staleWhileRevalidate })`); a cache without it carries none of it and refuses a view's `swr` option |
| `cache-background.ts` | The stale hit's one background promise |
| `schema.ts`, `ttl.ts` | Per-read options and mutation invalidation options; TTL parsing |
| `drivers/*` | Backend-only get/set/delete/clear primitives |
| `src/extensions/query.ts` | The collector of a transaction scope (`collect`, `TransactionWriteOutcomes`), which `settled` and the part that watches writes install by value |

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

The official scope is a PURE function of four facts: the private storage
revision (`r6`), the cache `version`, the database's dialect and its SQL
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
site. Bump the storage revision whenever the derivation, the key or the
stored form changes meaning, and re-pin the exact-byte tests deliberately in the same change.

No connection string, host, username, or credential enters cache identity, and
the SQL namespace never appears in a public cache key or an operation argument.
Public/unscoped driver methods refuse keys beginning with `viborm:` before
backend or executor effects.

Official `$invalidate` and mutation `cache.invalidate` accept relative exact
keys or `*` suffix prefixes. Validate the complete target list before starting
any delete or clear. By default, `autoInvalidate` clears the entire bound
official namespace, including cached relation reads; `false` opts out.

## Stored rows

An entry holds what the DRIVER returned for the read's one statement, its
rows, as JSON data (`codec(run)`, `src/extensions/codec.ts`); it is never a
copy of the decoded answer. A hit hands those rows to the prepared read's own
parser (`prepareSingle(…).parseResult`), the decoder a driver's answer goes
through, driver result parser (`driver.result`) included. So a hit is a fresh
graph that every scalar, list, relation, recursive and gated-field rule
decides again, and decimal, date, bytes, point and JSON leaves are built by
their one owner. Do not add a walker over the decoded answer, and do not add
a second codec of the result's shape.

What is stored is each driver family's physical form, unchanged: the
PostgreSQL drivers' date and time columns as text (VibORM installs identity
parsers for them) and `numeric`/`int8` as text, the MySQL driver's `DATE`,
`DATETIME`, `TIMESTAMP`, `LONGLONG` and `NEWDECIMAL` as text (its `typeCast`),
better-sqlite3's, Bun's and libSQL's integers as bigints (`safeIntegers`,
`intMode: "bigint"`), D1's as numbers, bytes as each driver hands them, and
JSON columns and relation aggregates as the driver returns them (a parsed
document, or text the decoder parses).

The encoding is shape-blind: JSON values as they are, and a tagged array for
what JSON cannot carry — `["n", text]` a bigint, `["d", epoch]` a `Date`
(`["d", null]` an invalid one), `["b", base64]` a `Uint8Array` (a `Buffer`
included), `["B", base64]` an `ArrayBuffer`, `["f", text]` a non-finite
number or `-0` — with every array tagged `["a", …]`, so no JSON document can
spell a tag. A plain document keeps its keys, `__proto__` included, as data.
A row value of any other kind (a class instance a driver did not normalize,
an array with a hole or an `undefined`) cannot be stored: the read answers
uncached and the set is recorded as `cache-set-failed`. A driver result
parser therefore sees, on a hit, the values after that round trip: a
`Uint8Array` where the driver gave a `Buffer`.

Stored rows are hostile input on materialization. A value outside that
grammar is refused before decoding; the decoder then refuses a value outside
its column's declared domain as it would a driver's. Either refusal is a
`CacheConfigurationError` (`method: "materialize"`, `cache/result-codec.ts`)
that exposes no value. Columns the read does not decode are ignored, as they
are in a driver's answer, and a getter or proxy object an in-memory backend
hands back is read for the plain data it shows: the two ways this boundary is
looser than the r5 answer walker was.

The engine seam is `PreparedOperation.seen` (`raptor3/commands/index.ts`): a
function the read's `publish` tells the driver's rows before decoding them.
A run it is set on reads object rows (never the positional transport) and is
never folded into a shared `findUnique` batch
(`query-engine/pending-operation.ts`): a shared statement's rows are not the
read's own, and decoding them later would answer another call's row.

The private storage revision is `r6` (`key.ts`): r5 entries held the decoded
answer, which read as rows would be refused at best, so the bump is the
invalidation, as every earlier one.

## SWR

Stale-while-revalidate comes with its value: `cache({ driver, swr:
staleWhileRevalidate })`. Without it, a view's `swr` option is a
`CacheConfigurationError` when the view is bound, and the driver carries no
revalidation code (the stale branch of `[SERVE]` asks the request's
`revalidate`, handing it the steps on the entry's key the driver owns).

A stale hit synchronously gives one complete background promise to the exact
chain's `waitUntil`. That promise owns marker acquisition, inner core replay
(`codec.run()`, keeping its rows), storing them, set, and cleanup. Background replay is the `around`'s late `run()`:
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
is, a backend failure is a `CacheConfigurationError`. Every write registers
its invalidation (the whole scope by default) unless it passes
`cache: { autoInvalidate: false }` with no `invalidate` targets
(`hasCacheInvalidationWork`). Do not reintroduce executor wrappers,
per-mutation WeakMaps, or native/fallback publication branches.

## Deliberate read bypass

The `around` returns `run()` untouched for a call outside the `$withCache()`
view, a call in a callback or nested transaction or in a public array
(`run.mode !== "direct"`), and a call `key(run)` cannot key (above). Every
other part's `around` stays outside the cache, whatever the chain's order
(`{ inner: true }`), so each sees every call, hits and misses alike.
A cache-managed read keeps its driver rows, so it never reads the positional
transport nor shares a `findUnique` batch (Stored rows, above).

## Instrumentation and privacy

Cache get, set, invalidate, and actual revalidation work are `cache` units
the cache emits with `work` (`units.ts`; without a chain that observes
units, a step runs alone), seen by every `unit` part that listens to that
kind; a read's outcome (`hit`, stale `hit`, `miss`, `bypass`,
`cache-set-failed`) is noted on the call's `operation` unit. What a
presenter shows is noted too, in the public shape `InstrumentationNote`: a
span name and its attributes as a unit starts (`cache.driver`, `cache.ttl`;
the revalidation as a root `viborm.operation` with the read's database),
`cache.result` once a get answered, each outcome as a `cache` log. Core
contains no observer's faults and selects no trusted observer; the official
instrumentation presents these notes as it presents any extension's.
Cache keys and suffixes never reach units, spans, logs, errors, or correlation.

## Backend rules

- Backends implement asynchronous `get`, `set`, `delete`, and `clear` only.
- MemoryCache defaults to a 1024-entry LRU bound; `maxEntries` is its only
  public construction option. One `unref()` sweep timer expires entries by
  their absolute storage deadline, including TTLs above the host timer range.
- KV clamps physical expiry to 60 seconds. CacheDriver enforces logical fresh
  and stale deadlines and the revalidation marker's own age.
- Official entries verify full canonical identity before materialization; the
  private storage revision is r6. Durable mutations invalidate the complete
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
