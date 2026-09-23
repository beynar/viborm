# Release verdict — the consumption-boundary repairs (2026-09-22)

**Source identity.** Integration branch `closure-s` at `392dfd30c0c7226b8fba0ebd4f8d1366d8bbecbd`, squashed onto `pattern-engine` as one commit (hash in the ledger's final record); the frozen gate, the performance attestation, the footprint and the recount ran on `392dfd30c`, whose `src/`, `tests/`, `scripts/` and `benchmarks/` trees the squash carries byte for byte (the index states the Git tree ids, scoped and named, beside the sha256 digests). Node 24.21.0, the pinned lockfile. Raw gate logs, exit codes and identities: [`gate/`](gate/), assembled in [`index.md`](index.md). A first gate on the pre-G1 tip `74f25f57f` found the two reds G1 repaired; its raw logs were overwritten by this run and are not retained — the two reds and their causal schedules are in [`g1/note.md`](g1/note.md). Hosted Neon / D1 qualification stays **deferred**.

## Outcome

**Locally ready, with the repair prompt's six falsifiers closed through their existing owners.**

| defect family (review of `bc18b4e23`) | repaired at | witness |
| --- | --- | --- |
| Unlocked FOUND observations: a parent connecting to `b2` although its selector named `b1`; a conditional upsert writing `42` after `count` drifted 7→8; a nested upsert changing a profile that moved to another owner | U1 — `CommandExecution.confirmFound` / `Selection.confirm`: before any effect that depends on it, the located row is re-taken UNDER LOCK over the identity, the membership and every matched condition the operation already owns (one statement, the conditions conjoined — G1), and that row is the binding every consumer spends; a lost requirement raises its existing failure; missing-key probes stay unlocked | `mysql2-found-consumption` 12 cells on native MySQL (hooked and lock-held schedules), `sqlite3-found-consumption` 5 |
| Nested membership after the premises: `m1` moved from `t1` to `t2` after the last premise was still deleted by `t1` | U2 — `holdMember`: the captured member's row, parent and junction membership are held through the consuming effect; a future joiner stays outside the bounded worklist; an arbitrary initial filter may change | `pg-captured-set-concurrency` 28 cells (reassignment at both positions, committed-between and uncommitted-waited schedules, nested UPDATE and DELETE, reference and junction membership) |
| Result failure plus listener failure: the cardinality failure and the committed progress were lost | U3 — `capturedMutation` settles the operation's answer inside the existing settlement owner; the cardinality failure primary, the listener failure retained through `retainWriteOutcomeFailure`, the hold released once, `atomicity: "segment"` / `phase: "result"` / `committedSegments: 1` | the two `onWriteOutcome` schedules as registered cells; D-58 carry decoding and `one-write-outcome-composition` unchanged |
| The two measured MySQL default gaps (backslash/newline string defaults; `.dateTime().now()` at the column's precision) | U4 — the MySQL migration driver's own literal spelling and default-expression owners; the containment pin replaced by a round-trip; the attestation intact | `mysql-defaults-docker` 3, `mysql2-schema-attestation` 5, `mysql-strict-mode-docker` 9, the raw-INSERT oracle |
| Evidence and provenance | U5 — the gate enumerates its projects from the workspace (`scripts/closure-final-inventory.mjs`, pinned by `gate-inventory-census.core`); tree ids beside sha256 digests, each scoped; the cost parenthetical corrected (the MySQL introspector is `excluded-shared-boundary`); 527 stated as project executions | this index |

**Deletions.** U1: the found-choice existence loop, a contribution payload no reader consumed, two dead parameters, the duplicated key demand in `relation-body.ts`. U2: one premise statement per captured UPDATE member (replaced by the held read). G1: the per-condition confirmation loop. U4: the MySQL generator-hook override. U5: none.

**Cost, measured on the final source** ([`recount/recount.md`](recount/recount.md)): engine **16,098 → 16,182** token-bearing lines (+84: U1 +41, U2 +37, U3 +9, G1 −3), like-for-like **19,956 → 20,040**, charged perimeter **23,891 → 23,975**; U4's three migration files are `excluded-shared-boundary` and counted apart. Ratios against the recorded old-engine denominators: engine 0.352 of 46,021, 0.402 with the same integration files. The growth is the two lifetimes the review found missing — a locked confirmation of a found row and a held captured member — each one owner.

**Remaining approved restrictions.** Unchanged: D-55, D-56, D-59, D-54, D-9, D-60 (preparation cost), D-62. The batch route's FOUND-consumption premises keep their unlocked form and the CURRENT-reference half of the rule is interactive-only on this tree (recorded in U1's note; no batch-route schedule exists).

## Validation

One frozen local gate on `392dfd30c`, every stage exit 0:

| lane | result |
| --- | --- |
| Whole-estate typecheck | **0 diagnostics** |
| Fixed lane | **955 / 955** |
| `g4/parity` directory in thirds (project executions) | **172 + 140 + 215 = 527 / 527** |
| Nested-write conformance, six files | **172 / 172** |
| g2-baseline / g2-contracts / g1-compare | **216 / 216**, **216 / 216**, **36 / 36** |
| Transport smoke, transaction-array | 1 / 1, 4 / 4 |
| Live PGlite pins | **7 / 7** |
| Census, package build, campaign receipts, coverage-policy self-tests | exit 0 each |
| Native MySQL 8.4, every file the `provider-mysql2` project registers (15, including the two the previous gate omitted) | **753 passed / 0 failed / 1 skipped** |
| Native PostgreSQL 16, every `provider-pg` file (6) | **519 passed / 0 failed / 7 skipped** |

Native MySQL per file:

| `mysql2-cascaded-identity.test.ts` | 4 passed (4) |
| `mysql2-concurrency-policy.test.ts` | 11 passed (11) |
| `mysql2-found-consumption.test.ts` | 12 passed (12) |
| `mysql2-generated-key.test.ts` | 5 passed (5) |
| `mysql2-read-surface.test.ts` | 122 passed (122) |
| `mysql2-reference-representability.test.ts` | 5 passed (5) |
| `mysql2-relations-ddl.test.ts` | 106 passed (106) |
| `mysql2-scalars.test.ts` | 293 passed (293) |
| `mysql2-schema-attestation.test.ts` | 5 passed (5) |
| `mysql2-writes-raw.test.ts` | 93 passed (93) |
| `mysql2.test.ts` | 84 passed | 1 skipped (85) |
| `mysql-strict-mode-docker.test.ts` | 9 passed (9) |
| `decimal-list-defaults-mysql-docker.test.ts` | 1 passed (1) |
| `mysql-defaults-docker.test.ts` | 3 passed (3) |

Native PostgreSQL per file:

| `pg-captured-set-concurrency.test.ts` | 28 passed (28) |
| `pg-nested-write-races.test.ts` | 95 passed (95) |
| `pg-polymorphism-ddl.test.ts` | 60 passed (60) |
| `pg-read-surface.test.ts` | 76 passed (76) |
| `pg-reference-representability.test.ts` | 5 passed (5) |
| `pg.test.ts` | 220 passed | 7 skipped (227) |

**Performance, source-bound on the committed `392dfd30c`** ([`perf/table.md`](perf/table.md), every report protocol-valid, statement counts equal on both arms), the cells the engine repairs can touch, two passes each: `nested-conditional-found/full` **0.960 / 0.957** (was 0.795 / 0.818 at `bc18b4e23` — the measured cost of U1's locked confirmation on a FOUND arm, one read more per found consumption; under the 1.05 budget, reported as the regression it is), `nested-conditional-missing/full` **0.829 / 0.765**, `key-transition-cascade/full` **0.895 / 0.891**, `bulk-update-returning-100/full` **0.937 / 0.942**, `fixed-collection-rowref-1000/parse` **0.693 / 0.680**, `bulk-update-returning-100/prepare` 1.585 / 1.573 at the statement seam (the accepted D-60 cost, untouched).

**Bundles and source, re-measured on the final source** (`receipts/source-size-repair.json`): engine gzip **101,757 B = 0.649** of 156,771 (≤ 0.75), `pg-simple` **193,456 B = 0.737**, `pg-relations` **193,584 B = 0.737** of 262,658 / 262,788 (≤ 1.00).

## Risks

1. **Hosted Neon HTTP and D1 remain unqualified**; deferred by the prompt.
2. **The FOUND rule's current-reference half is interactive-only.** On the batch route a parent-held `connectOrCreate` still spends the plan-time probe's literal; no batch-route schedule exists in the tree. Recorded, not repaired.
3. **The found-arm confirmation costs a locked read per found consumption**: `nested-conditional-found/full` moved from 0.80 to 0.96 of the old engine. Under budget, but real.
4. **One owed witness**: a dual-condition upsert losing only its second matched condition names the first condition's field (G1's documented attribution cost) and has no registered cell.
5. **U4 leaves a third default gap named, not repaired**: an expression default's non-ASCII bytes read back one codepoint per byte; backslashes in enum values stay refused; `NO_BACKSLASH_ESCAPES` servers are outside the supported set.
6. **The first gate's raw logs on `74f25f57f` were not retained**; its two reds are documented in G1's note.
7. **Two files someone else modified in the working tree** — `docs/architecture/raptor3-implementation-plan.md` and `features-docs/recursive-query.md` — are left uncommitted; the repair prompt and the review's witnesses are included as this checkpoint's inputs.
8. **Nothing is pushed.** The push remains Arnaud's.
