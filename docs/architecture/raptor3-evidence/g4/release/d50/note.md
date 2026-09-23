# Release unit "d50" — the exact identity scratch on PostgreSQL batch-only transports (note)

Integrator: Fable, in the main tree on `b7b0f7235` (commit 17). Ruling
D-50 (Arnaud, 2026-09-19, "ok do 1"): implement the CTE identity scratch for
PostgreSQL-family batch-only transports rather than fall back to segmented
RETURNING or keep the refusal. Receipts under `receipts/`.

## 1. The refusal and its shapes

`OperationContext.insert`, batch arm: when a produced field has to reach later
statements and the key is not carried by the exact identity scratch, the
engine refused every provider that supports RETURNING and CTE mutations —
"Raptor 3 G1 atomic output requires exact identity scratch or segmented
RETURNING". The scratch existed only as the statement-local last insert id
(`batchRefs.storeLastInsertId`: SQLite `last_insert_rowid()`, MySQL
`LAST_INSERT_ID()`); PostgreSQL's `lastval()` is session-global (another
generated column or a trigger moves it) and was rightly never offered. So on
PGlite in batch-only mode, on Neon HTTP, and on the Docker `pg` batch-forced
driver, every nested create under a generated increment key, every junction
link to a fresh row, every create arm of a nested upsert was refused. The
gate triage found the refusal escalated four times and never ruled
(`g4/release/gate/atomic-output.md`): 28 open cells in the family, the five
registered kept-red Docker `pg` cells (`batchPrimaryKeyDataflowContract`,
ledger commit 4), and the masked twins of three defects behind them.

## 2. The truth and its owners

- **The dialect owns the spelling.** `BatchReferenceSqlAdapter.storeReturning?
  (batchId, key, insert, column)`: the PostgreSQL adapter spells it as
  `WITH "__viborm_inserted" AS (<insert> RETURNING <column>) INSERT INTO
  "__viborm_batch_refs" ("batch_id", "ref_key", "ref_value") SELECT $batch,
  $key, CAST(<column> AS TEXT) FROM "__viborm_inserted"` — ONE statement that
  runs the INSERT and stores its own key; nothing session-global is read.
  MySQL and SQLite do not offer it (their CTEs are read-only).
- **The capability owns "can this provider mutate inside a CTE".**
  `capabilities.supportsCteWithMutations` was already the one authority the
  estate toggles (`tests/raptor3/transport/driver.ts:72`,
  `expanded/batch-produced.ts:61`, `post-prep/g29-result-progress-pglite.test.ts:98`
  force it false to exercise segmented RETURNING on a PostgreSQL dialect).
  The PostgreSQL adapter's batch references read it live: `storeReturning`
  and the key store derived from it are offered only while it holds, and a
  PostgreSQL that cannot mutate in a CTE offers no exact key store at all
  (the 38 fixed-stage cells of the scripted transport said so when the
  engine first read the dialect's spelling without the capability).
- **The dialect owns how the key is stored; the engine chooses nothing.**
  `batchRefs.storeInsertedKey(batchId, key, insert, column)` states the
  statements in order — the CTE store alone (PostgreSQL), or the INSERT then
  the last insert id store (SQLite, MySQL); it is derived once in
  `createBatchRefs`. The engine's batch arm asks `carriesIdentity` = the
  produced field is one increment key AND the dialect states a store, queues
  the first statement with the INSERT's context and producer record (the
  error attribution index is unchanged) and the rest after it, and reads the
  reference back at the key's own width: `CastType` gains `"bigint"`
  (`BIGINT` on PostgreSQL, where `INTEGER` is 32-bit; `SIGNED` and `INTEGER`
  on MySQL and SQLite, the 64-bit casts they already had). One owner per
  fact, no policy boolean in the engine; the first draft's engine-side choice
  between the two stores left five branch arms unreachable in the
  deterministic coverage scope (90.98 against the 91 floor), which the
  dialect-owned store removes.
- **The scratch outlives one native batch.** The PostgreSQL scratch table was
  declared `ON COMMIT DROP`. A record series commits member by member on a
  batch-only transport (its shipped segmentation, `recordSeriesProgress`),
  and the second member's INSERT reads the reference the first batch stored:
  with `ON COMMIT DROP` it found no table (`42P01`), the exact red of the
  Docker cell "generated parent ID feeds nested createMany child FKs". The
  table now lingers on the pinned session like the SQLite and MySQL scratch
  tables; the rows are cleared per batch id at setup and deleted at the end.

The guard stays for the shapes the scratch cannot carry: a produced field that
is not one increment key on a provider whose RETURNING cannot be segmented.
Widening the scratch to every produced column is a follow-up for a ruling,
not this unit.

## 3. Hunks

