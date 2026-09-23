# RQ-07 — the recursive-query feature's local release verdict (source-bound)

**Status (2026-09-23, after the native round and the external review's follow-ups): implemented; reviewed unit by unit (RQ-03/04, RQ-02/05, RQ-05 cache, RQ-06, the integration, the native round — each by an independent Opus reviewer — and, last, RQ-01 as one unit and the follow-up round, `rq07-final-review.md`: ACCEPT after one bounded repair round); executed locally on all four providers — SQLite, PGlite, native PostgreSQL 16.14 and native MySQL 8.4.11 — every executed gate stage green.** The external review's three findings (`rq07-review-followups.md`) are repaired on this tree and reviewed: the `_distance` output key has one producer, a bounded carrier that omits a hop's children at a level is refused, the RQ-00 native release stages and the §6 cost cells are recorded (`gate/native-projects/`, `rq07-cost-measures.md`), and the gate re-ran into `gate-2/` and, on the final bytes, into `gate-3/`. The frozen gate first ran on the committed tree `dc662e184` with the native lanes unable to run (Docker engine down); Arnaud then authorized the engine's restart and the native lanes executed (`rq07-native-lanes.md`): they found one production defect on MySQL and two defects of the native runner, repaired at their owners, after which every lane the repairs touch was re-executed on the repaired tree (rows marked *re-run* below). Every gate stage has now run, the docs-site validate last (exit 0, pre-existing warnings only). Hosted providers remain deferred. This is the feature's source-bound verdict for the one local commit; it is not a publication decision.

## Source identity

Recorded by the gate (`gate/identity.txt`, raw logs and exit codes beside it):

```
head 076fad02b1c77435ce7389a51996163c66aad819
tree: dirty tracked 36, untracked 563
src-digest 717fd6b407b8d7c894fd234ab2dd5ea8f215773befa2745d9da06befc2b5289e (tracked src files at their working-tree bytes)
untracked-src src/validation/relations/recurrence.ts 
harness-identity 4145275a0d4217b5c69460f470681007ae397793c9bfb59529422d49597c47f2
node v24.21.0 pnpm 10.11.0 lockfile c366c9806e268e19970626c34e0c5ea1bb74cc7c24b388fa072d580d7bf9aceb
started 2026-09-23T02:30:43Z
 4:30  up 23 days,  4:10, 3 users, load averages: 7.62 7.57 7.75
```

The commit that carries this tree is named in the ledger record below the
gate; its `src/` bytes are the ones the gate hashed (`src-digest` above). The
native round amended that commit: the delta is confined to the tail of
`Queries.lowerRecursiveRelationProjection` (the lateral carrier placement),
`src/query-engine/raptor3/AGENTS.md` (the layer guide's paragraph on the
lateral placement, edited after the native runs),
`tests/raptor3/recursive-query/provider-sql-native.test.ts` and the ledgers;
the re-run stages below were measured on that amended tree. The amended tree's
final `src/`, by the same measure (no untracked `src/` file remains):

```
src-digest 635a16687f88f4cd182afbaa4c70d1f3ab2432a40b6a2945cf64f174f9e60a78 (tracked src files at their working-tree bytes)
```

## Outcome

The approved scope of `features-docs/recursive-query.md` §2 is implemented
through the ordinary relation projection, with one owner per fact. Every unit
was independently reviewed as a whole. Every unit except RQ-01 was reviewed on
the same uncommitted tree over `076fad02b` (Opus author, Opus adversarial
reviewer, one bounded repair round each); RQ-01's whole-unit review (SQL
placement and decoder) and the follow-up round's review ran last, on the tree
over the amended commit `4ead1c591`, and are recorded in `rq07-final-review.md`
(Opus reviewer, one bounded Opus repair round, ACCEPT); RQ-01's decoder repair
had been reviewed first (`rq01-decoder-repair.md`):

