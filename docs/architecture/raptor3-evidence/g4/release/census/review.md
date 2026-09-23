# Release unit "census" — independent review

Reviewer: independent (not the integrator). Tree: main `/Users/arnaud/code/viborm`,
branch `pattern-engine`, head `7bc08ebd9`. Unit reviewed: uncommitted new file
`src/query-engine/raptor3/shared/decimal.ts` and uncommitted edit to
`src/query-engine/raptor3/shared/query.ts`. No file under `src` or `tests` was
edited by this review.

## Verdict: ACCEPT

## What was checked, and what it found

### 1. The diff itself

Read every hunk of `git diff -- src/query-engine/raptor3/shared/query.ts`
(+30/−75, matches `receipts/numstat.txt`) and the whole new
`src/query-engine/raptor3/shared/decimal.ts` (156 lines, matches the note).

- The free function `exactDecimalDomain` and the three private methods
  `decimalMembers`, `canonicalDecimal`, `requireDecimal` were compared line by
  line against the pre-image (`git show HEAD:src/query-engine/raptor3/shared/query.ts`).
  All four moved verbatim in meaning: only cosmetic differences (an added
  `export`, dropped trailing commas, `private` → free function with an
  explicit `result`/`state` parameter in place of `this.adapter`/`this`).
  Every refusal-sentence string is byte-identical to its pre-image:
  - `"Decimal field '${field}' has no declared precision and scale, so it has no exact value to bind."`
  - `"Decimal field '${field}' received a value that is not an exact decimal."`
  - `"Decimal list '${field}' received a member that is not an exact decimal."`
  - `"Cannot divide decimal field '${field}' by zero."` (still thrown in `query.ts`; only the condition's zero-test moved into `dividesByZero`)
  - the field-reference precision/scale mismatch message (only `sameDecimalDescriptor` → `sameDecimalDomain` changed, itself a same-body forwarder)
  - the two `InvalidScalarResult` throws for a decimal scalar and a decimal list stayed in `query.ts`, unchanged, exactly as the note claims ("the `InvalidScalarResult` throws in the owner, the `QueryEngineError` throws in the moved functions").
- The five non-"moved" seam functions (`sameDecimalDomain`, `dividesByZero`,
  `decimalSumOperand`, `decodeDecimalScalar`, `decodeDecimalList`) were each
  checked against the inline code they replaced. All are behavior-preserving
  restructurings, not just plumbing:
  - `decodeDecimalScalar`/`decodeDecimalList` reproduce the base's
    widened/internal/public dispatch and `?? "text"` defaulting exactly;
    `decodeDecimalList`'s `internal ? members : members.map(toDecimal)` moved
    into the seam, but the `undefined` → `InvalidScalarResult` refusal stayed
    in the owner, unchanged.
  - `decimalSumOperand` reproduces the base's `canonicalizeDecimal` +
    `logicalToCoefficient(canonical, domain.scale)` pairing and its
    undefined-propagation to the ordinary binder's refusal exactly.
- The `?? "text"` representation default was spelled three times in the base
  `query.ts` (decimal scalar decode, decimal list decode, decimal list bind —
  lines 811/4478/4612 of the pre-image) and a fourth, unrelated
  `dateTimeRepresentation ?? "text"` default that the note correctly excludes.
  All three decimal ones are now in `decimal.ts`; the owner keeps only the
  unrelated date-time one. Confirmed by grep on both the pre-image and the
  current tree — the note's "previously spelled three times" claim is exact.
- `decimal.ts` was checked for the constructs the note disclaims: no `Number(`,
  no `: number` annotation, no `class` — all absent (grep confirms).
- Only `src/query-engine/raptor3/shared/query.ts` imports `./decimal` inside
  `src/query-engine` (grep across `src/`); the seam has exactly one reader.
  Only `decimal.ts` (plus the frozen, unrelated V1
  `result/cache-value-codecs.ts`) imports the central codec directly inside
  `src/query-engine` — single owner, no second reader, consistent with the
  "one fact, one authority" rule.

### 2. Is the seam an honest owner, or a census dodge?

This was the central judgment call. `tests/fixtures/decimal-language-census.ts`
(read in full, doc comments at lines 138–220) draws detector 2's boundary as:
a module is decimal-owned either because its **name** matches
`decimal(-*)?\.[jt]sx?` / sits under a `decimal/` directory
(`isDecimalSource`), or because a **mixed-purpose** module imports the central
codec directly (`isDecimalOwnedSource`). `decimalFloatTransportEntries` only
scans a node's `Number(` call when the whole file is decimal-owned by one of
those two routes, or the node itself sits in a decimal-named lexical region.
By renaming the seam file `decimal.ts` and routing `query.ts`'s codec access
through it, `query.ts` drops out of the "mixed-purpose module" trigger (it no
longer imports the codec directly) while the seam is automatically in-scope by
name — and its own scan found nothing, because it is genuinely a decimal
module.

Whether that is legitimate turns on whether `decimal.ts` is a real asset
boundary or "a barrel that only re-exports the codec under another path" (the
note's own disqualifying description). Two checks say it is real:

- Content: `decimal.ts` does not merely re-export the codec's functions. It
  adds engine-specific decisions the codec does not make — which codec entry a
  traversal takes (bound literal vs. list member vs. widened `_sum` vs.
  internal/public result), the provider-representation default
  (`?? "text"`), and the engine's own refusal sentences for `canonicalDecimal`
  /`requireDecimal`/`decimalMembers`. A pure barrel would just be
  `export { canonicalizeDecimal, ... } from "@validation/primitives/decimal-codec"`;
  this is not that.
- Precedent: `git show 5a37bcd7:src/query-engine/result/decimal-result-decode.ts`
  and `git show 5a37bcd7:src/query-engine/builders/decimal-field.ts` (the
  retired engine's shipped shape, which the census's fixture doc comments
  describe as the intended one) are structured identically — decimal-named
  modules that own domain lookups and representation defaulting, consumed by
  general query/builder code that does not import the codec directly for
  those facts. The new `decimal.ts` reproduces that same division of labor for
  Raptor 3's `query.ts`, not a novel loophole.

Conclusion: the seam is an honest owner (engine's entry choice, one
representation default, engine's refusal sentences), consistent with the "one
owner per fact" framing in `note.md` §3 and the common brief's "one fact, one
authority" rule. Not a patchwork of 23 exemption lines, not a re-export
barrel.

### 3. What discriminates — independently re-run (not just receipts read)

All four with `TMPDIR=/private/tmp/viborm-census-review-tmp` and
`node scripts/run-vitest-safe.mjs run <file>`, one file per call:

| File | Result |
|---|---|
| `tests/contracts/architecture/decimal-language-census.test.ts` | 42/42 passed |
| `tests/raptor3/g4/read-codecs.test.ts` | 12/12 passed (×2 projects = 24/24) |
| `tests/raptor3/g4/unit02/decimal-having-operand.test.ts` | 1/1 passed (×2 projects = 2/2) |
| `tests/contracts/engine/query/parity-decoding.core.test.ts` | 13/13 passed |

These match `receipts/census-after.log` and `receipts/decimal-tests.log`.

Whole-estate typecheck re-run independently
(`node scripts/run-typecheck.mjs`): 0 diagnostics, matching
`receipts/typecheck.log`.

Biome re-run independently: `npx biome check` on both files together reports
"Found 15 errors. Found 1 info." — identical rule-set and counts (verified by
diffing the rule tally, not just the totals: `assist/source/organizeImports`×1,
`lint/complexity/useSimplifiedLogicExpression`×4,
`lint/correctness/noUnusedFunctionParameters`×3,
`lint/correctness/noUnusedVariables`×1, `lint/style/noParameterProperties`×4,
`lint/style/useDefaultSwitchClause`×2) to `npx biome check` on the pre-image
`query.ts` alone. `decimal.ts` checked alone: "Checked 1 file in 4ms. No fixes
applied." — zero diagnostics, confirming the note's "the seam clean" claim
independently rather than trusting `receipts/biome-after.log`.

### 4. Falsification reproduced in a scratch detached worktree

`git worktree add --detach /private/tmp/viborm-census-verify-base HEAD` (HEAD
= `7bc08ebd9`, the last commit — the uncommitted fix is absent there, so
`query.ts` still imports `@validation/primitives/decimal-codec` directly and
`decimal.ts` does not exist: confirmed by grep before running anything).
Symlinked `node_modules` from the main tree (read-only use; removed before
worktree removal) rather than reinstalling. Ran the census file there with its
own `TMPDIR=/private/tmp/viborm-census-verify-base-tmp`:

```
FAIL tests/contracts/architecture/decimal-language-census.test.ts
  > finds no decimal transport through JavaScript number
  Received: ["src/query-engine/raptor3/shared/query.ts Number 23"]
Test Files  1 failed (1)
     Tests  1 failed | 41 passed (42)
```

Exact match to the note's claimed pre-fix red and to
`receipts/census-before-gate.log`. Worktree removed afterward
(`git worktree remove /private/tmp/viborm-census-verify-base`); `git worktree
list` no longer shows it. The reviewed tree's `git status --short -- src
tests` is unchanged from before this review (`M query.ts`, `?? decimal.ts`
only) — no edits were made to the author's files.

## What could not be verified

- The `extended-local` project's remaining 13 shards and the
  `shared-family`/`imported-pglite` stages (184 cells / 41 files) were not
  re-run; the note itself marks the full gate re-run as following the triage
  and out of scope for this unit. Not a finding against this unit — it does
  not touch those files.
- `receipts/mode-g2-baseline.log` (216/216, the fixed `g2-baseline` contract
  gate) was read but not independently re-run; it was outside the four files
  named as discriminating for this review and is a broad regression gate
  rather than evidence specific to the decimal seam.

## Findings

None at blocking or revise severity. Two purely cosmetic observations, no
action needed:

- Low: the moved functions gained `export` and lost trailing commas (biome's
  own formatting choice on this file, pre-existing style, not introduced by
  this unit — confirmed identical diagnostic count/rule-set to base).
- Low: `dividesByZero` and `sameDecimalDomain` are one-line forwarders to the
  codec; both are named, single-purpose, non-boolean-bag functions consistent
  with the "no policy-boolean bags" rule, not flagged as a concern.

## Verdict

**ACCEPT.** The seam is a genuine, precedented owner (matching the retired
engine's `decimal-field.ts`/`decimal-result-decode.ts` shape), every moved
function and refusal sentence is unchanged in meaning, the four discriminating
test files and the whole-estate typecheck pass on independent re-run, biome is
identical to base on both files, and the falsification reproduces exactly in
an isolated scratch worktree. No patchwork, no second reader, no policy
boolean, no barrel.
