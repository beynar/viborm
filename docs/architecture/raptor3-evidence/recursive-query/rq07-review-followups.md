# RQ-07 — the external review's findings, closed (source-bound, 2026-09-23)

Arnaud forwarded an external review of the committed feature (`4ead1c591`)
with three findings: a `_distance` output-key collision (P1), a depth lost at
the carrier boundary (P2), and an unfilled release gate (P3: the RQ-00 native
release stages not executed, the RQ-01 whole-unit review still owed, §6 cost
cells unrecorded). Each was verified against the tree before anything moved.
This ledger records the verification, the repair at its owner, the witness
that falsified the old behaviour and pins the new one, and what P3 required.

## P1 — the output key `_distance` had two producers (production, `Queries.prepareProjection`)

**Verified.** A point's distance publishes under `_distance`
(`DISTANCE_FIELD`). `prepareProjection` refused a *scalar* named `_distance`
prepared after a distance (`name === DISTANCE_FIELD && distanceSelected`, in
the scalar arm) and any field of that name prepared *before* a distance
(`fields[DISTANCE_FIELD]` in the distance arm). A **relation** named
`_distance` prepared after the distance met neither guard: the relation arm
wrote `fields["_distance"] = relationShape(...)` over the distance leaf. With
`recurse`, the decoder then wrote the slot over the distance wherever the
repeated key is present and left the distance where a numeric cutoff omits the
key; the live cache codec follows the same shape; and the schema-only
`ExpectedResultShape` guard (`result/result-shape.ts`) ran after the selected
relations but before the *included* ones, so the renderer could declare the
key twice for an included relation.

**Repair (one owner each).**

- `src/query-engine/raptor3/shared/query.ts`, `prepareProjection`: the guard
  "`_distance` after a distance" is hoisted above the scalar **and** relation
  arms (the variants arm included); the distance arm's "`_distance` before a
  distance" guard is unchanged. One sentence, both orders, every producer:
  `A distance result cannot be selected together with a model field named
  '_distance'.` — the refusal that already existed for a scalar.
- `src/query-engine/result/result-shape.ts`: the same guard moves after both
  `addSelectedRelations` calls and the polymorphic ones, so the schema-only
  shape refuses an included relation of that name exactly as a selected one.

**Witness** `tests/raptor3/recursive-query/distance-key-collision.test.ts`
(3 cells, registered as `RQ07_FOLLOWUP_COUNTS`): the engine entry refuses the
pair in both selected orders and in the included spelling; the shipped client
with the cache extension refuses both selected orders with **zero statements
and zero cache writes**; `renderOperationResultType` refuses both with the
same sentence and, for each producer alone, renders `_distance: number` or
`_distance?: Array<VibORMRecursiveNode1>` — never both; each producer alone
prepares with its own key (`scalar` leaf vs `recursive` shape) and the
expected SQL. Admission refuses `select` beside `include` at one level
(V4001), so the included spelling is public only below admission; the cell
says so. Lowering-only on the PostgreSQL adapter with PostGIS: the refusal
precedes the first statement, and no PostGIS-less local provider spells a
distance.

## P2 — a bounded carrier could unfold an occurrence it never transported (production, `Queries.decodeRecursiveCarrier`)

**Verified.** The decoder validated every bounded edge fact against the level
it is reachable at (the levelled walk) and that every fact is consumed, then
unfolded each occurrence from `successors.get(parent)` — the parent's distinct
children over the *whole* edge index, at *every* level the parent is reached.
A carrier holding `near → leaf @2` and `far → near @2` but **not**
`near → leaf @3` passed both checks (every present fact is reachable and
consumed) and still produced `leaf` under the `near` reached at level 2: an
occurrence the provider never transported. The engine's own statement cannot
produce that carrier — it discovers a parent's children at every level it
reaches the parent, the collection filter prunes each hop identically, and
cycle prevention is the decoder's, not the statement's — so this was the
carrier boundary failing to refuse a malformed provider result.

