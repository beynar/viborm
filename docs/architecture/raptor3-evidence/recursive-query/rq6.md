# RQ-06 — composition through the shipped client, and the 900-case generated campaign (unit `rq6`)

Unit `rq6`, 2026-09-23. Scope: RQ-06 of
[recursive-query.md](../../../../features-docs/recursive-query.md) in full, and
the §5 "Execution placement" and "Resource behavior" rows. This is an author
record, not an acceptance verdict. The independent review, the native
PostgreSQL/MySQL lanes (see "Owed") and RQ-07 belong to their owners.

Two limits on that scope (added in the repair round):

- **"Resource behavior" is covered here only in part.** Composition cell 4
  pins deep-chain stack safety and SQL that does not change with depth. The
  row's other two falsifiers are rq34's, not this unit's. Exhaustive provider
  limit failure without partial success is rq34's two
  `exceedsMySQLRecursionLimit` cases (group "RQ-03 an exhaustive acyclic chain
  beyond the public depth ceiling", run by `provider-sql-native.test.ts`),
  which have never executed on native MySQL. Controlled graph fan-out is
  rq34's ladder cell ("RQ-04 transport grows with distinct edge facts while
  output grows with paths"), recorded green by rq34.
- **Complete array preparation before dispatch is asserted, and holds, on the
  batch transport only** (cell 5). On a transactional driver,
  `executeLegacyArrayTransaction` (`array-transaction-legacy.ts`) admits and
  dispatches each member in turn inside the one transaction. That is the
  existing lifecycle, and recursion does not change it.

## Identity of what was executed

| Fact | Recorded value |
| --- | --- |
| Repository / branch / HEAD | `/Users/arnaud/code/viborm`, `pattern-engine`, `076fad02b1c77435ce7389a51996163c66aad819`. The uncommitted tree was preserved; nothing was staged or committed. |
| Runtime | Node `24.21.0` (`/Users/arnaud/.vite-plus/js_runtime/node/24.21.0/bin`), V8 `13.6.233.17-node.53`, darwin-arm64. Vitest `3.1.4`, better-sqlite3 `12.6.0`, SQLite `3.51.2`. `TMPDIR=/private/tmp/viborm-rq6-tmp`. |
| Harness | `scripts/run-vitest-safe.mjs --heap-limit-mb=768 --rss-limit-mb=1536 --wall-limit-ms=120000`, `scripts/run-typecheck.mjs`. The shared lock was respected; no run overlapped another. |
| Owned files, final SHA-256 (after the repair round) | `campaign-harness.ts` `3bfe24ee…c809` (new; round one `739cb06a…fde9`); `campaign-sqlite.test.ts` `0ec4d9ab…10d8` (new; round one `e85e370c…1fbf`); `campaign-native.test.ts` `a96092b9…4aca` (new; round one `11d8b323…a127`); `composition.test.ts` `4f7785a6…a458` (new; round one `bab476ae…0982`); `fixed-cases.ts` `6a0691a5…d2e4` (was `2c0d1868…3496`); `graph-oracle.ts` `b16b9298…6c49` (was `b7137e9d…8376`). |
| Production read at run time (not edited) | `query.ts` `140edb00…d9cf21`, `shared/schema.ts` `ffd0c223…c5764f`, `client-route.ts` `49deb8d1…33731f`, `cache-value-codecs.ts` `324d612c…3c3484`, `recurrence.ts` `31cfe13c…d90af3`, `select-include.ts` `42275a1a…9989e7`, `relations/index.ts` `621103b0…4a396be`, `result-types.ts` `a308ff18…62c822`, `client/types.ts` `d042c8c9…62ca83`. These are the final bytes the reviewed RQ-03/04, RQ-02/05 and cache units recorded. Their SHA-256 was the same before and after every run below. |
| `src/` content digest (in the receipt) | 442 files, `7668803dd17471278e8689c8c12a0c6450e106359371ba82fce06583b39adba3` |
| Lockfile | `pnpm-lock.yaml` `c366c9806e268e19970626c34e0c5ea1bb74cc7c24b388fa072d580d7bf9aceb` (unchanged) |

The new files are in no manifest yet, because the integrator owns the
manifests. They ran through the scratch workspace
`$TMPDIR/rq6.workspace.mjs`: one inline project that `extends` the repository's
`vitest.config.ts` and includes exactly `composition.test.ts` and
`campaign-sqlite.test.ts`. They still ran through `run-vitest-safe.mjs` and the
shared lock. `graph-oracle.test.ts` ran in the registered `raptor3` project.

## Result in one paragraph

**No production change and no production defect found.** All 12 composition
cells pass through `createClient` on SQLite (a transactional and a batch-only
transport). All 300 saved cases pass on SQLite through the shipped client
against the independent oracle, each in exactly one provider statement that
carries the recursive CTE. The receipt is
[rq6-campaign-sqlite.json](rq6-campaign-sqlite.json). The CM002 reconciliation
flipped 34 singular cases from required to the admitted nullable relation, with
0 graphs changed and 0 expected outcomes changed. The corpus digest moved from
`fab0ccd5…6cdd` to `ff708cf3…fdd7`. **The native PostgreSQL and MySQL halves of
the campaign (600 of the 900 executions) were not executed: the Docker engine is
down.** `campaign-native.test.ts` is written and typechecked, and running it is
owed (see "Owed").

## C1 — CM002 reconciliation of the corpus (`fixed-cases.ts`, `graph-oracle.ts`)

- **Red witness (before).** The pre-reconciliation `fixed-cases.ts` (backup copy,
  served out of tree by a Vite `resolveId` redirect, with the working file
  untouched) was run under the final campaign: **2 failed | 4 passed (6)**. The
  identity cell and the singular-fk cell both stop at
  `rq06:singular-fk:000: a required singular self reference is oracle-only (CM002 refuses its schema)`
  (`$TMPDIR/final-falsify-pre-cm002.log`). The old corpus is self-consistent
  (digest `fab0ccd5…` equal to its own constant). It still declares 34 cases
  that no admitted provider schema can express. The CM002 cell also shows that
  the schema such a case needs is refused:
  `SchemaValidationError`, issues `[["CM002", "Circular required relations: singularNode → singularNode"]]`,
  with no statement sent.
- **The fact.** A singular self slot is required only when its reference columns
  are non-nullable. CM002 refuses that schema before any projection is prepared,
  so every executed singular case uses the nullable owning relation, and a node
  without a target publishes `parent: null`.
- **Owner.** `generateRecursiveCase` in `fixed-cases.ts` owns the corpus. The
  harness's `requireExecutable` (in `campaign-harness.ts`) is the one place
  that refuses an oracle-only case, so such a case is never counted as
  executed proof.
- **Hunk.** `singularMayBeEmpty = profile === "singular-fk" ? true : undefined`
  (was `seed % 3 !== 0`). The ring the required flag used to force is kept,
  stated as `(profile === "singular-fk" && seed % 3 === 0)`, so every graph is
  byte-identical. `RQ06_FIXED_CORPUS_IDENTITY.sha256` is updated, and its comment
  records `fab0ccd5…` and why it was superseded. `graph-oracle.ts` changed in
  comments only: the `singularMayBeEmpty: false` input and the
  `required-singular-missing` outcome are labelled ORACLE-ONLY (CM002). The
  oracle's logic is unchanged.
- **Cases affected: 34** (`rq06:singular-fk:000`, `003`, … `099`, the seeds with
  `seed % 3 === 0`). Serialized cases changed: 34. Graphs changed: 0. Expected
  outcomes changed: **0**, because the kept ring gives every node its one
  reference, so none of the 34 ever reached `required-singular-missing`. Their
  outcomes stay 17 foreign-key cycles and 17 row sets with a cutoff. This was
  computed by evaluating old and new corpora case by case
  (`$TMPDIR/probe/compare.ts`).
- **Digests.** Before `fab0ccd55c6391e4693edc75ed714de624630a90eb858eb8a579b95efea76cdd`,
  after **`ff708cf3e848bb47693109b3dba5486f8770ce7a9d8af9c8aed5333eaffbdfd7`**.
  Both digests were recomputed: the old one from the backup copy, the new one
  by `graph-oracle.test.ts` and by the campaign identity cell.
- **Deleted.** The expression `seed % 3 !== 0`. Nothing else was deleted.
- **Second placement.** The oracle-only outcome still exists for the abstract
  pin. The CM002 cell evaluates a required variant of a saved case with the
  oracle (`required-singular-missing`, source `n0`) beside the schema refusal.
  `graph-oracle.test.ts` keeps its own abstract pin, and I did not edit it.
- **After.** `graph-oracle.test.ts` passed **9/9** (registered `raptor3`
  project). The campaign identity cell passed.
- **Integration note (a file I do not own).** In `graph-oracle.test.ts`, cell
  "freezes 100 reproducible serialized cases per profile", the loop over
  `singularMayBeEmpty === false` entries now iterates zero cases. Nothing
  deleted or skipped it: its subject set is empty because the corpus no longer
  contains an unadmitted case. The fact that replaces it (no executed case is
  required) is asserted by `campaign-sqlite.test.ts` ("executes exactly the
  reconciled corpus…", with `requireExecutable` over all 300 cases). The owner
  of that file should state the replacement there, or retire the loop, and
  label the "reports an absent required singular target" cell as oracle-only.

## C2 — the provider execution harness (`campaign-harness.ts`, new)

- **Fact / owner.** This file owns how one saved case becomes provider rows and
  one public operation, identically on every provider:
  - `campaignSchema`: three self models keyed `(seed, id)`, admitted by schema
    validation. The singular chain uses the nullable owning FK
    `(parentSeed, parentId) → (seed, id)`. The collection hierarchy uses a
    child-held FK. The graph is a paired junction whose columns are
    `from_1, from_2, to_1, to_2`. The published node is exactly the oracle's
    `{ id, order, <relation> }`. `seed` is a key member that is never
    selected, so a compound private identity stays hidden.
  - `PROFILE_WORLDS`: the provider-neutral tables. The SQLite identity cell
    checks them against the admitted schema's own migrated tables (same
    columns, nullability and primary key), so the native DDL spells tables the
    schema actually has.
  - `materialize`: rows under a seed key. A singular edge `from → to` is
    `from`'s own reference; a collection edge is the child `to`'s reference.
  - `publicArgs`: ONE `findMany`, `where: { seed, id: { in: roots } }`,
    `orderBy: { id: "asc" }`, and the recursive slot with the case's own
    `recurse`, `where: { included: true }` and `orderBy: { order }`. The FK
    singular slot takes neither a where nor an orderBy.
  - `judgeCase`: the value must deep-strict-equal the oracle's rows, or, where
    the oracle fails, the error must be `QueryEngineError` with
    `Recursive relation '<relation>' contains a cycle.`. The case must use
    exactly one provider statement, and that statement must carry
    `WITH RECURSIVE`. `isDeepStrictEqual` alone decides the value half
    (repair round R1). A mismatch names the first differing
    enumerable-string-key path, or says that the difference lies outside
    those keys, and the owner it points at. Order-only differences point at
    `Queries.completeOrder` /
    `lowerOrder`; a published-rows vs. cycle-refusal disagreement points at
    `Queries.decodeRecursiveCarrier`; statement count points at
    `Queries.lowerRecursiveRelationProjection`; a non-engine failure points at
    the adapter or provider.
  - `minimizeFailingCase`: greedy deletion (a node with its edges, an extra
    root, an edge) until no single deletion still fails. The result is a
    1-minimal failing graph, re-executed on the same provider.
  - The receipt holds the corpus identity, the source identity (HEAD, the
    `src/` content digest, harness and lockfile SHA-256), the runtime, the
    chunking (derived from the verdicts present, repair round R4), totals,
    and every seed's profile, outcome, occurrence count,
    value digest, statement and recursive-statement count, and verdict. It is
    written only when `VIBORM_RQ06_RECEIPT_DIR` names a directory.
- **Independence.** `graph-oracle.ts` still imports nothing, and the oracle does
  not depend on the harness. The harness imports the oracle and
  the public client surfaces, never a candidate membership, SQL or decoder
  owner. It knows the decoder's public error sentence only.
- **Deleted.** No deletion (new harness).

## C3 — the SQLite campaign (`campaign-sqlite.test.ts`, new, 6 cells)

Each profile is one cell with one in-memory database. The tables are migrated
from the admitted schema by `syncLiveSchema`. The profile's 100 cases are
inserted raw, with FK checks deferred for rings, and
`PRAGMA foreign_key_check` must then be empty. Then one public `findMany` runs
per case through `createClient`. Chunking: **one vitest invocation**, with
three profile cells of 100 cases each plus three small cells. Each invocation
took 4–6 s of wall time, far under the 120 s limit.

| Cell | What it proves |
| --- | --- |
| executes exactly the reconciled corpus, in the admitted schema's own tables | Digest `ff708cf3…`. 300 cases, 100 per profile. `requireExecutable` passes on all 300, every oracle outcome is rows or an FK cycle, and the provider-neutral tables equal the migrated tables. |
| refuses the schema a required singular case needs before any projection (CM002) | See C1. |
| minimizes a failing case to a graph no single deletion still fails (harness self-test) | On a 7-node junction case with the synthetic failure "n6 reachable", the result is one root and one simple path, and every single deletion then passes. |
| singular-fk / collection-fk / junction: 100 saved cases… | Every seed matches the oracle, in one recursive statement. |

**Receipt** [rq6-campaign-sqlite.json](rq6-campaign-sqlite.json) (SHA-256
`3a4afc02…9150`, regenerated in the repair round; round one `3b8a0c63…3bb6`):

- 300 executed, **300 matched, 0 failed**.
- 300 statements, every case exactly 1 with exactly 1 `WITH RECURSIVE`.
- Outcomes: singular-fk 75 rows / 25 FK cycles; collection-fk 86 / 14;
  junction 100 rows. This is exactly the oracle's tally.
- Minimized failures: none.

## C4 — the native campaign (`campaign-native.test.ts`, new, 4 cells per native profile) — RUN 2026-09-23: pg 4 / 4, mysql 4 / 4, 300 / 300 matched on each (`rq07-native-lanes.md`)

This file runs the same saved cases, schema, public read and verdict. Each
profile is one cell and one fresh `runLiveWorld` namespace. The DDL comes from
`PROFILE_WORLDS`: text is `TEXT`/`VARCHAR(191)`, `INTEGER`, `BOOLEAN`. The cases
are the world's initial rows. The client is `createClient` over the world's
observed driver, with no candidate factory, so `assertHealthy` expects 0
candidate entries.

- **Statement attribution** uses only the fixture's public surface. A
  passive `LiveBarrier` (the typed fifth parameter of `runLiveWorld`, which
  returns no cut) records each completed statement's SQL in completion order.
  A case's statements are the completions between its two readings of that
  record. Completions are sequential. The barrier makes the world open its
  idle peer connection. (Repair round R3: this replaced an `observeState`
  counter, so that the in-world minimizer judges with the statement texts.)
- **Incomplete statements** (entered, never completed) fail the cell.
- **Minimization** happens inside the live world. Candidate rows get fresh seed
  keys ≥ 100,001 and are inserted through `driver._executeRaw` into
  `names.table(...)`.
- **Receipts**: `rq6-campaign-pg.json` and `rq6-campaign-mysql.json` in
  `VIBORM_RQ06_RECEIPT_DIR`.

The file typechecks with the estate. **It has never executed.**

## C5 — composition through the shipped client (`composition.test.ts`, new, 12 cells)

The world is `node` (parent/children FK, links/linkedBy junction, notes) plus
`note`, on real in-memory SQLite, with the tables migrated from the schema.
Every expected value is hand-written from the seeded rows. Admission is
counted by spying the one admission boundary, `EngineSchema.prototype.admit`.
The provider view is a `SQLite3Driver` subclass that records every statement,
batch, transaction and control statement.

| # | Placement | What it asserts about statements / authority / errors |
| --- | --- | --- |
| 1 | `findUnique`, `findUniqueOrThrow`, `findFirst` (root `orderBy`+`skip`), `findFirstOrThrow`, `findMany` (root `take`), each under `select` AND `include` (10 calls) | The value, **1 statement carrying the CTE, 1 admission** per call. The `…OrThrow` miss is `NotFoundError` in 1 statement. |
| 2 | `create`, `update` (post-write move, read through recursion), `upsert` create arm, `upsert` update arm, `delete`, each under `select` AND `include` (10 pairs; `include` added in the repair round, R2) | Each is compared with the same mutation using the same slot without `recurse`, in a fresh world: `select: { …, parent: { recurse: true, select: { id: true } } }` against `parent: { select: { id: true } }`, and `include: { parent: { recurse: true } }` against `include: { parent: true }`. For `delete` the slot is `children` with `orderBy: { id: "asc" }`, the same way. The `include` values are hand-written from the seeded rows, with all four scalars at every level. The value, the **same statement verbs in the same order**, 1 recursive statement where the ordinary read sits, the write before the read, 1 admission, and, for the four post-write mutations, the same transaction count. `delete` shows the **pre-delete snapshot**: the whole deleted subtree (`a → a1 → a1x`, `a2`) is published and read before the `DELETE`, and afterwards `a1`/`a2` are detached (ON DELETE SET NULL). |
| 3 | note → node → recursive `children` → notes; `parent` recursion with `children` recursion inside; one slot recursing at two positions (depths 1 and 2) | Values, 1 statement, 1 admission, and **one distinct CTE name per recursive position** (2 and 2). |
| 4 | Depths 1, 2, 8, 32, 100 (`true`), 1000 on a 5,000-row chain, then `depth: false` | 1 statement each. **Byte-identical SQL text for every numeric depth** (depth is a bind). Chain lengths and cutoff ends are read iteratively. The **4,999-hop exhaustive chain** decodes through the client with no stack failure. |
| 5 | `$transaction([...])` | On a **batch-only** transport, `[findMany, findUnique include, create]` runs as ONE batch of 4 statements. The timeline is exactly `admit:findMany, prepare:findMany, admit:findUnique, prepare:findUnique, admit:create, batch:4, dispatch…`: **nothing is dispatched before every member is admitted and prepared**, and nothing is admitted or prepared after. `update`, `upsert` (both arms) and `delete` members refuse the whole array with `TransactionError` and **0 statements**, recursive and ordinary alike (8 worlds). On a transactional driver the array is 1 transaction with 3 admissions, and the pre-delete snapshot sees the earlier member's move. |
| 6 | `$transaction(async (tx) => …)` | 1 transaction (the caller's). Each multi-statement operation is a savepoint: control is exactly `SAVEPOINT, RELEASE, SAVEPOINT, ROLLBACK TO, RELEASE`. The refused (FK-cycle) readback rolls back to **its own** savepoint only. The caller alone decides: commit keeps the earlier update, rethrow loses it. 3 admissions. |
| 7 | `buildStatement()` | A read builds one `WITH RECURSIVE` statement, the same `Sql` object twice, with 0 statements sent. Awaiting the same operation runs exactly that text, with 1 admission in total. `create`/`update`/`upsert`/`delete` with a recursive projection answer `undefined`, and nothing is sent (**D-64 unchanged**). |
| 8 | Extension chains of 0, 1, 5 (each with `request`, `query`, `statement` and `observe`) | Read and mutation values are identical to chain 0, with 1 admission per operation. Each extension ran request ×1, query ×1 and observe(operation) ×1 per operation, and statement and observe(statement) ×1 per statement: exactly `length × (6 + 2 × statements)` calls. Request patches carrying `select`/`include`/`omit` with other recursion are ignored. Query handlers see the **admitted** `recurse` (`{ depth: 2, cycles: "reject" }`, `{ depth: 100, … }`), frozen, and `Reflect.set` returns `false`. A request injecting a top-level `recurse` gets `ValidationError` with 0 statements. |
| 9 | Official `defaultOmit` | `secret` is absent at every repeated level under `include`. An explicit `select` of `secret` inside the recursive node wins at every level. 1 statement, 1 admission. |
| 10 | 6 concurrent recursive reads (`Promise.all`) | Values, 6 statements, 6 admissions, and no object shared across results. |
| 11 | Provider failure | **Read:** the junction table is dropped, and the recursive `links` read publishes exactly what the ordinary `links` read publishes: `QueryError` `V2001` `Query execution failed`, `meta { driver, model, operation }`. 1 statement, no retry, no value. **Write:** a duplicate-id `create` with a recursive readback publishes `UniqueConstraintError` `V3001` `meta.columns ["rq06_composition_nodes.id"]`, the same as the ordinary control. It has the same statement verbs, 0 recursive statements (no readback is sent), and the stored row is unchanged. |
| 12 | Result-phase refusal after acknowledged work (FC-05 / D-58 shape) | The update closes `r → a → a1 → r`, so the recursive readback refuses after the write. The ordinary control's provider answers its readback's relation column malformed. **Batch-only** transport: the recursive primary is the decoder's own `QueryEngineError` (`Recursive relation 'children' contains a cycle.`), and the control's is `QueryEngineError` V9001 (observation 2). Both carry `recordSeriesProgress { atomicity: "segment", phase: "result", committedSegments: 1, committedWriteMembers: 1, completedMembers: 0 }`. That is the payload of G4-02 cell 9 (`uncertain-outcome-meta.test.ts`); FC-05 cell 2 has the same shape for its two-member write. Both leave the row **durable**, cause **1 invalidation**, and complete with `certainty: "committed"`: **no rollback is claimed**. **Transactional** (own region), recursive and control: rolled back, no progress, 0 invalidations, no certainty. |

## Falsification (discriminating power; no working-tree file was mutated)

Each mutant is an out-of-tree copy of one production module served through a
Vite `resolveId` redirect (`$TMPDIR/falsify/redirect-plugin.mjs`,
`redirect-any.mjs`, `make-mutants.py`, `make-admit-twice.py`), with a load
marker that printed in every run. The working files' SHA-256 were identical
before and after every run. All results below are on the final bytes of the
test files.

| Mutant (production rule broken) | Result |
| --- | --- |
| `global-visited`: the decoder never leaves the active path (`query.ts`) | Campaign: **26/100 junction seeds fail**. Each minimizes to the 4-node diamond `n0→n1, n0→n2, n1→n3, n2→n3`, and the owner named is "recursive lowering or carrier decoding". FK profiles stay green, because an FK tree revisits a node only through a cycle, which `reject` refuses anyway. Composition: green (no junction diamond placement there). |
| `tiebreak-desc`: the complete-key tie-break descends (`Queries.completeOrder`) | Campaign: **3 collection-fk and 4 junction seeds fail**. They minimize to a root with two tied children (e.g. `n0 → n1, n2`, all `order 0`), and the owner named is "sibling order: Queries.completeOrder / lowerOrder". |
| `cutoff-published`: the repeated key is published at a numeric cutoff | Campaign: **42 singular, 31 collection, 42 junction seeds fail**. The minimized example is `n0 → n2` at `depth: 1`. Composition: **9/12 cells fail** (1, 3–10). The cells that stay green are 2 (its chains end naturally before depth 100), 11 and 12 (failure paths). |
| `admit-twice`: the command engine drops its one-admission memo (`commands/index.ts`) | Composition: **3/12 fail** (5, 8, 12), the placements where a second consumer (array preparation, interceptor input, cache/outcome route) reads the admitted arguments. |
| `pre-cm002`: the pre-reconciliation corpus (C1) | Campaign: **2/6 fail**, refused as oracle-only. |

## Runs

All runs used Node 24.21.0 and the safe runner, one at a time.

| Command / scope | Result | Wall / peak RSS | Log (`$TMPDIR`) |
| --- | --- | --- | --- |
| rq6-local: `composition.test.ts` + `campaign-sqlite.test.ts`, final bytes, receipt written | **18/18** (12 + 6) | 6.31 s / 602.7 MiB | `final-green-2.log` |
| raptor3: `graph-oracle.test.ts` (final `fixed-cases.ts` / `graph-oracle.ts`) | **9/9** | 3.20 s / 348.6 MiB | `final-graph-oracle.log` |
| Falsification: global-visited (both files†) | 1 failed / 17 passed (the campaign junction cell) | 11.97 s / 607.8 MiB | `final-falsify-global-visited.log` |
| Falsification: tiebreak-desc (both files†) | 2 failed / 16 passed (campaign collection-fk and junction cells) | 4.37 s / 599.5 MiB | `final-falsify-tiebreak-desc.log` |
| Falsification: cutoff-published, both files† / composition on its final bytes | 12 failed / 6 passed (campaign 3 of 6); 9 failed / 3 passed | 4.88 s; 5.12 s / 442.2 MiB | `final-falsify-cutoff-published.log`, `final2-falsify-cutoff-published.log` |
| Falsification: admit-twice (composition) | 3 failed / 9 passed | 4.99 s / 468.8 MiB | `final2-falsify-admit-twice.log` |
| Red witness: pre-cm002 (campaign) | 2 failed / 4 passed | 3.64 s / 490.2 MiB | `final-falsify-pre-cm002.log` |
| Biome `check` (read-only after `--write` on the four NEW files only) | clean | — | — |

† These three runs took the campaign file at its final bytes, which have not
changed since. They took `composition.test.ts` one edit before its final bytes:
cell 5 later gained its refused-verb table. So all three were re-run on the
final composition bytes. Cutoff: 9 failed / 3 passed (the row above). The
other two: `global-visited` **12/12 passed** (`final2-falsify-global-visited.log`)
and `tiebreak-desc` **12/12 passed** (`final2-falsify-tiebreak-desc.log`). The
composition world has no junction diamond and orders only by unique ids, so
graph path pruning and tie order are the campaign's and RQ-03/04's pins, not
composition's.

Timing: in the final run (`final-green-2.log`, one sample on a shared
machine), the campaign took 99 ms for singular, 91 ms for collection and
1,462 ms for junction, per 100 cases. The composition cells took 5–74 ms each.
The previous final-bytes run of the campaign (`final-green.log`) took 68, 48
and 842 ms.

Earlier development runs, kept as history and not attesting the final bytes:
`campaign-sqlite-1.log` (6/6), `composition-1.log` (10/12). The two
composition failures there were test-side: the array deleted `a1`, which a
required note references (FK restrict), and the admitted `recurse` is a
null-prototype record. Both were fixed in the test. Probe runs are under
`$TMPDIR/probe*.log`.

## Typecheck

`node scripts/run-typecheck.mjs` (native TS7, whole estate) on the final bytes:
**exit 0, 0 diagnostics**, 17.68 s, 5,481.5 MiB peak (ceiling 8,192). The
owned and production SHA-256 were identical before and after
(`typecheck-2.log`).

It ran **twice**. The first run (`typecheck.log`, also exit 0 / 0 diagnostics,
11.89 s) predated the last edit to `composition.test.ts` (more
refused-array verbs in cell 5), so it is withdrawn as an attestation of the
final bytes.

A focused JS `tsc` 5.9.3 over the unit's files (`$TMPDIR/probe/tsconfig.rq6.json`,
1,280 MB heap) was used during development: 0 diagnostics.

## Registrations owed (the integrator owns the manifests)

| File | Cells | Project / lane |
| --- | ---: | --- |
| `tests/raptor3/recursive-query/composition.test.ts` | **12** | `raptor3` (`RAPTOR3_DETERMINISTIC_TESTS`), in-memory SQLite, credential-free, e.g. an `RQ06_COMPOSITION_COUNTS` beside `RQ05_CACHE_COUNTS` |
| `tests/raptor3/recursive-query/campaign-sqlite.test.ts` | **7** | `raptor3` (`RAPTOR3_DETERMINISTIC_TESTS`), in-memory SQLite, credential-free |
| `tests/raptor3/recursive-query/campaign-native.test.ts` | **4 per native profile** (pg, mysql) | `raptor3-live-provider`, beside `provider-sql-native.test.ts` (`RQ01_NATIVE_COUNTS` → `G4_NATIVE_PG/MYSQL_*`) |
| `tests/raptor3/recursive-query/graph-oracle.test.ts` | 9 (unchanged) | as registered |
| `tests/raptor3/recursive-query/campaign-harness.ts` | — | helper, not a test file |

**Credential-free walk.** `EXTENDED_LOCAL_TESTS` (in
`scripts/credential-free-test-manifest.mjs`) adopts every `*.test.ts` not
named in `extendedLocalExclusions`. Until the three files are registered and
excluded there, the walk adopts them. `campaign-native.test.ts` would then
**fail at import** in the credential-free lane, because `live-world.ts` asserts
`VIBORM_RAPTOR3_PROVIDER` when it loads, exactly as `provider-sql-native.test.ts`
would if it were not excluded through `G4_NATIVE_*`.

## Owed (native lanes, the integrator's; the engine is unavailable to this unit) — SETTLED 2026-09-23: both lanes executed, 600 / 600 matched (`rq6-campaign-pg.json`, `rq6-campaign-mysql.json`; the MySQL run first failed 62 cases on the correlated-CTE defect, `rq07-native-lanes.md` F2)

`docker ps`: "Cannot connect to the Docker daemon". **600 of the 900
executions are owed:** 300 on native PostgreSQL and 300 on native MySQL, plus
their receipts. Commands, once the file is registered (or through a scratch
workspace that includes it), with the port read silently from the existing
plain-URL files and never printed:

```sh
export PATH=/Users/arnaud/.vite-plus/js_runtime/node/24.21.0/bin:$PATH
VIBORM_RAPTOR3_PROVIDER=pg VIBORM_RAPTOR3_PROVIDER_PORT=<pg-g3 port> \
VIBORM_RQ06_RECEIPT_DIR=docs/architecture/raptor3-evidence/recursive-query \
node scripts/run-vitest-safe.mjs --heap-limit-mb=768 --rss-limit-mb=1536 --wall-limit-ms=120000 \
  run --workspace vitest.workspace.ts --project raptor3-live-provider \
  tests/raptor3/recursive-query/campaign-native.test.ts
# then the same with VIBORM_RAPTOR3_PROVIDER=mysql and the mysql-g3 port
```

If one invocation exceeds the 120 s wall, chunk by profile with
`-t "singular-fk"`, `-t "collection-fk"` and `-t "junction"`. Give each chunk
its own `VIBORM_RQ06_RECEIPT_DIR`. The file name is per provider, not per
chunk, so chunks that shared a directory would overwrite one another. Each
chunk's receipt then holds its 100 verdicts. A complete receipt, or the three
chunk receipts together, must show `executed 300, matched 300` per provider,
and its `corpus.sha256` must be `ff708cf3…fdd7`.

## Measured / not measured

- **Measured.** The SQLite campaign: 300 statements for 300 cases, 900 public
  occurrences in total, and the per-profile wall times above. Composition:
  statement, verb, admission, transaction, batch and control-statement counts
  per placement, recorded in the cells. Resource receipts for every run. The
  corpus diff (34 serialized cases, 0 graphs, 0 outcomes).
- **Not measured.** Anything native. PGlite: the existing `provider-sql-pglite`
  lane was not run, since no file it executes changed in this unit and it is
  not mine. CPU, allocation and peak memory per case. The native campaign's
  wall time.

## Unverified

- The native PostgreSQL/MySQL campaign in its entirety: the completion-order
  statement attribution, in-world minimization through `_executeRaw`, the
  provider version probe, and MySQL specifics. Those are the compound
  `(INT, VARCHAR(191))` CTE column typing, the `BOOLEAN` filter bind, and the
  4-column junction key (1,536 bytes, under InnoDB's 3,072). They are read
  from the code, not observed.
- The composition placements on any provider other than SQLite. The batch-only
  witnesses use a SQLite fixture transport, not Neon or D1.
- The minimizer returns a **1-minimal** graph: no single node, root or edge
  deletion still fails. That is not proven globally minimal. For example, the
  tie-break mutant's `junction:025` minimizes to 4 nodes (`n0 → n1 → n3, n4`).
  A 3-node tie would presumably also fail; that was not run.
- The corpus is thin on sibling ties: only 7 of the 200 collection/junction
  cases exercise the complete-key tie-break (the tiebreak mutant's reds).
  Changing the corpus beyond CM002 is outside this brief.

## Observations for the integrator and engine owners (no action taken)

1. **Double INSERT on a refused create with any relation projection.** A
   duplicate-id `create` whose `select` holds a relation (ordinary or
   recursive) sends its `INSERT` twice, in two transactions, before publishing
   `UniqueConstraintError`. The same `create` without a relation projection
   sends one `INSERT … RETURNING` (probe `$TMPDIR/probe-dup.log`). The
   recursive projection inherits exactly the ordinary route (cell 11 asserts
   equality), so this is existing write-route behavior, not a recursion
   change. It is recorded for the engine owner.
2. **The result-phase primary differs by cause, and the progress does not.**
   A malformed ordinary relation column is published as `QueryEngineError`
   `V9001` "Record-series execution failed at a committed-segment boundary.".
   The recursive decoder's refusal keeps its own sentence. Both carry the same
   `recordSeriesProgress`.
3. `graph-oracle.test.ts`'s required-singular loop now has an empty subject set
   (see C1).

## Blockers

The Docker engine is unavailable, so the native lanes cannot run here. RQ-06's
exit ("all 900 provider/profile seed cases … pass with replayable evidence") is
therefore **not met**: 300 of 900 are executed and green. No repair failed, and
no representation attempt was spent.

## Cost

| File | Physical / code-bearing lines / bytes |
| --- | --- |
| `campaign-harness.ts` (new) | 844 / 685 / 28,848 |
| `campaign-sqlite.test.ts` (new) | 366 / 316 / 12,405 |
| `campaign-native.test.ts` (new) | 292 / 253 / 9,827 |
| `composition.test.ts` (new) | 1,721 / 1,549 / 58,371 |
| `fixed-cases.ts` | +15 / −3 lines against the backup (the reconciliation, its comment, and the identity history) |
| `graph-oracle.ts` | +7 / −1 lines, comments only, 0 logic |
| Production | **0 lines**, no deletion |

## Repair round (2026-09-23)

The independent review returned seven findings: two major, five minor. All
seven were applied exactly as requested and none was declined. No production
file changed: the regenerated receipt's `src/` digest is still `7668803d…dba3`
(442 files), the same as in round one. Backups of every edited file, taken
before the first edit, are in `$TMPDIR/backup-before-repair/`. Their SHA-256
equal the round-one values recorded above, so nothing had drifted.

### R1 (major) — the value verdict is deep-strict equality (`campaign-harness.ts`)

- **Red witness (before).** The probe `$TMPDIR/probe/repair.probe.test.ts`
  imports the round-one harness (the backup copy, byte-identical to
  `739cb06a…fde9`) beside the working one. The case is `rq06:junction:001`.
  Its oracle rows get one extra enumerable `Symbol.for("rq.path")` key on the
  first row, so `isDeepStrictEqual` is false. The round-one `judgeOutcome`
  returned no mismatch, and
  `judgeCase(…, [one WITH RECURSIVE statement]).match` was **`true`**: the
  harness scored the case as a match. The reviewer's Date and Map shapes
  cannot be built from oracle rows, which hold only strings and numbers, so
  the symbol key is the witness (`$TMPDIR/repair-probe.log`).
- **Fact / owner.** `isDeepStrictEqual(oracle.rows, observed.value)` alone
  decides the value half of a verdict (`judgeOutcome`, line 561).
  `firstDifference` only names the difference. When it finds no path, the
  mismatch reads
  `$: differs outside enumerable string keys (symbol keys, Date/Map contents or prototypes)`.
  Its doc comment now says it is a diagnostic.
- **Hunk.**
  `const mismatch = firstDifference(…); if (mismatch === undefined) return {…}`
  became `if (isDeepStrictEqual(oracle.rows, observed.value)) return {…}`,
  with `mismatch: firstDifference(…) ?? "<the sentence above>"`. The header
  comment now says "deep-strict-equal".
- **Deleted.** The rule that decided a match from the path walker's
  `undefined`.
- **Second placement.** `judgeCase` calls `judgeOutcome`, so both campaign
  files' verdicts use the fix, and after R3 both minimizers do too.
- **After.** In the probe, the repaired harness answers the fallback
  sentence with `match: false`, and the exact rows still match (the control).
  The 300 SQLite verdicts did not change: 300 matched.
- **Observation (not changed: outside the requested change).** The owner line
  for such a difference comes from `orderOnly`. That function compares
  canonical JSON, which drops symbol keys and Map contents. In the probe the
  owner reads "sibling order: Queries.completeOrder / lowerOrder". The verdict
  is right, but the owner hint is wrong for any difference that JSON cannot
  see.

### R2 (major) — mutation placements under `include` (`composition.test.ts`, cell 2)

- **Red witness (before).** None by run. The gap was found by reading: every
  round-one mutation in cell 2 was projected through `select`.
- **Fact / owner.** `create`, `update`, both `upsert` arms and `delete` read
  back through their ordinary route under `include` exactly as they do under
  `select`. The owner is the ordinary mutation readback and snapshot route,
  which admission shares through `core.include`.
- **Hunk.** Cell 2 (lines 495–823) is now parametrized over
  `projections = ["select", "include"]`.
  - Each post-write mutation holds its write arguments, its `select` fields
    beside `parent`, and a hand-written `expected` and `control` for each
    projection. The `select` values are the round-one values, unchanged.
  - Under `include`, the recursive slot is `include: { parent: { recurse: true } }`
    and the control is `include: { parent: true }`. Every level carries the
    four scalars, written with the file's `row()` helper.
  - `delete` runs `include: { children: { recurse: true, orderBy: { id: "asc" } } }`
    against `include: { children: { orderBy: { id: "asc" } } }`. Its expected
    value is the full pre-delete subtree: `a` → `a1` → `a1x`, and `a2`.
  - The assertions are the same as in round one, now labelled with the
    projection: value; verb order; 0/1 recursive statements; the readback
    last (post-write) or the snapshot before `DELETE`; 1 admission; the
    transaction count (post-write mutations only, as before); and the
    post-delete rows.
  - Header item 2 and the cell title now name both projections.
- **Deleted.** No deletion. The table's `args(parent)` became
  `args(projection)` plus `selected`, so each round-one `select` request is
  rebuilt to the same shape.
- **After.** Cell 2 passes: 10 recursive/control pairs in 20 fresh worlds.
- **Not done.** No mutant was run against the `include` arm, because no
  falsification was requested. Its discriminating power rests on the
  hand-written values and the route assertions.

### R3 (minor) — the minimizer's predicate is the verdict (both campaign files)

- **Red witness (before).** The same probe replicates both inline
  predicates, because they are not exported. The case is `rq06:junction:001`,
  with its exact rows published by one statement without `WITH RECURSIVE`, so
  `judgeCase` fails it. The round-one predicate
  (`judgeOutcome(…).mismatch !== undefined || statements !== 1`) returned the
  case **unchanged** (5 nodes, 6 edges): every candidate read as passing. The
  repaired predicate reduced it to 1 node and 0 edges, which still fails.
- **Fact / owner.** A candidate still fails exactly when `judgeCase` fails
  it. The verdict function is the one owner, for both choosing which cases to
  minimize and inside `stillFails`.
- **Hunks.**
  - SQLite (`campaign-sqlite.test.ts:357`):
    `return !judgeCase(candidate, observed, driver.statements.slice(start)).match`.
    The selection already used `judgeCase(…).match` (line 348).
  - Native (`campaign-native.test.ts:189–207`): the selection is
    `judgeCase(testCase, observed, completedSql.slice(from, to))`, and that
    verdict is also what the minimized entry records. Round one recorded a
    `judgeCase(…, [])` placeholder there, which the post-hoc mapping then
    replaced; the mapping is kept. `stillFails` is
    `!judgeCase(candidate, result, completedSql.slice(start)).match`.
  - To have statement texts inside the world, the fixture's `observeState`
    counter became a passive `LiveBarrier` (lines 154–158, passed at line 239).
    It is the typed fifth parameter of `runLiveWorld`, and
    `native-constraint-ownership.test.ts:812` already uses a barrier this way.
    It records each completion's SQL in completion order, which is the same
    sequence as `live.completions`. **Consequence:** with a barrier,
    `runLiveWorld` opens its peer pool, one idle second connection per
    profile world, and checks that the two connection ids differ.
- **Deleted.** The two `judgeOutcome(…) … !== 1` predicates, the native
  `observeState` counter, and the `judgeOutcome` import in both files. The
  harness still exports `judgeOutcome`, but only `judgeCase` calls it now.
- **After.** The three SQLite profile cells pass. No seed failed, so the
  minimizer did not run. The native file typechecks and has **not executed**.

### R4 (minor) — `chunking` is derived from the verdicts present (both campaign files)

- **Fact / owner.** A new harness function, `chunkingOf(invocation, verdicts)`
  (line 789), lists each profile the invocation actually executed, with its
  case count. Both files call it. A `-t "junction"` native chunk now reads
  `…; executed junction (100 cases)`.
- **Red witness (before).** By reading: both files hard-coded "100 cases
  each" over all three profiles.
- **Deleted.** The two fixed strings.
- **After.** The SQLite receipt now reads
  `one vitest invocation of campaign-sqlite.test.ts; one cell and one in-memory database per profile; executed singular-fk (100 cases), collection-fk (100 cases), junction (100 cases)`.
  The receipt was regenerated (SHA-256 `3a4afc02…9150`, written first to
  `$TMPDIR/receipt-repair/` and then copied). Field by field, it differs from
  round one only in `chunking` and in the digests of the two edited harness
  files. HEAD, the `src/` digest, the corpus (`ff708cf3…fdd7`), the runtime,
  the totals (300/300/0/300) and all 300 case verdicts are byte-identical.

### R5 (minor) — header item 11 (`composition.test.ts`)

Item 11 now says what cell 11 asserts: no recursion-specific retry or
wrapping; the read is one statement; and the write's statements, including
the ordinary route's re-run of the refused INSERT (observation 1), equal the
ordinary control's. The change is to a comment only.

### R6 (minor) — cell 3's vacuous identity check (`composition.test.ts`)

- **Chosen: delete it, and remove the claim from C5 row 3.** The check
  compared the depth-1 occurrence `{ id: "a" }` with the depth-2 occurrence
  `{ id: "a", children: [...] }`. Their shapes differ, so they could never be
  one object, whatever the decoder did. Deleting it removes no discriminating
  power, so it weakens nothing.
- The alternative (compare two structurally equal occurrences from the two
  positions) was not possible without changing the placement's query. In
  this query, depth 1 publishes `{ id: "a" }` and `{ id: "b" }`. Depth 2
  publishes `a` and `b` with their children, and the cut-off leaves `a1` and
  `a2`. No occurrence has the same shape at both positions.
- Carrier isolation stays witnessed by the two distinct CTE names and the
  depth-specific values.

### R7 (minor) — the scope of the note

The two lines under the scope paragraph at the top of this note name where
the uncovered "Resource behavior" falsifiers are pinned (rq34). They also
say that complete array preparation before dispatch is asserted, and holds,
on the batch transport only.

### Repair-round runs

All runs used Node 24.21.0 and the safe runner, one at a time. The workspace
lock path is `tmpdir()`, which follows `TMPDIR`, so it is **per unit rather
than machine-wide** under per-unit TMPDIRs. Before each run I checked the
process table: no other vitest or typecheck was running.

| Command / scope | Result | Wall / peak RSS | Log (`$TMPDIR`) |
| --- | --- | --- | --- |
| Witness probe (R1, R3): `repair.probe.test.ts`, round-one harness vs working harness | **2/2** (the reds above, recorded as assertions on the old bytes) | 1.19 s / 258.9 MiB | `repair-probe.log` |
| Affected cells: rq6-local, `-t '(2\. create\|3\. nested\|: 100 saved cases)'`, composition cells 2 and 3 plus the three SQLite profile cells, receipt written | **5 passed**, 13 filtered out (18) | 3.18 s / 564.5 MiB | `repair-affected.log` |
| `node scripts/run-typecheck.mjs` (native TS7, whole estate), once, on the final bytes | **exit 0, 0 diagnostics** | 7.94 s / 5,483.7 MiB (ceiling 8,192) | `typecheck-repair.log` |
| Biome `check` (read-only, after `--write` on the four edited test files only) | clean | — | — |

**Not re-run**, per "only the affected cells": composition cells 1 and 4–12,
and the campaign identity, CM002 and minimizer self-test cells. Their code did
not change, but their files did; the filtered run still loaded and collected
both files whole. The round-one falsification table was not repeated and
describes round-one bytes. `graph-oracle.test.ts` was not re-run, because
`fixed-cases.ts` and `graph-oracle.ts` are unchanged.

### Registrations, owed and unverified after the repair round

- **Registrations: unchanged.** `composition.test.ts` 12 cells (cell 2 is
  parametrized inside itself), `campaign-sqlite.test.ts` 6,
  `campaign-native.test.ts` 4 per native profile.
- **Owed: unchanged** (600 native executions). Each native receipt, chunked or
  not, now names the profiles it holds. Each native profile world holds two
  connections while it runs (R3).
- **Unverified additions:** the barrier-recorded attribution, the peer
  connection's identity check and the in-world minimizer on native providers
  (none has executed); the discriminating power of the `include` arm of cell 2
  (no mutant run); and the R1 owner-hint limit noted above.

### Cost after the repair round

| File | Physical / code-bearing lines / bytes | Against round one |
| --- | --- | --- |
| `campaign-harness.ts` | 868 / 699 / 29,733 | +31 / −7 lines |
| `campaign-sqlite.test.ts` | 366 / 316 / 12,379 | +7 / −7 |
| `campaign-native.test.ts` | 301 / 259 / 10,262 | +54 / −45 |
| `composition.test.ts` | 1,853 / 1,677 / 62,667 | +268 / −136 |
| Production | **0 lines**, no deletion | — |

## Post-review addendum (2026-09-23, RQ-07 integrated repair round)

Recorded by the RQ-07 integrated repair author at the integrated review's
request. After the RQ-06 re-check (REVISE, one minor finding: the `orderOnly`
owner hint), the RQ-07 integrator edited three evidence-bearing test files
between 03:13 and 03:15 and regenerated the receipt at 03:13:45, before the
last of those edits. No ledger recorded the edits, their witnesses, a reviewer
or a typecheck until this entry. Each file's before-bytes are reconstructed
exactly (SHA-256 below). Every witness below ran in this round, one vitest at a
time, with out-of-tree copies served by a Vite `resolveId` redirect; no
working-tree file was mutated. Logs are in `/private/tmp/viborm-rq-int-repair-tmp`
(`run-b-finding1-witnesses.log`, `run-d2-green-affected.log`).

### A1 — the `orderOnly` guard (`campaign-harness.ts`)

- **Edit.** The first statement of `orderOnly` is now
  `if (canonical(expected) === canonical(actual)) return false;`, under a
  two-line comment: a difference canonical JSON cannot see is not a
  sibling-order difference. This is the RQ-06 re-check's requested change.
  Before: `3bfe24eeb91c368baef6e1e31ad356394607b308f505aaaf9bc597078640c809`.
  Deleting those three lines from the working file gives exactly that hash,
  which matches the abbreviation at line 33 above.
- **Red (before).** The re-check's probes on `3bfe24ee` named sibling order as
  the owner of an undefined-valued key, a symbol key and a null prototype
  (`/private/tmp/viborm-rq6-review-tmp/r2-owner-probe.log`,
  `r2-owner-probe-2.log`). This round, A2's cell ran against the reconstructed
  `3bfe24ee` harness: **1 failed**, with owner
  `sibling order: Queries.completeOrder / lowerOrder (raptor3/shared/query.ts)`.
- **Green (after).** The same cell passes on the working harness.
  `campaign-sqlite.test.ts` passes **7/7**, and the 300 verdicts are unchanged.
- **Reviewer.** The RQ-06 re-check reviewer specified the change and validated
  it on an out-of-tree patched copy (`r2f/patched`, which differs from the
  landed bytes only in its comment and its absolute imports). The RQ-07
  integrated reviewer read the landed bytes and ran them green
  (`/private/tmp/viborm-rq-int-review-tmp/run1.log`). The re-check's own red
  and green used its probes and its patched copy. This round's red is the
  first time the landed cell (A2) ran against the pre-guard bytes.
- **Final SHA-256.** `beec83251a6ef5a68e26b67ad54b7d938f3d05ee2db206062ff70772883d86d7`.

### A2 — the 7th cell (`campaign-sqlite.test.ts`)

- **Edit.** The new cell is "names lowering or decoding, not sibling order,
  for a difference canonical JSON cannot see". A symbol key on one oracle row
  must be a mismatch whose owner is lowering or decoding, never sibling order.
  The edit also added two top-level regex constants and the `judgeOutcome`
  import. Before:
  `0ec4d9abdbccbdb1eec260a86ccf9eb13564fde5c6848ee634eef8af9c1e10d8`.
  Removing those hunks from the working file gives exactly that hash, which
  matches the abbreviation at line 33 above. The receipt of 03:13:45
  names an intermediate `a777834a…` whose bytes were not kept, and nothing
  attests it.
- **Red (before).** The cell against the pre-guard harness fails (A1).
- **Green (after).** **7/7** on the working bytes. The cell count moves from 6
  to 7 in the registrations table above; the manifest's
  `RQ06_COMPOSITION_COUNTS` already said 7.
- **Reviewer.** The RQ-07 integrated reviewer ran it green (run 1). No reviewer
  had challenged its discriminating power before this round's red.
- **Final SHA-256.** `fd13bb5b7a245323e95d2f3e1d62a835c8644fd7fe4b55ceb98ea28ddf78e430`.

### A3 — the ring assertion and the ORACLE-ONLY title (`graph-oracle.test.ts`)

- **Edit.** C1 above says this unit never edited this file, and its
  integration note asked the file's owner for this change. The cell "reports an
  absent required singular target…" is now titled `ORACLE-ONLY (CM002): …`. In
  "freezes 100 reproducible serialized cases per profile", every singular-fk
  case must now have `singularMayBeEmpty === true`. The ring loop's subjects
  moved from `singularMayBeEmpty === false`, which has been empty since the
  reconciliation, to the kept-ring seeds, `seed % 3 === 0`. The rest of the
  diff is Biome formatting (import order, line wraps). Before:
  `322c757ad79a7c48187b24310d9a77e4efa736a69e5baf9ffcf222f5ac2a686f`, a copy
  preserved in the rq34 review tree (`rq01-sql-placement.md:29` records
  `322c757ad79a7c48`).
- **Red (before).** Two out-of-tree corpora, each run with the old file and
  the new one:
  - the pre-CM002 corpus (`fab0ccd5…`): old file **9/9**; new file **red** at
    `:307` (`rq06:singular-fk:000`);
  - a self-consistent corpus with the ring clause removed: old file **9/9**,
    because its ring loop has no subjects; new file **red** at `:319`
    (`0 !== 1`).
- **Green (after).** On the working corpus, the old file passes 9/9 and the
  new file **9/9**.
- **Reviewer.** The RQ-07 integrated reviewer ran it green (run 1). This
  round's two reds are its first discriminating witnesses.
- **Final SHA-256.** `6fd84700b54159d356d5ce640b38b726008c9352e0fb8f4d10a4bc6c698ad339`.

### The receipt, the typecheck and superseded values

- **Receipt.** `rq6-campaign-sqlite.json` was regenerated on this round's
  frozen tree with `VIBORM_RQ06_RECEIPT_DIR` set. It was written to
  `$TMPDIR/receipt/` and then copied. SHA-256:
  `881ba8994d4020cf47832f919c408e17110f319d345fae1ebd60cc3f9203275f`.
  - Its `source.files` names exactly the bytes above: `campaign-sqlite.test.ts`
    `fd13bb5b…`, the harness `beec8325…`, `fixed-cases.ts` `6a0691a5…`,
    `graph-oracle.ts` `b16b9298…` and the lockfile `c366c980…`.
  - Its `src/` digest is `824cdafb…d893` (442 files) rather than `7668803d…`,
    because this round changed `query.ts`, `recurrence.ts`,
    `cache-value-codecs.ts` and `src/query-engine/raptor3/AGENTS.md` (F5–F8,
    [rq07-integrated-repair.md](rq07-integrated-repair.md)); the guide is under
    `src/` and is hashed with it.
  - Compared field by field with the receipt it replaces (`86da2ebd…`), only
    `source` differs. The corpus (`ff708cf3…fdd7`), runtime, chunking, totals
    (300 / 300 / 0 / 300) and all 300 case verdicts are identical.
- **Typecheck.** The round ran one typecheck, after every edit
  (`node scripts/run-typecheck.mjs`: native TS7, whole estate including
  `tests/**`). It exited 0 with 0 diagnostics, in 8.72 s, at 5,737.2 MiB
  (ceiling 8,192). The owned files' SHA-256 were the same before and after it.
- **Superseded values.** The harness and SQLite-campaign SHA-256 at line 33 and
  the receipt SHA-256 at line 184 are the repair round's values; the values in
  this addendum replace them.
