# Driver and transaction remediation

Status: driver implementation complete for assigned bounded fixes; integrated
qualification and release decisions remain with root. Scalar runtime follow-through is verified as recorded below; latest vector
dimension and public type/declaration changes await integration under source freeze. Original review
identity: `a4a5b8dc6`. Work continues only in the managed V1 worktree. The original
checkout and its dirty files are preserved.

## Implemented owners

- C1 (`drivers-03`, `production-ops-01`): postgres.js receives its original URL,
  percent decoding and TLS stay with the provider, URL connection keys outrank
  conflicting options. MySQL URL credentials/database are percent-decoded and
  query options retained; unsupported TLS-looking options refuse construction.
  URL result-shape overrides are validated at construction. Bun SQL combines URL
  and non-URL options in its provider configuration.
- C3 (`transactions-01`, `transactions-08`, `drivers-05`, `production-ops-08`):
  base work queues behind active connection transactions. Reentrancy alone
  refuses, using a lazily loaded async scope. Wrappers of one supplied SQLite,
  Bun SQLite, PGlite or local libSQL handle share a weakly keyed physical queue.
- C4 (`transactions-02`, `PB-1`): ordinary provider failures do not poison the
  driver. Successful SQLite rollback retains the database, including memory
  databases. Provider-owned transaction failures do not end shared pools or
  close PGlite. Successful disconnect clears genuinely retained cleanup poison.
- C5 (`drivers-01`, `drivers-02`, `drivers-07`, `production-ops-02`,
  `differential-05`, `driver-conformance-06`, `PB-3/4/8`): pg and PGlite use
  per-query temporal text parsers; mysql2 typed commands use per-command text
  decoding, also on borrowed pools. Supplied postgres.js transports must use
  the exported `vibormTypes` temporal parser setup and are refused otherwise.
  Every libSQL transaction uses its real `transaction("write")` owner; caller
  clients are retained by identity and never closed. A read-only integer probe
  refuses supplied libSQL number mode before a typed write can commit.
  Supplied SQLite/Bun SQLite FK enforcement is checked without changing it.
- H2 (`drivers-04`, `edge-bundle-02/07`): Neon 1.2 string queries and batch
  queries use `.query`; libSQL 0.18 uses dedicated transaction handles for
  memory and remote clients. PlanetScale 2 decision remains with root: SDK 2
  removed parameter-array formatting, so compatibility cannot be claimed yet.
- H3 (`driver-conformance-01`, `errors-03/04`): Bun string `errno` SQLSTATE
  maps to the correct constraint/transaction class. Network errors map to
  ConnectionError; PostgreSQL cancellation and MySQL lock-wait timeout map to
  retryable QueryError V2002, distinct from deadlock.
- H4 (`drivers-06`, `driver-conformance-05`, `write-api-01/06`,
  `production-ops-05/07`): provider bind caps corrected: SQLite 32,766, PGlite
  32,767, postgres.js 65,533. D1 remains 100. Array-binding/query admission
  improvements belong to the engine owner.
- H11 (`transactions-03`, `write-api-05`, `production-ops-17`): SQLite/Bun
  SQLite transactions use BEGIN IMMEDIATE. Owned handles have busy_timeout
  5000. Modern libSQL transactions already use the provider's write mode.
- H12 (`driver-conformance-02/03/04`): D1 bigint parameters cross the provider
  as decimal text; adapter CAST/projection work belongs to the engine owner.
  postgres.js validated list parameters use escaped PostgreSQL array text.
  SQLite-family raw Date values use ISO timestamp text. D1 session bindings
  are accepted in the public driver option type.
- H21: pg, PGlite and Neon keep temporal scalar/array OIDs as text; postgres.js
  uses textual temporal parsing. Named-zone/BC/array decoding belongs to the
  query owner.
- `transactions-05`: a user error after a caught operation failure retains its
  identity instead of being replaced by an aggregate with the stale failure.
- `transactions-12`: Neon batch isolation levels are forwarded to the provider.
- `production-ops-06`: mysql2 typed statements use text protocol, avoiding its
  per-IN-size server prepared-statement cache growth.

## Added evidence

`tests/contracts/drivers/v1-transport-remediation.core.test.ts` owns URL
credentials/TLS, safe borrowed postgres admission, Bun SQLSTATE, connection and
lock timeout classification, and raw SQLite Date encoding.

`tests/providers/local/sqlite3-v1-driver-remediation.test.ts` owns a two-wrapper
rollback witness, actual reentrancy, queued maxWait, failed COMMIT recovery,
foreign BEGIN ownership, modern libSQL rollback and supplied integer-mode refusal.

`tests/providers/hosted/neon-http-v1-remediation.test.ts` runs against
`NEON_DATABASE_URL` (or `NEON_TEST_DATABASE_URL`), tests real Neon HTTP plus pg
and postgres.js owned/supplied transports, exact decimals, timestamp years0000/0001/0099/9999,
boolean/bigint lists, atomic failed HTTP batches and commit notification order.
It creates one unique `public.viborm_v1_<uuid>` fixture per run, deletes its own
rows, retains the empty table and prints only its non-secret name. It executes
no DROP, TRUNCATE or destructive migration.

## Executed checks

Initial bounded focused selection of seven contracts:

```
node scripts/run-vitest-safe.mjs run --workspace vitest.workspace.ts --project=layer-drivers tests/contracts/drivers/error-mapping.core.test.ts tests/contracts/drivers/transaction-scheduler.core.test.ts tests/contracts/drivers/bind-parameter-capacity.core.test.ts tests/contracts/drivers/neon-http-transport-coverage.core.test.ts tests/contracts/drivers/supplied-pool-ownership.core.test.ts tests/contracts/drivers/sqlite-binary-values.core.test.ts tests/contracts/drivers/provider-result-contracts.core.test.ts --reporter=dot
```

- Error mapping: 53 tests passed.
- Supplied ownership: five postgres stand-ins lacked the newly required public
  parser configuration.
- Neon controlled transport: seven stand-ins used the obsolete call-only SDK
  shape. These stand-ins are being updated to the actual 1.2 `.query` API.
- Run terminated at the 1536 MiB sampled process-group RSS ceiling after 13.4s;
  teardown verified. This is incomplete evidence, not a passed gate. Subsequent
  heavy selections must use at most two provider-backed files per run.
- Global test slot yielded to root; no additional test/typecheck runner started
  until scheduling permission resumes.

## Qualification update (2026-10-08)

