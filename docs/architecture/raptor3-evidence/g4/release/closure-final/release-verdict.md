# Release verdict — the final local closure (2026-09-21)

**Source identity.** Integration branch `closure-r` at `b5fde8c1eec56992eaadd898c72e462a191151e5`, squashed onto `pattern-engine` as one commit (its hash is in the ledger's final record); the frozen gate, the performance attestation, the bundle and source measurements and the recount all ran on `b5fde8c1e`, whose `src/` and `benchmarks/` the squash carries byte for byte. Node 24.21.0, the pinned lockfile; the harness identity, the per-stage raw logs and exit codes are in [`index.md`](index.md) and [`gate/`](gate/). Hosted Neon / D1 qualification is **deferred** and does not block this local verdict.

## Outcome

**Locally ready.** Every decision of the decided prompt's §1 is implemented, adopted in the ledger (D-64 kept, D-65 both bounds, D-66 native MySQL in local qualification, D-67 the deadlock policy) and witnessed; none is pending.

| resolved behaviour | before | unit |
| --- | --- | --- |
| A `connectOrCreate` CREATE arm producing a NULL referenced value, and a child-held connection to a parent whose referenced field is NULL | wrote the NULL and silently disconnected the holder | R1 — one requirement at `CommandExecution.stored`, the narrower found-choice loop deleted; both directions, found/produced arms, compound references, root/nested, sibling write; native pg and mysql2 witnesses of rollback, borrowed ownership and segmented progress |
| A root captured `updateMany`/`deleteMany` whose captured row stopped matching between premise and effect | mutated it anyway on the batch route | R3 (D-65) — the effect carries the complete captured identity set AND the prepared selector (`Queries.includeIdentities`); a captured row that stopped matching survives; the fewer-rows outcome is the existing cardinality error with truthful acknowledged progress |
| A nested captured series' worklist | an unstated promise about joiners | R3 (D-65) — bounded: capture once, prepare all, execute in order; the pre-unit added-member premise and its recovery stay; a member added after that boundary is outside the worklist; membership and parent requirements stay at their boundaries; over-promising comments corrected |
| Native MySQL: 150 tests stopping at the final schema-fingerprint attestation | `MigrationError … final live fingerprint does not match` | R2a — the introspector's deparse inverse repaired at its owner (two escape layers, apostrophes; a body it cannot own keeps the catalog text and fails closed), the namespace and migration-recovery cells at theirs |
| Descending to-many include ordering, DateTime-list membership, the createMany statement-count pin | wrong order / wrong operands / an obsolete physical pin | R2b — the collection owner keeps the requested order (LIMIT blocks derived-table merge, measured), list members use the field-aware codec, the fold pin re-expressed to rows/values/count/order |
| Four MySQL concurrency cells | `Transaction deadlock detected` | R2c (D-67) — a choose probe no longer locks the absence it is about to insert; a genuine deadlock victim fails visibly with the normalized failure, no replay, no isolation change; the unique-key race converges; an unlocked probe that FINDS a row demands the target's keys so a row moved under it is refused, not silently connected (three shapes witnessed) |
| D-64's witness | in no vitest project | R4 — `read-only-build-contract` registered in the normal inventory |

**What was deleted.** R1: `FieldValue.membership` and the contribution payload no reader consumed, two dead parameters, the `suppliedValues` loop. R2c: the gratuitous `FOR UPDATE` on a choose probe's miss. No wrapper, no rename-for-compression.

**Cost.** Engine 16,040 → **16,098** token-bearing LOC (+58 over this closure: R1 +0, R3 and R2c's demanded-keys arms and the selector composition), like-for-like 19,898 → 19,956, charged perimeter 23,833 → 23,891 (the MySQL introspector repair is charged-integration). Ratios against the recorded old-engine denominators: engine **0.3498** of 46,021, **0.40** with the same integration files, physical 0.35, bytes 0.37 — plan §7's ≤ 0.60 / ≤ 0.70 met. Per-unit table: [`recount/recount.md`](recount/recount.md).

**Remaining approved restrictions.** D-55, D-56, D-59 (output identity, rounding, the two MySQL sentences), D-54 (the private recursive fit), D-9 (borrowed `createMany` `skipDuplicates`), D-60 (preparation cost) and D-62 (the bulk write cell) stand as accepted. The behavioural inventory's dated addendum names every row this closure moved.

## Validation

One frozen local gate on `b5fde8c1e` (`gate/summary.log`, raw logs in `logs/`), every stage exit 0:

| lane | result |
| --- | --- |
| Whole-estate typecheck | **0 diagnostics** |
| Fixed lane | **955 / 955** (89 files) |
| `g4/parity` directory, credential-free, in thirds | **172 + 140 + 215 = 527 / 527** |
| Nested-write conformance (six files, shared-family launcher) | **172 / 172** |
| g2-baseline / g2-contracts / g1-compare | **216 / 216**, **216 / 216**, **36 / 36** |
| Transport smoke, transaction-array | 1 / 1, 4 / 4 |
| Live PGlite pins (isolated stage) | **7 / 7** |
| Census | exit 0 (sentence counts labelled as sentences; the inventory is the capability authority) |
| Package build, campaign receipts, coverage-policy self-tests | exit 0 each |
| Native MySQL 8.4, per file | **735 passed / 1 skipped / 0 failed** across 11 files (was 589 / 160 / 1 at the previous checkpoint) |
| Native PostgreSQL 16, per file | **473 passed / 7 skipped / 0 failed** across 6 files, including the 17-cell captured-set contract and the 95-cell nested-write races |

**Performance, source-bound, on the committed `b5fde8c1e` through the protocol's own comparator** ([`perf/table.md`](perf/table.md), every report `measurementProtocolValid: true`, statement counts equal on both arms): `nested-conditional-found/full` **0.795 / 0.818** CPU, `nested-conditional-missing/full` **0.798 / 0.784**, `key-transition-cascade/full` **0.907 / 0.908**, `bulk-update-returning-100/full` **0.935 / 0.942** (D-62 had accepted 0.963), `fixed-collection-rowref-1000/parse` **0.709 / 0.709** (P1's attestation read 0.669; the read path took R2b's ordering owner — still 0.34 under the 1.05 budget), `bulk-update-returning-100/prepare` **1.558 / 1.610** at the statement seam the frozen series brackets (the perf unit read 1.556 / 1.432 there; D-60's restated budget is stated at D-9's package-seam bracket, 1.33, where this cell last read 1.325 — the preparation cost is the accepted D-60 cost, not a new movement).

**Bundles and source, re-measured on the final source** (`receipts/source-size-final.json`): engine gzip **101,533 B = 0.648** of the frozen 156,771 (≤ 0.75), `pg-simple` **193,224 B = 0.736** and `pg-relations` **193,352 B = 0.736** of 262,658 / 262,788 (≤ 1.00). The earlier 0.646 / 0.735 are historical readings; these are the release numbers.

## Risks

1. **Hosted Neon HTTP and D1 are unqualified.** Their behaviour is derived from a Neon-shaped fixture and from D1's declarations; the live Neon suite is credential-gated and was not run; no live D1 witness exists. Deferred by the decided prompt, stated here so no reader takes the local verdict for a hosted one.
2. **D-65's nested bound is a documented window, not a closed one.** A member that joins a captured series after the pre-unit premise is outside the worklist by contract; `FOR UPDATE` on the interactive route does not exclude phantoms and the code no longer claims it does.
3. **`bulk-update-returning-100/prepare` is the accepted D-60 cost** and reads 1.56–1.61 at the frozen series' statement seam; nothing in this closure touched that path, and the bracket difference (statement vs package seam) is the perf unit's documented finding.
4. **The MySQL lane's green rests on one container and the approved fixtures.** Its deadlock witnesses force schedules through the public client on native InnoDB; a different InnoDB version or isolation default is unmeasured.
5. **Three files someone modified in the working tree during this program** — the first closure handoff (a 5-line pointer to the decided prompt, included in the checkpoint), `docs/architecture/raptor3-implementation-plan.md` and `features-docs/recursive-query.md` (unrelated, left uncommitted) — are not part of the audited work.
6. **Nothing is pushed.** The checkpoint is one local commit on `pattern-engine`; the push, the pull request and the publish remain Arnaud's.
