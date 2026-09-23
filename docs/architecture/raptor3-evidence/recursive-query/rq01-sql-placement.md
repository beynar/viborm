# RQ-01 — SQL placement and decoder repair ledger (source-bound)

**Status (2026-09-23): the native PostgreSQL and MySQL placements EXECUTED
and green (3 / 3 cells per provider, `rq07-native-lanes.md`); the unit's
whole-unit independent review is still owed** (see "Owed" below). The earlier
status — NOT accepted while the native lanes could not run — is superseded. Everything below is measured on the
uncommitted working tree over HEAD `076fad02b1c77435ce7389a51996163c66aad819`; it is not a
qualification verdict for the feature.

## Source identity

Runtime `v24.21.0` (pinned), `pnpm-lock.yaml` SHA-256 `c366c9806e268e19970626c34e0c5ea1bb74cc7c24b388fa072d580d7bf9aceb`.
Working-tree file digests (SHA-256, first 16 hex) at the time of this ledger:

| file | digest |
| --- | --- |
| `src/query-engine/raptor3/shared/query.ts` | `7ba81f05fd890eb8` |
| `src/query-engine/raptor3/shared/schema.ts` | `ffd0c223e16a9137` |
| `src/validation/relations/recurrence.ts` | `c114679c42337b10` |
| `src/validation/relations/select-include.ts` | `6080563d1a372d82` |
| `src/validation/relations/index.ts` | `39fd7392fcf8c7a4` |
| `src/schema/relation/static-membership.ts` | `c3939a8d52fd063b` |
| `src/client/result-types.ts` | `cf304b71de2feb7a` |
| `src/client/types.ts` | `c659f0ac6b33c27a` |
| `tests/raptor3/recursive-query/provider-sql-fixture.ts` | `96830ff80e5e7b5d` |
| `tests/raptor3/recursive-query/provider-sql-sqlite.test.ts` | `22c332ac8cb44d30` |
| `tests/raptor3/recursive-query/provider-sql-pglite.test.ts` | `469b8d3eb4c8b57a` |
| `tests/raptor3/recursive-query/provider-sql-native.test.ts` | `27d022f2b7e2957c` |
| `tests/raptor3/recursive-query/carrier-boundary.test.ts` | `5b680217244d6eb6` |
| `tests/raptor3/recursive-query/graph-oracle.test.ts` | `322c757ad79a7c48` |
| `tests/raptor3/recursive-query/graph-oracle.ts` | `b7137e9dc3454a2e` |
| `tests/raptor3/recursive-query/fixed-cases.ts` | `2c0d186840c114f9` |
| `scripts/raptor3-manifest.mjs` | `cffec1d6ed92a5ba` |

## What RQ-01 proved so far

| Lane | Result | Log |
| --- | --- | --- |
| SQLite, expanded placement matrix (2 cells: 9 recursive cases + ordinary mutation control; DateTime physical keys) | 2 passed (2) — 20.23s wall, 460.3 MiB peak sampled process-group RSS (sampled ceiling 1536 MiB) | `/tmp/rq01-sqlite-resume-2.log` |
| PGlite, isolated stage `provider-sql-pglite` (1 cell, same matrix) | 1 passed (1) —  | `/tmp/rq01-pglite-resume-2.log` |
| Native PostgreSQL (`provider-sql-native`, 1 cell) | **NOT RUN — engine unreachable** (superseded 2026-09-23: executed and green, `rq07-native-lanes.md`) | — |
| Native MySQL (`provider-sql-native`, 1 cell) | **NOT RUN — engine unreachable** (superseded 2026-09-23: executed and green, `rq07-native-lanes.md`) | — |
| Carrier boundary after the singular-fixture correction, before the decoder repair | 8 passed, 3 failed (11) — 7.46s wall, 404.4 MiB peak sampled process-group RSS (sampled ceiling 1536 MiB). (the three reds = decoder defects 1–3) | `/tmp/rq01-carrier-resume-1.log` |

Each recursive case in the matrix asserts deep equality of the public result,
exactly one `WITH RECURSIVE` statement, a single statement for `findMany`, the
ordinary mutation's statement count for `update` with the write before the
read, and the read before the write for `delete` (pre-delete snapshot).

## Fixture defects corrected at their owner (production not implicated)

1. Four `findMany` cases spelled the compound identity as `where: { tenant_code: … }` —
   the compound selector exists only in the `whereUnique` schema
   (`validation/model/core/where.ts`); the ordinary filter is scalar/relation/
   AND/OR/NOT. Corrected to `where: { tenant: "t", code: … }`; the `update`/
   `delete` cases keep the selector. Before: `ValidationError: Unknown key: tenant_code`.
2. The PGlite suite created its five tables in one script through
   `driver._executeRaw`, whose path is PGlite's single-statement `query`:
   PostgreSQL syntax error `42601` in `beforeAll`, cell skipped. Corrected to one
   statement per call.