- Modern SDK/core boundary batch: **29/29 passed** (browser async-context
  absence, URL/TLS/credentials, Neon `.query` API and query-level type parsers,
  canonical driver failure union). Missing Neon URL is now a configuration
  error, not a transient connection error.
- Supplied ownership contracts: **56/56 passed**. Existing fake postgres clients
  now use the required temporal parser setup; borrowed handles remain open.
- Actual Neon HTTP plus pg/postgres owned and supplied: **6/6 passed**, 4.50s
  wall, sampled process-group RSS 503.4 MiB. The stock HTTP driver, not a
  capability-overriding subclass, proved failed-batch rollback, Serializable
  isolation forwarding, durable notification before result normalization,
  and acknowledgment after a provider response whose row count was then made
  invalid. Scalar and list dates through years 0001/0099/9999, bigint lists,
  booleans and exact decimal values passed west of UTC. Year 0000 awaits the
  PostgreSQL field-aware physical bind fix owned by the adapter/engine agents.
- Local driver batch initially **6/6 passed**. Added the actual PB-2 witness
  against two native libSQL clients; **7/8 passed**, with PB-2 still losing an
  acknowledged later write on SDK 0.18. The dependency upgrade alone is NOT
  a fix. The final bounded mitigation is implemented and verified (17/17 local/cache/
  postgres contracts):
  typed and raw BUSY quarantine the exact native client across VibORM wrappers. The existing
  disconnect owner closes an owned transport before reconnecting. It never
  closes a supplied client; that client's owner must close and replace it.
  Raw PRAGMA/VACUUM remain outside implicit batches.
- Browser PGlite/serialized transactions preserve use without `node:async_hooks`.
  The shared queue still orders unrelated work; reentry is bounded by a 5000ms
  default queue wait when async-context tracking is unavailable. Node/Bun
  supported async context detects reentry immediately. Timeout drains a nested
  callback's admitted statements and savepoint cleanup before releasing the
  physical connection; later stale work refuses.
- Prepared-statement reuse honors existing postgres `options.prepare: true`
  through the SDK's supported third query argument. False remains the default
  for pooler compatibility. SQLite's bounded 100-entry native statement cache
  now refreshes hits and evicts the least recently used statement.

The hosted suite retains these EMPTY fixture tables after DELETE of its own
rows (no DROP/TRUNCATE was authorized):

- `public.viborm_v1_d593b4d4648f423aaf4e42ba3ad04757`
- `public.viborm_v1_057f87b899d3465fbd2c5d8cfa46dc29`
- `public.viborm_v1_44593a26aff94ef7afa59d6ad8fb4baa`

Future removal requires explicit DROP confirmation for these exact names.
The first run exposed HTTP naive timestamp decoding because Neon 1.2 ignores
initialization-level `types`; every real query and batch member now passes
query-level text parsers. The second proved the capability through a temporary
candidate; the final run qualified the stock capability. Earlier failures remain
evidence, not hidden by the final passing run.

Driver production LOC at source freeze: 11,840 versus 11,481 at integrated
upstream (+359), and 11,743 at the original baseline (+97). Scalars are 3972
versus3932 (+40); schema JSON is4164 versus4150 (+14). The scalar figures
include root's temporal vocabulary changes in the shared tree. Driver new source
primarily owns physical-handle scope, borrowed setup, browser waits, nested
timeout drainage and native libSQL quarantine. Tests/docs are separate.


## Explicit disposition boundaries

`drivers-18/20/21/24`, `driver-conformance-08`, `production-ops-09/15` are
addressed by the public SQLite parser export and contract, executable supplied
postgres/pg setup, D1 session acceptance, corrected driver overview evidence,
and supported Neon TCP guidance. `drivers-12` authToken is supported; a new
WebSocket transport/client pass-through is not implemented. `drivers-14` now
has actual hosted Neon fidelity/batch evidence; this is not hosted Turso,
PlanetScale, Cloudflare D1 or a full server-version CI matrix.

Root owns release-level decisions for `drivers-08/09/10/11/13/15/16/17/19/23`,
`production-ops-03/10/11/12/14/16/19/20/21`, and broader transaction features
`transactions-04/06/09/10/11/13/14`. No Microsoft SQL Server, MariaDB,
CockroachDB, replica router, stream API, pool stats or shutdown deadline is
claimed by this driver patch. PlanetScale remains compatible with the qualified
1.x SDK; SDK 2.0 removes parameter-array execution, and no safe formatter
bridge is silently invented. Migration refusals remain with the migration
capability owner. Explicit BEGIN IMMEDIATE is now the stock owned SQLite write
transaction behavior, while an interactive mode option remains a distinct
product decision.

Final PB-2/SQLite LRU/postgres preparation command:

```sh
node scripts/run-vitest-safe.mjs run --workspace vitest.workspace.ts --project=provider-sqlite3 --project=layer-drivers tests/providers/local/sqlite3-v1-driver-remediation.test.ts tests/contracts/drivers/sqlite-statement-cache.core.test.ts tests/contracts/drivers/postgres-transport-coverage.core.test.ts --reporter=dot
```

**17/17 passed**, 4.39s wall, 523.0 MiB sampled process-group RSS, teardown
verified. An attempted one-statement provider batch failed post-BUSY recovery
in both deferred and write modes. It was removed rather than retained as
unproven overhead. Typed and raw execution preserve native semantics; BUSY
quarantines that exact native client before any later VibORM acknowledgment.
The native-client holder sees only the first committed row, proving the failed
write and refused follow-up did not create durable effects. Owned disconnect
closes the quarantined handle and reconnects; supplied disconnect neither
closes nor forgives it. The native owner must close and replace a supplied
client.

## Scalar and validation follow-through

Assigned `api-dx-01`, `schema-dsl-03/13/14/16/24`: format-only string declarations
retain their domain without a create default. `.id()` keeps convenience generation,
`.id({ generate:false })` disables it, and `{generate:true}` explicitly requests
it elsewhere. The one descriptor/helper makes format/key order commute and
preserves caller defaults. Nullable defaults retain existing values/closures;
number/bigint/dateTime/date/time/int reconstructed bases retain refinements.
L5 F008 now warns about actual installed defaults rather than domain descriptors.
Coded custom native maps match trusted tagged declarations; schema documents
remain catalog-closed. Schema JSON records disabled generation while old documents
without a flag retain their authored generation behavior.

