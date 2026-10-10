# Changelog

All notable changes to VibORM are recorded here. Releases follow Semantic
Versioning.

## Unreleased

A new public capability, so a minor release: proposed **1.1.0** (first
candidate 1.1.0-rc.1). The release PR sets the heading.

### Added

- **Recursive relation filters.** A `where` filter on an ordinary self relation
  accepts `recurse` and quantifies over the relation's transitive closure. This
  covers a foreign key such as `parent`/`children`, or a junction such as
  `team.parents`/`team.children`.
  - Example: `{ parent: { recurse: true, self: true, some: { grants: { some: {
    userId } } } } }` matches a document when it, or any ancestor, carries the
    grant.
  - `recurse` takes the same options as in `select`/`include`: `true` follows
    100 levels, `{ depth: n }` follows 1–1000 levels, `{ depth: false }` is
    exhaustive.
  - `self: true` includes the row itself. `some`/`every`/`none` take the related
    model's full `where`; with `recurse`, a to-one relation accepts them too.
  - Cycles and diamonds terminate, and each reached row counts once. Rows
    hidden by `softDelete` or a `rows` extension stop the walk.
  - It compiles to one correlated `WITH RECURSIVE` inside `EXISTS`. It works in
    every read, `count`, aggregates, `updateMany`/`deleteMany`, and nested
    inside other relation filters.

### Fixed

- **MySQL: `updateMany`/`deleteMany` filtered through a relation now match the
  rows that matched before the statement.** MySQL evaluates such a filter row
  by row while the statement, and the cascades it fires, change the rows the
  filter reads, so a self relation or a cascading delete could change or remove
  the wrong rows. The filter now reads the matching keys first, in the same
  statement, as PostgreSQL and SQLite already answered.

### Changed

- On a to-one relation filter, the key `recurse` now always selects the
  recursive filter. Filter a target field literally named `recurse` through
  `is`: `{ parent: { is: { recurse: … } } }`.

## 1.0.1-rc.1 — Release candidate

Fixes the regressions found in the round-2 review of 1.0.0 and removes
per-operation work that protected nothing.

### Fixed

- **SQLite, libSQL, bun:sqlite and D1: typed queries no longer inspect physical
  storage.** In 1.0.0, every statement on a model with a DateTime, Time or
  Decimal column was surrounded by a catalog read, `BEGIN IMMEDIATE`, a storage
  assertion and `COMMIT`; DateTime and Time columns also scanned the whole table
  twice. A primary-key lookup on a `createdAt` + `updatedAt` model took 82 ms at
  1k rows and 7.7 s at 100k. D1 refused every query on a model with a text
  DateTime column (statement too long, or pattern too complex). One
  non-canonical timestamp row made the whole model fail with V8003. A typed
  statement now sends only its own SQL: one statement per `findUnique`, about
  0.05 ms at 100k rows, and no write lock for reads.
- **libSQL: a `SQLITE_BUSY` while opening a transaction no longer loses later
  writes.** The SDK reused a connection left inside the failed `BEGIN`, so later
  writes were acknowledged and never committed. The client is now quarantined
  (V1003) as it already was for a busy statement.
- **`where: { field: 0 }` on an int or bigint column no longer throws** "Explicit
  zero is not portable for an auto-increment field" when an `.increment()` id
  was built first. The zero refusal applies to the auto-increment id on create
  only.
- **Push never renames a table without a named pair.** `lenientResolver` and the
  documented resolver could rename another application's table into a new
  model, labelled non-destructive. `lenientResolver` now renames columns only
  and leaves table pairs undecided, in push and in `migrate generate` alike:
  name each table pair in a resolver. Every table rename is destructive and
  needs consent.