| Unit | What it established | Note |
| --- | --- | --- |
| RQ-00 | the frozen contract, placement matrix, owner map, private-pin inventory and the accepted baseline | `rq00-contract-baseline.md` |
| RQ-01 | SQL placement executed on SQLite and PGlite (nine recursive cases + the ordinary mutation control; the DateTime physical-key cell); the four decoder defects repaired at their owners (`decodeRecursiveCarrier`, `jsonValue`): one first-hop-and-later admission rule, levelled reachability at the carrier boundary, the JSON boundary answering its own failure for a cyclic value, one enter/leave active path (12,000-level chain under the ordinary ceilings) | `rq01-sql-placement.md`, `rq01-decoder-repair.md` |
| RQ-03 / RQ-04 | FK chains and hierarchies, junction graphs, through the same projection/lowering/decoder/assembler; `completeOrder` is the one tie-break for ordinary windows and recursion (`recursiveOrder` deleted); the six private pins migrated to ordinary entry points, no compatibility shim | `rq34-chains-hierarchies-graphs.md` |
| RQ-02 / RQ-05 (types) | admission normalized once (`recurrence.ts`), static eligibility on the proven membership machinery, exact options at every nesting level, widened depth, schema-only rendering of the same normalized recurrence as declarations; typecheck zero | `rq-types.md` |
| RQ-05 (cache) | the route's refusal replaced by `recursiveRelationCodec`: iterative enter/leave snapshot and materialization, exact cutoff-key absence / exhaustive-key presence, cyclic snapshots refused, fresh objects and leaves per hit; lifecycle and extension bypasses unchanged | `rq-cache.md` |
| RQ-06 | every RQ-00 placement through the shipped client (12 cells: find verbs, all row-returning mutations incl. both upsert arms and the pre-delete snapshot, arrays with complete preparation before dispatch, borrowed callback transactions, read-only build with D-64 unchanged, 0/1/5 extension chains, default omit, failure identity and acknowledged-progress reporting); the independent oracle reconciled with CM002; **300 / 300** saved cases on SQLite, one statement each | `rq6.md`, `rq6-campaign-sqlite.json` |

**What disappeared (§3.6):** `Queries.recursive()`, the private traversal
types and path decoder, `Queries.recursiveOrder`, the route's recursive cache
refusal, the census's private recursive-read fit (D-54), the per-frame
ancestor copy; the six private pin files now prove their behaviour through the
public projection.

**Cost.** Recount on the frozen tree (`gate/recount/recount.md`, `gate/source-size-rq.json`), like for like against the RQ-00 baseline (core 16,234 code-bearing LOC / 21,095 physical / 799,114 bytes; broader 24,027 / 31,860 / 1,178,227):

| perimeter | files | token LOC | physical | bytes | Δ vs RQ-00 |
| --- | ---: | ---: | ---: | ---: | --- |
| charged engine (`src/query-engine/**`) | 38 | 16,602 | 21,638 | 821,199 | +368 token LOC (+2.3 %) |
| charged, everything the tool charges | 63 | 24,450 | 32,489 | 1,203,542 | +423 token LOC (+1.8 %) |

(The committed tree `dc662e184` measured 16,558 / 21,550 / 817,710 and 24,411
charged; the native round's lateral placement added 22 token lines and the
follow-up round's one-producer guard and per-level hop check 10 more, the
final repair round's nested-spelling guard 5 more; the elegance pass took 42
out and Option B's sixteen reasons put 49 back, net +7 —
`gate-4/recount/recount.md`, `gate-4/source-size-rq.json`.)

The growth is the feature itself — admission (`recurrence.ts`, the node arms), the recursive relation lowering, the carrier decoder, the cache codec and the renderer — minus the deletions named above; no wrapper or renamed code is counted as compression. Bundles on the final source, gzip against the frozen baseline (156,771 / 262,658 / 262,788): engine **104,450 B = 0.666** (≤ 0.75), `pg-simple` **196,091 B = 0.747**, `pg-relations` **196,222 B = 0.747** (≤ 1.00) — the committed tree measured 104,209 / 195,848 / 195,979. Ratios against the old engine's 46,021 token LOC: engine 0.360, like-for-like 20,515 / 49,887 = 0.411.

## Validation

One frozen local gate (`gate/summary.log`, per-stage raw logs and `exit-codes.txt` beside it), serial, pinned Node, every executed stage **exit 0**:

| Stage | Result |
| --- | --- |
| Whole-estate typecheck | **0 diagnostics** (*re-run* on the repaired tree: 0) |
| Fixed lane (`Raptor 3 fixed`, now including the recursive-query SQLite suites) | **1,028 / 1,028** (96 files) |
| Recursive-query deterministic suites (sqlite 15, carrier 12, oracle 9, cache-codec 10, cache-lifecycle 7, composition 12, campaign-sqlite 7) | **72 / 72** |
| Migrated private pins (prep/recursive-read-fit 6, g4/read-recursive-fit 3, unit02/recursive-codec-fit 3, unit01/recursive-vocabulary 1) | **13 / 13**; the registered modes `g4-read-recursive-fit` 3 / 3 and `g3p05-recursive-read-fit` 6 / 6 |
| Admission, schema introspection, relation types (their own projects) | **61 / 61** |
| Isolated PGlite stage `provider-sql-pglite` (matrix + RQ-03/04 worlds) | **14 / 14** (*re-run* on the lateral shape: 14 / 14, `gate/rq-pglite-rerun.log`) |
| `g4/parity` directory, credential-free, in thirds | **172 + 140 + 215 = 527 / 527** |
| Nested-write conformance (six files) | **172 / 172** |
| g2-baseline / g2-contracts / g1-compare / transport smoke / transaction-array | 216 / 216, 216 / 216, 36 / 36, 1 / 1, 4 / 4 |
| Live PGlite scratch pins | 7 / 7 (`gate/pglite-provider.log`, the run on the committed tree `dc662e184`; not re-run — the lateral placement is outside these pins) |
| Refusal census | exit 0 — candidates **36 distinct** at 46 sites (23 before the feature: the retired private fit's sentences and the carrier boundary's now count as public), invariants 23 distinct; self-test 7 / 7 (*re-run*: unchanged). *After F37 (Option B, `rq07-elegance-pass.md`; receipts `elegance-pass/f37-option-b/`)*: candidates **36 distinct at 46 sites**, inherited 75 at 76, invariants **22 distinct at 23 sites**, 203 sites, the same before and after F37 on the elegance pass's tree: F37 moves no count — its sixteen carrier-boundary sites construct `InvalidScalarResult(phrase, reason)`, so the census reads each site's phrase (`recursive carrier`, `recursive depth`, …) where it read `Invalid provider …`, twelve sentences at the same sixteen sites. The moves since the gates are the elegance pass's: invariants 23 → 22 (F24 retired the RQ-5 invariant site) and, against gate-3's 47 candidate sites, 46 (F21 merged the second `recursive identity` site); self-test 7 / 7 |
| Manifest / campaign-receipts self-test, coverage-policy self-tests | exit 0 (*re-run*: exit 0) |
| Package build, source-size and bundle measurement, recount | exit 0 (*re-run*: exit 0) |
| Recursive-query SQLite-facing files (`provider-sql-sqlite`, `composition`, `campaign-sqlite`, `carrier-boundary`; unchanged shape, changed function) | *re-run* **46 / 46** (`gate/rq-sqlite-facing-rerun.log`); modes `g3p05-recursive-read-fit`, `g4-read-recursive-fit` exit 0 (`gate/g3p05-recursive-read-fit-rerun.log`, `gate/g4-read-recursive-fit-rerun.log`) |
| **Native PostgreSQL 16.14** (`provider-sql-native` 3, `campaign-native` 4, `read-envelope-native` 5) | **12 / 12**; campaign **300 / 300** (`rq6-campaign-pg.json`) — first run 11 / 12 (runner defect F1), green after the repairs |
| **Native MySQL 8.4.11** (same files) | **12 / 12**; campaign **300 / 300** (`rq6-campaign-mysql.json`); the two exhaustive spine cases answered by the provider's errno 3636 — first run 6 / 12 (production defect F2, runner defect F3), green after the repairs |
| **RQ-00 native release stages** (`gate/native-projects/`, one file per bounded invocation, after the follow-up round's repairs): `provider-pg` 7 files on PostGIS 16 / 3.4 | **490 passed, 7 skipped (the project's own), 0 failed** |
| `provider-mysql2` 15 files on MySQL 8.4.11 | **793 passed, 1 skipped (the project's own), 0 failed** |
| **Frozen gate, round 2** on the tree with the follow-up repairs (`gate-2/`, 2026-09-23T09:10–09:13Z, src-digest `04903b9b…`, every stage exit 0): typecheck **0 diagnostics**; fixed lane **1,032 / 1,032** (1,028 + the P2 witness + the 3 one-producer cells); recursive-query deterministic suites **76 / 76**; migrated pins 13 / 13; admission + introspection 61 / 61; PGlite 14 / 14; parity 172 + 140 + 215 = **527 / 527**; conformance 172 / 172; g2 216 / 216 twice; g1-compare 36 / 36; modes 3 / 3 and 6 / 6; transport smoke 1 / 1; transaction-array 4 / 4; live PGlite pins 7 / 7; native PostgreSQL and MySQL RQ lanes (`provider-sql-native` 3 + `campaign-native` 4 per provider) **7 / 7 each**, 300 / 300 campaign cases each; census **36 distinct candidate sentences at 47 sites** (46 before: the per-level hop check is one more site of the existing `Invalid provider recursive depth`), invariants 23; self-tests, coverage policy, build, source-size, recount exit 0; **docs-site validate exit 0** (11 pre-existing navigation warnings) | all green |
| **Final repair round** after gate-2 (`rq07-review-followups.md`, "Final repair round"; src-digest `243127df…`) | re-run on the final bytes: recursive-query deterministic **77 / 77**, migrated pins 13 / 13, admission + introspection 61 / 61, typecheck 0 diagnostics, census exit 0 (inherited 76 sites; candidates 36 at 47); not re-run there: the fixed lane (1,033 expected), parity, conformance, PGlite, native lanes, build, recount — all re-run by gate round 3 below |
| **Frozen gate, round 3** on the final bytes (`gate-3/`, 2026-09-23T10:55–10:58Z, src-digest `243127df…`): typecheck **0 diagnostics**; fixed lane **1,033 / 1,033**; recursive-query deterministic **77 / 77**; migrated pins 13 / 13; admission + introspection **61 / 61** (its first invocation was refused by the safe runner's 1,536 MiB RSS ceiling under a machine load of 13–17 before any test ran — 1,548 MiB sampled — and re-run alone: 61 / 61 at 1,405 MiB; both rows in `exit-codes.txt`); PGlite 14 / 14; parity 172 + 140 + 215 = **527 / 527**; conformance 172 / 172; g2 216 / 216 twice; g1-compare 36 / 36; modes 3 / 3 and 6 / 6; transport smoke 1 / 1; transaction-array 4 / 4; live PGlite pins 7 / 7; native PostgreSQL and MySQL RQ lanes 7 / 7 each with 300 / 300 campaign cases each; census 36 distinct candidate sentences at 47 sites, invariants 23; self-tests, coverage policy, build, source-size, recount, **docs-validate** exit 0 | all green |
| **Frozen gate, round 4** on the final bytes — after the elegance pass and Option B (`gate-4/`, 2026-09-23T16:46–16:49Z, src-digest `175e9156…`): typecheck **0 diagnostics**; fixed lane **1,034 / 1,034** (1,033 + composition cell 13); recursive-query deterministic **78 / 78**; migrated pins 13 / 13; admission + introspection **61 / 61** (again refused first by the runner's 1,536 MiB RSS ceiling before any test — 1,536.6 MiB sampled — and re-run alone: 61 / 61 at 1,510 MiB; both rows in `exit-codes.txt`; this stage's four files sit at the ceiling on this machine); PGlite 14 / 14; parity 172 + 140 + 215 = **527 / 527**; conformance 172 / 172; g2 216 / 216 twice; g1-compare 36 / 36; modes 3 / 3 and 6 / 6; transport smoke 1 / 1; transaction-array 4 / 4; live PGlite pins 7 / 7; native PostgreSQL and MySQL RQ lanes 7 / 7 each with 300 / 300 campaign cases each; census **36 distinct candidate sentences at 46 sites** (47 before the pass: one `…recursive identity` site removed), invariants **22 at 23** (23 before: the never-firing assertion removed); self-tests, coverage policy, build, source-size, recount, **docs-validate** exit 0. A first invocation of this round was refused wholesale by a stale run lock left by a stopped gate chain (owner process dead, removed as the harness instructs) and is superseded by this one | all green |
| **RQ-00 native release stages, re-run on the final source** (`gate-3/native-projects/`, 2026-09-23T11:14–11:43Z, head `3c86b331f`, `src/` unchanged since; one file per bounded invocation): `provider-pg` 7 files on PostGIS 16 / 3.4 | **490 passed, 7 skipped (the project's own), 0 failed** — `pg.test.ts`'s first invocation hit the runner's 300 s wall limit while the machine load reached 66 from other sessions' runs (it took 280 s on the earlier green run) and was re-run alone with a 900 s limit: 220 passed, 7 skipped in 796 s at load 32–42; both invocations in `summary.log` |
| `provider-mysql2` 15 files on MySQL 8.4.11 | **793 passed, 1 skipped (the project's own), 0 failed** |
| **RQ-00 native release stages, re-run on the final bytes after the elegance pass and Option B** (`gate-4/native-projects/`, 2026-09-23T16:33–16:45Z): `provider-pg` 7 files | **490 passed, 7 skipped (the project's own), 0 failed**, every file inside the 300 s wall limit this time |
| `provider-mysql2` 15 files | **793 passed, 1 skipped (the project's own), 0 failed** |
| Docs site validate (`blume validate`, run after the native round once the docs workspace's stale module links were re-pointed at the lockfile's virtual-store entries — no install) | **exit 0** (`gate/docs-validate.log`): 0 errors, 11 pre-existing navigation warnings (index-title mismatches and one duplicate sidebar order), none on the feature's page `client/selecting.mdx` |

**Executed, not hosted-qualified.** Every local provider lane the plan names
has run on this tree: SQLite and PGlite in the frozen gate, native PostgreSQL
and MySQL in the native round (`rq07-native-lanes.md`, logs
`gate/native-{pg,mysql}.log`, receipts `rq6-campaign-{pg,mysql}.json`). The
MySQL lane's first execution was the one that mattered: it exposed that MySQL
materializes a correlated recursive CTE read twice once per statement (every
outer row after the first received the first row's facts), which PGlite,
SQLite and single-root cases could not show; the carrier now lives in a
lateral derived table where the provider spells `LATERAL`. RQ-01's
whole-unit independent review is done and ACCEPTS the unit
(`rq07-final-review.md`, section A); the docs-site validate has run (exit 0).
Owed: the hosted Neon/D1 qualification the plan defers.

## Pre-merge elegance pass and Option B (after the closure round)

Arnaud asked for one last pass against `ELEGANCE.md` — duplication, dead
code, needless abstraction, boundary violations — and a check that the
documentation is current, through `/workflows`. Record: `rq07-elegance-pass.md`
(receipts under `elegance-pass/`). Five independent Opus lens reviewers read
the feature's delta and returned 57 deduplicated findings; one Opus author
applied them in two rounds (the first round's hand-off to the author was cut by
a length limit, which its re-check caught; round 2 delivered the remaining 21
in full), one declined by rule (the recursive shape's `optional` flag: a
pinned test and a contract row), each round re-checked to ACCEPT. What
changed in production: one carrier vocabulary constant read by the lowering
and the decoder; one identity encoder for root, key and edge endpoints; the
unread root column dropped from the recursive CTE (each statement ~110
characters shorter); the static recursive type reuses `WrapRelation`; the
default depth stated once; the `_distance` collision sentence owned by one
module; single-use closures inlined; three unreachable guards and a
never-firing assertion removed; the LATERAL arm assembled by the adapter's
SELECT assembly. In tests: shared fixtures replaced copied harnesses
(`recursive-fit-cells.ts`, `cache-world.ts`, `counting-memory-cache.ts`,
`runPlacementMatrix`/`caseOutcome`/`columnDefinitions` in the provider
fixture), two stale review probes that still pinned the retired
`Queries.recursive` were migrated, the census's empty private-fit machinery
was removed; no assertion was deleted or weakened. Documentation: the contract's
§1, §2.3, §3.5 and §5, the plan's status, `PENDING_WORK.md`, `selecting.mdx`
(the `recurse: false` and repeated-key refusals, the FK-cycle error, the
provider-limit identity), `compatibility.mdx`, `errors.mdx`, the layer guides
and the adapter README were brought to the tree's state.

**Option B, Arnaud's decision.** A malformed recursive carrier now has one
public identity: the decoder's sixteen refusals throw `InvalidScalarResult`
with their messages byte for byte, so the caller receives the operation's one
malformed-result `QueryEngineError` V9001 (`Driver "…" returned a malformed
<check> scalar for operation "…": <reason>.`, `meta.scalarType` naming the
kind of check) exactly as for a malformed ordinary row — except, stated once
in §2.3, for a member of a `$transaction([...])` array on a batch-only
transport, where the array owner reports `QueryError` V2001 as it does for
any malformed member. Witnessed through the shipped client (composition cells
12 and 13: four malformed answers, the single-operation batch placement, the
well-formed control); the FK-cycle `QueryEngineError` and CM002 are untouched;
the census counts are unchanged (36 candidates at 46 sites: the twelve
`TypeError` rows became twelve `InvalidScalarResult` rows at the same sites).

## Risks

1. **MySQL's correlated-CTE behaviour is worked around, not understood from
   its source.** The lateral placement is proven by the server experiments
   (E1–E9), 12 / 12 native cells and 300 / 300 campaign cases on MySQL 8.4.11;
   other MySQL versions and MariaDB are unobserved. PostgreSQL takes the same
   lateral shape (PGlite 14 / 14, native 12 / 12); SQLite keeps the scalar
   form. `cte_max_recursion_depth` is now observed natively (errno 3636).
2. **The corpus is thin on sibling ties** (7 of 200 collection/junction cases);
   the tie-break repair is pinned directly instead.
3. **Two observed pre-existing behaviours** recorded by RQ-06, not this
   feature's: a refused duplicate `create` with any relation projection sends
   its INSERT twice in two transactions; a malformed ordinary relation column
   publishes `QueryEngineError` V9001 while the recursive decoder keeps its own
   sentence.
4. **Performance** is measured for transport and output growth (rq34) and for
   the cache and decoder walkers (rq-cache, rq01-decoder-repair); the frozen
   comparator cells touched by this feature's shared owners (`completeOrder`
   on the ordinary order path, `jsonValue`, `decodeValue`) are re-attested on
   the committed tree below — every cell at or under its closure-final ratio,
   the one ratio above 1 (`bulk-update-returning-100/prepare`, 1.56–1.65) being
   the closure-final's own recorded 1.56–1.61, not this feature's. The
   attestation was taken on `dc662e184`; the native round's delta is confined
   to the recursive carrier's placement and two native tests, which none of
   the comparator cells exercise. The follow-up round's hoisted guard in
   `prepareProjection` runs on every comparator cell's preparation (one
   comparison per projected relation field) and was not re-attested.
5. **A pre-existing drift** found on the way: HEAD `076fad02b` registered
   `g4/unit01/count-output-slots.test.ts` without moving the campaign
   self-test's frozen G4-01 total (83 → 84); re-frozen with provenance.

## Performance attestation (on the committed tree)

Source-bound, through the protocol's own comparator
(`benchmarks/operation-pipeline-compare.mjs` at the frozen baseline
`5a37bcd7f`, candidate = this commit in a clean detached worktree, sqlite3,
semantic comparison, cpu mode, 5,000 iterations after 1,000 warm-up, two
independent passes; receipts, per-cell logs and `table.md` in `perf/`).
The cells are the ones this feature's shared owners touch — the ordinary
window tie-break (`completeOrder`), the JSON boundary (`jsonValue`) and the
ordinary row decoder — plus the closure-final's write cells as a control:

| cell | pass 1 CPU ratio | pass 2 CPU ratio | closure-final (b5fde8c1e) | statements |
| --- | ---: | ---: | ---: | --- |
| scalar-find-unique/full | **0.888** | **0.799** | — (new here) | 1/1 |
| fixed-collection-rowref-20/full | **0.924** | **0.965** | — (new here) | 1/1 |
| fixed-collection-rowref-1000/parse | **0.662** | **0.667** | 0.709 / 0.709 | 1/1 |
| nested-conditional-found/full | **0.822** | **0.784** | 0.795 / 0.818 | 4/4 |
| key-transition-cascade/full | **0.913** | **0.910** | 0.907 / 0.908 | 3/3 |
| bulk-update-returning-100/full | **0.963** | **0.943** | 0.935 / 0.942 | 1/1 |
| bulk-update-returning-100/prepare | 1.557 | 1.647 | 1.558 / 1.610 | 1/1 |

All 14 measurements report `measurementProtocolValid: true` with identical
statement counts on both sides. The feature adds no statement and no measurable CPU time to the ordinary read and write paths it shares (the comparator measures statements and time, not allocation; the feature's own parse and cache allocation is measured in `rq07-cost-measures.md`); the `prepare` ratio above 1 is the pre-existing closure-final finding (its explanation and acceptance live in `g4/release/closure-final/`), unchanged in magnitude here. Load during the run: 12.06 / 9.30 / 8.54 at start, so the
absolute microseconds carry noise; the ratios are what the protocol compares.
