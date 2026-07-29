# Final-Review Findings — Fix Plan

**Input:** the 13 confirmed findings (2 major, 11 minor) of the last adversarial branch review (2026-07-28, run `wf_ca509287-c6e`), plus one unsound pre-existing bonus the verifier surfaced. Evidence with verbatim repros: the review task output; each unit below cites its finding.

**Parallelism rule:** units are grouped into lanes by *file collision* — every lane owns a disjoint file set, so all five lanes run concurrently in worktrees. Merge order resolves the two known overlap points (noted below).

**Memory rule (hard, host OOM history):** worktree lanes run only targeted suites, one vitest at a time, `--minWorkers=1 --maxWorkers=2`. The full estate runs exactly once per phase boundary (merge, gate), alone, `--minWorkers=1 --maxWorkers=4`.

**Witness rule:** every fix ships a regression witness that FAILS under revert of the fix — the stale-cache major especially (a batch-only cached-read witness that observes staleness before the fix).

---

## Phase 1 — five parallel lanes

| Lane | Units | Files owned | Size |
|---|---|---|---|
| **A — batch branch** | **A1 (MAJOR):** shared-batch `$transaction([...])` must run mutation cache invalidation — the branch bypasses the `wrapExecutor` closure (`client.ts:712-875` never reaches `runExecution`); invalidate post-commit from the batch branch using the same cache-flow machinery, per mutated model, with a cached-read staleness witness on the batch-only driver. **A2:** `limit: 0` as the sole batched op → the documented no-op `{count: 0}`, not V5001. **A3:** a sibling operation's presence-guard failure in a shared batch surfaces as the typed, attributed error (not raw V7006) — route through the existing batch-error attribution. | `src/client/client.ts` (batch branch), `src/query-engine/cache-flow.ts`, `batch-error-attribution` | M |
| **B — result types** | **B1 (MAJOR):** `_sum` typed per the field's own decoder — bigint→`bigint`, decimal→`string` (exists), else `number`; mirror in groupBy; expectTypeOf probes for every scalar × `_sum`/`_avg`/`_min`/`_max`. **B2:** `[Selection] extends [undefined]` arm on the row-returning ops so `select: undefined` types the full default row (the arm bulk writes already have). **B3 (pre-existing, unsound):** optional/union `select` (`{...(cond && { select })}`) types as the honest union of both arms, not the full row — mirror `BulkWriteResult`'s discriminant. | `src/client/result-types.ts`, type tests | M |
| **C — cache keys** | **C1:** brand-aware cache-key serialization — `DbNull`/`JsonNull`/`AnyNull` sentinels serialize to a reserved token distinct from any user JSON document (incl. `{kind:"DbNull"}` collisions); FieldRef/Sql operand tokens audited for the same class while there. Collision witness both directions. | `src/cache/key.ts` (+ sentinel brand exports read-only) | S |
| **D — guards & oracle** | **D1:** the unknown-key clause guard stays ON when the clause value type may be `undefined`, and covers array-form `orderBy`; re-probe typo-beside-real-key on both. **D2:** the V2 oracle takes the same arm as production for omit-only bulk writes (rows, not `{count}`) — re-align and re-run the oracle suite. | `src/validation/**` guard helper, oracle harness test files | S |
| **E — docs truth** | **E1:** json.mdx (JSON `gt/lt` + insensitive shipped), find-many.mdx (nested cursor/negative take shipped), sorting.mdx (cap 3→8), compatibility.mdx (decimal refusals noted as database differences), prisma-parity-contract.md (`omit` self-contradiction resolved), plus a grep sweep for the same stale claims elsewhere. Every corrected cell verified against live behavior, not the plan. | `docs/content/**`, `docs/architecture/prisma-parity-contract.md` | S |

**Known overlaps for the merge:** A and C both touch cache internals (different files — verify); B's `result-types.ts` edits must keep lane D's oracle expectations true (merge re-runs the oracle suite).

## Phase 2 — merge + adversarial review

Cherry-pick A→B→C→D→E; full estate once (bounded). Then contract reviewer (re-runs the five original finding repros verbatim — each must now behave; plus the staleness witness on the batch-only driver) and theater reviewer (reverts each fix, its witness must fail; gates/pins only tighten). ≤2 fix rounds.

## Phase 3 — gate

Types, full estate (alone, bounded), `test:gates`, pinned-Biome delta vs main, both Docker legs (env vars inline, PASSED not skipped), tree clean except the maintainer's three local files.

## Explicitly out of scope

The five downgraded findings stay unfixed by decision: to-one `delete: true` no-op (documented Prisma divergence), per-mutation `cache`-bag stripping (pre-existing, own backlog item), nested-upsert doc cell (already tracked), transaction-portability completeness gate self-reference (minor, own item), `select` union collapse on bulk writes (covered by B3's honest-union work only where unsound). The refuted `distinct`+negative-`take` finding needs nothing — the oracle proved the behavior correct.