- **PostgreSQL: adding enum values uses `ALTER TYPE … ADD VALUE [BEFORE …]`
  again.** 1.0.0 recreated the type for an append, rewriting every table using
  it, and failed when a view, rule or CHECK depended on the column. The type is
  replaced only for removals, reorders, and when the same migration may use a
  new value (a default naming it, a column converted to the enum, or a new
  partial-index predicate naming the enum or one of its columns); any such
  replacement still fails on a dependent view, rule or CHECK (#85).
  `apply`, `down` and `reset` commit after a migration that adds enum values.
- **postgres.js: a `BEGIN` that cannot connect leaves the client usable.** It
  rejects with the retryable V1001 instead of quarantining the client with V5001
  until `$disconnect()`.
- **`s.enum()` accepts a readonly tuple**, so the documented
  `const STATUS = [...] as const` recipe compiles and keeps its literal union.
- **libSQL: BigInt keys read from a many-to-many junction are exact** with a
  supplied client in `intMode: "number"`.

### Performance

- `exist()` and unpaged `count()`/`aggregate()` read the filtered table
  directly instead of a subquery ordered by primary key: `count()` on 200k rows
  went from about 1.8 ms to about 30 µs on SQLite and from about 35 ms to 10 ms
  on PGlite.
- A supplied libSQL client no longer sends a setup statement before its first
  query: one Turso round trip less per client.
- Nested writes on D1, Neon HTTP and MySQL batch routes no longer send a
  `DELETE` that could never match.
- bun:sqlite reuses compiled statements through its own `query()` cache.

### Added

- **`viborm check --db`** audits SQLite-family storage: non-canonical
  DateTime/Time text, decimal columns without VibORM's scaled-integer storage,
  and audited columns missing from the database. It exits 1 when any exists,
  prints the repair route and adds a `storage` report to `--json`.

### Changed

- **TypeScript 5.9 is the minimum supported version (was 5.8).** On 5.8 a
  three-level include over a 100-model schema fails with TS2589. The package
  gate type-checks that schema as an installed consumer on 5.9.
- libSQL: a supplied client may use intMode `"number"` or `"bigint"` (1.0.0
  refused `"number"` with V1004); `"string"` mode is not supported for typed
  reads.
- Documentation: the homepage states the V1 status; the configuration and
  Cloudflare KV examples run as written; the Raw SQL page warns about compact
  ids stored as bytes, and the vector page about hand-made HNSW indexes. The
  postgres.js page documents its two round trips per query, the
  `options.prepare` opt-in, and `viborm/pg` as the one-round-trip driver.

### Upgrading from 1.0.0

- **SQLite databases written by another tool or by an RC.** Typed queries no
  longer check stored values. Timestamps stored as non-canonical text are
  missed or misordered by filters until repaired. A foreign `DECIMAL(p,s)`
  column that VibORM never pushed or migrated reads whole numbers as scaled
  coefficients (3 reads as 0.03). Run `viborm check --db`, and adopt foreign
  tables through push, migrate or a baseline; see the SQLite migration guide.
- **PostgreSQL migrations generated by 1.0.1 that add enum values** must be
  applied, rolled back and reset by 1.0.1 or later.

This release candidate targets npm `next`, not `latest`. Publication requires
the protected workflow in [RELEASING.md](RELEASING.md).

## 1.0.0 — 2026-10-09

- Repair the confirmed transaction, driver lifecycle, SQLite storage, scalar,
  nested-write, cache, type and migration defects from the October 8 adversarial
  review. Provider qualification and remaining product gaps are recorded in the
  remediation report.
- Support Neon serverless 1.2 and libSQL 0.18; require a fixed SQLite library floor.
  Raw SQL remains physical, while typed DateTime, Decimal, ID and vector values
  have explicit admission and decoding contracts.
- Refuse unsafe schema/index adoption before effects; preserve migration atomicity,
  canonical temporal defaults and JSON null distinctions.
- Load TypeScript config and project environment files in the CLI; correct the
  installation and persistence recipes. Ship third-party license notices.
- Preserve exact cyclic relation types when applications export inferred clients
  or client factories and emit declarations. No getter annotations or codegen
  are required. Rebuilding a client from separately emitted raw cyclic models
  retains its documented limitation.
- Keep PostgreSQL migration rename planning, generated constraint names and
  rollback consistent. Apply accepted table and column renames before enum
  changes that use their new names, retaining enum array and default metadata.

- **Fixed: an unlimited soft delete no longer reads every candidate key to
  lock them.** Before tombstoning a model that a restricting relation
  references, a `deleteMany` without `limit` locked its candidates by reading
  all their keys into memory. PostgreSQL and MySQL now take the same locks
  with one counted row back; SQLite, which has no row locks, skips the read.
  A `deleteMany` with `select` still reads one key per row it returns.
- **Fixed: a limited soft delete checks every value its statements bind.** A
  soft `deleteMany` with `limit` chose its window of locked keys by counting
  the keys alone, so a long `in` list or a selected result re-read by key
  without `RETURNING` (MySQL) could still fail with "needs N bound values,
  above the verified limit". The keys are still capped at half the bind
  budget, and the compiled statements, with everything they bind, are now
  checked too; past either, the window is the key range. In an array
  transaction the window is SQL beside the caller's filter, which is then
  bound twice; past the budget it is refused before anything is written.
- **Fixed: a mutable control value no longer keys shared state.** A control
  value holding a `Date` or bytes, or a frozen object whose getter changes its
  answer, could key a row filter or a cached read whose value then changed
  under it. Such a value, and one holding a getter or a non-enumerable
  property, now binds its row filters for its call alone and its read is not
  cached.
- **Fixed: a dropped `pg` connection no longer ends the process.** While a
  `$transaction` (or a migration's reserved session) held a pooled client,
  nothing listened to that client's `error` event: a server restart, failover
  or terminated backend crashed Node with an unhandled `error`, and code that
  contained it could commit and return the broken client to the pool. The
  transaction now rejects with that failure, never commits after it, and
  releases the client so the pool destroys it.

## 1.0.0-rc.5 — Release candidate

- **Performance: a client created per request.** Clients built over the same
  schema object share the schema's validation, registries and prepared
  queries, so a client created per request (a Worker, a serverless handler)
  no longer rebuilds them; better-sqlite3 reuses its prepared statements per
  SQL text; SQLite and D1 collection reads decode positional rows; first-use
  code stays out of the cold path, and the result cache loads with
  `viborm/cache`, not with the client. The shipped bundle is about 36 KiB
  smaller.
- **Added: `viborm check`**, a CLI command that runs the full schema
  validation, and `createClient({ skipSchemaValidation: true })` for an
  application that already ran it: the client then resolves relations only.
- **Behaviour change: `v.array` reports a hostile array** (a revoked proxy, a
  throwing read) as a validation issue instead of throwing.
- **Behaviour change: malformed binary data from a driver is refused**
  instead of decoded leniently. Every shipped driver returns well-formed
  values.
- **Behaviour change: `isRetryable()`** on an error carrying an unregistered
  code answers "not retryable" instead of throwing.
- **Fixed: cache keys accept a value reached twice.** A cached read whose
  arguments reused one array or object (`{ id: { in: ids }, parentId: { in:
  ids } }`) failed with "Circular reference in cache key args"; only a real
  cycle is refused now.
- **Fixed: `push` reads the database catalog one statement at a time.** It
  read every catalog query at once on its one session, which node-postgres
  queues and warns, on every `push`, that pg@9 will refuse.
- **Added: `viborm/soft-delete`, the official soft-delete extension.**
  `softDelete({ models, actor })(client)` turns deletes of the named models
  into tombstones (the call's time in a nullable `DateTime` field, and
  optionally the actor), hides tombstones from every query that selects rows,
  and adds `restore`/`restoreMany`. `deleted: "without" | "with" | "only"`
  chooses the rows of one call; `mode: "hard"` deletes physically (a purge
  also says `deleted: "only"`, see the guide's warning). The extension is
  one file of about 100 lines, built only from the public capabilities below,
  in its own entry point: the root entry never imports it.
- **Added: three extension capabilities, `controls`, `rows` and `deletion`.**
  `controls` declares call arguments (a closed list or a Standard Schema,
  placed on reads, writes or named
  operations; a schema may be an object or a function carrying
  `~standard`, such as an ArkType type), checked once before request
  handlers and visible only to the declaring extension's handlers
  (`context.controls`). `rows` declares row filters per model, one
  set per mode, chosen per call by a control; core applies them at every
  place a query selects rows (root reads and writes, aggregates, cursors,
  every relation, quantifiers, counts, ordering, recursion, nested write
  targets). A to-one relation whose target is filtered out reads `null` and,
  on a client with `rows`, is typed `| null`
  when its target model has an entry (or the same field and relation names as
  one); a reference to a missing row is still an error. `deletion` turns a delete of the named
  models into an update with the call's one time and constant data, refused
  while a visible row still references it through a restricting foreign key
  (on PostgreSQL and MySQL it locks its candidates before that check, so a
  concurrent `connect` cannot leave a live row referencing a tombstone),
  unless the call's controls match `removeWhen`. A cached read that receives
  a control is keyed on its value and, on a client with `rows`, on the `rows`
  declarations; a read that receives none keeps today's key. Definitions are
  trusted: VibORM does not check a declaration at runtime.
- **Added: `data`, an extension capability that writes fields.** For the
  models it names, an extension writes fields on every create (`create`) and
  every update (`update`) of them: root and nested, one row or many, both
  arms of an `upsert`, and the update a soft delete makes. A value is a
  constant, `{ control: "<name>" }` for the value the call passed, or, on an
  update, one of the field's update operators such as `{ increment: 1 }`. A
  `connect` or `set` that only moves a foreign key, and a delete that stays
  physical, write nothing. When two extensions write the same field, the one
  applied later wins. An extension now has ten capabilities. A field the
  schema requires may be left out of a create when an extension writes it
  on that call, a required foreign key such as `tenantId` included. When
  TypeScript knows the models the `data` entry names (written inline, or
  passed to a recipe as a written list), the client's types agree: those
  fields are optional in its create data, nested creates included, and keep
  their own types.
- **Added: an extension fills a field only when the caller left it out.** A
  call that writes a field an extension writes keeps its own value, at any
  depth, on a create and on an update, and wins over every extension that
  writes it. Writing it through the relation whose foreign key it is
  (`tenant: { connect: ... }` for `tenantId`) counts as writing it: the
  relation decides the key. A field written as `undefined` counts as left
  out. A value the extension would have written there is not checked either,
  so a field's own schema never sees or refuses it. Under tenancy, reads stay with the call's tenant but writes are not
  enforced: a caller who writes `tenantId`, or connects a tenant, by hand
  writes into that tenant.
- **Added: a `rows` filter can use a value the call passes.** Write
  `{ control: "<name>" }` where a filter takes a value, at any depth (inside
  `in`, `AND`, `OR` and `NOT` too), and each call sees the rows that match the
  value it passed: one client serves every tenant. A call that does not pass
  an optional control drops the filters that name it; one that does not pass
  a control `required` on a model matches none of that model's rows, even
  when it reaches them through a relation of a model the control is not
  required on. Each mode and value is
  prepared once and reused; a client keeps 256 of them, and past that the
  oldest is prepared again when it comes back. Cached reads are keyed on the
  value, so two tenants never share an entry.
- **Added: `required: true` on a control.** A call that leaves out a
  required control is refused with a `ValidationError` at the control's path,
  on every operation the control is placed on (without `on`, every operation
  of every model).
- **Docs: extension recipes.** A new guide page gives tenancy, audit stamping
  and optimistic locking, each one declaration built from the capabilities
  in this release, to copy into your code. They are recipes, not package
  entries. Each keeps the model names you pass it, with no `as const`, so
  your editor lets a required `tenantId` be left out of a create of those
  models.
- **Added: `ExtensionState` and `ExtendedOperationResult`** are exported from
  `viborm`, for plugins generic over the client they receive.
  `ExtendedOperationResult` and a model-mapped query handler's `proceed()`
  read the client's `rows`; `OperationResult`, `InferDatabase` and
  `renderOperationResultType` stay schema-only. `Client`'s
  optional third type parameter is now the chain's controls (see "Changed
  (types)" below), and `$withCache()` accepts the chain's controls.
- **Behaviour change: a limited `deleteMany` or `updateMany` takes the first
  rows by id.** `limit: n` now takes the first `n` matching rows ordered by
  primary key, ascending (a compound key field by field, in the order the
  model declares them), as `findMany` with `take` and no `orderBy` does. Before,
  it took whichever rows the database reached first, which differed between
  databases and could differ between the hard and the soft delete of the same
  rows. Now every path picks the same rows: a hard delete, a soft delete with
  or without a restricting child (skipping rows deleted already), a scalar
  update, an update whose `data` carries a relation, inside
  `$transaction([...])`, and with or without `RETURNING`. The SQL gains an
  `ORDER BY` on the primary key: inside the key subquery on PostgreSQL and
  SQLite, and on the statement itself on MySQL. On a compound key whose
  `.id([...])` lists the fields in another order than the model declares
  them, an update whose `data` carries a relation now runs its rows in that
  declaration order too.
- **Changed (types): extension typing for plugins generic over their client.**
  Inside a function generic over `VibORMClient<C, X>`, index a model with
  `M[K & keyof M]`: `VibORMClient<C, X>["post"]` is now a TypeScript error
  there. A definition written against one client and applied to another now
  compiles, with its method types following the first client; build each
  definition from the client it is applied to. Replacing an earlier
  extension's model method is refused when the extension is applied, and is
  no longer flagged in your editor. `Client`'s third type parameter used to
  say whether the cache extension was applied; it is now the controls the
  client's extensions declare, and the cache's `cache` option is one of them.
  `Client<C, D, true>` no longer compiles: take the type from the client you
  built (`typeof client`) instead.
- **Breaking: a mutation's `cache` option is the cache extension's declared
  control.** VibORM now takes `cache` out of a mutation's arguments and checks
  it once, before any request handler runs, the way it handles every argument
  an extension declares. Five things change for code that touched it:
  - A request handler can no longer add or replace `cache`: a patch that
    names it is refused with a `QueryError` ("named control \"cache\""),
    whichever order the two extensions were applied in.
  - Request handlers no longer see `cache` in their input (query handlers
    already did not).
  - A `cache` value whose getter throws is a `QueryError`, no longer a
    `CacheConfigurationError`. A malformed value is still a
    `CacheConfigurationError`.
  - `cache` is checked before request handlers run, so an invalid `cache`
    fails before them, and a request handler that throws no longer stops
    `cache` from being read.
  - A mutation whose arguments are not an object (a string, a number) fails
    with the `ValidationError` ("Expected object") a client without the cache
    gives, no longer a `CacheConfigurationError`.
  - Added: the value `cache()` returns has a `controls` member, which declares
    `cache` on writes.
  - Added: request and query handler contexts of a model operation have an
    optional `controls`: the values of the controls the handler's own
    extension declares, and only those.
  - Unchanged: the message of a `cache` value the cache refuses still reads
    "Invalid mutation cache options: …". (The third type parameter of the
    public `Client` type does change: see "Changed (types)" above.)

## 1.0.0-rc.4 — 2026-09-29

- **Breaking: instrumentation presentation moves into the `instrumentation()`
  extension.** Core no longer builds span names, span attributes, log events
  or per-channel SQL/parameter disclosure, and it has no runtime import of the
  extension: it asks the fixed-name extension what it wants and hands it
  neutral facts, so a client without the extension no longer carries that
  code. Spans, log events and thrown-error diagnostics of an installed
  extension are unchanged. These public members and exports are removed or
  changed:
  - `Driver.getBaseAttributes()` and `Driver.getContextAttributes()` are
    removed. Span attributes, including `db.namespace`, are built by the
    extension from the driver's `dialect`, `driverName` and
    `adapter.namespace`.
  - The protected `Driver` members `getInstrumentation()`,
    `isTracingEnabled()`, `getLogger()`, `getLoggingDisclosure()` and
    `getTracingDisclosure()` are removed, so a subclass can no longer steer
    what a log or span discloses by overriding a hook: the extension reads
    each channel's disclosure from its own configuration.
    `canDiscloseParameters()` and `getErrorDisclosure()` remain protected and
    overridable; their default bodies now read the extension installed on the
    executing client's chain.
  - The protected `observeTrustedDriverLifecycle()` takes a lifecycle boundary
    (`"connect"`, `"disconnect"`, `"transaction"`, `"savepoint"`) in place of a
    span name, and the statement and lifecycle execution gates hand the
    extension a dispatch record instead of span options.
  - The statement gate's `execute()` no longer normalizes a statement failure.
    Each caller passes an executor that already normalizes, so a subclass
    that calls `observeTrustedStatement()` and relies on the gate to normalize
    must wrap its executor in `executeNormalizedStatement()`.
  - `CacheDriver.getBaseAttributes()` is removed. Cache spans and cache log
    events are built by the extension; the backend's name still comes from
    `CacheDriver.driverName`.
  - The `segment` lifecycle unit is removed from `ObservationUnit`: nothing
    produced it. `viborm/instrumentation` no
    longer exports `SPAN_RECORD_SERIES_SEGMENT` or the seven
    `ATTR_VIBORM_WRITE_*` attribute names (`ATTR_VIBORM_WRITE_ATOMICITY`,
    `ATTR_VIBORM_WRITE_COMMIT_OUTCOME`, `ATTR_VIBORM_WRITE_COMMITTED_SEGMENTS`,
    `ATTR_VIBORM_WRITE_COMMITTED_WRITE_MEMBERS`,
    `ATTR_VIBORM_WRITE_COMPLETED_MEMBERS`, `ATTR_VIBORM_WRITE_MEMBER_PATH`,
    `ATTR_VIBORM_WRITE_STATEMENT_COUNT`), which no span carried.
  - Added: `instrumentation({ tracing: { tracer } })` takes the tracer the
    runtime or application already holds: Cloudflare Workers' `tracing` from
    `cloudflare:workers`, or any OpenTelemetry `Tracer`. Spans start through
    its two-argument `startActiveSpan(name, fn)` and nest under the caller's
    active span, and the library never imports `@opentelemetry/api` itself.
    With a handed tracer, `root` spans (cache revalidation) nest under the
    active span, and status is set only where the span supports `setStatus`.
    Without `tracer`, the API is auto-detected as before.
  - Fixed: a custom adapter whose `namespace` getter throws no longer loses an
    operation's error log or fails `$withCache` (its spans are presented
    without `db.*` attributes), and a native-batch member's failure is logged
    to the client that member belongs to, with that client's disclosure, not
    to the client whose chain observes the batch.
- **Fixed: layer type programs fit their shard heap again.** The `updatedAt`
  arm of scalar update admission related every field's update schema to
  `VibSchema` structurally, which raised every type program that includes
  `src` by about half (0.91M to 1.38M types) and pushed the instrumentation
  layer's program out of its 1280 MB heap. The arm now reads the schema's
  input and output from its `[inferred]` brand and yields the same record,
  pinned by `tests/types/operation-schemas/updated-at.core.types.ts`. No
  public type changes.

Published to npm (`next`) only: the release workflow verified the published
bytes before the registry served them and stopped, so rc.4 has no GitHub
release or `v1.0.0-rc.4` tag.

## 1.0.0-rc.3 — 2026-09-29

- Add the type-only `InferDatabase<Schema>` export from `viborm/client`.
  Each model exposes `Row`, `Create`, `Update`, `Where`, and `FindMany`, derived
  from the existing public inference types. No query runtime behavior changes.
- Document application type helpers, operation validation, JSON Schema export,
  and runtime TypeScript descriptions in the
  [Types and JSON Schema guide](docs/content/docs/client/types-and-json-schema.mdx).

This release candidate targets npm `next`, not `latest`. Publication requires
the protected workflow in [RELEASING.md](RELEASING.md).

## 1.0.0-rc.2 — 2026-09-28

- Reduce temporary engine allocations by sharing stateless operation methods,
  lowering only the projection columns needed, and removing intermediate
  filter, selection, and decoder collections. Operation admission and cache
  codecs remain instance-local; public results and failure ordering are unchanged.
- Preserve the release automation repair that resumes a GitHub draft by its
  returned identity instead of requiring immediate visibility in the release list.

Saved SQLite measurements support the allocation work; they are not timings of
the integrated RC2 package or a performance guarantee for every provider. See
the [performance review](docs/architecture/rc2-performance-review.md) for the
measured source identities, limits, and qualification evidence. Publication
still requires the protected release workflow in [RELEASING.md](RELEASING.md).

## 1.0.0-rc.1 — 2026-09-28

This candidate brings the changes below together for V1 qualification. It is
not a stable release. Read the [V1 upgrade guide](docs/content/docs/getting-started/upgrading-to-v1.mdx)
before upgrading from `0.1.0` or a development checkout. Provider and migration
limits remain part of the contract; see the [driver guide](docs/content/docs/drivers/index.mdx).
This candidate was published through the workflow described in
[RELEASING.md](RELEASING.md); stable V1 promotion remains separate.

- **Fix: omitted `.updatedAt()` fields refresh on update** (#54). Non-array
  DateTime, Date and Time fields now receive the application's current UTC
  value at update admission, including explicit empty update payloads, bulk
  updates, upsert update arms and nested updates. Explicit values still win;
  create defaults, `.now()` restrictions and ordinary temporal fields are
  unchanged. A create-default override does not replace the update clock.
  Each admitted occurrence evaluates once; reusing admitted input does not
  regenerate it during retry. Temporal arrays keep their prior explicit-value
  behavior and do not gain an automatic list default. Validation failures from
  omitted-field defaults now propagate with their field path rather than being
  silently discarded by the object validator.
- **Breaking: `.now()` creation timestamps are insert-only** (#47). A
  `s.dateTime().now()`, `s.date().now()` or `s.time().now()` field was
  documented as a creation timestamp that is "set once", yet an ordinary
  `update` accepted it and overwrote the stored creation time. It is now
  refused by every update surface — `update`, `updateMany`, the `update` arm of
  `upsert`, and nested `update` / `updateMany` / `upsert.update` at any depth —
  in TypeScript (the key is typed `?: never`, so a payload held in a variable
  is refused too) and at runtime, where the call fails with `Unknown key:
  <field>` before the forbidden assignment executes, whether the value is spelled directly,
  inside `{ set }`, or as `undefined`. An explicit `<field>: undefined` is the
  one spelling TypeScript cannot refuse, because an optional key always admits
  `undefined`: it compiles and is refused at runtime. Create, `createMany`, nested create,
  `upsert.create` and `connectOrCreate.create` still accept an explicit value,
  and an omitted one is still generated. Filtering, ordering and reading the
  field are unchanged. The generator declared last decides:
  `.now().updatedAt()` stays updatable, `.updatedAt().now()` does not, and
  `.now().default(value)` / `.nullable().now()` keep the restriction.
  This insert-only rule does not apply to `.updatedAt()` or ordinary temporal
  fields; automatic `.updatedAt()` refresh is described above. The schema
  registry exported by `viborm/validation` shows the same rule: for such a
  field, `createSchemaRegistry(...).proxy.<model>.scalars.<field>.update` is
  now `undefined` (and typed `undefined`), while its `base`, `create` and
  `filter` are unchanged. To change a
  creation timestamp deliberately, use raw SQL — the restriction covers what
  the typed client writes, not the column.
- **Fix: table removal follows foreign keys, not table names** (#42). A push or
  generated migration that removed a populated parent and child on SQLite
  failed with `Foreign key constraint violation` whenever the parent's name
  sorted first, and succeeded with the names swapped. Drops are now ordered
  child-first from the foreign keys the database holds; unrelated drops keep
  their order, and the preview, consent and executed program agree. On SQLite
  a generated rollback recreates referenced tables first. PostgreSQL and MySQL
  keep their forward order: they drop the keys before the tables. Their
  generated rollback of such a removal now recreates every table before it
  restores the keys, once each; it used to restore a child's key before the
  parent existed and then a second time, so it failed. Tables that reference
  each other are dropped in an order their `onDelete` actions allow, when one
  exists: a `setNull` or `cascade` key can let one of them go first. **Newly
  refused on SQLite:** removing tables that no order can drop, such as a cycle
  of `restrict`/`noAction` keys, a cycle whose `cascade` reaches rows a
  `restrict` key still guards, or a table whose `restrict` key references
  itself, is refused before any statement runs (`V11009`, naming each blocked
  table and the key that refuses it). The refusal is decided from the schema
  alone, because no order safe for every row set can be established from it.
  Such a plan used to run in catalog order: it failed and rolled back unless
  the rows happened to satisfy that order, and it succeeded on empty tables,
  which are now refused too. Remove one relation, or change its action to
  `setNull`, in a separate change first.
- **One native type per dialect** (#45). Every scalar factory that takes a
  native type — `s.string`, `s.int`, `s.number`, `s.bigInt`, `s.boolean`,
  `s.dateTime`, `s.date`, `s.time`, `s.json`, `s.blob`, `s.vector`, and the
  second argument of `s.enum` — also takes a map by dialect:
  `s.string({ pg: PG.STRING.CITEXT, mysql: MYSQL.STRING.LONGTEXT, sqlite:
  SQLITE.STRING.TEXT })`. Each migration, adapter and identifier-storage
  decision uses its own dialect's entry, or the automatic column when the map
  omits it, so a DDL change to one entry is a migration on that dialect only.
  The map's keys are exact in TypeScript (beside a real key, and in a map held
  in a variable) and at runtime; an object with no dialect key must be a whole
  `{ db, type }` value; each entry must be its key's dialect and, at runtime, a
  value the `PG` / `MYSQL` / `SQLITE` constants produce; `{}` and an object that
  is both a `{ db, type }` constant and a map are refused. A union of two maps
  that share no dialect key needs a `NativeTypeMap` annotation. The factory
  stores a frozen copy. Parameterized constants (`PG.STRING.VARCHAR(n)` and
  the rest) now return their dialect in their type (`DialectNativeType<"pg">`,
  still a `NativeType`). Schema documents carry a map as the new optional
  `nativeByDialect` field, mutually exclusive with `native`, with the same
  catalog check (`J011`); `NativeTypeMap` is exported from `viborm/schema`.
  The single `{ db, type }` argument is unchanged in TypeScript, including
  custom spellings outside the catalog. At runtime (untyped callers only) it
  must now name `pg`, `mysql` or `sqlite` as `db` and carry a string `type`;
  before, an unknown `db` was silently ignored on every dialect, and a
  `db: "pg"` value with a missing, misspelled or non-string `type` crashed
  `serializeModels` with a `TypeError`. Before, a map was accepted at runtime,
  silently ignored on every dialect, and crashed `serializeSchema` with a
  `TypeError`.
- **A many-to-many junction's two foreign keys can have different actions
  (#46).** `.onDelete()` and `.onUpdate()` on a model-target `s.toMany` now
  also take `{ source, target }`: `source` is the junction's key to the model
  that declares the configuration, `target` its key to the target model (not
  the column order). `s.toMany(() => topic).onDelete({ source: "cascade",
  target: "noAction" })` removes a post's memberships when the post is deleted
  and refuses to delete a topic that is still assigned (a nested `delete`
  through a post first removes that post's own membership). Both sides are
  required; an extra key or `setNull` on either side is refused where it is
  written, at runtime and in TypeScript. A bare action keeps meaning "both
  keys", and existing declarations produce the same DDL. The one-owner rule
  (R011) is unchanged: moving the configuration to the other endpoint means
  swapping the sides, and that migrates to nothing. Schema JSON adds
  `junction.onDeleteSides` / `junction.onUpdateSides`, each exclusive with the
  symmetric key (`J004`); the serializer writes them only for unequal sides.
  Internal state: `relation["~"].state.junction.onDelete` / `onUpdate` now
  always hold the `{ source, target }` pair, and a resolved junction edge
  carries its actions on `topology.source` / `topology.target` instead of
  beside the topology.
- **Breaking: `_count` is a reserved member name.** A schema whose model
  declares a scalar, a relation or a polymorphic slot named `_count` is now
  refused where the schema is validated — client construction, migrations and
  `validateSchema` — with `[F010] Model '<model>' declares a member named
  '_count'; '_count' is reserved for relation counts. Rename it, and use
  .map("_count") on a renamed scalar to keep its column name.` Before, such a
  schema was accepted and `_count` had no single meaning: admission and the
  type renderer read `select._count` / `include._count` as relation counts,
  while the runtime published the member (even when `omit`, or the model's own
  `.omit()`, had excluded it) and the static result type intersected the member
  with the counts. `_count` in `select` and `include` is now relation counts
  everywhere. To keep the column, rename the member and map it:
  `tally: s.int().map("_count")`. A `groupBy` can no longer group by a field
  named `_count`, since none exists; the grouped-field collision refusal for
  `_avg`, `_sum`, `_min` and `_max` is unchanged. In TypeScript the key is
  refused at compile time too: `s.model({ _count: ... })` and
  `.extends({ _count: ... })` no longer type-check, and the diagnostic names
  the reason: ``not assignable to type '"`_count` is reserved for relation
  counts (F010)"'``.
- **Breaking: `_distance` is a reserved member name**, by the same rule as
  `_count`. A schema whose model declares a scalar, a relation or a
  polymorphic slot named `_distance` is refused where the schema is validated
  — client construction, migrations and `validateSchema` — with `[F010] Model
  '<model>' declares a member named '_distance'; '_distance' is reserved for
  distance results. Rename it, and use .map("_distance") on a renamed scalar to
  keep its column name.` Before, such a schema was accepted and the key had two
  producers: selecting a point's distance beside a scalar or relation of that
  name, in either order, or a recursive relation of that name whose node
  selected a distance, was refused per query with `A distance result cannot be
  selected together with a model field named '_distance'.`; that sentence no
  longer exists, and `_distance` in a result is always the selected distance.
  To keep the column, rename the member and map it:
  `rank: s.int().map("_distance")`, which can be selected, filtered and
  ordered beside a distance. In TypeScript the key is refused at compile time
  too: `s.model({ _distance: ... })` and `.extends({ _distance: ... })` no
  longer type-check, and the diagnostic names the reason:
  ``not assignable to type '"`_distance` is reserved for distance results
  (F010)"'``.
- **A singular polymorphic slot reads every arm.** A `select` that named only
  some arms of a required or optional to-one variant slot used to return
  `null` for a row whose target belongs to an unnamed arm; the documented
  contract and the inferred type always said an unnamed arm keeps its default
  projection, and the runtime now agrees. `subject: {}` reads every arm at its
  default projection too. A missing row behind an unnamed arm is now the
  slot's integrity refusal (`Polymorphic relation '<slot>' references a
  missing '<arm>' record.`) where it used to read as `null`. Selections that
  name every arm are unchanged. The TypeScript renderer's empty-`select`
  refusal now names the model instead of `'undefined'`.
- **Error-surface change: a malformed polymorphic slot is a malformed
  result.** A driver (or its `parseResult` middleware) that hands back a NULL
  or non-object value where a polymorphic to-one or to-many slot's document
  belongs used to escape as a raw `TypeError` (NULL) or be refused at its
  first variant arm, in that arm's sentence (any other non-object). It now
  fails at the slot, with the ordinary malformed-result `QueryEngineError`
  every other provider document raises:
  `Driver "<driver>" returned a malformed polymorphic slot scalar for
  operation "<operation>": the slot is not an object.` (`meta.scalarType` is
  `"polymorphic slot"`). The same holds for a polymorphic to-many slot's
  orphan-integrity entry: when it is present but is not an object (NULL, an
  array, a number or a string), the read fails with `...: the integrity entry
  is not an object.` It used to be ignored (NULL, number, string) or have its
  array entries read as orphan counts. An absent entry still means no
  orphaned membership. The statements VibORM issues always build these
  documents, so only a driver or middleware that rewrites results can observe
  the change; well-formed results are unchanged.
- **PGlite runs the full GeoPoint tier with PostGIS.** The optional
  `@electric-sql/pglite` peer now admits 0.4 and 0.5 besides 0.3
  (`^0.3.2 || ^0.4.0 || ^0.5.0`), and VibORM is tested on 0.5.8 (PostgreSQL
  18.3). With `@electric-sql/pglite-postgis` 0.2.8 (PostGIS 3.6, which requires
  PGlite 0.5.8 exactly) loaded through PGlite's own `extensions` option,
  `CREATE EXTENSION postgis` run by the caller, and `postgis: true`, the PGlite
  driver passes the same GeoPoint contracts as `pg` and postgres.js — bounds,
  polygons, distance, `_distance`, the generated migration estate and GiST
  index planning — in process, with no server. The driver gains no option:
  the extension is PGlite's to load and the caller's to install, and
  `postgis: true` stays an assertion that migrations prove. On PGlite 0.5,
  pgvector is its own package, `@electric-sql/pglite-pgvector`, where 0.3 and
  0.4 exported `@electric-sql/pglite/vector`; and 0.5.8 starts with
  `enable_seqscan` on, where 0.3 started with it off. A persistent `dataDir`
  does not cross a PostgreSQL major: moving one from PGlite 0.3 to 0.5 is a
  dump and restore.
- **Behaviour change on batch-only drivers: `createMany` with `skipDuplicates`
  warns and runs instead of refusing.** Where no savepoint can isolate one
  member — D1 Workers bindings, Neon HTTP, a native array batch, and a member of
  an array `$transaction([...])` — a `createMany` with `skipDuplicates` that is
  relation-bearing, or nested under another `create`/`update` (many-to-many
  included), used to throw `TransactionError` (`V5001`) before any write. It
  now runs **without** `skipDuplicates` and warns once per client and model —
  on the `warning` log channel when logging routes warnings (the sentence in
  `meta.notice`), with `console.warn` otherwise: `createMany skipDuplicates
  cannot skip rows involving nested writes on driver "d1" (no savepoint
  available) in post.createMany; running without skipDuplicates — a duplicate
  will fail with a unique-constraint error.` A duplicate then fails with the
  ordinary `UniqueConstraintError`, and rows an earlier batch committed stay
  committed, exactly as for the same call without `skipDuplicates`. A root
  scalar `createMany` with `skipDuplicates` is unchanged (it skips in SQL),
  except on MySQL inside an array `$transaction([...])`, whose per-row skip
  needs a savepoint: it too now runs without the flag and warns instead of
  refusing. Interactive drivers keep skipping inside a savepoint.
- **Recursive relation projections.** A self-relation's node — `parent`,
  `children`, a proven one-to-one inverse or a paired junction graph — takes
  `recurse` in `select` and `include`: `true`/`{}` follow the relation to depth
  100, `{ depth: n }` to `n` levels (1–1000), `{ depth: false }` exhaustively;
  a junction graph prunes cycles path-locally by default and may unfold them
  with `{ preventCycles: false }` under a bounded depth, while a foreign-key
  cycle inside the traversed window is an error. The node's own projection
  repeats at every level, filters prune every hop, each level keeps its
  `orderBy`, and the repeated key is absent at a numeric cutoff and present
  (`[]` or `null`) where the data ends. One provider statement serves any
  depth; the result composes with the cache, `omit`, extensions, arrays and
  callback transactions like any other relation projection, and
  `renderOperationResultType` renders a recursive result as named declarations.
  Output grows with paths, not rows: a graph can return exponentially more
  occurrences than it stores, even with cycle prevention, so depth 100 is not a
  size bound. Executed locally on SQLite, PGlite, native PostgreSQL 16 and
  native MySQL 8.4 (the placement matrix and the hierarchy and graph worlds on
  all four; the composition matrix on SQLite; 300 generated cases each on
  SQLite, native PostgreSQL and native MySQL); hosted providers are not yet
  qualified. Where the provider spells `LATERAL` the carrier's recursive CTE
  lives in a lateral derived table, because MySQL materializes a correlated
  CTE that is read twice once per statement. Providers cap exhaustive
  traversals with their own limits: MySQL's `cte_max_recursion_depth` surfaces
  as the provider's error (errno 3636), never as a truncated result. A
  recursive node may select a point's distance, returned as the node's
  `_distance`; no relation can take that name (see "`_distance` is a reserved
  member name" above).
- **A connection must be representable.** An explicit `connect`, and the found
  and the create arm of `connectOrCreate`, establish a relation by writing the
  value the target holds for the referenced field. Every component that
  connection needs must be present and non-NULL. A target whose
  referenced field reads NULL cannot establish the requested relation, so the
  write is refused — `NestedWriteError`, naming the relation and the field —
  instead of writing that NULL and silently disconnecting the holder from
  whatever it pointed at. One requirement covers both directions (a parent-held
  edge and a child-held one), found and produced values, and single and compound
  references; it is checked before the connection is consumed, so nothing is
  written and then discovered. Ordinary nullable scalar writes, an explicit
  `disconnect`, and a NULL field that is not part of the consumed reference are
  unaffected, and a model declaring a nullable referenced unique is not itself
  refused.
- **A selected bulk mutation carries its selector to the
  effect.** An `updateMany` or `deleteMany` that captures an identity set and
  then consumes it sends BOTH the complete captured identity set and that
  statement's original prepared selector in the consuming statement. A row that
  stopped matching the selector between the capture and the effect is therefore
  not mutated, on the batch route as on the interactive one, and the existing
  `selected-row cardinality changed` error is the answer when fewer rows are
  affected than were captured. Failure and commit stay separate facts: on an
  operation-owned interactive transaction its owner rolls back; on an already
  acknowledged atomic batch the acknowledged effects and the result-phase
  failure are both reported truthfully — a check after dispatch cannot undo that
  batch and does not claim to. Compound and mapped keys, `limit` and the
  zero-result answer are unchanged.
  A nested captured series is BOUNDED in the same spirit: the initial filter
  selects the worklist ONCE, and a qualifying row that joins after that boundary
  is not adopted into it. The filter is not re-evaluated before every member —
  an earlier member may legally change the facts a later one was selected by —
  but the actual identity, parent and relation-membership requirements are still
  enforced where they always were, so a member that loses or changes its
  membership is still not consumed. `FOR UPDATE` locks rows; it does not exclude
  phantoms, and nothing here claims otherwise.
- **Native MySQL is part of local release qualification.**
  The `mysql2` driver is qualified against a local MySQL 8.4 — schema push and
  re-push, the migration and namespace boundaries, the read and nested-write
  inventory, and concurrency — rather than inheriting its status from shared
  transport code. A database-selected deadlock victim is a FAILED transaction:
  it is reported as the provider failure it is, with no committed victim
  effects, and it is never treated as an eligible unique-key race or silently
  replayed. The recoverable unique-key race that `upsert` and `connectOrCreate`
  already converge under is unchanged. Hosted MySQL (PlanetScale) qualification
  remains deferred.

- Prepare the V1 release and publication system.
- **The query engine is replaced.** Raptor 3 (the name that appears in some
  engine error messages) is now the only engine behind the public client API,
  which is unchanged: every operation, filter, nested
  write, transaction form and result shape is the same, and the differences
  the cutover surfaced were repaired to the old engine's answers or ruled and
  documented one by one. What changed at the adapter and driver contracts is
  listed below. Every refusal the engine raises is a documented sentence, and
  the sentences fall into three kinds that are easy to confuse:

    - **An invalid request.** The operation asked for something the data cannot
      represent — a connection whose reference value is NULL, a `_distance`
      selection beside a field of that name. Nothing is written; correcting the
      request is the whole remedy.
    - **An operational database failure.** The provider refused the work or
      aborted the transaction — a deadlock victim, a constraint violation, a
      driver that answered a malformed or missing result. The driver normalizes
      it; it is a fact about that run, not a limit of the ORM, and the same
      request can succeed on the next one.
    - **A capability refusal.** The engine will not do this here — building a
      write to one SQL statement, a generated non-increment key on a transport
      with no interactive transaction. This one names a boundary that will not
      move by retrying.

  A failed internal invariant is none of the three: it is thrown as an
  `EngineInvariantError`, carries no `V####` code, and is a defect to report.
  Counting sentences does not measure any of this. The three kinds above are
  this changelog's own reading of what a failure means to a caller; the census
  (`scripts/raptor3-refusal-census.mjs`) separates a different three by
  construction — invariants, private-fit internals and refusals — and reports
  23 distinct candidate sentences this engine spells that the previous one did
  not: a count of SENTENCES, not of operations you can no longer perform, and
  not a coverage figure. What the engine does and does not support is the
  behavioural inventory's fact, one row per admitted fact.
- `DatabaseAdapter["expressions"]["integerDivide"](left, right)` is a
  **required** adapter member: the portable integer quotient the engine uses when it has to state in SQL
  the value an integer or bigint column will hold after a `{ divide }` (PostgreSQL integer
  division, `TRUNCATE(a / b, 0)` on MySQL, `a / CAST(b AS INTEGER)` on SQLite).
  A third-party adapter must add it; this is a compile-time change for adapter
  authors and invisible to client code.
- `PendingOperation.buildStatement()` (and the engine's internal
  `QueryEngine.build()`, which backs it) answers the one SQL statement a
  **read** compiles to, taken from the prepared read the execution itself
  runs. Every write now answers the `does not compile to one SQL statement`
  refusal — including a write the previous engine could fold into a single
  statement, such as a scalar `delete` on a driver with `RETURNING`. Run the
  operation instead of building it.
- A nested write that must observe its own earlier writes — a member that
  reads a row an earlier member wrote, a series of dependent members — now
  runs on a **batch-only** transport that keeps no session between requests
  (Neon HTTP, D1) as a succession of atomic batches, each committing as it
  completes. A key the database generated in one batch is read back at the
  end of that batch and carried into the next as a literal, so such a write
  no longer fails with a bare provider error once its first batch has
  committed. This is verified on a batch-only fixture that keeps no session
  between requests; the live Neon suite is credential-gated on
  `NEON_TEST_DATABASE_URL` and was not run for this release, and the D1 driver
  is exercised on the Workers runtime's own local D1 and on no hosted
  Cloudflare D1. A failure in a later batch leaves the earlier batches committed,
  and the error says so (`atomicity: "segment"`, `committedSegments`). Nothing
  changes on a transport with an interactive transaction, where the whole
  write is one transaction.
- The transport facts each driver guarantees for a nested write — how it runs,
  what a mid-way failure leaves behind and how it is reported, the bind
  capacity per statement, and which of these are verified live — are stated
  per driver in the [drivers overview](/docs/drivers)
  under "Nested writes and failures per driver".
- The SQLite drivers (`sqlite3`, `bun-sqlite`, `d1`, `libsql`) no longer
  normalize `count`/`exist` results in their driver-level `parseResult`
  middleware. The query engine's decoder owns the meaning of a count and an
  exists answer — it asks for its own `_count` alias and reads it back — so
  those answers are unchanged on every SQLite driver. The
  `DriverResultParser.parseResult` contract itself is untouched: a consumer
  that wrapped `driver.result.parseResult` is still asked once per operation
  with the provider's raw result, and is unaffected in outcome. The shipped
  `parseResult` function itself no longer exists on those drivers: a wrapper
  that captured it before installing its own must check for its absence
  before calling it.
- The MySQL adapter no longer normalizes `count`/`exist` results in its
  adapter-level `parseResult`. The query engine's decoder owns the meaning of a
  count and an exists answer — it asks for its own `_count` alias and reads it
  back, and a count carried under any other column was refused before this
  deletion exactly as it is after it — so those answers are unchanged, on the
  live route and inside `$transaction([…])`.
- The PostgreSQL adapter no longer converts a bigint in its adapter-level
  `parseResult`. That leg was offered the operation's row array rather than a
  value, and an integer's width is owned by the query engine's own scalar
  codec, which turns a bigint or an integer text into a number and refuses one
  outside the safe integer range. Count answers are unchanged on both the `pg`
  and the `postgres.js` transport.
- `DatabaseAdapter["result"]["parseResult"]` is untouched: it remains a
  required member, still asked once per operation with the provider's raw
  result, and on all three shipped adapters it is now the pass-through the
  SQLite adapter has always installed.
- A nested write under a parent with a generated increment key now runs on a
  PostgreSQL-family transport that has no callback transaction (Neon HTTP, a
  batch-only PGlite) as one native batch: the parent's INSERT is a
  data-modifying CTE whose own RETURNING stores the key in the batch
  reference table, and every later statement of the same batch reads it back. Such writes were
  refused before ("Raptor 3 G1 atomic output requires exact identity scratch
  or segmented RETURNING"). A generated key that is not an increment key on
  such a transport keeps that refusal.
- The batch reference contract (`@internal` `BatchReferenceSqlAdapter`) gains
  an optional `storeReturning(batchId, key, insert, column)`, present on the
  PostgreSQL adapter; the PostgreSQL batch reference table is no longer
  declared `ON COMMIT DROP`, so the table survives the batch that created it;
  each dispatched batch makes its own reference rows and drops them at its own
  end. The logical `CastType` gains `"bigint"` (`BIGINT` on
  PostgreSQL, the 64-bit integer cast the other dialects already had), so a
  `bigint` increment key is read back at its own width.

### Decimal (breaking)

A decimal field admits `Decimal | string`. A JavaScript `number` is a double
rather than an exact decimal, so it is refused at every decimal position —
create and update values, `increment`/`decrement`/`multiply`/`divide`,
`push`/`unshift`, every filter operand, `having` operands, cursors and unique
lookups — with one issue: `Expected an exact decimal: a Decimal or a string
like '-12.345' (sign, digits, at most one dot, no exponent); a JavaScript
number is a double and is not accepted`. The keys, the nullable arms and the
operand forms (literal, field reference, SQL fragment, callback) do not move;
only the literal narrows, and the input types drop `number`. Write
`{ total: "0.3" }`, not `{ total: 0.3 }`.

- `new Decimal(value)` takes a `Decimal`, a string, or a whole `bigint`
  (`new Decimal(5n)` is `5`); a number throws `TypeError`. The arithmetic and
  comparison methods take the same arguments, so `total.plus("1")` rather than
  `total.plus(1)`.
- The `String(number)` rule and the documented `0.1 + 0.2` case are gone with
  it: there is no double to spell.
- The input JSON Schema of a decimal is the string alone
  (`{ type: "string", pattern }`, with the domain in `description`); the
  `{ type: "number" }` arm is gone, so a document generated from it no longer
  describes values the validator refuses.
- A schema document's decimal default written as a JSON number (`"default":
  1.5`, or a number member of a list default) is refused with `J008`; write
  the string `"1.5"`. An invalid `precision`/`scale` in a document reports the
  per-key sentence below under `J010`.
- `s.decimal({ precision, scale })` reads its argument as the developer's own
  code. Each bad bound has one sentence at its key —
  `'precision' must be an integer between 1 and the maximum safe integer` at
  `descriptor.precision`, `'scale' must be an integer between 0 and precision`
  at `descriptor.scale` — replacing the five earlier messages. A missing or
  non-object argument (untyped JavaScript) now reports the `precision`
  sentence at `descriptor.precision` instead of
  `A decimal must declare { precision, scale }` at `descriptor`. Extra,
  inherited, symbol and non-enumerable keys are ignored at runtime (the types
  still refuse extra keys), and a throwing getter or a revoked proxy throws its
  own error instead of a `ValidationError`.
- `.default(x)` checks the default against the field's own schema and reports
  one sentence, `The decimal default did not satisfy its field schema`, in
  place of the list-specific messages (`must be an array`, `dense array with
  no shadow properties`, `Could not snapshot`). Extra properties on a list
  default are dropped rather than refused. A custom `.schema()` that throws, or
  that returns a non-object result such as `null`, lets that error (a
  `TypeError` for `null`) escape `.default()` instead of `The decimal field
  schema failed while validating its default`. The check is still eager, at
  `.default()`, `.array()` and `.schema()`.

### Geo: a geographic value is validated as the record VibORM returns (breaking for refusal wording and polygon admission)

A `GeoPoint`, `GeoBounds` or `GeoArea` argument is now read by the same record
walker as every other object operand, not by a bespoke reader. For points and
bounds the accepted values are unchanged for ordinary input; what changes is
the posture toward unusual objects and the wording of refusals. Polygons are
checked for their shape first and their geometry second; the geometry refused
is what the databases were measured to answer wrongly or differently.

- Refusals name the key: `{ longitude, latitude, latitdue }` fails with
  `Unknown key: latitdue` at path `latitdue` (was `Expected GeoPoint with
  exactly longitude and latitude`), a missing coordinate fails with
  `Missing required field: latitude`, a non-object with `Expected object`
  (was `Expected GeoPoint object`), and a non-finite coordinate with
  `Expected finite number` (was `Expected finite longitude`). Range messages
  are unchanged. Unknown-key and missing-key refusals now point at the key:
  `data.location.extra` and `data.location.longitude` where the path was
  `data.location`; an object without the coordinates, such as a `Date` or a
  `Map`, also fails at `data.location.longitude`.
- Bounds and areas follow the same rule: `{ bounds: { …, nort: 49 } }` fails
  with `Unknown key: nort` at `bounds.nort` (was `Expected GeoBounds with
  exactly south and west and north and east`), `{ bounds, extra }` with
  `Unknown key: extra`, and a bounds coordinate out of range with
  `Latitude must be between -90 and 90` or `Longitude must be between -180 and
  180` (was `south must be between -90 and 90`, and so on; paths unchanged).
  `GeoBounds south must be less than or equal to north` and `Expected GeoArea
  with exactly one of bounds or polygon` are kept word for word, but an area
  carrying both variants where one is itself invalid now reports that
  variant's refusal (for example the `south`/`north` message at
  `bounds.south`) instead of the exactly-one message.
- An area spelled `{ bounds: undefined, polygon }` is now the polygon area: an
  explicit `undefined` is an absent key, as everywhere else.
- Newly accepted: an inherited enumerable coordinate, a class instance, and an
  object carrying extra symbol or non-enumerable keys; the walker reads
  enumerable string keys only, as it does for every other argument.
- A getter or proxy trap that throws while a point is read surfaces as a
  validation issue carrying the thrown cause (through `parse` and every
  operation boundary) instead of the former `Could not read …` message; in an
  operation it is reported at `root` as `Schema validation failed
  unexpectedly` where the path named the coordinate. A direct call of a geo
  validator, and `v.point()["~standard"].validate`, now let the throw
  propagate, as every other `v.object` schema already did, and so does `s.point().default(…)`, whose value is the
  developer's own declaration: a throwing getter there is that raw error at
  declaration time instead of a `ValidationError`.
- A `GeoPolygon` is checked for its shape first: exactly `outer` and optional
  `holes`, finite in-range vertices, at least three vertices per ring
  (`A GeoPolygon ring needs at least 3 vertices`, kept), all reported by the
  record walker. Its geometry is checked second, on the great-circle reading:
  a polygon is refused when it has no single meaning there, or when it falls
  outside one of three stated domain choices (next entry); a valid polygon a
  database computes differently is admitted (below). Measured with
  VibORM's own predicates on PostGIS 3.6.2 and MySQL 8, PostGIS raises only
  for an edge between antipodal endpoints and answers every other malformed
  polygon silently: a hole reaching outside the outer ring adds its own area,
  a point inside two holes matches, a bowtie matches both lobes, and MySQL
  answers a pole vertex with the equator and the opposite pole. Those polygons
  are refused at admission, the same on every dialect, with the pre-D2
  messages word for word: `A
  GeoPolygon ring cannot self-intersect` (a crossing or touching ring,
  including one that repeats a vertex further on or goes past a whole turn
  over itself), `A GeoPolygon ring must have non-zero area`, `A GeoPolygon
  ring cannot contain a pole` (a vertex on a pole), `A GeoPolygon cannot
  contain a pole` (a ring winding around one, or running over both), `A
  GeoPolygon hole must be strictly inside its outer ring` and `GeoPolygon
  holes cannot touch or overlap`. Each is reported at its ring (`outer` or
  `holes.<i>`), except the vertex and edge refusals (`ring cannot contain a
  pole`, `cannot join vertices within 0.01 degrees of antipodal`), reported
  at the offending vertex (`outer.<j>` or `holes.<i>.<j>`, the vertex ending
  the edge).
- Three of those refusals are VibORM's own domain choices, each for its
  stated reason, not properties every valid polygon lacks: the resolution,
  1e-9 degrees (about 0.1 mm), a fixed margin for floating-point rounding
  within which a point is on what it touches, so closer rings touch and a
  shorter edge is a repeated vertex; near-antipodal edges, refused within
  0.01 degrees of opposite points, where one float64 step of a written
  coordinate turns the edge's great circle by more than a third of that
  resolution; and the poles, where a vertex within the resolution of a pole
  has no longitude, and a ring winding around a pole or running over both
  has no side away from both, while an edge of exactly 180 degrees of
  longitude runs over the pole and is admitted. The entries below give
  each one's figures.
- A vertex on a pole has no longitude and is refused with `A GeoPolygon ring
  cannot contain a pole`, at the vertex, as before D2; a vertex within 1e-9
  degrees of a pole, VibORM's resolution, counts as on it. A vertex any
  further off is admitted, however near (the databases' reading of such
  rings is below). A ring winding around a pole, or running over both poles,
  has no side away from both and is refused with `A GeoPolygon cannot
  contain a pole`.
- The geometry reads each edge as PostgreSQL does, as the great-circle arc
  between its vertices on the sphere, not as a straight line of longitude and
  latitude. MySQL reads the edge on the ellipsoid instead: the largest
  departure from the arc observed over 30 random edges per length (measured
  by bisection) is 0.0007 degrees (about 79 m) on a 10-degree edge, 0.007 at
  30, 0.029 at 60, 0.075 at 90, 0.17 at 120 and 0.46 at 150, none along the
  equator or a meridian, so
  points within that band beside an edge can be answered differently by the two
  databases (stated, not refused: below); a long edge split into shorter ones
  narrows the band with the square of the length.
  Around every vertex, whatever the edge length, MySQL also answers points
  within about 1e-6 degrees (about 11 cm) unlike PostgreSQL and the sphere:
  about 13% of such points in random pentagons with edges of 0.001 to 5
  degrees (1,240 to 1,332 of about 9,600 per size), none from 1.8e-6 out,
  PostGIS none; there MySQL's SPATIAL index and table scans can also
  answer differently (152 points in the review's run, all within 7e-7 of a
  vertex). In the 0.001-degree square from (10, 40), MySQL matched
  (10.0009994, 39.9999994), outside, and missed (10.0000006, 40.0009994),
  inside.
  In the box from (0, 40) to (10, 50) both databases put (5, 40.05) outside and
  (5, 50.05) inside, because the south edge bows north to about latitude
  40.105 and the north edge to about 50.10. So a hole drawn touching or just
  inside a straight parallel edge crosses the edge's arc and is refused
  (PostGIS matched points in the hole beside it), a hole between the straight
  line and the arc on the inner side is accepted, and three vertices in a
  straight line of longitude and latitude off the equator form a thin
  triangle, not a zero-area ring. A touch is refused even where it is exact,
  as before D2: it is where the two databases' edges (sphere, ellipsoid) and
  tolerances part. A differential run of 4,800 random holes and
  quadrilaterals against PostGIS geography agreed on every verdict.
- Newly accepted, because both databases answer them correctly: a closing
  vertex repeated at the end, or any vertex repeated consecutively (it is sent
  as written and closed once more), a ring that goes past a whole turn of
  longitude beside itself. SQLite-family providers still refuse polygon
  filtering, now after admission.
- Admitted, the database's reading stated instead of refused (owner decision,
  2026-09-24: VibORM refuses a polygon with no single meaning, or outside
  its stated domain choices, never a valid one because a database computes
  it differently; `point.mdx`, "How each
  database reads a polygon", has the figures and the advice):
  - Rings reaching across the equator, the 0/180 meridian and the 90/-90
    meridian at once, every ring of half the globe or more among them.
    PostGIS then has no reference point outside the polygon's box and falls
    back to one it derives from the first edge sent or from its internal
    circle tree over the edges, so its answer depends on vertex order and
    query path: table scans went wrong on 42 of 44 random ring rotations
    where either fallback point fell inside the ring and on none of 436 where
    both fell outside; 23 of 372 random such rings were misread, one of them
    27% of half the globe, and none of 494 reaching across two planes or
    fewer. Rerun on the admitted witnesses (400 random points each, table and
    index scans): the tropics band from -170 to 170 at ±30 (11.18 steradians
    on the great-circle reading) 38 points wrong on PostGIS, a band with two
    175-degree edges on each side 398 of 398, a random ring across all three
    planes 347 of 397, the Pacific from 115 to -75 degrees none; MySQL none
    on any. Splitting such an area into polygons joined with `OR`, each on
    one side of one of those planes, avoids it. `A GeoPolygon cannot reach
    across the equator and the 0/180 and 90/-90 meridians at once` and
    `A GeoPolygon must cover less than half the globe` are gone.
  - Edges of any length short of the antipodal bound below. MySQL's
    ellipsoid edge was observed to leave the great-circle arc by as much as
    0.46 degrees on 150-degree edges, 1.6 at 170, 2.7 at 174, 8.4 at 178 and
    16 at 179 (the largest over 30 random edges per length), and
    in every run of 30 random triangles with an edge up to 2 degrees short
    of antipodal it answered some points far from the edge unlike PostGIS and
    the sphere. `A GeoPolygon edge must be shorter than 150 degrees` is gone.
  - Rings of any size above VibORM's resolution. MySQL answers points within
    about 1e-6 degrees of a vertex unlike the sphere, so it misplaced points
    a tenth of the ring from every edge in rings a few 1e-6 degrees across
    (0.4% at 5e-6, 9% at 2e-6, 16 to 32% at 1e-6, 34 to 56% below) and none
    of 16,000 in rings 1.4e-5 across; PostGIS answered all of them. `A
    GeoPolygon ring must be at least 2e-5 degrees across` is gone.
  - Vertices near a pole. With two consecutive vertices a few 1e-6 degrees
    from a pole, MySQL (from about 3e-6 degrees down) and PostGIS (from about
    6e-7 down) answered points 70 degrees from the ring wrongly: in the ring
    from (-60, -89.9999999) east to (120, -89.9999999) and back along latitude
    -60, MySQL matched (30, 70) and missed (30, -70), and PostGIS's answer
    changed with its query plan on another. None of about 1,500 such rings
    from 5.6e-6 degrees out was answered wrongly. `A GeoPolygon vertex must
    be at least 1e-4 degrees from a pole` is gone.
  - An edge 180 degrees of longitude long between vertices that are not
    antipodal, such as (0, 10) to (180, 20): it lies on one great circle and
    runs over the pole on its vertices' side, the pole on the ring. Both
    databases read it so away from the edge (8 named and 140 random such
    rings, about 118,000 points at least 0.01 degrees from every edge: none
    wrong on PostGIS, one on MySQL, inside its ellipsoid band beside another
    edge); on the edge itself they part: PostGIS matched (0, 50), (180, 60)
    and the pole on the edge from (0, 10) to (180, 20), MySQL did not, and
    for (0, 10) to (180, 10) they answered (0, 80) differently. `A
    GeoPolygon edge cannot span exactly 180 degrees` is gone.
- An edge whose end lies within 0.01 degrees of its start's antipode is
  refused with `A GeoPolygon edge cannot join vertices within 0.01 degrees of
  antipodal`, at the vertex ending it: two antipodal points lie on every great
  circle through them, and near the antipode a one-step float64 move of a
  written coordinate turns the edge's circle by up to about 3e-12 / d degrees
  at d degrees from antipodal (3.1e-9 at 0.001, 3.0e-10 at 0.01, over 2,000
  random edges per distance), so nearer than 0.01 the written coordinates do
  not fix the edge to VibORM's 1e-9-degree resolution. An edge between
  exactly antipodal endpoints, such as (0, 0) to (180, 0), which PostGIS
  raises for, is refused by it.
- Points within 1e-9 degrees, about 0.1 mm, of an edge count as on it, and an
  edge shorter than that is a repeated vertex. That is VibORM's resolution at
  every ring size: against 60-digit geometry on 9,000 random rings 1e-9 to
  1e-4 degrees across, every ring whose edges and clearances exceed twice it
  was judged exactly (4,048 simple rings admitted with the right winding,
  2,135 crossing ones refused), and so was every one of 6,190 polygons with
  vertices 3.5e-9 to 3.6e-4 degrees from a pole, over it or with holes by
  it. A ring whose vertices all lie within it of
  one another, one distinct vertex included, is refused with `A GeoPolygon
  ring must have non-zero area`. Cross products are taken from vertex
  differences, so a 1e-7-degree bowtie inside a larger ring is refused at any
  latitude (the plain product admitted it at latitude 45).
- A polygon without `outer` fails with `Missing required field: outer` (was
  `Expected GeoPolygon with outer and optional holes`), and a ring that is not
  an array with `Expected array` (was `Expected outer ring array`). A ring is
  read by index like every array operand: an empty slot in a sparse ring fails
  as `Expected object` at its index, and an inherited index is read.
- Unchanged: longitude `-180` still becomes `180`, `-0` still becomes `0`,
  `holes: []` is still the same argument as no `holes`, and an accepted
  polygon is still sent with its outer ring counterclockwise and its holes
  clockwise.

### Identifiers are generated by VibORM (breaking for the dependency graph)

`@paralleldrive/cuid2`, `nanoid` and `ulidx` leave the runtime dependency graph
and nothing joins it: SHA3-512, the one hash CUID2 needs, is VibORM's own
Keccak-f[1600] and adds no dependency at all. Every format is built here, from
`crypto.getRandomValues` and nothing else — a runtime that cannot provide secure
randomness is refused rather than served a weaker identifier. CUID2 output is
byte-identical to the package it replaces, proven by a differential test against
the pinned upstream, and the digest is byte-identical to `@noble/hashes` over
the NIST known-answer vectors and 10,000 random messages, proven by a second
differential test that keeps that package installed for development only.

- Added `s.string().uuidv7()` and `s.string().ksuid()`, with the matching
  `generate` kinds in the JSON schema document.
- `s.string().id()` now sets `hasDefault`, so a generated primary key is
  optional in the create type as it already was at runtime. `.id()` no longer
  overrides a generator declared before it, and `.id(prefix)` after a generator
  is refused (`.id("")` names no prefix, so it stays a plain key declaration).
- A nanoid length outside the range a nanoid can have — not a whole number, or
  outside 1 to 65536, the entropy source's own per-call quota — is refused at
  declaration instead of silently producing empty identifiers or throwing a
  platform error on every row.

### Identifier storage (breaking for new schemas)

Naming a format is now a promise about every value of the field, and VibORM both
holds you to it and takes advantage of it. `.uuid()`, `.uuidv7()`, `.ulid()`,
`.ksuid()`, `.nanoid()` and `.cuid()` declare a **domain**; a bare `.id()` still
declares a **key** and is unchanged in every respect — its values are whatever a
string column holds, and it is still stored as text.

- **Values are validated.** A declared or derived domain admits only its own
  values, everywhere one can appear: `create`, `update`, `where`, unique
  selectors, cursors, and every `connect` / `connectOrCreate` / `upsert` key. A
  prefix is matched whole, and aliases normalize once — an uppercase UUID and a
  lowercase ULID address the same row their canonical spelling does. Previously
  `s.string().uuid()` refused nothing.
- **Storage changes for new schemas.** `uuid`/`uuidv7` become `uuid` on
  PostgreSQL and `BINARY(16)`/`BLOB` elsewhere; `ulid` becomes
  `bytea`/`BINARY(16)`/`BLOB`; `ksuid` becomes `bytea`(20)/`BINARY(20)`/`BLOB`.
  A declared prefix is no longer stored — it is identical in every row and is
  re-applied on read. `nanoid` and `cuid` keep text storage.
- **Foreign keys derive.** A column that references a key is admitted,
  normalized and stored exactly as that key is, with no declaration of its own —
  through self-relations, compound members, one-to-one chains, junction columns
  and polymorphic carrier columns alike. Declaring a DIFFERENT domain on a
  foreign key than its target has, or reaching one column through references
  whose keys disagree, is a schema error (FK012).
- **Four operators are gone from the compact formats.** `contains`,
  `startsWith`, `endsWith` and `mode` are removed from the filter TYPE of a
  `uuid`/`uuidv7`/`ulid`/`ksuid` field and refused by the engine: sixteen bytes
  are not the text you wrote them as. `equals`, `not`, `in`, `notIn`, `lt`,
  `lte`, `gt`, `gte`, `orderBy`, cursor pagination, `_min`/`_max`, `_count` and
  `groupBy` are exact and unchanged — the byte order of all four formats IS
  their canonical text order. The loss goes by the FORMAT, not by the storage:
  a compact format that takes the text-family override below still loses them,
  because the validation schema is built before any adapter exists and one
  filter type per field rather than one per deployment is what keeps the type
  and the runtime saying the same thing. A DERIVED domain narrows at run time
  only: a foreign key has no declaration of its own to compute a type from.
- **A field reference across storage is refused.** `where: { id: { equals: (ctx)
  => ctx.fields.someString } }` compiled and matched nothing when `id` was
  compactly stored and `someString` was not — it compared payload bytes with
  public text. Both directions now raise before any I/O, naming what each column
  holds. Two TEXT columns are untouched whatever their domains: a `nanoid`
  stores exactly the string it shows, so comparing it with an ordinary string
  column asks the question it appears to ask.
- **`_min`/`_max` aggregate the transported spelling.** PostgreSQL has neither
  `min(uuid)` nor `max(bytea)`, and the answer is the same either way.
- **`DEFAULT gen_random_uuid()`** is emitted only for an unprefixed `.uuid()`
  field, and only where the column can hold one: `uuidv7` needs PostgreSQL 18,
  and no database can produce a prefixed value or a `bytea` payload.

### Existing databases

A column that already holds text has two routes, and neither is silent.

- **Keep the column.** A text-family native type
  (`s.string(PG.STRING.VARCHAR(40)).uuid()`, `TEXT`, `citext`, MySQL `CHAR(n)`,
  …) opts out of compact storage while keeping the domain validated. PostgreSQL's
  `char(n)` is not among them — `character(n)` blank-pads to its full width, so
  no value of the domain would ever be returned. A native type the domain cannot
  live in is refused where it is declared (F013), with a message naming the
  spellings that format does accept.
- **Convert the rows.** The generated `alterColumn` into a binary column is now
  **refused** rather than run: nothing can re-read stored text as bytes, and the
  refusal names the manual route. PostgreSQL's `text` → `uuid` leg still runs —
  `col::uuid` is a real per-value conversion — and is now preceded by a guard
  that says how many rows would fail it and what the two routes are, instead of
  naming one offending value.
- `identifierConversionChecks` (new, from `viborm/migrations`, alongside the
  `MigrationCheckInput` type) renders the questions a conversion has to answer
  first — every row in the domain, no two rows folding together under the
  uuid/ulid alias, every referencing foreign key still finding its parent after
  that fold — as `trusted-read` checks you can run or pass to `generate()`. The
  fold question is asked of the key and of any referencing column that is a
  complete key of its own model, never of a plain many-side foreign key. On
  MySQL every identity comparison is rendered as `CAST(… AS BINARY)`: the 8.0
  default collation folds case in `=`, which admitted a foreign key that the
  `BINARY(n)` column would then leave without a parent.
  The per-dialect recipes are in the new
  [Converting identifier columns](https://viborm.dev/docs/migration/identifiers)
  guide; every statement on that page was executed against PostgreSQL 16,
  MySQL 8 and SQLite.

### Decimal API change (breaking)

The exact decimal value type is now VibORM's own `Decimal` instead of
decimal.js, and it brings no dependency with it: an immutable signed `BigInt`
coefficient and a scale, where decimal.js was 32 KB minified.
`Decimal` is still exported from `viborm`, still constructed once per selected
leaf, and still satisfies `instanceof Decimal`. Nothing VibORM owns changed:
`s.decimal({ precision, scale })`, the frozen descriptor, exact admission,
canonical identity, provider representations, DDL, filters, updates, aggregates
and migrations all behave exactly as before, and the accepted input grammar
(`"+1.5"`, `".5"`, `"1."` accepted; `"1e3"` refused) is unchanged.

What changes for application code that does arithmetic on returned values:

- **18 prototype members instead of ~130**, every one of them distinct.
  Kept: `abs`, `cmp`, `div`, `eq`, `gt`, `gte`, `lt`, `lte`, `minus`, `neg`,
  `plus`, `times`, `toFixed`, `toJSON`, `toNumber`, `toString`, `valueOf`,
  and the constructor.
- **No aliases.** decimal.js spelled three operations twice; only `plus`,
  `minus` and `times` exist here.
- **Gone:** `pow`, `sqrt`, `mod`, `prec`, `round`, `toExponential`,
  `toPrecision`, `isZero`, `isNeg`, `isNaN`, `isFinite`, `floor`, `ceil`,
  `trunc`, `toDP`, `toSD`, `dp`, `sd`, `ln`, `log`, `exp`, the trigonometric
  methods, `toFraction`, `toNearest`, `clamp`, and the radix conversions.
  `x.isZero()` becomes `x.eq("0")`; `x.isNeg()` becomes `x.lt("0")` (a JavaScript number is refused; write the string or a bigint); rounding to a
  fixed number of places is `x.toFixed(n)`.
- **No NaN and no Infinity.** `new Decimal("abc")`, `new Decimal(NaN)` and
  `new Decimal(Infinity)` throw `TypeError` where decimal.js produced a NaN
  value, and `div(0)` throws `RangeError("Division by zero")`.
- **No configuration at all.** `Decimal.set({...})` is gone and nothing
  replaces it: the class has no static properties, so nothing an application
  sets can move a value in either direction. `div` takes its decimal places and
  its rounding as arguments — `div(other, fractionDigits = 20, rounding =
  "half-up")`, where `rounding` is `"half-up"` (ties away from zero, the
  default and what decimal.js's default produced) or `"half-even"` (ties to the
  even neighbour, what the SQL engines do). `toFixed` rounds half away from
  zero.
- **`toString()` never emits exponent notation.** There is no `toExpNeg` /
  `toExpPos` equivalent and no threshold: the canonical text of a value is
  every digit it has, which is also the text VibORM stores, compares and keys
  cache entries on.
- **`structuredClone` of a `Decimal` returns an empty object** rather than
  throwing, because the value lives in private fields. It was already not
  cloneable; it is now quietly not cloneable. Post `row.total.toString()`
  across a worker or a `structuredClone`-based cache boundary and rebuild the
  value on the other side. VibORM's own cache stores the canonical text, so
  nothing internal is affected.
- **No `@types/*` package.** The declarations are VibORM's own and ship with
  it, so `dependencies` carries no type-only package.

There is no compatibility shim, and a decimal.js instance is not accepted as
input. Convert one at the boundary:

```ts
import { Decimal } from "viborm";

const converted = new Decimal(oldDecimalJsValue.toFixed());
```

Use `toFixed()` with no argument rather than `toString()`: it is decimal.js's
complete value in plain notation, so it cannot hand the new constructor an
exponent form shaped by the old constructor's `toExpNeg`/`toExpPos`, which the
accepted grammar refuses.

## 0.1.0 - 2026-01-24

- Published the initial development package.