Runtime scalar declaration batch: modifier 60 + native 49 + new 6 = **115/115**,
2.60s wall, 353.8 MiB, teardown verified. Final nanoid domain length refusal, string schemas, JSON format/serialize and
L5 runtime checks passed below. Public type probes await the integrated gate.

Comparable, string and decimal filter operands now validate the stored domain
without repeating custom write transformations; ID folding remains enforced.
Refined arithmetic is refused with a resulting-value explanation at runtime and
public numeric/decimal types. List push/unshift applies the custom member schema
once. Boolean/enum/blob/vector/point expose no public custom-schema modifier and
need no corresponding change. Root retains JSON admission and read ownership.
New `v1-refinement-admission.core.test.ts` (now11 cases) pins transformations, numeric
refusals, list-member validation, identifiers, temporal and decimal crossings.

## Latest integration checkpoints

Controlled Neon transport9 + transaction lifecycle30 = **39/39** passed3.59s,
426.6MiB after the SDK1.2 public array-of-query-promises transaction API change.
The prior stock hosted6/6 evidence predates that API change. A mistyped project
filter matched no projects; the corrected `provider-neon-http` run could not
collect because root's new SQLite guard used an unsupported runtime alias.
Both runs executed zero tests and created no fixtures. Root repaired the import;
That intermediate attempt required a rerun, which passed in the final
checkpoint below and added one empty fixture.

Current production LOC vs integrated upstream: drivers 11821 vs 11481 (+340),
scalars 3988 vs 3932 (+56), schema JSON 4164 vs 4150 (+14), validation scalars 2837
vs 2793 (+44). Driver count is +78 against original task baseline 11743; scalar
counts include root's time vocabulary. Tests/documentation are separate.

## Final focused verification, current public SDK API

The corrected live command executed **6/6**, 9.65s wall, 451.6 MiB, teardown
verified. This is the current SDK1.2 public query-promises batch implementation,
not the earlier runtime-only third-argument transaction query call. Hosted proof
covers TCP and HTTP temporal/decimal/bigint/boolean fidelity, atomic failure,
Serializable batch commit segments and acknowledgment before postcommit parsing
refusal. The new EMPTY retained fixture is
`public.viborm_v1_eac80f2633d442299a48737dae3b5681`; all owned rows were deleted,
with no DROP/TRUNCATE. A subsequent live rerun qualified year0 scalar and native-array binding below.

```sh
node --env-file=.env scripts/run-vitest-safe.mjs run --workspace vitest.workspace.ts --project=provider-neon-http tests/providers/hosted/neon-http-v1-remediation.test.ts --reporter=dot
```

Final scalar/L5/JSON/error checks: new modifier 6/6, new refinement 8/8,
model-rules 37/37, string-scalar-schemas 120/120, schema JSON serialize 35/35,
schema JSON format 20/20, public error registry 18/18. The first refinement run's
single failure was a test using Decimal.gt(0), outside the exact comparison
operand API; gt(0n) corrected it. A legacy string filter oracle expected write
schema reexecution and was updated to the authorized physical-domain behavior,
with ID refusal and no-transform counters retained. JSON format exact internal
metadata witnesses were updated for the explicit generation choice; an
intermediate repeated-context fixture edit was corrected. None required a
production patch during qualification.

```sh
node scripts/run-vitest-safe.mjs run --workspace vitest.workspace.ts --project=layer-scalars --project=layer-schema-validation tests/unit/scalars/v1-refinement-admission.core.test.ts tests/unit/scalars/v1-modifier-remediation.core.test.ts tests/unit/schema-validation/model-rules.core.test.ts --reporter=dot
node scripts/run-vitest-safe.mjs run --workspace vitest.workspace.ts --project=layer-scalars --project=layer-schema-json tests/unit/scalars/string-scalar-schemas.core.test.ts tests/unit/schema-json/format.core.test.ts tests/unit/schema-json/serialize.core.test.ts --reporter=dot
node scripts/run-vitest-safe.mjs run --workspace vitest.workspace.ts --project=coverage-errors tests/contracts/public-client/errors/error-registry-gate.test.ts --reporter=dot
```

Owned source/test is frozen and the global runner slot yielded to query, then
root's integrated native gate. Runtime checks are qualified; the newest public
generation/refined-arithmetic probes and restored exact identifier-kind types
still require that integrated typecheck.


## Followthrough: poisoned setup and write output admission

The supplied libSQL precision setup probe now crosses the existing execution
owner, so SQLITE_BUSY cannot escape quarantine during initialization. The new
native supplied-client regression proves a sibling wrapper refuses reuse, only
one provider execution occurs, and borrowed disconnect never closes the client.
Local driver11 + scalar output/refinement9 + modifiers60+6 passed **86/86**, 6.09s,
459.4MiB, teardown verified. A first error assertion expected the unredacted
provider cause; the new public disclosure contract requires the V5003/provider
code oracle, while quarantine and lifecycle assertions are unchanged.

Ordinary custom-schema outputs now pass one final schema-free physical-domain
check at the ORM scalar builder. The primitive v.* transform API stays intact.
Hostile typed schemas returning string-for-number, noninteger-for-int,
string-for-bigint, number-for-string, and invalid temporal text are refused before
ORM write dispatch; legitimate transforms still run exactly once. The scalar
refinement suite also verifies ordinary int/float/bigint zero-divisor refusal,
including nullable numeric fields, while set:0 and nonzero divide remain valid.
Its final **10/10** passed3.19s,455.0MiB. One new fixture typo used s.bigint instead
of the existing public s.bigInt; it was corrected before the final run.

```sh
node scripts/run-vitest-safe.mjs run --workspace vitest.workspace.ts --project=provider-sqlite3 --project=layer-scalars tests/providers/local/sqlite3-v1-driver-remediation.test.ts tests/unit/scalars/v1-refinement-admission.core.test.ts tests/unit/scalars/modifier-contracts.core.test.ts tests/unit/scalars/v1-modifier-remediation.core.test.ts --reporter=dot
node scripts/run-vitest-safe.mjs run --workspace vitest.workspace.ts --project=layer-scalars tests/unit/scalars/v1-refinement-admission.core.test.ts --reporter=dot
```

The latest real Neon SDK1.2 run passed **6/6**,7.38s,448.3MiB, including year0000
scalar and timestamp arrays through pg/postgres owned and supplied TCP clients and
the current public HTTP API. All owned rows were deleted; EMPTY retained fixture
`public.viborm_v1_d9d91d847e8e4288b2bf8e1cd044f875` was created without DROP/TRUNCATE.
The command is the same provider-neon-http command above.