**Repair.** In the levelled walk, each bounded hop below the cutoff now
compares the children it finds at the next level with the parent's one answer;
a difference is the existing refusal `Invalid provider recursive depth` (a
hop the provider did not discover). `successors` stays the one answer per
parent, taken once; the unfold is unchanged. The doc comment names the three
questions the walk answers.

**Witness** `carrier-boundary.test.ts`, new cell "refuses a bounded carrier
that omits a hop's children at one level a parent is reached" (12 → 13 cells,
manifest updated): the exact carrier the review described. Before the repair
the cell failed with *Missing expected exception* (the decoder answered with
the invented `leaf`); after it, 13 / 13. The legitimate converging carrier
beside it (both levels transported) still decodes.

## P3 — the release gate

1. **The RQ-00 native release stages** (`rq00-contract-baseline.md`: the
   7-file `provider-pg` project and the 15-file `provider-mysql2` project, one
   file per bounded invocation, credentials from the environment) are executed
   on this tree by `native-projects.sh` (scratchpad; the inventory read from
   `scripts/closure-final-inventory.mjs providers`, the exact list owner):
   logs and per-file exit codes in `gate/native-projects/`. `provider-pg` ran
   from `/private/tmp/viborm-fc-env/pg`, `provider-mysql2` from
   `/private/tmp/viborm-m1-env/mysql`. The stage logs carry neither container
   names nor server versions. A read-only `docker inspect` of the port each
   file names (read silently) maps them to `viborm-triage-pg-20260918` (image
   `postgis/postgis:16-3.4`, restart policy `no`) and
   `viborm-triage-mysql-20260918` (image `mysql:8`, restart policy `no`, up
   since 06:55:57Z, the native round). The versions come from the image tag
   (PostGIS 16 / 3.4) and from the native round's observation (MySQL 8.4.11),
   not from these logs. **The PostGIS container's start:** it had stopped with
   the engine at 06:55:13Z; the integrating session itself started it at
   **08:47:16Z** (`docker start viborm-triage-pg-20260918`, its own command,
   recorded in the session transcript), nine minutes before the stage began
   (08:56:34Z), to run the `provider-pg` project this finding requires. No
   authorization was asked for that start: the session's one explicit Docker
   authorization is Arnaud's "go ahead restart" (06:52:25Z, the engine
   restart), and the forwarded review (08:43:05Z) asked for the complete
   native projects, not for a container start. The handoff's rules ("never
   quit/launch/restart Docker Desktop or any app or service") did not permit
   it; it is recorded here as a deviation from them.
   Results (`gate/native-projects/summary.log`, 2026-09-23T08:56–09:10Z, tree
   `4ead1c591` + this round): **provider-pg 7 / 7 files, 490 cells passed,
   7 skipped** (the project's own pre-existing skips: `pg.test.ts` 220 passed
   | 7 skipped); **provider-mysql2 15 / 15 files, 793 cells passed, 1
   skipped** (`mysql2.test.ts` 84 | 1 skipped); no failure, exit 0 on every
   invocation. Re-run on the final source after the final repair round
   (`gate-3/native-projects/`, head `3c86b331f`): the same 490 + 7 and 793 + 1,
   0 failed; `pg.test.ts`'s first invocation hit the runner's 300 s wall limit
   at a machine load of 66 and passed alone under a 900 s limit (796 s).
2. **The §6 cost cells** are recorded in `rq07-cost-measures.md`
   (`perf/rq07-cost-measures.json`): depths 1 / 2 / 8 / 32 / 100 / 1000, the
   exhaustive 1,100 chain, widths 1 / 2 / 8 / 32 at depth 2, diamonds and
   cycles, each with statements, SQL/bind sizes, transported facts,
   occurrences, output bytes, CPU, wall, heap delta, and the peak RSS.
3. **RQ-01's whole-unit independent review** and the review of this round
   run as one Opus adversarial review after the gate; its record is
   `rq07-final-review.md`.
4. The verdict's wording: "independently reviewed" is narrowed to name what
   was reviewed and by whom, unit by unit, until the whole-unit RQ-01 review
   exists.

## Re-verification (this round)

