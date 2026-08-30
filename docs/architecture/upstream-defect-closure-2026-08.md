# Pre-V1 upstream defect closure — disposition ledger

Companion record to
[docs/research/upstream-orm-fixed-issues-2025-08-29-to-2026-08-29.md](../research/upstream-orm-fixed-issues-2025-08-29-to-2026-08-29.md)
(the research evidence, which this record does not rewrite). The report's
current-surface verification ran at checkout `237c5352`; this closure re-audited
every candidate against branch `by-v1-upstream-defect-closure` at `fdd69ce8`
(post GeoPoint merge) on 2026-08-30 and implemented the fixes on that branch.

Every candidate was re-proven with a standalone public-contract falsifier
(`bun` scripts driving the public client/migration surfaces) before any code
changed. All 11 candidates were live on current bytes; none had been fixed
incidentally by the migration V1, namespace, decimal, relation-language,
extension, or GeoPoint programs.

## Dispositions

| # | Defect | Audit verdict on `fdd69ce8` | Resolution |
|---|---|---|---|
| 1 | Bun SQL PostgreSQL JSON/JSONB double encoding | LIVE — physical `jsonb_typeof` was `string` for arrays/objects; write-return and fresh reads returned serialized strings. Root cause: the PG adapter binds canonical JSON text and relies on parameter-context casting, which Bun SQL alone violates by JSON-encoding the string a second time. | FIXED — `JsonParameter` carrier (`src/sql/json-parameter.ts`) bound by the PG adapter's two JSON sites; renders as canonical text for every stock PG transport by construction (`toString`), while Bun serializes the original value exactly once (`toJSON`). No driver changed. |
| 2 | Enum arrays serialized as scalar enums | LIVE on all three dialects — `serializer.ts` enum branch never consulted `array`; PG emitted a bare enum, MySQL scalar `ENUM(...)`, SQLite scalar `TEXT CHECK`. PG value lowering also failed (22P02) even with corrected DDL. Known-bug skip existed at `tests/contracts/public-client/all-field-types.core.test.ts`. | FIXED — serializer decides the list representation before enum identity: PG registers the enum and emits `name[]`; MySQL/SQLite/libsql fall through to the JSON list container. Runtime crossing via the adapter-owned `arrays.enumValue` (one untyped array-literal parameter; no runtime enum namer). Known-bug skip removed; push-twice is a no-op on all three dialects. |
| 3 | Composite stored references not normalized to target-key order | LIVE (narrowed) — `addressesTargetKey` matched order-insensitively and `members` published in declared order; MySQL apply failed midway (errno 6125) on permuted declarations. The report's "query vs migration consumers disagree" clause was DISPROVEN: pairing was consistent everywhere; the live harm was invalid MySQL DDL from an accepted declaration. | FIXED — `matchTargetKey` returns the matched key's ordered tuple (exact-order match first, then first set-match in catalog order); `checkStoredReference` publishes members reordered with pairs intact; `storedReferences.fields` follows the normalized order. MySQL permuted-declaration apply now completes; declared-order schemas byte-identical. |
| 4 | Idle node-postgres Pool error escapes | LIVE — owned lazy `pg.Pool` had zero `'error'` listeners; the idle emission escaped as `uncaughtException`. Supplied pools correctly untouched. | FIXED — one driver-owned `error` listener on the owned pool only (attached at construction, detached after `end()`); failure retained and surfaced as the cause of the next acquisition failure through `normalizeDriverConnectionError`. Supplied pools stay borrowed and untouched. |
| 5 | Nested statement failures attributed to root model | LIVE — nested child unique violation reported correct table/constraint/code but `meta.model` named the root. Driver layer already honored `statement.context`; only query-engine compilation never supplied one. | FIXED — optional `model` on `StatementStepBase`, stamped by the record compilers and relation Parts; the executor derives a per-statement execution context (`deriveStatementExecutionContext`) preserving correlation/instrumentation provenance. Zero driver changes. Deliberate residuals: the PG CTE tree fold keeps operation attribution (one merged statement, pinned), and native-batch `executeBatch` overrides still attribute to the batch context. |
| 6 | PostgreSQL SQLSTATE 23001 not a ForeignKeyError | LIVE — 23001 with full FK metadata normalized to generic `QueryError` V2001; only `23503` was recognized. | FIXED — `POSTGRES_RESTRICT_VIOLATION = "23001"` recognized in the single PG foreign-key arm; metadata already flowed. |
| 7 | Extended SQLite BUSY/LOCKED families not retryable | LIVE for code/errno shapes (better-sqlite3/bun:sqlite/numeric); message-embedded shapes (libsql/D1) already matched by accident via substring. Extended symbolic codes were additionally STRIPPED from `meta.providerCode` by the diagnostic allowlist. | FIXED — `SQLITE_BUSY*`/`SQLITE_LOCKED*` prefix recognition plus numeric base-code bits (`(n & 0xff) === 5 || 6`) gated on the context `dialect === "sqlite"` (threaded from driver-instrumentation and driver-transaction-base); extended names added to the stable provider-code allowlist so `meta.providerCode` survives. |
| 8 | Cross-realm Date/Uint8Array rejected | LIVE — genuine foreign-realm values failed solely on local `instanceof`; both spoof directions correctly refused (and must remain so). | FIXED — `isDate` falls back to the `[[DateValue]]` brand, new shared `isUint8Array` reads the `%TypedArray%` tag accessor; blob/date normalize foreign-only values to local views/Dates so downstream `instanceof` sites stay valid; spoofs still refused; `default-codec` consumes the shared guards. |
| 9 | Invalid raw Date reaches provider dispatch | LIVE — all four raw forms passed `new Date(NaN)` through; PGlite failed post-dispatch as generic V2001, bun:sqlite silently bound NULL. Typed path already refused pre-dispatch. | FIXED — one `refuseInvalidDateParameters` at `DeferredRawOperation` resolution (all four raw forms, fragment values, verbatim params, one array level), raising the raw family's `QueryError` V4002 before any dispatch. Valid Dates keep identity. |
| Y1 | SQLite INTEGER/REAL native DateTime | LIVE — declaration is public (`s.dateTime(SQLITE.DATETIME.INTEGER/REAL)`) and honored only by DDL; runtime lowering always wrote ISO text, decoding refused native values (V9001), equality missed. | FIXED — `datetime-physical-codec` owns text/epoch-millis/Julian-day encode+decode with one range/finiteness predicate; SQLite adapter alone reads the declared native form (`literals.dateTime(iso, nativeType?)` + `result.dateTimeRepresentation`, mirroring the decimal seam); create/update/filter/cursor/default lowering and result decoding agree; raw stays physical. |
| Y2 | Empty-update upsert on existing row fails | LIVE on every reachable path (targeted and probe, transaction and batch, PGlite/SQLite/MySQL) — `compileUpdateArm` handed empty data to the SET builder. Contrast fact: ordinary `update({ data: {} })` was already a valid no-op read; only the upsert found arm was broken. | FIXED — `compileUpdateArm` branches on "this shell spells no inline scalar UPDATE" (`updateCompiler || empty data`), reusing the existing no-write found-arm body; missing-row create, non-empty upsert, ordinary update, and `buildSet` byte-identical. |

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
- `encodePhysicalDateTime` became total for its validated-ISO precondition and
  the SQLite adapter's duplicate refusal was deleted (one guard per invariant);
  an unreachable bigint re-check in the decode was likewise removed;