## Declaration emission (in progress)

Public schema/root entries now reexport named scalar/model/schema interfaces as
types only. A real packed-tarball composite producer and downstream consumer
fixture is saved at tests/package/declaration-consumer-smoke.mjs. It covers
exported models/schema/client, relation inclusion, groupBy keys and a wrong-ID
negative probe under TypeScript5.8 and native TypeScript. Build/packed proof is
pending the all-writer freeze; no declaration fix is claimed yet. Same-shape
chain/ring TS2321 remains under investigation at static-membership's equality
owner, with no owner change made yet.


The temporal output guard returns the normalized physical-domain result, so a
hostile schema returning Date cannot leak a Date through a declared string output,
and transformed offset text becomes canonical UTC. The write schema still runs
once. Final output/refinement/zero-divisor suite **11/11** passed2.79s,423.1MiB.
Latest scoped production LOC: drivers11821 (upstream+340, taskbaseline+78),
scalars3989 (upstream+57),schemaJSON4164 (+14),validation/scalars2871 (+78,
including concurrent root JSON/negation changes). Declaration public type exports
are separate and do not create runtime bundle entries.


## Remaining defects versus product gaps, at integration freeze

Confirmed type defects still need actual packed proof: H13 exported model/client
composite emission and same-shape chain/ring TS2321. Named public exports and the
packed producer/downstream/extends/chain fixture are implemented, equality is
still unchanged until a decisive repro. Vector .dimension previously affected
DDL state alone and did not constrain create or the base used by set/filter; the
bounded scalar rebuild and nullable-order regressions are saved but unverified.
Supported-SDK ranges still need root's PlanetScale2 disposition; no compatibility
with its removed parameter-array API is claimed.

These are qualification limits, separately: Bun-native/Workers-native matrix,
hosted Turso/PlanetScale/D1, broad server-version CI, and packed declaration
isolation all remain unexecuted here. Existing controlled regressions are honest
boundary evidence, not hosted-provider claims. Duplicate D1 Sessions and lock-wait
error rows now carry the same implementation/evidence disposition as their primary
rows. The first integer setup failure preserves classified V5003 and quarantines
that exact handle; it does not promise transparent provider recovery.

New MSSQL/MariaDB/CockroachDB targets, replica routing, additional platforms,
streaming/row locks, session defaults, and custom codecs are product gaps. They
have not been silently reclassified as bugs fixed by documentation.

## Integrated core follow-through (qualification pending)

The native integration gate3 found one remaining owned type diagnostic: a manually
written Standard Schema with unknown input admitted arithmetic shorthand on a
refined number. EffectiveInput now intersects the physical primitive input with
the custom input, matching the existing base-then-custom admission order;
the unchanged public increment refusal probe awaits the next native gate.

Core runtime evidence passed vector48/48, refined/output-domain11/11, supplied
clients56/56 and transaction lifecycle30/30. Two lifecycle regressions were real:
failed bound SAVEPOINT creation did not mark its parent rollback-only, and a
premature provider callback completion did not quarantine base work. The existing
failure owner now distinguishes internal provider contract errors and bound
savepoint failures from recoverable ordinary provider setup errors. Existing
savepoint/provider contract regressions will verify those changes next.

Physical $schema verifyStorage/assertStorage statements now bypass user statement
transforms at the driver finalizer while retaining bind-limit enforcement and
protected observation. A focused regression covers both protected operation names
and proves ordinary model statements still transform.

Obsolete implicit identifier-generation tests now request .id() explicitly. The
native catalog count records the authorized PostgreSQL INTERVAL removal; the docs
corpus records the additional format-choice fence and shifted string model fence.
Interning tests prove lazy custom validation and one invocation per create/set,
rather than mirroring primitive factory calls. Physical filters intentionally
accept stored values outside write refinements.

Confirmed JSON default defect dsl-cross-product-08 is being corrected across
scalar/default admission, existing JSON write construction, schema-document codec
and migration literals. It is not resolved by documentation: nonnullable bare
.default(null) must never become NOT NULL DEFAULT NULL; JsonNull must remain
separate from nullable SQL NULL through runtime and manifest round trips.

## Final bounded driver/scalar qualification before native gate 4

Latest source and tests are frozen for the integrated native typecheck and fresh
package build. No declaration-emission resolution is claimed before the packed
consumer actually runs.

- Real Neon HTTP/TCP fidelity and batch cases: **6/6 passed**, 5.14s wall,
  497.3 MiB sampled process-group RSS. The additional PB-1 witness initially used
  a transaction-pooler URL; its backend PID could be reused by the killer, so that
  fixture failed. The corrected witness uses the equivalent direct endpoint for
  both isolated transports, terminates only the backend PID returned by its own
  session, and contains pool errors without serializing connection objects.
  Corrected PB-1: **1/1 passed**, 3.61s wall, 462.5 MiB. The warm-dead transaction
  rejected within 666ms; a later SELECT on the same driver succeeded. No other
  backend was enumerated or terminated.
- Formatted ID list members: existing ID codec now admits and canonicalizes
  create/set/push/unshift and list filter operands. Physical list storage remains
  plain strings. Both modifier orders are covered. Incompatible string and
  temporal scalar generation on lists now refuses at declaration in both orders;
  explicit array defaults remain valid. String/modifier cases: **128/128 passed**.
- Ordinary junction/model table-name collisions now fail once through the
  existing topology table-claim owner before client work, including checked
  resolution and implicit names: **2/2 passed**.
- Protected physical storage contexts preserve the private extension chain and
  correlation while excluding user statement transforms; bind budgets remain
  enforced. Statement-index remapping clones both public and trusted metadata,
  preserves suppressed evidence and retains the error owner's sanitized cause.
  Context witness1/1 and remap witness1/1 passed.
- Native Bun fixture: **1/1 passed**, including PB-4 supplied handle control
  ownership. Failed nested BEGIN never runs the callback, never closes the
  borrowed handle, and leaves the caller's transaction and uncommitted row
  intact; the native owner can still roll it back. Raw calls use the approved
  Sql-fragment entry.
- Latest combined batch: 138/142 passed. Four obsolete assertions expected
  millisecond Time generation and the original unsanitized cause identity.
  Corrected contract assertions passed **10/10**, 2.70s wall, 395.5 MiB. Teardown
  verified for every completed run.

Commands:

```sh
node --env-file=.env scripts/run-vitest-safe.mjs run --workspace vitest.workspace.ts --project=provider-neon-http tests/providers/hosted/neon-http-v1-remediation.test.ts --reporter=dot
node --env-file=.env scripts/run-vitest-safe.mjs run --workspace vitest.workspace.ts --project=provider-neon-http tests/providers/hosted/neon-http-v1-remediation.test.ts -t 'warm postgres.js' --reporter=dot
node scripts/run-vitest-safe.mjs run --workspace vitest.workspace.ts --project=layer-drivers --project=layer-scalars --project=layer-schema-validation --project=layer-operation-schemas --project=provider-bun tests/contracts/drivers/error-index-remap.core.test.ts tests/contracts/drivers/protected-storage-statements.core.test.ts tests/unit/scalars/v1-modifier-remediation.core.test.ts tests/unit/scalars/string-scalar-schemas.core.test.ts tests/unit/schema-validation/junction-model-name-collision.core.test.ts tests/unit/operation-schemas/update/updated-at.core.test.ts tests/providers/platform/bun-sqlite-runtime.test.ts --reporter=dot
node scripts/run-vitest-safe.mjs run --workspace vitest.workspace.ts --project=layer-drivers --project=layer-operation-schemas tests/contracts/drivers/error-index-remap.core.test.ts tests/unit/operation-schemas/update/updated-at.core.test.ts --reporter=dot
```

New retained EMPTY hosted fixtures (their rows were deleted; no DROP/TRUNCATE):

- `public.viborm_v1_2102fd60055f4aac8cf24d3d80834005`
- `public.viborm_v1_bc001166d13d445c9079c0f6cba43244`

Production source LOC at this freeze, counting TS/JS files recursively:

| Owner | Current | Original task baseline | Delta | Integrated upstream | Delta |
| --- | ---: | ---: | ---: | ---: | ---: |
| Drivers | 11,855 | 11,743 | +112 | 11,481 | +374 |
| Scalars | 4,160 | 3,306 | +854 | 3,932 | +228 |
| Schema JSON | 4,193 | 4,052 | +141 | 4,150 | +43 |
| Validation scalars | 2,932 | 2,920 | +12 | 2,793 | +139 |

The original baseline predates the integrated upstream changes; its scalar delta
must not be attributed solely to this remediation. Shared owner counts include
root's temporal/JSON changes. Necessary added decisions are physical-handle queue
ownership, bounded browser fallback, libSQL quarantine, scalar output-domain
composition and authenticated existing JSON-null defaults. No public provider
registry, manual SQL formatter or second ID codec was added.

Unresolved product gaps remain explicit: row-locking language, advanced
transaction options and client defaults, provider-capability-dependent option
types, provider-managed maxWait, replica routing, new dialects, streaming and
provider telemetry. Hosted Turso and PlanetScale2 are not qualified. These are
not repaired by documentation. The actual packed H13 consumer is the remaining
owned integration gate; runtime source is otherwise stable with the evidence
above. Definition refusal for incompatible generated arrays does not pretend
that the current scalar State generics reject every such chain statically.

## Last concrete transport followthrough

The review's stale-error replay (`transactions-06`) now has a bounded correction
at the existing bound transaction owner. Later work in a rollback-only scope
receives TransactionError with a clear reason instead of the earlier statement's
constraint error. Its original primary and suppressed evidence survive; successful
callback completion still refuses commit with the original primary. Savepoint
recovery grants are unchanged. The caught-error/no-provider-dispatch regression
is saved, awaiting the next focused slot.

SQLite3/Bun raw INTEGER parity (`data-fidelity-17`, `read-api-15`, `escape-07`)
now reads INTEGER leaves losslessly once. Existing trusted `$raw` context marks
safe raw SQL; raw results copy rows and normalize only safe-range bigint leaves
to number, retaining wider bigint. Unsafe/direct/migration raw follows the same
rule, and typed model decoding retains its scalar domain. Native direct, safe,
unsafe, array and callback fixtures are saved, awaiting focused qualification.

### Final transport checkpoint: 125 qualified cases

Final focused selection passed **124/125**, 5.89s wall, 522.0 MiB. The one
remaining old Bun oracle expected rounded unsafe raw; its corrected exact-value
assertion and full native probe passed **1/1**, 2.28s wall, 387.4 MiB. All125
selected cases are now qualified; production sources were unchanged between
these two runs and teardown was verified.

- Error mapping59: errors02 code-recognized UNIQUE/NOTNULL captures table and
  columns; qualified quoted identifiers retain literal dot/comma/escaped quote
  leaves. Non-identifier expressions do not invent columns. Socket ETIMEDOUT
  emits retryable V1002; PostgreSQL57014 and MySQL1205 emit retryable V2002.
- Transaction lifecycle31 and savepoint17: later dispatch describes rollback-only
  state, retains primary/secondary evidence and performs no provider work; final
  rollback preserves the original caught primary.
- Controlled INTEGER5, actual SQLite13 local12 and native Bun1: direct/safe/unsafe
  raw, array and callback routes share safe-range number/wide bigint results.
  Model typed decoding remains unchanged. The native probe also requalified
  fixed Decimal, compact identifier, GeoPoint and supplied-control ownership
  crossings under the same Bun runtime.

```sh
node scripts/run-vitest-safe.mjs run --workspace vitest.workspace.ts --project=layer-drivers --project=provider-sqlite3 --project=provider-bun tests/contracts/drivers/error-mapping.core.test.ts tests/contracts/drivers/transaction-lifecycle.core.test.ts tests/contracts/drivers/savepoint-queue.core.test.ts tests/contracts/drivers/sqlite-integer-safety.core.test.ts tests/providers/local/sqlite3-v1-driver-remediation.test.ts tests/providers/platform/bun-sqlite-runtime.test.ts --reporter=dot
node scripts/run-vitest-safe.mjs run --workspace vitest.workspace.ts --project=provider-bun tests/providers/platform/bun-sqlite-runtime.test.ts --reporter=dot
```

Remaining owned gate: actual packed declaration producer/consumer on TS5.8 and
native TypeScript. No further runtime source edits remain from assigned confirmed
transport/scalar defects. Broader provider/platform qualification and explicit
product gaps remain listed separately in the finding ledger.

### Corrected errors24 taxonomy, awaiting final gate

