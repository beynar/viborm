# The Engine Compression Audit

**Date:** 2026-08-05
**Language:** This document uses Simplified Technical English (ASD-STE100 style).
**Method:** Four read-only analyst lenses (repetition census, ATOM vocabulary gaps, dispatch unification, vestige + invariant placement), each chained into a skeptic that re-read every cited line, attacked every net-delta claim, and checked every proposal against the recorded doctrine. Confidence numbers are post-skeptic. The original findings below are historical input. The implementation outcome supersedes their proposed shapes.

## Implementation outcome

The compression work started at `18328f96dc84a72b38b058960acb2f87a30d7667`. The validated implementation base is `58a7bdd89292cacd9acf145093b9d2bf084598d3`. Documentation followed as a separate atomic unit.

The result is **2,383 production TypeScript lines added and 4,146 deleted: net −1,763 lines** in `src/query-engine`. This exceeds the planned reduction. Public query APIs, result types, SQL order, parameter order, step IDs, guards, and execution order remain unchanged, except for the authorized Create `connectOrCreate` replacement-race message correction.

The implementation removed **20 named internal concepts or carriers**, plus dead exports and barrels:

- The query-engine and builder barrels, the `@query-engine` alias, and the dead V1 builder exports.
- The legacy operation program, `ProgramFailure`, `UniqueConflictPin`, `ProgramReadOperation`, and `RelationStatement`.
- `BatchValueRef`, `BatchResolvableValue`, and `PreparedBatchRacePin`.
- The relation-program values module and its duplicate nullability/message ownership.
- The many-to-many descriptor bounce.
- The optional per-kind `RelationMutation` bag, `RelationMutationStep`, and `RelationMutationPlan`.
- `ParentIdSource`, `PerFieldParentIdSource`, `AdoptParentIdSource`, `FreshReferenced`, and `UpsertParentBinding`.
- The non-structural `Probe` and `validateProbe`.

The live model now has four stronger boundaries:

1. `StatementStep` is a union of `ReadStep` and `WriteStep`. Only writes can carry a race pin or unique-conflict policy.
2. `PlanningFragment` contains statement steps and outputs, but no guards. E6.9 preparation writes remain legal during planning.
3. `RelationMutationProgram` preserves parsed input order and meaning without carrying execution deduplication.
4. Foreign-key sources are bound to a foreign/referenced field pair. No caller supplies a field name when it resolves a source.

The provisional structural adopt helper was rejected. It needed arm callbacks and duplicate exceptions, and it added more production code than it removed. The implementation therefore deleted the original non-structural probe vocabulary and kept the four explicit adopt sites. No branch-step IR, strategy object, generic mutation DSL, payload walker, or shared utility landfill was added.

The remaining local compression was measured after the main migration. Only guard/write bucketing still had three or more semantically identical instances, so it received one owner. Correlation builders, generated-identity constructors, and recursive where walkers still have different invariants or fewer than three live instances and remain separate.

## The question, answered first

The engine grew 30,820 → 33,119 → 38,927 lines across PRs #16 and #20 (+26%), with V1's write runtime deleted in the middle. **Was the growth avoidable by smarter abstractions?** Mostly no — and the audit can show it, not just say it:

