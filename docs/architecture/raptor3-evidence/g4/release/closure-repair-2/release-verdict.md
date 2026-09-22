# Release verdict — the three gaps closed (2026-09-22)

**Source identity.** Integration branch `closure-t` at `afaf711e41ce93705f9f7883b584efdd42dd8e36`, squashed onto `pattern-engine` as one commit (hash in the ledger's final record); the frozen gate, the performance attestation, the footprint and the recount ran on `afaf711e4`, whose `src/`, `tests/`, `scripts/` and `benchmarks/` trees the squash carries byte for byte ([`index.md`](index.md) states the Git tree ids beside the sha256 digests, each scoped). Node 24.21.0, the pinned lockfile. Raw gate logs, exit codes and identities: [`gate/`](gate/). Hosted Neon / D1 qualification stays **deferred**.

**Editorial correction (2026-09-22; no receipt was relabelled).** The preserved
`gate/mysql2__*.log` files sum to **793 passed / 0 failed / 1 skipped across 15
files**; the earlier 758 subtotal omitted the 35 passing cells in
`mysql2__decimal-wide-arithmetic-docker.log`. The preserved `gate/pg__*.log`
files sum to **490 passed / 0 failed / 7 skipped**, not 525. The generated index
and per-file inventory were already correct. The performance sentence below
also overstated the witness: `nested-conditional-found/full` is 4 baseline
statements/round trips versus 5 candidate statements/round trips in both
passes. The raw logs and performance JSON remain unchanged.

## Outcome

**Locally ready; the three gaps the previous verdict recorded are closed at their existing owners.**

| gap (verdict of `88fe2814b`) | closed by | witness |
| --- | --- | --- |
| Batch reference reuse: on the batch route a parent-held `connectOrCreate` spent the plan-time probe's literal, so a recycled key connected another row | T1 — `CommandExecution.folded` gains one selector arm: where the probe read unlocked and the route is the batch one, the holder's own statement reads the reference where it is spent, a scalar sub-select pinned to the located row's COMPLETE captured identity (`Queries.includeIdentities`), never to the public selector; the presence premise is held; a NULL transition refuses through R1's shared representability requirement | `sqlite3-batch-reference-reuse` 11 cells on both local forced-batch fixtures (session-keeping and sessionless), `pg-batch-reference-reuse` 6 cells on native PostgreSQL's forced batch profile: recycled key, compound column-mapped reference, disappearance, NULL transition, concurrent reassignment, root and nested placement; uncontended consumption still commits; the interactive route unchanged |
| Dual-condition attribution named the first condition | T2 — the one combined confirmation kept (no added round trip); a conjoined loss reports that a matched requirement changed, without naming one condition; a single condition keeps its exact sentence | `sqlite3-found-consumption` 5 → 10 cells, `mysql2-found-consumption` 12 → 15: first-only, second-only, both changing — the error, the unchanged row, no consuming write; the new public sentence registered in the refusals map |
| MySQL literal boundary: `mysqlEnumType` spelled its own literal; an expression default's non-ASCII bytes came back one codepoint per byte | T3 — one string literal (`mysqlStringLiteral`, the enum rule deleted); the loss located at ONE boundary — the catalog prints a stored expression's literal one byte per character behind its frozen `_charset` introducer — and read there with the charset the introducer names (UTF-8 family decoded; `ascii`/`binary` the bytes themselves; `latin1` MySQL's Windows-1252), fail-closed for a charset it does not own | `mysql-provider-free-catalog.core` 5 → 7 cells (+ the cp1252 body), `mysql-defaults-docker` 3 → 4, `mysql2-schema-attestation` 5 → 6: native push, no-op repush, declared change, raw INSERT omitting the column, with Unicode and escaped enum values |

**Deletions.** T3: `mysqlEnumType`'s own escaping rule, the introducer discarded by `deparsedStringValue`, the generator-hook duplicate. T2: the per-condition branch in the sentence template and its `match`/`skip` pair. T1: no deletion — the batch arm is added beside the interactive one at the same owner.

**Cost, measured on the final source** ([`recount/recount.md`](recount/recount.md)): engine **16,182 → 16,259** token-bearing lines (+77: T1 +65, T2 +12, T3 +0), like-for-like **20,040 → 20,117**, charged **23,975 → 24,052**; T3's files are `excluded-shared-boundary` (+51 token lines there, reported apart). Ratios: engine 0.353 of 46,021, 0.403 with the same integration files.

## Validation

One frozen local gate on `afaf711e4`, every stage exit 0 ([`gate/summary.log`](gate/summary.log)):

| lane | result |
| --- | --- |
| Whole-estate typecheck | **0 diagnostics** |
| Fixed lane | **955 / 955** |
| `g4/parity` in thirds (project executions) | **172 + 140 + 215 = 527 / 527** |
| Nested-write conformance, six files | **172 / 172** |
| g2-baseline / g2-contracts / g1-compare | **216 / 216**, **216 / 216**, **36 / 36** |
| Transport smoke, transaction-array | 1 / 1, 4 / 4 |
| Live PGlite pins | **7 / 7** |
| Census, package build, campaign receipts, coverage-policy self-tests | exit 0 each |
| Native MySQL 8.4, every file the `provider-mysql2` project registers (15) | **793 passed / 0 failed / 1 skipped** |
| Native PostgreSQL 16, every `provider-pg` file (7) | **490 passed / 0 failed / 7 skipped** |

Native MySQL per file:

| `mysql2-cascaded-identity.test.ts` | 4 passed (4) |
| `mysql2-concurrency-policy.test.ts` | 11 passed (11) |
| `mysql2-found-consumption.test.ts` | 15 passed (15) |
| `mysql2-generated-key.test.ts` | 5 passed (5) |
| `mysql2-read-surface.test.ts` | 122 passed (122) |
| `mysql2-reference-representability.test.ts` | 5 passed (5) |
| `mysql2-relations-ddl.test.ts` | 106 passed (106) |
| `mysql2-scalars.test.ts` | 293 passed (293) |
| `mysql2-schema-attestation.test.ts` | 6 passed (6) |
| `mysql2-writes-raw.test.ts` | 93 passed (93) |
| `mysql2.test.ts` | 84 passed | 1 skipped (85) |
| `mysql-strict-mode-docker.test.ts` | 9 passed (9) |
| `decimal-list-defaults-mysql-docker.test.ts` | 1 passed (1) |
| `decimal-wide-arithmetic-docker.test.ts` | 35 passed (35) |
| `mysql-defaults-docker.test.ts` | 4 passed (4) |

Native PostgreSQL per file:

| `pg-batch-reference-reuse.test.ts` | 6 passed (6) |
| `pg-captured-set-concurrency.test.ts` | 28 passed (28) |
| `pg-nested-write-races.test.ts` | 95 passed (95) |
| `pg-polymorphism-ddl.test.ts` | 60 passed (60) |
| `pg-read-surface.test.ts` | 76 passed (76) |
| `pg-reference-representability.test.ts` | 5 passed (5) |
| `pg.test.ts` | 220 passed | 7 skipped (227) |

**Performance, source-bound on the committed `afaf711e4`** ([`perf/table.md`](perf/table.md), every report protocol-valid; statement counts are equal except for `nested-conditional-found/full`, whose per-checkout witnesses are 4 baseline versus 5 candidate; machine load 8–12 from the owner's desktop apps during the run): `nested-conditional-missing/full` **0.801 / 0.780** CPU, `key-transition-cascade/full` **0.906 / 0.905**, `bulk-update-returning-100/full` **0.940 / 0.930**, `fixed-collection-rowref-1000/parse` **0.681 / 0.681**, `bulk-update-returning-100/prepare` 1.534 / 1.528 at the statement seam (the accepted D-60 cost). **One measured regression, reported, not budgeted away**: `nested-conditional-found/full` reads **0.927 / 0.975 CPU but 1.057 / 1.145 WALL** — over plan §7's 5 % wall budget. The cell was 0.795 CPU / 0.895 wall before U1 and 0.960 / 1.119 at `88fe2814b`: the wall growth is U1's locked confirmation of a FOUND row, one extra round trip per found consumption on the interactive route, which this checkpoint keeps (it is the correctness the review demanded) and does not touch. Disposition for Arnaud: accept it as the price of the FOUND rule, or fund a bounded unit that folds the confirmation into the consuming statement where the provider allows it.

**Bundles and source, re-measured on the final source** (`receipts/source-size-repair-2.json`): engine gzip **102,017 B = 0.651** of 156,771 (≤ 0.75), `pg-simple` **193,708 B = 0.737**, `pg-relations` **193,836 B = 0.738** of 262,658 / 262,788 (≤ 1.00).

## Risks

1. **Hosted Neon HTTP and D1 remain unqualified**; the batch-route repair is proven on the two local forced-batch fixtures and native PostgreSQL's forced profile, not on a hosted transport.
2. **The found-arm confirmation's wall cost** on `nested-conditional-found/full` exceeds the 5 % wall budget (CPU under it); a decision, recorded above.
3. **The conjoined-condition failure is truthful, not specific**: it cannot say which of two conditions changed without a second round trip, which the prompt forbade.
4. **T3's remaining named limits**: an enum member outside the BMP cannot converge (`information_schema.COLUMN_TYPE` is utf8mb3); a session that does not speak UTF-8 is disclosed, not guarded; `NO_BACKSLASH_ESCAPES` stays outside the supported set.
5. **A window the batch route cannot hold**: on a provider with a lock to take, the held premise closes the window between the last premise and the first write; on the sessionless fixture the presence premise still aborts the unit but holds nothing.
6. **Two files someone else modified in the working tree** — `docs/architecture/raptor3-implementation-plan.md` and `features-docs/recursive-query.md` — are left uncommitted; the prompt for this checkpoint is included as its specification.
7. **Nothing is pushed.** The push remains Arnaud's.