The final owned scan confirmed a false earlier disposition: SQLite lock refusal
still claimed DEADLOCK and PostgreSQL55P03 was unmapped. V5006
TRANSACTION_CONTENTION now maps SQLite BUSY/LOCKED (including extended/numeric
families) and PostgreSQL lock_not_available at the existing provider mapping.
The existing TransactionError family and canonical retry disposition own it;
no class, retry runner or registry was added. Genuine deadlock remains V5003;
MySQL1205 remains retryable query timeoutV2002. Public documentation distinguishes
these meanings and explains that transient classification proves neither commit
certainty nor write idempotency. Focused mapping/union/classification/Prisma/docs
regressions are saved, not yet executed against this final taxonomy.

Final source lint fixes also preserve omitted-versus-explicit-undefined close
scope signaling, promise close-resolver initialization, provider diagnostics
options, URL query-key deletion, and shared queue drain behavior. All are
formatted; the next focused gate includes lifecycle/savepoints before package
qualification. The earlier125-case runtime evidence predates these lint-only
rewrites and this substantive taxonomy addition.

### Final taxonomy and transport qualification: 223 cases

The final selection qualifies **223/223** across the bounded correction runs.
Integration10 passed220/223 in6.24s,567.2MiB. The failures were one old local
SQLite BUSY V5003 oracle and the registry census's two missing-row/count checks
for the already-existing internal ProviderTransactionContractError. LocalSQLite
passed12/12 after its oracle correction. The registry now includes that existing
subclass and pins its intentional public TransactionError clone; registry19/19
passed integration13 in2.74s,463.2MiB. All runners verified teardown. No production
code changed after integration10, and all owned source/tests are frozen.

Mapping60/60 pins truthful V5006 SQLite/PostgreSQL contention and intact genuine
deadlock meaning; lifecycle31/savepoints17 qualify the lint followthrough;
union14, classification34, Prisma24 and discrimination6 qualify the new code
through the existing public family. Actual SQLite12.11.1 local12, INTEGER5 and
native Bun1 qualify raw parity and quarantine/recovery contracts against the
final dependency install. The packed declaration gate remains pending freshbuild.

### Source count after final driver freeze

