# Pre-V1 upstream defect closure — disposition ledger

Companion record to the
[full-year source audit](../research/upstream-orm-fixed-issues-2025-08-29-to-2026-08-29.md).
That audit owns the upstream population, normalization, source evidence, and
the original current-checkout verdicts at `237c5352`. This closure owns the
later re-audit, implementation dispositions, and validation evidence; it does
not rewrite the source census. It re-audited every candidate against branch
`by-v1-upstream-defect-closure` at `fdd69ce8` (post GeoPoint merge) on
2026-08-30 and implemented the fixes on that branch.

Every source-audit candidate was re-proven with a standalone public-contract
falsifier (`bun` scripts driving the public client/migration surfaces) before
any code changed. All 11 candidates were live on current bytes; none had been
fixed incidentally by the migration V1, namespace, decimal, relation-language,
extension, or GeoPoint programs. The later [issue #34](https://github.com/beynar/viborm/issues/34)
was reproduced and fixed locally through the same red-capable review loop.

## Dispositions

| # | Defect | Audit verdict on `fdd69ce8` | Resolution |
|---|---|---|---|
| 1 | Bun SQL PostgreSQL JSON/JSONB double encoding | LIVE — physical `jsonb_typeof` was `string` for arrays/objects; write-return and fresh reads returned serialized strings. Root cause: the PG adapter binds canonical JSON text and relies on parameter-context casting, which Bun SQL alone violates by JSON-encoding the string a second time. | FIXED — `JsonParameter` carrier (`src/sql/json-parameter.ts`) bound by the PG adapter's two JSON sites; renders as canonical text for every stock PG transport by construction (`toString`), while Bun serializes the original value exactly once (`toJSON`). No driver changed. |
| 2 | Enum arrays serialized as scalar enums | LIVE on all three dialects — `serializer.ts` enum branch never consulted `array`; PG emitted a bare enum, MySQL scalar `ENUM(...)`, SQLite scalar `TEXT CHECK`. PG value lowering also failed (22P02) even with corrected DDL. Known-bug skip existed at `tests/contracts/public-client/all-field-types.core.test.ts`. | FIXED — serializer decides the list representation before enum identity: PG registers the enum and emits `name[]`; MySQL/SQLite/libsql fall through to the JSON list container. A MySQL or SQLite scalar native declaration can no longer pre-empt that container, including for enum and native DateTime lists. Runtime crossing uses the adapter-owned `arrays.enumValue`. Known-bug skip removed; push-twice is a no-op on all three dialects. |
| 3 | Composite stored references not normalized to target-key order | LIVE (narrowed) — `addressesTargetKey` matched order-insensitively and `members` published in declared order; MySQL apply failed midway (errno 6125) on permuted declarations. The report's "query vs migration consumers disagree" clause was DISPROVEN: pairing was consistent everywhere; the live harm was invalid MySQL DDL from an accepted declaration. | FIXED — `model/keys.ts` now publishes the one ordered `referenceableKeys` catalog: addressable keys plus predicate-free unique indexes. `findReferenceableKey` supplies the target tuple order to both FK validation and relation uniqueness derivation; `checkStoredReference` publishes member pairs in that order. Model key members are captured once before validation, and index fields/options are detached from caller mutation before either serialization or catalog caching. Repeated members are refused at relation/model declaration boundaries. A compound selector name can identify only one tuple: derived underscore-name collisions and explicit cross-ID/unique collisions are refused at declaration, while distinct explicit names preserve both tuples. A retained MySQL2 provider contract covers apply, nested write, and second-push convergence. |
| 4 | Idle node-postgres Pool error escapes | LIVE — owned lazy `pg.Pool` had zero `'error'` listeners; the idle emission escaped as `uncaughtException`. Supplied pools correctly untouched. | FIXED — each owned pool has one exact listener and generation-owned retained failure state; supplied pools remain borrowed and untouched. The listener is removed only after `end()` succeeds. A failed disconnect quarantines the same pool and listener for a public cleanup retry, refuses connect and query work until that retry succeeds, and carries the retained idle failure beside its public primary. No replacement pool is created while cleanup is unresolved. Successful and failed pool queries, explicit acquisitions, concurrent generations, and both late max-wait outcomes settle only the failure generation they observed, so healed or already-reported evidence cannot contaminate later work. |
| 5 | Nested statement failures attributed to root model | LIVE — nested child unique violation reported correct table/constraint/code but `meta.model` named the root. Driver layer already honored `statement.context`; only query-engine compilation never supplied one. | FIXED — optional `model` on `StatementStepBase`, stamped by the record compilers, relation Parts, and grouped polymorphic target probes; the executor derives a per-statement execution context (`deriveStatementExecutionContext`) preserving correlation/instrumentation provenance. The PG CTE tree fold deliberately keeps operation attribution because it is one merged statement. Native D1/Neon rejection attribution is exact when the provider request contains one statement; an opaque rejection covering several statements keeps batch attribution rather than guessing. |
| 6 | PostgreSQL SQLSTATE 23001 not a ForeignKeyError | LIVE — 23001 with full FK metadata normalized to generic `QueryError` V2001; only `23503` was recognized. | FIXED — `POSTGRES_RESTRICT_VIOLATION = "23001"` recognized in the single PG foreign-key arm; metadata already flowed. |
| 7 | Extended SQLite BUSY/LOCKED families not retryable | LIVE for code/errno shapes (better-sqlite3/bun:sqlite/numeric); message-embedded shapes (libsql/D1) already matched by accident via substring. Extended symbolic codes were additionally STRIPPED from `meta.providerCode` by the diagnostic allowlist. | FIXED — exact base names or uppercase/digit underscore-delimited symbolic family members plus numeric base-code bits (`(n & 0xff) === 5 || 6`), all gated on `dialect === "sqlite"` (threaded from driver-instrumentation and driver-transaction-base). Lookalikes, token-prefix matches, and cross-dialect symbols stay non-retryable; known extended names remain in the stable provider-code allowlist. |
| 8 | Cross-realm Date/Uint8Array rejected | LIVE — genuine foreign-realm values failed solely on local `instanceof`; both spoof directions correctly refused (and must remain so). | FIXED — shared guards prove the native internal slots across realms. Date consumers then use `Date.prototype` intrinsics, never caller-overridable instance methods. Blob admission reads intrinsic metadata through `%TypedArray%.prototype` and re-views foreign-realm, subclassed, caller-owned custom-prototype, or own-shadowed values. Exact unshadowed local `Uint8Array` and captured local Buffer prototypes are a trusted runtime boundary and preserve identity; proxies, detached buffers, and tag spoofs become normal validation issues. |
| 9 | Invalid raw Date reaches provider dispatch | LIVE — all four raw forms passed `new Date(NaN)` through; PGlite failed post-dispatch as generic V2001, bun:sqlite silently bound NULL. Typed path already refused pre-dispatch. | FIXED — raw admission refuses invalid Dates in every call shape. Provider-parameter finalization then revalidates Date leaves after the last applicable query or statement transform and before provider dispatch on direct, driver fallback-batch, and native-batch execution. It snapshots every admitted data-descriptor ordinary array/record as one stable own-descriptor graph, preserving provider-visible aliases, cycles, sparse arrays, and descriptors while normalizing foreign built-in prototypes to local ones. Classification does not invoke accessors, iterators, or `toJSON`; Proxy reflection traps may present the captured view, but the later Proxy cannot change it. Arrays with custom inherited behavior, indexed accessors, or custom `toJSON` are refused because those semantics could hide an invalid Date from provider traversal. Provider-native values and custom/accessor/`toJSON` record carriers remain opaque, so VibORM deliberately does not interpret nested values behind that provider-owned boundary. Driver fallback batches detach admitted public parameter graphs and private prepared-`Sql` provenance before entering the transaction queue. |
| Y1 | SQLite INTEGER/REAL native DateTime | LIVE — declaration is public (`s.dateTime(SQLITE.DATETIME.INTEGER/REAL)`) and honored only by DDL; runtime lowering always wrote ISO text, decoding refused native values (V9001), equality missed. | FIXED — `datetime-values` owns the one logical domain: a real proleptic-Gregorian date, hour `00`–`23`, minute/second `00`–`59`, offset through `±23:59`, and represented UTC instant in the inclusive range `0000-01-01T00:00:00.000Z`–`9999-12-31T23:59:59.999Z`. ISO validation, result parsing, and `datetime-physical-codec` consume it. The codec owns text/epoch-millis/Julian-day crossing; every admitted millisecond is writable as REAL and Julian decoding rounds back to that millisecond. Schema validation, SQLite query/result lowering, migration defaults, and stored-reference compatibility share the scalar-native interpretation; raw remains physical. Authenticated snapshots carry the declaration: V1 diffs it, while live push omits declaration comparison because introspection cannot recover it and instead validates unmarked TEXT/INTEGER/REAL candidate rows during recreation, including same-form adoption. The SQLite migration SQL mirrors the public grammar, imports the exact shared bounds, and guards all six directed form changes. LibSQL bypasses native `ALTER COLUMN` for those conversions; D1 preflight refuses a relation-bearing recreation before rendering. An authenticated fixed-decimal INTEGER is not an epoch-millisecond candidate. Malformed, out-of-domain, or inexact stored rows abort atomically. Scalar native declarations on lists retain the JSON container, and cursor coverage binds a public `Date` through a unique INTEGER DateTime field. |
| Y2 | Empty-update upsert on existing row fails | LIVE on every reachable path (targeted and probe, transaction and batch, PGlite/SQLite/MySQL) — `compileUpdateArm` handed empty data to the SET builder. Contrast fact: ordinary `update({ data: {} })` was already a valid no-op read; only the upsert found arm was broken. | FIXED — `compileUpdateArm` branches on "this shell spells no inline scalar UPDATE" (`updateCompiler || empty data`), reusing the existing no-write found-arm body; missing-row create, non-empty upsert, ordinary update, and `buildSet` byte-identical. |
| GH-34 | Blank manual migration dispatches | LIVE on SQLite3 and PGlite — `up: []` published a zero-operation state, while whitespace-only `Sql` became an opaque provider dispatch. SQLite3 rejected that dispatch during apply and PGlite accepted it, so identical migration intent had provider-dependent state semantics. | FIXED — `compileManualOperations` is the single manual-program invariant owner. Forward and manual rollback programs require at least one dispatch; every dialect-rendered dispatch requires non-whitespace text before estate publication. Accepted SQL remains byte-exact, opaque, parameterized, and unsplit. Public SQLite3/PGlite tests prove rejection before provider execution or any estate write; compiler tests prove rollback symmetry and exact valid dispatch preservation. |

## Brief-vs-bytes corrections established during audit

- Ordinary empty `update` is a valid no-op read on current bytes; the Y2 fix
  therefore leaves ordinary update and the shared SET builder byte-identical
  rather than "keeping them invalid".
- Candidate 3's cross-consumer pairing disagreement does not exist on current
  bytes; normalization at the resolution owner fixes the one real harm
  (unsatisfiable MySQL DDL) while preserving working PG/SQLite schemas.

## Adversarial review round

Two independent review passes ran over the complete diff after implementation —
a correctness/trust-boundary skeptic and an ELEGANCE.md ownership skeptic, both
verifying every claim on current bytes with standalone probes. Fifteen findings
survived verification; fourteen were fixed in the same round:

- a foreign detached-buffer `Uint8Array` now returns a validation issue instead
  of a thrown TypeError escaping the Standard Schema surface;
- the pg driver's retained background pool failure is cleared by a successful
  acquisition, so a healed transport never explains a later unrelated failure;
- the PostgreSQL array-text enum-list reading is gated on an adapter-declared
  `enumListRepresentation`, so JSON dialects keep the malformed-row refusal
  every other list type has;
- `$transaction([...])` shared batches derive the same per-statement execution
  context as standalone execution, so provider failures name the same model on
  every route (engine-owned guards/postconditions keep operation attribution on
  both — documented in ATOM.md);
- the SQLite adapter's duplicate DateTime refusal was deleted because the
  physical codec makes REAL/Julian crossing total to the millisecond across the
  public domain (one guard per invariant); an unreachable bigint re-check in
  the decode was likewise removed;
- the automatic foreign-key index NAME got one owner
  (`automaticForeignKeyIndexName` in `src/schema/relation/helpers.ts`),
  consumed by both the serializer (emit) and the variant-storage reservation
  (refuse), deleting a keep-synchronized clause;
- `JsonParameter` stores one fact (the canonical text); `toJSON` derives from
  it, so post-bind mutation of the original value cannot diverge the two
  binding protocols; the stale postgres.js `json` override comment was
  restated;
- every `hasEvery`/`hasSome` candidate reuses the same whole-list storage
  crossing as assignment; the two JSON adapters express
  `arrays.enumValue === arrays.value` by identity;
- `dialect` now reaches all seven `normalizeDriverError` construction sites;
- two belt-and-suspenders test assertions were deleted; the shared-guard docs
  gained the admission-boundary clause that makes interior `instanceof` sites
  correct by rule.

The fifteenth finding is recorded below as an adjacent defect rather than
fixed: it predates this closure and needs a product decision.

A final merge-readiness pass then closed the defects the first pass had not
tested deeply enough:

- PostgreSQL list `push`/`unshift` now crosses as one complete provider-encoded
  container. This deletes the per-member SQL tree, avoids the bind ceiling, and
  reuses the existing ordinary/enum/decimal list-value owner.
- incompatible SQLite DateTime FK domains now fail at their definition
  boundary, while physical SQL defaults use the declared form and every
  admitted REAL instant remains writable;
- repeated relation, ID, unique, and index members are unrepresentable, while
  one ordered referenceable-key catalog replaces the two legality scans;
- hostile Date methods, raw-interceptor mutation, and detached foreign bytes
  are handled by their admission/dispatch owners;
- grouped polymorphic probes carry the target model, and D1/Neon use statement
  attribution only when cardinality or an authenticated context proves it;
- SQLite retry classification is both dialect-gated and token-exact;
- a pg acquisition failure remains primary. The earlier idle-pool event is
  retained through the one general suppressed-failure owner, which also
  subsumes the former cleanup-only record.

An independent repair review then challenged the new trust boundaries rather
than repeating their happy paths. It closed these additional gaps:

- provider Date snapshots now happen after the last applicable statement
  transform and before provider dispatch on direct, driver fallback-batch, and
  native-batch routes; driver fallback batches remain safe across the later
  queue wait because both public parameters and private prepared-`Sql`
  provenance are detached;
- every admitted data-descriptor ordinary raw array/record is now one stable
  descriptor snapshot, so a Proxy cannot present one view during finalization
  and another to the provider; admitted foreign containers normalize to local
  built-in prototypes, arrays with inherited/accessor serialization behavior
  are refused, and provider-owned record carriers remain explicitly opaque;
- raw array capture and finalization use indexed own elements, so a poisoned
  iterator or `map` cannot hide a Date or replace a sparse list;
- blob admission proves local as well as foreign typed-array slots, reads
  metadata through `%TypedArray%.prototype`, and re-views foreign-realm,
  subclassed, caller-owned custom-prototype, or own-shadowed values before any
  driver can read them; exact unshadowed local `Uint8Array` and captured local
  Buffer prototypes keep their trusted identity;
- model key tuples are captured once before duplicate/existence/name logic, and
  stored index options no longer remain caller-owned beside a cached catalog;
- node-postgres retained failures are owned by pool and generation; failed
  disconnect, failed/successful ordinary queries, concurrent acquisitions, and
  both late max-wait outcomes each have an explicit one-settlement contract;
- MySQL/SQLite list containers win over scalar native declarations, and the
  SQLite native DateTime cursor witness now binds a `Date` through the public
  API rather than locating the row by an unrelated string ID.
- PostgreSQL containment candidates now cross as one complete provider list,
  so non-text arrays no longer become an incompatible `text[]`; DateTime list
  membership also stays in the stored ISO vocabulary on JSON dialects.
- stored-reference validation now compares scalar/list shape before any
  SQLite DateTime member-native form. DateTime lists therefore share the one
  list-container domain, while a list can never reference a scalar;
- every TypeScript assertion introduced by this branch was removed. Typed
  fixtures and natural inference now express the same contracts without
  bypassing the type system.

## Adjacent findings (out of scope, recorded, not fixed here)

- `s.date()` / `s.time()` accept the SQLite `DATETIME.INTEGER`/`REAL` native
  types and still write ISO text into the numeric column — the same defect
  shape Y1 closed for `s.dateTime()`, now the only surviving instance. Needs a
  decision: extend the physical codec seam to date/time, or refuse the
  declaration.
- With opted-in `includeParams` diagnostics, a PostgreSQL JSON parameter now
  discloses as `{ json: "<canonical text>" }` instead of a bare string — the
  carrier keeps the document visible by design; shape, not content, changed.
- The `layer:client` gate's tsc leg exceeds its 1280 MB heap cap on clean
  `fdd69ce8` (pre-existing red; the full 4 GB type-check is green, and the
  layer's vitest leg passes).
- Native D1 and Neon calls expose no statement index on an undifferentiated
  multi-statement rejection. A one-statement provider request is attributable
  by cardinality and now uses that statement's context and index; a rejection
  spanning several statements deliberately remains at batch scope. Preparation
  failures and provider errors already carrying one unique execution context
  keep their exact statement attribution.
- The docker MySQL2 provider leg fails 156 tests on CLEAN `fdd69ce8` (family
  pushes end in "final live fingerprint does not match", plus errno 1170 and
  namespace-containment residue) — verified identical from a HEAD worktree
  against a freshly reset database. The docker legs are not part of
  `test:all`, so this drift also predates and survives the closure.
- Two extended-local architecture censuses are red on CLEAN `fdd69ce8`
  (verified: scanned files and census contracts byte-identical to HEAD): the
  database-namespace census's admitted live-execution-owner list omits
  `_executeRaw` sites the migration V1 merge added (`apply-v1.ts`,
  `operators.ts`, and extra sites in `push-plan.ts`/`reset-v1.ts`), and the
  decimal census counts one `Number(` in
  `src/migrations/drivers/mysql/introspect.ts`. They run only under
  `test:all`'s extended-local leg, so the drift predated and survives this
  closure unnoticed by the layer gates.

- bun:sqlite silently binds even VALID `Date` raw parameters as NULL (Bun's own
  binder; reproduced outside VibORM). Raw Date type portability across SQLite
  providers is inconsistent beyond the invalid-Date invariant closed here.
- `isRetryableError`'s raw fallback list in `src/errors/base.ts` is a second,
  pre-normalization provider-code reader. Left untouched; growing it would
  duplicate the one normalization owner.
- Neon HTTP bytea (report row "Drizzle rc.1") remains UNVERIFIED: hosted Neon
  transport was unavailable to the audit and no substitute provider is treated
  as equivalent.

## Validation

The initial closure implementation ran the following ladder on 2026-08-30,
sequentially under the workspace lock:

- All 21 standalone public-contract falsifiers rerun green by the orchestrator
  (PGlite, bun:sqlite, docker PostgreSQL 5434, docker MySQL 3307, Bun SQL),
  after having been proven red on the pre-fix bytes.
- `pnpm test:types` green (full estate).
- Repository-pinned Biome clean on all 71 touched TypeScript files.
- `git diff --check` clean.
- Layer gates green: validation, scalars, schema-json, schema-validation,
  adapters, drivers, query-engine, migrations; client's vitest leg green (its
  tsc leg OOMs at the 1280 MB cap on clean HEAD too — pre-existing).
- `pnpm test:package` green (tsdown build + every declared export).
- `pnpm test` core leg green (357 files); extended-local green except the two
  architecture censuses proven red on clean `fdd69ce8` (above).
- Credential-free provider legs green: provider-pglite, provider-sqlite3,
  provider-libsql, provider-bun, provider-d1.
- Credentialed provider legs: provider-bun with docker PostgreSQL green
  (includes the new Bun SQL JSON round-trip contract on the real transport);
  provider-neon-http/planetscale skip visibly (no hosted credentials — the
  report's Neon HTTP bytea row therefore stays UNVERIFIED); docker
  provider-mysql2 fails 156 tests IDENTICALLY on clean `fdd69ce8` (this branch
  passes 10 more: the new pins) — pre-existing main drift, verified from a
  HEAD worktree against the same freshly reset database; docker
  provider-pg/provider-postgres fail only the GeoPoint block because this
  machine's PG 16 container has no PostGIS packages
  (`pg_available_extensions` has no postgis row), an environmental gap that
  predates this closure.

A pre-late-repair checkpoint ran 796 focused tests and the affected layer
gates: validation 812, relations 101, schema JSON 366, schema validation 385,
adapters 114, query engine 1,493, drivers 752, migrations 1,211, and the client
runtime leg 658. At that checkpoint, the full 4 GB `test:types` gate passed,
repository-pinned Biome checked 59 changed TypeScript files, and
`git diff --check` passed. The client layer's concurrent 1,280 MB tsc leg still
OOMed: a detached clean-HEAD measurement used 1,910,799 KB, while that repaired
tree used 1,886,058 KB, so the repair reduced rather than caused that existing
budget breach. Late-repair public-client evidence executed on PGlite and
SQLite. MySQL evidence at that checkpoint was structural: rendered SQL,
parameters, and DDL. The exact retained MySQL composite-reference provider test
was selected but skipped because `MYSQL_TEST_CONNECTION_STRING` was absent.

The final-byte adversarial review closed three further boundary defects before
acceptance: a caller-owned prebuilt `Sql` could change while an asynchronous
query interceptor was waiting before `proceed()`; the optional
`suppressedFailures` debugger mirror could overwrite a caller-owned property;
and SQLite TEXT DateTime conversion could read the first offset digit as the
third millisecond digit for a one-digit fraction. Operation resolution now owns
one flat `Sql` projection, the mirror yields to any existing own property, and
the SQLite parser consumes the third fraction digit only after proving the
second. Executed regressions cover the asynchronous race, planted error state,
and both `.7+12:00` and `.7-12:00` migration spellings.

The final 2026-08-30 measurements are:

- `pnpm test:types` green after the final patches.
- `pnpm test` green on the final pre-commit bytes: 362 files and 8,541 tests.
- Issue #34 first failed 2/2 public regressions on the unfixed compiler. Its
  final focused matrix is 12/12, the six related migration files are 69/69,
  and `pnpm test:layer:migrations` is green at 60 files and 1,251 tests. The
  full type gate was rerun on the final bytes; repository-pinned Biome accepts
  both issue-specific TypeScript files, and `git diff --check` is green.
- Client runtime layer green: 41 files, 683 tests. The late query-interceptor
  file is 48/48; the suppressed-failure and supplied-pool files are 70/70; the
  SQLite DateTime recreation file is 17/17; and the late validation files are
  81/81.
- `pnpm test:coverage:validation` executes all 108 files and 3,183 tests green.
  Every branch-introduced validation file is at 100%. The command remains red
  only at its absolute threshold (99.91% statements/lines, 99.73% branches)
  because `decimal-codec.ts:926` and the exhaustive defaults at
  `validation/scalars/decimal.ts:442-444,526-528` are byte-identical to clean
  main, as are their owning tests and coverage configuration. The first is an
  untested baseline text-materialization arm; the defaults are structurally
  unreachable after exact operation admission. No artificial witness was
  added for dead exhaustiveness code.
- `pnpm test:package` green on the final bytes: build plus 6/6 package
  contracts.
- Credential-free providers green: PGlite 857 passed/1 skipped, SQLite3 1,244
  passed/1 skipped, LibSQL 9 passed/1,152 capability skips, Bun 2 passed/2
  credentialed PostgreSQL skips, and D1 32/32.
- Repository-pinned Biome green on all 92 active changed or untracked
  TypeScript files;
  `git diff --check` green.

- Stale infrastructure found and cleared during the runs: leftover
  `_viborm_migration_state`/`_viborm_migration_log` tables in the shared
  docker MySQL `viborm` database and in `viborm_ns_beta` (from an interrupted
  earlier run), plus a connection-exhaustion storm (errno 1040) they caused;
  the `viborm` MySQL database was dropped and recreated empty.