`src/adapters/adapter-core-types.ts` (`storeReturning?`, `storeInsertedKey?`,
`"bigint"`), `src/adapters/shared/batch-refs.ts` (the derived key store), the
three adapters' cast maps, the PostgreSQL `storeReturning`, the
capability-read batch references and the scratch table,
`src/query-engine/raptor3/shared/operation-context.ts` (the batch arm of
`insert`), `src/query-engine/raptor3/AGENTS.md` (one paragraph),
`CHANGELOG.md` (two entries); the pins
`tests/raptor3/g4/parity/postgres-identity-scratch.test.ts` (live PGlite,
registered as `D50_PROVIDER_TESTS` in the raptor3 manifest, the
credential-free manifest and the runner's `raptor3-provider` stages) and
`tests/raptor3/g4/parity/increment-key-width.test.ts` (deterministic SQLite:
a `bigint` increment key stored after its INSERT and read back at width);
three adapter contract cells (`internals-and-geo`: the CTE store's statement
and parameters, the key store's shape on the three dialects, the capability
read live; `dialect-vocabulary`: the `bigint` cast on all three). Numstat in
`receipts/numstat.txt`.

## 4. Falsification and verification

- The pin: two cells on a recording batch-only PGlite driver — a nested
  `create` list carried in ONE native batch through the CTE store and the
  reference read (no `lastval()`), and a nested `createMany` whose two members
  both read the reference across the series' committed segments. Before the
  unit the same shapes hit the registered refusal (the family's inventory
  logs, `g4/release/gate/`); with `ON COMMIT DROP` still declared the
  createMany cell failed with `42P01` (`receipts/pin-42p01.log`).
- The atomic-output family, 9 files, run one file per process under the
  shared-family stage's ceiling: 32 red cells → 5, all five the defects the
  triage had already classified C and are NOT this unit's (M7 disjoint upsert
  guard ×2, skipDuplicates adopt ×2, the SQLite nested-connect "known" value)
  (`receipts/family/`).
- Docker `pg` (`tests/providers/docker/pg-nested-write-races.test.ts`,
  PostGIS 16 container): 95 / 95 — the five registered kept-red
  `batchPrimaryKeyDataflowContract` cells are green (`receipts/pg-nested-write-races.log`).
- The gate's own stages: the raptor3 fixed stage 758 / 758 (it was 38 red
  before the capability gate: the scripted transport's PostgreSQL dialect
  with `supportsCteWithMutations = false` must keep segmented RETURNING),
  the `raptor3-provider` PGlite stages including the pin, the
  `g29-result-progress-pglite` stage (`receipts/stage-*.log`).
- Fixed modes `g2-baseline`, `g2-contracts`, `g3-transaction-array`
  (`receipts/mode-*.log`); adapters coverage 100 / 100 / 100 / 100; the
  query-engine-core scope over its floors; the coverage policy
  (`receipts/coverage-*.log`); whole-estate typecheck 0 (`receipts/typecheck.log`);
  biome: the touched adapter, script and test files clean, the owner's
  diagnostics identical to its base.

Receipt summary (`receipts/RESULTS.txt`, the run after the dialect-owned store):

```
stage 'Raptor 3 fixed' exit=0  Tests 758 passed (758)
stage 'postgres-identity-scratch' exit=0  Tests 2 passed (2)
stage 'batch-produced-commands' exit=0  Tests 2 passed (2)
stage 'produced-commands.test' exit=0  Tests 2 passed (2)
stage 'g29-result-progress-pglite' exit=0  Tests 1 passed (1)
pins+contracts exit=0  Tests 63 passed (63)
family compound-relation-adoption exit=0  Tests 4 passed (4)
family create-junction-upsert exit=1  Tests 2 failed | 24 passed (26)
family fresh-create-subtree exit=0  Tests 4 passed (4)
family generated-output-fallback exit=1  Tests 1 failed | 4 passed (5)
family junction-produced-identity exit=1  Tests 2 failed | 10 passed (12)
family junction-upsert-arm-probe exit=0  Tests 10 passed (10)
family located-target-depth exit=0  Tests 8 passed (8)
family type-depth-ceiling exit=0  Tests 2 passed (2)
family nested-mutation-routing exit=0  Tests 72 passed (72)
pg-nested-write-races(docker) exit=0  Tests 95 passed (95)
g2-baseline exit=0  Tests 216 passed (216)
g2-contracts exit=0  Tests 216 passed (216)
g3-transaction-array exit=0  Tests 4 passed (4)
coverage:query-engine-core exit=0 All files | 87.46 | 91.01 | 90.59 | 87.46 | 
coverage:adapters exit=0 All files | 100 | 100 | 100 | 100 | 
coverage:policy exit=0
```

## 5. Still red, unverified, blockers

Still red after this unit in the family: the five class-C cells above. Not
measured here: Neon HTTP itself (no credential-free transport; the PGlite
batch-only fixture is the stand-in, and Neon's batch is one transaction on
one session, which the scratch table's lifetime now assumes). Blockers: none.