Physical TS/JS lines (including the integrated owners' work and final formatting):

| Owner group | Original baseline | Upstream integration | Final | Net after upstream |
| --- | ---: | ---: | ---: | ---: |
| Drivers | 11743 | 11481 | 11942 | +461 |
| Scalars | 3306 | 3932 | 4166 | +234 |
| Schema JSON | 4052 | 4150 | 4211 | +61 |
| Scalar validation | 2920 | 2793 | 2990 | +197 |

The original manifest predates19 upstream commits, so its delta includes upstream
work. These directory totals include other agents' temporal/JSON edits and are
not a per-author attribution. Correctness boundaries account for the additions:
shared physical-handle queue/lifecycle ownership, borrowed parser attestation,
SQLite quarantine and one raw INTEGER normalization, one generation descriptor,
physical schema-output composition and per-member list admission. The new
contention code extends existing owners; it creates no error class or retry runner.

### Actual packed H13 and peer boundary failure

The fresh diagnostic build completed5.52s,982.6MiB and immutable artifact
`/tmp/viborm-v1-diagnostic-artifact-1/viborm-1.0.0.tgz` captured the source before
writers resumed. Genuine TS5.8 composite producer failed: unannotated exported
client referenced inaccessible ClientExtensionState; valid named client
extension also reported TS2742. Initial fixture's missing extension name was
corrected and repeated; only the genuine declaration failures remained. Prior
named scalar/model reexports did not establish H13 resolution.

The no-peer root/schema tarball consumer failed under TS5.8 and native with
skipLibCheck:false: nine optional driver peer imports plus unused __name import
from a runtime helper lacking declarations. Existing generic type imports now
route to the public driver-only boundary (22source files; no runtime change).
Existing client state names are type-only public reexports. Runtime keepNames
and declaration-only builds are separated: installed tsdown uses one memoized
clean promise awaited before either writer starts, preserving runtime output.
Both builds stay under one safe runner's1536MiB aggregate ceiling. Candidate
packed proof remains pending dependency/source-stable checkpoint.

### Artifact2 narrows declaration defects

Build2 passed2.65s,1009.9MiB under the1536MiB aggregate ceiling, preserving
88runtime mjs and35declaration dmts files. Immutable artifact2 captured both
outputs. Named-state reexports now permit the simple unannotated exported
client. A valid named extension still fails TS2742; the existing MergeExtensionState
name is now type-only public and awaits artifact3 proof. Peer/helper leakage
reduced from ten failures to one CloudflareKV import via the cache barrel.
Generic cache types and existing schema functions now route directly to their
owners in client/cache-flow. These source-only corrections preserve runtime
identity; candidate3 actual packed H13/no-peer proofs are pending final native/core
and dependency/source freeze. No caller getter/type annotation masks the defects.

### Artifact3/4 consumer and diagnostic qualification

Build3 passed2.51s/965.9MiB; artifact3 is immutable. The real unannotated
composite db/schema/client and valid `$extends()` now emit and downstream types
retain ordinary scalar/include/groupBy answers. Chain2/5/30 emission passed;
chain100 public nested query passed. Ring10 still fails TS2321. State-only model
comparison did not repair the cyclic declaration comparison (artifact4,
`packed-declaration-6`, strict library checks after supplying the real
`@types/better-sqlite3` peer). The next candidate compares a named recursive
projection of declaration data, retaining target graph data while removing
fluent class methods. H13 remains open until an actual packed ring proof passes.

Artifact3 root/schema with runtime dependencies alone passed both TS5.8 and
native `skipLibCheck:false` with no optional driver/OTel/Cloudflare peers:
`packed-nopeer-3`,5.14s/761.3MiB. Actual packed D1 Sessions, exported
sqliteResultParser, and executable supplied postgres vibormTypes public setup
passed `packed-driver-setup-1`,0.78s/263.9MiB. No fake ambient peer declarations
or user annotations replace the original export sites.

Driver diagnostics/date qualification: `driver-diagnostics-2` passed121/121,
6.07s/540.2MiB, teardown verified. This revision precedes root's newer validation
message wording and the subsequent span/native-cause corrections. New false-
default `diagnostics.includeProviderDetails/includeCallsite` preserve bounded
own-data provider message/detail/hint with credential redaction, capture the
actual deferred raw/model creation stack only opt-in, and retain those selected
facts in official JSON error logs. Validation source/issues are snapshotted at
construction and survive public mutation. Default redaction remains intact.

The raw Date cutoff witness actually executes safe/unsafe inserts, strict
before/equal/after ISO-TEXT filters and updates with SQLite3/libSQL and Bun.
D1's controlled native binding receives the ISO timestamp. libSQL raw INTEGER
continues to expose its configured bigint carrier; the Date witness does not
pretend that a raw row has a typed model descriptor. SQLite epoch/Julian raw
parameters remain caller-owned physical values.

CI confirmed two obsolete fixture failures: generic provider binary mock lacked
the newly required `.pragma` FK read and could leave global Buffer unavailable
while cleanup ran; mock corrected and globals now restore synchronously before
async disconnect. Decimal duplicate-class census was substring matching the new
scalar phrase `Division by zero is not allowed`; census now matches the exact
class literal and checks that public schema validation produces an instance of
the root Decimal constructor. Qualification of these latest followthroughs is
pending the next bounded runner.

### Final diagnostic checkpoint and unresolved ring consumer

Immutable artifact5 contains 2,080,695 bytes; build passed in 2.53s at
973MiB (`/tmp/viborm-v1-build-5.log`). The genuine strict TS5.8 packed
consumer still passes exported db/schema/client/extension and chains2/5/30/100,
but ring10 fails TS2321 while comparing the named ModelIdentity projection
(`/tmp/viborm-v1-packed-declaration-7.log`,32.40s/966MiB). H13 remains a
confirmed defect; native compiler qualification has not been reached by that
script. An attempted generic structural graph projector additionally triggered
TS2589 in the source filter schema and was removed. No caller annotations,
ambient peer shims, or skipLibCheck relaxation hide either failure.

Binary transport correction now passes3/3 with teardown,3.54s/438.2MiB
(`/tmp/viborm-v1-binary-focused-4.log`). Node's async-context loader is primed
before removing Buffer; SQLite3/Bun byte binding and result conversion still
execute with Buffer unavailable. All globals restore before asynchronous cleanup.

The latest provider taxonomy introduces capacity V1005, schema mismatch V2004,
and numeric range V2005 in the existing ConnectionError/QueryError classes.
Capacity is retryable; schema/range refusals are expected and nonretryable. PG,
MySQL and proven SQLite category facts map without claiming a guessed Prisma
equivalent. Mapping73/73 and hostile30/30 individual suites passed in the prior
bounded batch; that command subsequently exceeded RSS in the separately repaired
binary fixture, so it is not a whole-command pass. Final SQLSTATE clone/span and
new public class export/runtime diagnostics are awaiting the integrated gate.

Native9 had no production diagnostics. Three owned test defects were repaired:
the fake Driver requires both generic arguments, failure-family discrimination
includes the new codes, and lifecycle completion now explicitly correlates its
private driver-lifecycle kind and failure fact. Native10/core qualification is
owned by the integration coordinator.

The final native pass exposed a diagnostics test harness mistake: withOtelRecorder
returns a recorder and accepts no callback. The three newly written tracing
cases had not executed their intended assertions; native10 caught the misuse.
The integration owner is repairing them to create/dispose a real recorder and
qualify actual spans. Prior test-count evidence does not establish those new
canonical statement/operation/lifecycle span claims. Baseline strict TS5.8
source imports additionally expose a generic filter.ts60 TS2589; the same
error occurs before and after the failed lazy-arm/asymmetric identity experiments.
The actual packed consumer is the public declaration qualification boundary;
source-only generic factory checking remains separately visible.

### H13 cause isolated without declaration waivers

The decisive temporary packed experiment changed only RecursiveArm from an
eager membership conditional to the already existing recursive node. Actual
unannotated ring10 then passed strict TS5.8 (`ring-packed-lazy`,5.50s/900MiB).
Restoring the simpler exact model-state identity also passed (`ring-packed-lazy-state`,
6.78s/921.5MiB). These commands mutate only disposable extracted declaration
files; immutable artifact5 is unchanged, so they are diagnosis rather than
final shipped-package proof.

The source fix removes the eager tuple conditional at the include schema owner.
The recursive node remains unavailable when its required recurse value is never;
ordinary includes no longer require an immediate whole-graph identity decision.
The unsuccessful named recursive identity language was removed, reducing
production LOC. Runtime schema factories are unchanged. Public self-recursion
positives/negatives and both compilers against a freshly built immutable artifact
remain required before resolving H13 and its chain/ring aliases.

### Final core integration follow-through

Actual recorder diagnostics assertions now ran: provider-details-callsite 7/7 and
schema JSON docs 137/137; 144/144 total, 3.78 s / 472.1 MiB (`root-final-diagnostics-corpus`).
This supersedes the earlier callback harness that did not execute its new span
assertions. Operation, statement and failed connection spans retain canonical
class/code/SQLSTATE, while the default cause stays redacted and standard cause is
the same sanitized instance as originalCause.

The final focused driver/instrumentation batch passed 132/132 across 10 files,
5.68 s / 583.7 MiB with verified teardown (`drivers-core-final-2`). It includes all
56 supplied-client/pool ownership cases and the single result-domain fixture
with multiple assertions. That fixture proves
actual database-legal SQLite INTEGER poisoning yields nonretryable QueryError
V2006 with model/operation/scalar/reason; targeted valid reads still work, clone
attribution survives, and an actual public 1000-bind IN filter succeeds.
Strict whole-query domain refusal remains the contract; V9001 is reserved for
actual invariants. No lenient read mode was added.

Neon controlled mocks now match SDK 1.2 query(): typed query promises are passed
as an array to transaction(), preserving statement-position attribution and
snapshots. No timeout was raised. Queue regressions preserve the first provider
error and the original cleanup aggregate, while subsequent queued work receives
a distinct rollback-only TransactionError carrying canonical suppressed evidence.

Tracing/logging snapshots now contain only their own SQL/parameter disclosure
flags; diagnostics alone contains provider-detail/callsite opt-ins. The reviewed
golden changes are exactly canonical class/code span attributes, sanitized native
cause alias/redaction, validation issue/source/path presentation, and conservative
cache.clear observation. Full runtime vocabulary explicitly includes the newly
public existing error classes and guards.

### Immutable artifact6 qualification

Native15 and all four core7 shards passed before build6. Exact PGlite32768
bind refusal now passes within13/13 capacity cases: the controlled provider
query never runs. That proves pre-dispatch avoidance of the known poison
trigger; it does not prove a32767-scale provider result.

Artifact6 SHA256 is
`23b9f10d5bca0828a0b23f58dde1021cc7199e48d5b9e71a725d7b32bdd01c9b`.
Strict TS5.8 ALL composite client/schema/$extends downstream positives and
scalar/data/raw-argument/recursion negatives passed; unannotated chains2/5/30
emit and chain100/ring10 queries also passed. Native emission still reports
missing root ReferentialAction and serialization length TS7056. The combined
command ended41.27s/1189.4MiB; TS5.8 emits1.54MB for the representative db
package, so passing compilation is not a performance claim. Existing relation
capability types were reexported by name for a fresh build7 native proof; no
runtime terminals, annotation workaround or skipLibCheck were introduced.

Independent immutable artifact6 checks passed: no-peer strict TS5.8/native
5.45s/761.4MiB; actual CommonJS runtime and .cts strict both compilers
5.62s/927.8MiB on Node24.14; genuine D1 Session/sqliteResultParser/supplied
postgres setup5.61s/895.9MiB (with real postgres, Workers and Node typings);
installed CLI typed config with project .env0.27s; soft-delete public consumer
3.45s/758.5MiB. All disposable consumer directories were removed.
The security dependency reproduction fixture also passes against the current
installed graph. Existing Decimal identity and error-name scripts inspect
fresh dist6, not the tarball: both pass; Decimal's exact refusal census now
accepts the minifier's backtick delimiter and the decisive schema/root instance
identity remains intact. Public type golden advances with build7 and is still
pending that artifact.

### Artifact7 producer and declaration checkpoint

Immutable artifact7 SHA256 `2cdfa2eafd06bf4d9e9cf28601ec49f9cfb3da4b7b0d26c0d5ef30eadcb84c36`: the named public relation capability exports eliminate native TS2883/TS7056 in the genuine exported schema/client/$extends producer. Corrected the test fixture's invalid one-sided relation by supplying its inverse; the retained direct `author.name` assertion now passes independently against source inference and emitted declarations. Actual packed client construction executes L5 topology admission. Native db passes5.62s/699MiB and emits209434bytes; ring10 and chain100 ordinary nested queries pass1.90s/712MiB and2.63s/636MiB; chain2 and chain5 declarations pass1.78s/648MiB and1.99s/722MiB, emitting147316 and4149140bytes.

H13 remains open: native chain30 declaration emission exceeds the unchanged1536MiB sampled ceiling at1577.8MiB (5.59s; teardown verified). The packed public golden also finds that the declaration bundler loses explicit type-only class export kinds although runtime exports remain correct. Retained its negative import/value probes and saved a minimal official `dts.sideEffects:true` metadata candidate for fresh build8. No resource increase or caller annotation masks either defect. Durable package registration now separates each compiler/case under the existing30s test ceiling and includes real no-peer/CJS/setup/CLI/dependency-security smokes.

### Artifact8: actual declaration scaling and compiler crash repair

Immutable artifact8 SHA256 `ab7eeddf7db47ef0aa4544b3e0fbdcc2d096d9c944dff8b43f891e6c39296c37`: the initial model state now has one named interface with exactly the previous shape/scalar/relation/unique/omit refinements. No runtime body change, casts, caller annotations or depth caps. Native chain5 declarations shrink from4149140 to284871bytes; native chain30 now emits8352040bytes in2.10s/823MiB within the unchanged1536MiB ceiling. This repairs the observed resource failure, not a claim that declaration size or all editor overhead is small.

The original JS compiler crash began after120–150 FK hops; chain100 alone did not cover it. The durable new unannotated chain200 case covers199hops and passes actual strictTS5.8,JS5.9,native public query checks in4.11s/943MiB,3.91s/963MiB,1.68s/700MiB respectively, with teardown verified. Actual exported db/source/emitted downstream positives and scalar/data/raw/recursion negatives pass strictTS5.8/native at the real768MiB heap and30s child wall budget:68011/56773-byte declarations,12.25s/892MiB and5.03s/729MiB. Paired required-owner nullability is checked by direct author.name and actual L5 construction, with no optional chaining. Multi-key groupBy reads both named fields through the same public consumer.

Final public export-kind golden still fails: the declaration bundler exposes type-only classes as values. Its official sideEffects option did not fix this and was removed. The next build carries a narrowly scoped source-AST correction of explicit named public entry type reexports, preserving aliases and all negative import/value probes. No H13/package completion claim until fresh proof. Each durable package subprocess now has explicit30000ms timeout/SIGKILL in addition to the outer safe process-group/RSS runner; Vitest's blocking-call timer alone was insufficient.


### Artifacts10–13: exact export kinds and remaining compiler boundary

Immutable artifact10 public surface golden now passes all27 subpaths (1.40s/412MiB, `/tmp/viborm-v1-package-golden-10f.log`). The declaration export-kind plugin matches actual entry filenames (`schema.d.mts`, not chunk name `schema.d`), reads explicit source export declarations through the TypeScript AST, and restores only those exact named type reexports. Negative class value imports remain intact. Golden corrections reflect existing source type exports: MemoryCacheOptions, ResolveCallback/ResolveChange, MigrationConfig, and explicit type-only inferredType/V. ModelState remains an approved type export, so its stale absence pin was removed. Runtime exports are unchanged.

StrictTS5.8 still reproduced TS7056 at chain30's unannotated exported schema/client in artifact10. Naming the initial model terminal itself did not help (artifact11); that failed wrapper/export was removed. Naming the existing initial scalar state at its sole createDefaultState factory does help, with exactly the same15 fields, boolean/undefined types and runtime object. Artifact12 emits chain30 declarations with strictTS5.8 in6.31s/965MiB (8080028bytes) and native in2.41s/782MiB (4002000bytes), below the unchanged768MiB child heap/1536MiB sampled RSS/30s wall bounds. These large declarations are not a small-editor-cost claim. A further backreference consumer remains under diagnosis because compiler-generated cycle elisions can affect downstream relation inference.

The exact original ten dependent `$extends` chain is now a standalone durable package case: actual runtime construction, strict source inference, exported declaration emission and downstream method positives/negatives. Artifact10 reproduces TS2589 at layer10 with loss of contextual scope typing (9.51s/937MiB); artifact13's first bounded accumulation candidate still reproduces it (5.94s/960MiB). H13 and codebase-health13 remain open until that exact witness passes. The three original TS5.9 member-scope TS2322 fixture causes now return explicit undefined from afterStatement, preserving the existing protocol and runtime value. A scoped project extending the real repository tsconfig exhausted the unchanged768MiB JS compiler heap; no whole-estate JS5.9 passing claim follows from packed public probes.