3. The carrier's required-singular schema (`nextId: s.string().unique()`, a
   non-nullable self foreign key) fails CM002 ("Circular required relations")
   before any projection is prepared. Replaced by the admitted nullable owning
   relation; the cell now proves empty → `null` and the multiple-successor
   refusal. The required-missing case is unreachable at runtime today and stays
   an explicitly labelled abstract oracle pin.

## Decoder repair (unit `rq-decoder`)

Note: `rq01-decoder-repair.md`. Independent review: REVISE (three minors) →
repaired → re-check ACCEPT. Owner: `Queries.decodeRecursiveCarrier` and
`Queries.jsonValue` in `src/query-engine/raptor3/shared/query.ts`.

| Defect | Repair | Witness |
| --- | --- | --- |
| 1 first hop bypassed the cycle policy | one `follow()` admission for every edge, the outer root seeds the active path | root self-loop: `prevent` → `[]`, `reject` → cycle error, `allow` unfolds to the cutoff |
| 2 recorded edge depth ignored | the existing reachability walk is levelled; bounded-only guard `depth !== false && consumed.size !== facts.size` | wrong-level carrier refused; an identity reached at two depths by different paths accepted |
| 3 cyclic JSON leaf → RangeError | `jsonValue` enters/leaves containers and answers `InvalidScalarResult("json", …)` | cyclic record and cyclic array refused; ordinary JSON pins unchanged |
| 4 quadratic ancestor copying | one active path (`Map<identity,count>`, enter on push, leave on pop) | 12,000-level chain decodes in 65 ms, 425 MiB peak under the 1,536 MiB ceiling; 1,101 cell (108 → 19 ms, one sample each) |

`carrier-boundary.test.ts` 11 → **12** cells (manifest `RQ06_CARRIER_BOUNDARY_COUNTS` updated).
Typecheck on the frozen source: **0 diagnostics** (native, whole estate).

**2026-09-23 — `rq07-review-followups.md` P2.** The levelled walk answers a
third question (a bounded hop below the cutoff must carry the parent's one set
of children at the next level); `carrier-boundary.test.ts` is **13** cells;
the wrong-level carrier (`root→child@2`, `child→grandchild@1`) is now answered
by that hop check at the root's hop, and the consumed-facts guard is witnessed
by a second carrier in the same cell (`rq01-decoder-repair.md`, dated note).

## Integrator confirmation on the frozen source

Run by the integrator on the frozen tree after the decoder repair landed, one
vitest at a time, pinned Node, log `/tmp/rq01-integrator-confirm.log`:

| Lane | Result |
| --- | --- |
| `raptor3` project: `carrier-boundary` (12) + `provider-sql-sqlite` (2) + `graph-oracle` (9) | **23 / 23**, 32.5 s wall, 408.8 MiB peak (ceiling 1,536) |
| `tests/unit/operation-schemas/relations/recursive-query.core.test.ts` (5 cells × 2 projects) | **10 / 10**, 402.4 MiB peak |
| Isolated PGlite stage `provider-sql-pglite` (both projects that collect it) | **1 / 1** and **1 / 1** |
| Native loopback ports (`pg-g3`, `mysql-g3`), read-only TCP probe | **unreachable** — the Docker engine is down; a restart was declined by Arnaud this session |

## Owed before RQ-01 can be accepted

- ~~The native PostgreSQL and MySQL executions of the same matrix~~ — done
  2026-09-23 (`rq07-native-lanes.md`): PostgreSQL 16.14 and MySQL 8.4.11, the
  matrix 3 / 3 cells each, one statement per case; the MySQL run found the
  correlated-CTE materialization defect repaired at the carrier's placement
  (lateral derived table where the provider spells `LATERAL`).
- The independent RQ-01 review over the whole unit (SQL placement + decoder),
  after the native receipts exist.

## After the consumer wave (2026-09-23)

RQ-03/RQ-04 (`rq34-chains-hierarchies-graphs.md`) extended the same fixture and
files: the SQLite provider file is now **15 cells** (matrix + the hierarchy and
graph worlds), the PGlite file **14**, the native file **3 per provider**; the
private pins were migrated to the ordinary projection entry points. The
integrator's confirmation on the merged frozen tree (`/tmp/rq-wave-integrator-confirm.log`):
typecheck **0 diagnostics**; `raptor3` recursive-query files (sqlite 15 +
carrier 12 + oracle 9 + cache-codec 9 + cache-lifecycle 6) **53 / 53**; the four
migrated pins **13 / 13**; admission + schema introspection **48 / 48**; the
PGlite stage **14 / 14** in both projects that collect it; the manifest
self-test **41 / 41** after re-freezing a pre-existing drift (HEAD `076fad02b`
had registered `g4/unit01/count-output-slots.test.ts` without moving the
frozen G4-01 total). The native rows above are still owed: the loopback ports
were probed again after the wave and remain unreachable.