The frozen gate re-ran on the repaired tree into `gate-2/`
(2026-09-23T09:10–09:13Z, src-digest `04903b9b…`, every stage exit 0):
typecheck 0 diagnostics; fixed lane 1,032 / 1,032 (1,028 + the two witnesses'
4 cells); recursive-query deterministic 76 / 76; migrated pins 13 / 13;
admission + introspection 61 / 61; PGlite 14 / 14; parity 527 / 527;
conformance 172 / 172; g2 216 / 216 twice; g1-compare 36 / 36; native RQ lanes
7 / 7 per provider with 300 / 300 campaign cases each; census 36 distinct
candidate sentences at 47 sites (one more site of `Invalid provider recursive
depth`); self-tests, build, source-size, recount, docs-validate exit 0. Engine
16,590 token LOC (+10 over the native round: the hoisted guard and the
per-level hop check); bundles 104,335 / 195,980 / 196,111 B gzip.

## Final repair round (2026-09-23, after the final review's findings)

The final adversarial review (RQ-01 as one unit, and this ledger's round)
returned one major and ten minor findings. Each was applied as requested and
none was declined; where a finding offered a choice, the row names the one
taken. Times are UTC (the vitest logs print UTC+2). Receipts are in
`final-repair/` beside this ledger: each log is its run's own bytes, the
probes are kept as `.mjs.txt`, and `final-repair/exit-codes.txt` has one row
per run. Source identity: HEAD `4ead1c591`. By the gate's measure the
`src-digest` was `04903b9b…` before the round (gate-2's, so `dist/` is this
tree's pre-repair build) and is
`243127df7dfc7e6ce592cbdad63d2ca2e979c1bada4df14a8870ffef23b28237` after it.

| finding | change | file(s) | run |
| --- | --- | --- | --- |
| **major**: P1 was not closed. A recursive slot named `_distance` whose repeated node selects a point's distance gives that node's `_distance` key two producers. Admission and preparation accepted it; the decoder published the slot at every level before the cutoff and the distance at the cutoff; the renderer declared the key twice. | `Queries.relationShape`'s recurrence arm throws `DISTANCE_NAME_COLLISION` when the node's own shape already holds a field named after the edge. Admission refuses the asking key there, so only a distance can put it there. `addSelectedRelations` mirrors the refusal for the schema-only shape when a recurrence is admitted, the relation is `_distance` and the nested shape has `distanceScalar`. The sentence is unchanged; `result-shape.ts` now states it once, as a constant its two sites share. The witness adds the nested spelling to the engine entry, the shipped client (plain and `$withCache()`) and `renderOperationResultType`. | `src/query-engine/raptor3/shared/query.ts`, `src/query-engine/result/result-shape.ts`, `tests/raptor3/recursive-query/distance-key-collision.test.ts` | Before (`01-red-before.log`): 2 of 4 cells red, the engine entry and the renderer, both with *Missing expected exception* on the nested payload. The built package accepted the same payload through the shipped client (`00-dist-probe-before.log`): the plain read sent 1 statement; `$withCache()` sent a second, with 1 cache read and 1 cache write. After (`04-green-after.log`): 4 / 4. Falsified by removing each guard in a backup copy (restored by `cp`): without the engine guard only the first cell is red (`05-falsify-engine-guard.log`); without the schema-only mirror only the renderer cell is red (`06-falsify-schema-only-mirror.log`). Each view's guard has unique coverage. |
| minor: the cache assertion proved nothing, because the plain `findMany` never reaches the cache. | The cell's cache half reads through `client.$withCache().place.findMany(args)` for the three public spellings, beside the plain read. It asserts `memory.reads === 0` and `memory.writes === 0` beside `driver.statements === 0`. | `distance-key-collision.test.ts` | Green after (`04`). The probe (`00`) shows the gap the finding named: the accepted plain read made 0 cache reads and 0 writes, while the `$withCache()` read made 1 of each. |
| minor: the schema-only hunk had no red witness. | Option (a): the hunk stays, and a new cell, "refuses the included spelling in the schema-only shape below admission", calls `buildExpectedResultShape(place, "findMany", included, index)` with the index from `new EngineSchema(schema)` and expects the collision sentence. The P1 paragraph's "the renderer could declare the key twice for an included relation" therefore describes the schema-only shape below admission: `renderOperationResultType` itself never reaches that spelling, because admission refuses it first (V4001). | `distance-key-collision.test.ts` (3 → 4 cells) | Red on HEAD's `result-shape.ts` bytes (`02-falsify-head-result-shape.log`: *Missing expected exception*; the shape built both producers). Green on this tree (`04`). |
| minor: P2 had taken over the only witness of the consumed-facts guard (the bounded `consumed.size !== facts.size` refusal). | The wrong-traversal-level cell also refuses `root→P@1`, `P→C@2`, `P→C@3` through `graphDecoder({ depth: 3, cycles: "prevent" })` with `Invalid provider recursive depth`. | `tests/raptor3/recursive-query/carrier-boundary.test.ts` (13 cells, unchanged) | Green (`04`). With the guard deleted in a backup copy (restored by `cp`), that cell is red at the new assertion and the other 12 pass (`03-falsify-consumed-guard.log`). |
| minor: the invariant P2 relies on was stated only at the decoder. | One sentence in `lowerRecursiveRelationProjection`'s doc comment. | `query.ts` | Comment only. |
| minor: the per-level check wrote its own "below the cutoff". | The condition reads `carriesRepeatedKey(shape.recurrence.depth, level)`, the owner of that fact. | `query.ts` | Equivalent by definition (`depth === false \|\| level < depth`, under `depth !== false`). After: carrier-boundary 13 / 13 and the recursive-query deterministic suites 77 / 77. |
| minor: the distance arm's comment was stale. | It points at `buildModelShape`'s guard after every producer and says "a field of that name: scalar, relation or variant slot". | `query.ts` | Comment only. |
| minor: RQ-01's two ledgers predate P2. | A dated note in each: the walk's third question, 13 cells, and the wrong-level carrier now answered by the hop check. In `rq01-decoder-repair.md` the note also reads round A's falsification and the second "Left unverified" item against P2. The native rows of `rq01-sql-placement.md` are marked superseded by `rq07-native-lanes.md`, and the garbled cell reads "8 passed, 3 failed (11)" again. | `rq01-decoder-repair.md`, `rq01-sql-placement.md` | Text. |
| minor: the verdict's wording. | Line 3 names RQ-01's whole-unit review and the follow-up round's review as the ones still owed, and says the findings are "repaired on this tree, pending that review". Line 41 reads "and the follow-up round's review are `rq07-final-review.md`". Risk 4 adds that the hoisted guard in `prepareProjection` runs on every comparator cell's preparation (one comparison per projected relation field) and was not re-attested. | `rq07-release-verdict.md` | Text. |
| minor: the environment record of the RQ-00 native stages. | P3 item 1 above records the container mapping, where the versions come from, and the PostGIS container's start: 08:47:16Z, by the integrating session, with no authorization asked, a deviation from the handoff's rules. | this ledger | Read-only `docker inspect` by port (`13-docker-inspect.log`; ports read silently, no connection string printed). The start's author and time come from the session transcript; `docker inspect` gives the same `StartedAt`. |
| minor: how often each provider evaluates the recursion was unrecorded. | The cost ledger's "Not measured here" bullet and the layer guide's SQLite clause now say that SQLite evaluates it once per reader (twice per carrier) and PostgreSQL once per outer row. No number is claimed. | `rq07-cost-measures.md`, `src/query-engine/raptor3/AGENTS.md` | Checked on the engine's own statement from the built package; this round changed no SQL. SQLite 3.51.2 (`better-sqlite3`, the engine's driver) plans two `MATERIALIZE __q1_recursive` blocks, one under each reader (`10-sqlite-plan-probe.log`). PGlite (PostgreSQL 17.4) plans one `CTE __q1_recursive` inside the lateral subplan, read by two `CTE Scan`s (`11-pglite-plan-probe.log`). |

### Runs

| log (`final-repair/`) | what ran | result |
| --- | --- | --- |
| `00-dist-probe-before.log` | the built package, the nested spelling through the shipped client with a lowering driver | plain: accepted, 1 statement, 0 reads, 0 writes; `$withCache()`: accepted, 2 statements, 1 read, 1 write (cumulative) |
| `01-red-before.log` (09:56:59Z) | `raptor3`: `distance-key-collision` + `carrier-boundary`, test edits only | exit 1: 2 failed, 15 passed (17) |
| `02-falsify-head-result-shape.log` (09:57:55Z) | the new cell on HEAD's `result-shape.ts` bytes | exit 1: 1 failed, 3 skipped |
| `03-falsify-consumed-guard.log` (09:58:05Z) | `carrier-boundary` with the consumed-facts guard deleted | exit 1: 1 failed, 12 passed |
| `04-green-after.log` (09:58:42Z) | both files, after the repairs | exit 0: **17 / 17** (13 + 4) |
| `05-falsify-engine-guard.log` (09:58:54Z) | `distance-key-collision` with the `relationShape` guard removed | exit 1: the first cell only (1 failed, 3 passed) |
| `06-falsify-schema-only-mirror.log` (09:59:02Z) | the same file with the `addSelectedRelations` mirror removed | exit 1: the renderer cell only (1 failed, 3 passed) |
| `07-rq-deterministic.log` (09:59:21Z) | gate-2's `rq-deterministic` command (8 files) | exit 0: **77 / 77** (76 + the new cell) |
| `08-rq-migrated-pins.log` (09:59:32Z) | gate-2's `rq-migrated-pins` command | exit 0: **13 / 13** |
| `09-rq-admission-introspection.log` (09:59:36Z) | gate-2's `rq-admission-introspection` command | exit 0: **61 / 61** |
| `10-sqlite-plan-probe.log`, `11-pglite-plan-probe.log` | `EXPLAIN` of the engine's statement from the built package | see the last row above |
| `12-typecheck.log` (10:03:12Z) | `node scripts/run-typecheck.mjs`, once, on the final bytes | exit 0, **0 diagnostics**, 8.32 s wall, 4,953.7 MiB peak (ceiling 8,192) |

Each falsification restored its file by `cp` from a backup and re-read its
SHA-256. `query.ts` was `c4924841…` before the repair and is `54eff16f…` after
it; `result-shape.ts` was `8ada83aa…` and is `d91b1789…`. The typecheck ran
between two identical readings of the four code and test files; the test
files end at `588a0ebb…` (`distance-key-collision`) and `84831b8f…`
(`carrier-boundary`).

**Not run, and why.** This round changed no lowering code: the one
`lowerRecursiveRelationProjection` hunk is its doc comment, the new refusal
fires before lowering, and the decoder's condition is the same predicate read
through its owner. No statement differs, so the isolated PGlite stage and the
native lanes were not re-run. The fixed lane, parity, conformance, the
census, the recount, the bundles and the build were not re-run either (no
wide runs). The census counts the `relationShape` throw as one more inherited
site of the registered `_distance` sentence (inherited 75 → 76 sites, total
204 → 205; candidates unchanged at 36 sentences / 47 sites; measured
read-only by the final review). The token recount grows by the two guards and
was not measured there (gate round 3 measured it: engine 16,595 token LOC).

**Registrations owed (manifest owner).** In `scripts/raptor3-manifest.mjs`,
`RQ07_FOLLOWUP_COUNTS` still declares `tests/raptor3/recursive-query/distance-key-collision.test.ts`
at 3 cells; the file now has **4** (no script reads the value today).
`RQ06_CARRIER_BOUNDARY_COUNTS` is unchanged at 13. The fixed lane collects
the file, so its total on this tree would be 1,033 (not run). The handoff's
and the verdict's gate-2 counts describe the tree before this round.

**Unverified.** The shipped client after the repair is witnessed through the
source (vitest), not through a rebuilt `dist/`. The static result type
(`src/client/result-types.ts`) of the refused nested pair was neither changed
nor examined; the finding asked for no change there, and the refusal comes
before any value exists. PostgreSQL's plan was read on PGlite, not on the
native server. The plan readings claim no work or time.