- the automatic foreign-key index NAME got one owner
  (`automaticForeignKeyIndexName` in `src/schema/relation/helpers.ts`),
  consumed by both the serializer (emit) and the variant-storage reservation
  (refuse), deleting a keep-synchronized clause;
- `JsonParameter` stores one fact (the canonical text); `toJSON` derives from
  it, so post-bind mutation of the original value cannot diverge the two
  binding protocols; the stale postgres.js `json` override comment was
  restated;
- `containmentCandidate`'s whole-list question is answered once by
  `listCandidateCrossesWhole`, owned beside the whole-list crossing; the two
  JSON adapters express `arrays.enumValue === arrays.value` by identity;
- `dialect` now reaches all seven `normalizeDriverError` construction sites;
- two belt-and-suspenders test assertions were deleted; the shared-guard docs
  gained the admission-boundary clause that makes interior `instanceof` sites
  correct by rule.

The fifteenth finding is recorded below as an adjacent defect rather than
fixed: it predates this closure and needs a product decision.

## Adjacent findings (out of scope, recorded, not fixed here)

- `s.date()` / `s.time()` accept the SQLite `DATETIME.INTEGER`/`REAL` native
  types and still write ISO text into the numeric column — the same defect
  shape Y1 closed for `s.dateTime()`, now the only surviving instance. Needs a
  decision: extend the physical codec seam to date/time, or refuse the
  declaration.
- PGlite/PostgreSQL `hasEvery`/`hasSome` fail with 42883 for any list whose
  members are not text (`integer[] && text[]`) — pre-existing, reproduced with
  no VibORM in the path; enum lists now route around it via the whole-list
  crossing, every other type is byte-identical to before.
- With opted-in `includeParams` diagnostics, a PostgreSQL JSON parameter now
  discloses as `{ json: "<canonical text>" }` instead of a bare string — the
  carrier keeps the document visible by design; shape, not content, changed.
- The `layer:client` gate's tsc leg exceeds its 1280 MB heap cap on clean
  `fdd69ce8` (pre-existing red; the full 4 GB type-check is green, and the
  layer's vitest leg passes).
- Native-batch `executeBatch` overrides (D1, libsql) still normalize a raw
  provider failure once against the batch context, so nested attribution does
  not flow there; the sequential fallback and every other route do. Closing it
  needs a driver-side statement-index→context path.
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

Run on 2026-08-30 against the closure worktree, sequentially (workspace lock):

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
- Stale infrastructure found and cleared during the runs: leftover
  `_viborm_migration_state`/`_viborm_migration_log` tables in the shared
  docker MySQL `viborm` database and in `viborm_ns_beta` (from an interrupted
  earlier run), plus a connection-exhaustion storm (errno 1040) they caused;
  the `viborm` MySQL database was dropped and recreated empty.