- **Mechanical duplication is LOW.** jscpd over the write engine: 0.7–1.4% exact-clone rate (≈200–300 duplicated lines in 20,756). The growth is not copy-paste.
- **One third of the write engine is doctrine prose.** 6,645 comment lines (32%) in the .ts files, plus 5,647 lines of in-folder markdown. `RelationUpsertPart.ts` is 44% comments; `UpdateOperation.ts` 33%. The skeptics verified this prose is NOT duplicated essay (D8) — each site argues its own decision — so there is no dedup win, only a relocation question (finding X1 below, the maintainer's call).
- **The remainder is positional semantics that measured different.** The waves repeatedly tried to unify and were stopped by measurements now on record: reads take the pre-transition key while writes take the post key; the empty to-one payload is a no-op on one direction by Prisma's measured behavior; the member arm was the wrong donor by falsification. The audit's four KEEP_AS_IS findings (A9, C7, C8, D6b) re-verified these as **false compressions** so no future wave spends itself discovering them again.

**What IS compressible:** ≈1,100 net code lines at low risk (waves R1–R2 below), of which the single largest chunk is not the new work at all but **V1 vestige THE DELETION missed** (~700 lines of dead program/values machinery, confirmed dead by a name-collision-corrected liveness pass). Beyond lines, the audit found ~15 removable *concepts* and three vocabulary moves that make invariants machine-checkable instead of prose-argued.

## Wave R1 — pure deletions and verbatim-clone extraction (≈ −800 lines, near-zero risk)

| # | Finding | What | Net | Conf. |
|---|---|---|---|---|
| R1.1 | D1 (adj.) | **Superseded by implementation:** the liveness audit proved that the proposed rump also had no justified owner. The complete legacy operation program was deleted, and live failure and constraint types now use their canonical owners. | Better than estimate | 1.0 |
| R1.2 | D2 | `src/query-engine/RelationProgramValues.ts`: 19 of 22 exports dead; relocate the 3 live ones into write-engine; merge the duplicated `requiredFkFieldsFor` derivation. | ≈ −245 | 0.85 |
| R1.3 | D4 | `buildCreateManyAndReturn` (dead V1 builder) + slim the `@query-engine` barrel to what production imports (it survives as a test alias). | ≈ −70 | 0.9 |
| R1.4 | B5/C2/D3/A5 (one family) | The verbatim clone tail, SAFE SUBSET ONLY: `normalizeWheres`+`normalizeWhereData` (byte-identical 44-line block, `RelationWritePart.ts:1841` ≡ `RelationJunctionPart.ts:2734`) to shared.ts. The `requireRecord`/`normalizeSingle` twins are NOT all safe — the skeptics found behavioral differences (UpdateOperation's 3-arg variant refuses multi-element arrays with its own message; per-file message templates) — extract only the byte-identical ones, keep the divergent ones in place with a one-line pointer. | ≈ −60 | 0.72 |
| R1.5 | C3 (adj.) | The six verbatim `NestedChildBuilder` closures → one `makeNestedChildBuilder` factory (the skeptic removed one false site — `UpdateOperation.ts:2805` is a direct call). | ≈ −50 | 0.75 |
| R1.6 | B/C skeptics' shared MISSED find | `RelationLinkPart.parentReferenced` (`:407-426`) privately re-derives `referencedFieldValue` — the exact drift-fork `parent-reference.ts`'s own header says the module exists to prevent. Replace with the shared resolver **with an explicit accepted-kinds pin** (the swap changes behavior for `transitioned` sources: typed internal refusal today → resolved value; the pin keeps the refusal until someone decides otherwise). | ≈ −20 | 0.8 |
| R1.7 | B-skeptic missed | `defaultSelect` has FOUR copies (the analyst listed one). Extract. | ≈ −20 | 0.8 |

## Wave R2 — high-confidence unifications (≈ −300 lines, moderate risk, each its own unit)

| # | Finding | What | Net | Conf. |
|---|---|---|---|---|
| R2.1 | C1 (adj.) | Merge `UpdateOperation`'s TWO root child-held kind switches (`:1924-2079`, `:2102-2298` — byte-identical preambles, same builder family) into one direction-aware switch, the shape the depth loop already has. | ≈ −125 | 0.7 |
| R2.2 | A1/C4 (same finding, adj.) | Collapse the literal-vs-planned twin builders in `nested-target-parts.ts` (`literalFkInject`≡`plannedFkInject` etc. — the literal source resolves through the same compile-phase path since `referencedFieldValue` ignores `known` for literals). The single-create pair is mechanically sound; the createMany pair differs more than inventoried (skeptic) — do it second, with its own witnesses. | ≈ −100 | 0.65 |
| R2.3 | A2 (adj.) | One home for correlation conjuncts (`parentHeldCorrelationFilters` / `nestedTargetCorrelationFilters` / `correlationFilters` — verified near-twins). The STATEMENT-builder half is riskier than the analyst claimed (the skeptic found a load-bearing AND-conjunct ORDER difference) — unify the conjunct builders first, the statements only with byte-identical-SQL assertions. The prize is doctrinal: the wrong-row split-witness pin gets ONE home instead of three kept in agreement by prose. | ≈ −60 | 0.6 |
| R2.4 | A6 | One constructor for the generated-identity INSERT (the RETURNING/insertId capability seam is spelled three times; the identity-RESOLUTION family above it stays distinct — the analyst and skeptic agree that unifying resolution would be false). | ≈ −25 | 0.8 |
| R2.5 | C6 (adj.) | `RelationJunctionPart` parallel-array slot config → array-of-structs, honestly typed as the THREE item shapes the arms actually carry (skeptic). Kills an index-alignment wrong-row hazard CLASS. | ≈ −35 | 0.5 |
| R2.6 | A8 | Name the guard/write bucketing (`step.kind === "guard"` split loops ×6) as one function; the batch guard-hoisting discipline gets a name. | ≈ −25 | 0.6 |

## Wave R3 — the sanctioned extraction and the vocabulary moves (concept wins; each needs its own reviewed unit)

| # | Finding | What | Why | Conf. |
|---|---|---|---|---|
| R3.0 | A-skeptic MISSED (audit FIRST) | **The connectOrCreate found-arm guard wording asymmetry**: `CreateOperation.ts:1799` words the vanished-target batch guard as plain not-found (`relationTargetNotFound(…, 'connect')`) while `UpdateOperation.ts:3438` words it `nestedReplacement('connectOrCreate')` with an explicit replacement-race comment. Either the asymmetry is V1-parity-recorded per operation, or Create reports the wrong failure class. MEASURE before R3.1 — a unifier would silently pick one. | Possible live wording defect | — |
| R3.1 | A3 (adj.) | The parent-held adopt family shared by Create/Update — **the extraction E3-U3's reclassification explicitly recorded as its own unit.** Guard wordings stay site-supplied; before-subtree emitters stay injected (their racePin plumbing differs deliberately); update-only kinds stay put. Only after R3.0's answer. | ≈ −65 lines, −3 concepts, and the recorded debt is paid | 0.55 |
| R3.2 | A4 (adj.) | **Rejected by implementation experiment:** a structural adopt helper required arm callbacks and exception policy. It failed the negative-line gate. The non-structural probe declaration and validator were deleted; explicit sites keep their local decisions. | −1 false concept | 1.0 |
| R3.3 | B1 (adj.) | **Superseded by a stricter model:** final and planning sources now belong to field-bound foreign-key members. Separate read and write sources express primary-key transitions without inference. Lookup is a final source only and cannot enter planning branch SQL. | One provenance model | 1.0 |
| R3.4 | A7 (adj.) | The optional located-PK publication threading — **the recorded conditional-arm unit** (`RelationUpsertPart.ts:1289-1324` names it; the plan's Status recorded it). Net lines ≈ 0; the win is a SHAPE ABSORBED (deeper relation-carrying writes on upsert update arms stop refusing) plus deleting the refusal essay. This is also one of the RA re-audit's nine (c-ii) survivors — two ledgers point at the same unit. | Absorption + essay deletion | 0.5 |

## Rejected — the false compressions, so nobody re-litigates them

All UPHELD by their skeptics, with the load-bearing differences named in the full audit output:

- **A fragment-level CONDITIONAL-ARM step kind (B3):** re-adds the BranchStep the census deliberately killed; +200-300 executor/validator lines against −150 Part lines. The arms' mass is in what they EMIT, not the branching.
- **A LOCATE step kind in the frozen vocabulary (B6):** honest delta ≈ 0; the two largest cited sites already have single-home statements. The provisional structural adopt helper also failed its objective keep gate, so explicit site logic remains smaller.
- **One payload-walker across the three roots (C7):** the positions differ in measured, load-bearing ways (E6.5's direction-split, N5's ordering, the census's per-position attribution). A strategy DSL would cost more concepts than it deletes.
- **AbstractWriteOperation (C8):** the shared skeleton is already thin; inheritance buys −20 lines and +1 coupling concept.
- **Table-driving the legality walks (C9):** blocked honestly by the X2 cast ratchet; net ≈ 0.
- **The `kinds.length` arity guards are NOT one invariant (D6b):** the `!== 1` vs `> 1` asymmetry between parent-held and child-held is half-deliberate (the child-held `> 1` is recorded: the empty payload is Prisma's measured no-op) — but note the RA re-audit independently flagged the OTHER half (parent-held refusing the empty payload) as a parity question. One MEASUREMENT unit, not a unification.
- **The comment mass is not duplicated doctrine (D8):** no essay extraction available; ≈ −15 lines of true self-clones at most.

## X1 — the one decision that moves more lines than everything else combined (maintainer's call)

**A10 (upheld, 0.7):** one third of the engine's lines are in-file doctrine essays. Relocating the long-form argumentation into the in-folder docs (ATOM.md and the plan ledgers), leaving one-line pointers at the sites, would remove ≈ 2,500–3,000 .ts lines — 5-8× the whole R1-R3 program — at zero code-concept change. It is deliberately NOT scheduled: the essays-at-the-site convention is a chosen working style of this codebase (the waves' reviewers read them in place), and thinning it is a taste decision, not an engineering one. Without it, the honest ceiling of this plan is ≈ −1,100 code lines (~8% of the write engine's code lines) and ~15 concepts.

## Deferred, sized

- **D5 (adj.):** the `query-engine-v2` → `write-engine` naming completion: 157 src occurrences in 21 files, 81 outside-dir test references, the `tests/query-engine-v2/` directory itself, 4 package.json paths. Net 0 lines, ~380 mechanical sites. Pinned message strings change — census entries required.

## Order

```
R3.0 (the wording-asymmetry measurement — first, it gates R3.1 and stands alone)
R1   (deletions; one lane, near-zero risk)
R2   (six units, each with byte-identical-SQL or witness assertions)
R3.1 → R3.2 → R3.3 → R3.4 (each its own reviewed unit; R3.4 doubles as an absorption)
X1, D5: maintainer decisions, any time.
```

Every unit inherits the standard harness: measure first, both-substrate witnesses where behavior could move (R1/R2 claim byte-identical SQL — assert it, don't argue it), cp-backed falsifications, census entries for any message that moves, and the reviewer reads every diff.
