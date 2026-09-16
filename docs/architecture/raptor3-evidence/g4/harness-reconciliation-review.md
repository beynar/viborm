# Independent review — G4 "Harness reconciliation (cuts, transport plans, witness one-liners)"

Reviewer: independent adversarial reviewer (did not write the unit).
Unit note: [`g4/witness/note.md` §18](witness/note.md) (line 2075).
Unit patch: [`reconciliation.patch`](witness/receipts/reconciliation/reconciliation.patch).
Brief: [`briefs/harness-reconciliation.md`](briefs/harness-reconciliation.md); plan §5.2–5.4.
Review receipts: [`harness-reconciliation-review-receipts/`](harness-reconciliation-review-receipts).
Review probes: `tests/raptor3/g4/review/harness-reconciliation/` (4 files, 14 cells)
plus `review.workspace.ts`, the scaffold that runs them before the registration
writer adds them to the manifest.

Identity at review: production `3bbaa936…`, harness `0f3b9eaa…`
([`identity-review.json`](harness-reconciliation-review-receipts/identity-review.json)).
Both moved from the author's `9bca8f01…` / `e69ecc30…`: another stream is still
writing `src/`, and my own probe files move the harness fingerprint. The five
files this unit owns are byte-identical to the author's `SHA256.files` before
and after every falsification I ran
([`unit-files-after-review.sha`](harness-reconciliation-review-receipts/unit-files-after-review.sha)).

## Outcome

**REVISE.**

Every load-bearing claim in §18 reproduces, and two of them reproduce *more*
strongly than the author measured. The CS-03 classification is right: the ten
reds are recognizer staleness, not an eliminated or moved cut, and I confirmed
that from the author's own two tapes without trusting his summary. The
transport fold scripts the candidate's real statements, publishes from the
provider's `RETURNING` and keeps every fault family. No expectation was tuned to
pass. No production file was touched, so the incremental charged cost really is
0 LOC / 0 parser tokens / 0 bytes.

What blocks ACCEPT is one of the two witness one-liners. SC-13's read half was
rewritten from an assertion that was factually wrong into an assertion that
cannot fail for the reason the cell exists — and SC-13 is the only place the C12
vector tier is exercised on the local provider. A one-line `seed` hook restores
a real witness; I wrote the probe that proves it (finding 1). Beside it, the
§5.4 elimination the whole transport-plan change rests on is evidenced by two
test files that no registered lane runs (finding 3).

## What I verified, independently

| Author claim (§18) | How I checked it | Result |
| --- | --- | --- |
| The CS-03 statements are identical at `0cc61e61` and now; only the spelling moved | Diffed the two tape receipts myself: verb + row count per statement, per seed | **Confirmed.** All 9 recorded cells have identical statement sequences; only `reachedCuts` differs, and only by the `choice:` cut |
| The repaired recognizer is not tuned to the new engine | Copied the two repaired scenario files into the REAL clean `0cc61e61` worktree `/private/tmp/viborm-g4-perf-baseline` (not a `src/` alias) and ran the self-test; restored from a scratchpad copy and re-hashed | **Confirmed, more strongly than §18.1.** 42/42. Worktree left clean ([receipt](harness-reconciliation-review-receipts/falsify-repaired-recognizer-on-0cc61e61.log)) |
| The added row-count assertion makes the recognizer "semantic, not only textual" | Mutated `? 1 : 0` → `? 0 : 1`, ran the self-test, restored to `2b03cb0b…` | **Confirmed load-bearing.** Exactly the 6 A-slice upsert cells (7133/7144/7160 × both profiles) go red ([receipt](harness-reconciliation-review-receipts/falsify-rowcount-assertion-mutated.log)) |
| The folded plan scripts the candidate's real statements | New probe drives the same one-statement reply the plan now writes | **Confirmed.** One `INSERT … RETURNING`, no second statement |
| "publishes the row from the INSERT's own RETURNING" | Probe scripts a row the public input cannot supply | **Confirmed.** The published value is `{id:"provider-chose-this"}`, not the input; and a 0-row reply fails, so the fold's replacing invariant has a falsifier |
| "no fault family was thinned" (author's unverified claim #4) | Enumerated the generator: folded (`depth===0`, ordinary/repeated) cells carrying a fault — 44 of 233 in the G3 range, 108 of 624 in the G4 write range, incl. seed 8091 in the `8000` child and 100031 in the `100000` child. Both children green. New probe pins fold × fault × both profiles and fold × overlap | **Confirmed**, and the missing count is now supplied ([census](harness-reconciliation-review-receipts/folded-recipe-census.txt)) |
| CS-02 is pre-existing, not a G4 regression, and the file was reverted | `cs02-structure-measure.test.ts` hashes `b37113fb…` in both trees; `bindRead`/`claimRead` are called only from `reference-instrumentation.patch` | **Confirmed.** Still 1 failed here |
| `tests/raptor3/core-structure/` is identical to `0cc61e61` apart from two hunks | `diff -rq` against the clean worktree | **Confirmed.** Exactly the two files, exactly the two hunks |
| No production file; patch is 5 files, +50/−19 | `grep -c "^+++ b/src/"` = 0; `+`/`−` counts; mtimes of the other dirty `tests/raptor3/g3/generation/*.ts` are 04:47 (another stream) vs this unit's 12:18–12:47 | **Confirmed.** Incremental core / complete charged cost **0 / 0 / 0** |

## Findings

### 1 — must-fix — SC-13's rewritten read half cannot fail for the reason the cell exists

**Location** `tests/raptor3/g4/read-codecs.test.ts:441` (title), `:469–470`
(the two assertions), `:436` (the doc comment).

The old assertion was wrong and the author is right to have removed it:
`observeFailure` (`tests/raptor3/g4/witness-world.ts:134–148`) fails when no
refusal fires, and the recorded red was "The required refusal did not fire", so
the cell was demanding a refusal neither engine raises.

The replacement is `assert.deepEqual(candidateRead, shippedRead)` plus
`assert.deepEqual(candidateRead, [])` over the table the *refused write* left
empty. `[]` is true of any empty table and of no capability: with zero rows the
result parser never reaches a vector value, so the C12 read boundary is no
longer witnessed anywhere on the local provider —
`tests/raptor3/g4/native/read-envelope-native.test.ts:37` states the round trip
needs pgvector, which this environment does not have.

**Probe**
`tests/raptor3/g4/review/harness-reconciliation/vector-read-witness.test.ts`
(run through `review.workspace.ts`; receipt
[`review-probes.log`](harness-reconciliation-review-receipts/review-probes.log)).
It seeds one row with the witness world's own fixture-owned raw SQL — the
mechanism plan §5.2 prescribes and `WitnessWorldOptions.seed` already exposes —
and measures:

- the vector column does exist on SQLite: `"embedded_vector" JSON NOT NULL`;
- **both engines decode it and return `[{ embedding: [1, 0, 0] }]`.**

So the honest, non-vacuous contract was available for one extra `seed:` option,
and it is *stronger* than the sentence the cell now asserts: the tier-less
provider **refuses the write and answers the read, decoding the stored list**.

**Resolution** Give SC-13's `createWitnessWorld` a `seed` that inserts one row
and assert the decoded parity (keep the empty-table arm beside it if wanted), or
say explicitly in the cell that the read half is a parity-of-emptiness check and
register the seeded witness elsewhere. Either way, update the doc comment at
`:436` — "The contract is a refusal with one identity, not a silent
degradation" now describes only the write half, directly above a read half that
asserts a non-refusal.

### 2 — note — the folded transport shape has no FIXED fault witness

**Location** `tests/raptor3/g3/generation/transport-plans.ts:539–545` (the fold)
and `tests/raptor3/g3/generation/generated-transport-smoke.test.ts:139–147`.

The brief says "Do not thin the fault coverage". The author's argument — the
fault attaches to the reply, not to a statement — is correct at the driver
(`tests/raptor3/transport/driver.ts:208–237`: `injected`, `committed` and the
`57014` outcome are reply-level and fire after the committed/acknowledged
events, independent of statement count). But §18.8 #4 admits "No per-fault-family
count was extracted from the receipts", and the *fixed* representative matrix
contains exactly one depth-0 C11 recipe — seed 8027 — whose `fault` is `none`.
So after this change the fold × fault intersection is exercised only by seeded
campaign cells (measured: one per 100-seed child).

**Probe**
`tests/raptor3/g4/review/harness-reconciliation/folded-fault-coverage.test.ts`
(6 cells: two folded faulted recipes and one folded two-actor recipe, on both
transport profiles) plus
[`folded-recipe-census.mjs`](harness-reconciliation-review-receipts/folded-recipe-census.mjs).
All green.

**Resolution** Add one `depth: 0` C11 recipe with
`fault: "legal-provider-failure"` to `representativeRecipes()` (or adopt the
probe), and replace §18.8 #4 with the census.

### 3 — must-fix (record) — the §5.4 elimination the transport change rests on is evidenced by tests no lane runs

**Location** `tests/raptor3/g4/unit02/root-member-cut-trace.test.ts` and
`tests/raptor3/g4/unit02/malformed-result-cuts.test.ts`, cited as the
surrounding-cut evidence by `g4/unit02/note.md` §P.11.3 and relied on by §18.2.

Plan §5.4 admits an absent cut only with "the concrete strategy/trace **and the
same property checked at its legal surrounding cuts**". For the root-`create`
fold that property is checked by those two files — and neither is in
`scripts/raptor3-manifest.mjs` nor in `EXTENDED_LOCAL_TESTS` (measured
programmatically against both manifests). They therefore run in no project and
no gate would notice if the surrounding-cut property broke. The reconciliation
unit accepted the §5.4 record without checking that its evidence executes.

I ran them under the review scaffold: **8 cells, green today**
([`review-probes.log`](harness-reconciliation-review-receipts/review-probes.log),
project `hr-review-unregistered-cut-evidence`).

**Resolution** Record a blocker (B-R3) asking the registration writer to
register both files, exactly as B-R2 was recorded. No code change is owed by
this unit.

### 4 — note — the widened recognizer accepts collations that are not the exact-text one

**Location** `tests/raptor3/core-structure/measurement/extension-a-scenario.ts:22`
and `extension-composition-scenario.ts:15`:
`(?: COLLATE (?:"[^"]+"|\w+))?`.

The comment justifies the widening by "the adapter's exact-text operator"
(`sqlite-adapter.ts:357–358`, `COLLATE BINARY`), but the pattern admits any
collation, including `COLLATE NOCASE` — the spelling of the *insensitive* public
filter, a different comparison from the one the cut is about. It is unreachable
today, because the upsert locate is generated from the operation's own unique
key rather than from a caller's filter, so this is robustness, not a defect.

**Probe**
`tests/raptor3/g4/review/harness-reconciliation/lookup-recognizer.test.ts`
(third cell). The same file also pins the two claims the repair rests on: the
repaired pattern reads both tapes' spellings and the Postgres `COLLATE "C"`
form, the old pattern is blind to the current one, and neither reads a
`lookupExtra` column, a `LIKE` filter or an `ORDER BY` term.

**Resolution** Either narrow the alternation to the adapter's exact-text
collations, or say in the comment that any collation is deliberately accepted
and why.

### 5 — note — one receipt carries no identity

**Location**
`docs/architecture/raptor3-evidence/g4/witness/receipts/reconciliation/cs03-all-seed-sweep-after.json`
— 38 bytes, `{"checked":300,"failures":[]}`. No production/harness fingerprint,
no slice names, no seed list, no runner resource line. §18.1 leans on it for the
"300-cell sweep" claim. Every other receipt in the directory is a runner log.

**Resolution** Re-emit it with the identity, or drop the claim: the three
registered `cs03-*-seeds` campaigns already cover the same 300 recipes on both
profiles and are green (I re-ran all three).

### 6 — note — §18.5's blocker B-R2 is already stale

`scripts/raptor3-manifest.mjs:510 / 516 / 522 / 528` now read **8 / 7 / 7 / 13**,
matching the files. All four `g4-route-*` modes pass their contract gate and
exit 0 (measured 13:27–13:28; `g4-route-cache` needed one retry after a "Stale
Raptor 3 evidence" trip caused by the concurrent `src/` stream, which is the
brief's admitted retry). §18.5's "Registered / Frozen 7 / 5 / 6 / 11" table and
blocker **B-R2 should be marked resolved** so the integrator does not chase it —
exactly as the author's own unverified claim #2 warned.

The rest of §18.5 holds: 8 / 7 / 7 / 13 cells green, D-5 and D-6 hold as
recorded divergences, `g4-lifecycle-events` 3/3 and `g4-lifecycle-admission`
3 passed / 1 failed (the recorded route blocker B-1c).

### 7 — note — the now-green G4 read files are still outside credential-free discovery and the promotion is unrecorded

`scripts/raptor3-campaign-receipts.test.mjs:971–985` keeps every G4 fixed suite
out of `EXTENDED_LOCAL_TESTS` and out of `RAPTOR3_FIXED_LOCAL_TESTS`
"while they are red", and says in its own comment that joining that stage "when
they pass" is "an explicit decision". `read-codecs.test.ts` and
`read-recursive-fit.test.ts` held the last two red cells of `g4-read-contracts`,
and this unit made them green (62/62, reproduced). §18 records no promotion
request. The guard is list-shaped and other members of `G4_FIXED_SUITES` are
still red, so this is a request to record, not a change to make.

**Resolution** Add the promotion request for the registration writer to §18.7.

## §7 decision-elimination gate, applied to this diff

No production file, so the four questions are answered against a harness diff.
I looked for each of the listed smells in the actual hunks and found none: no
second public-syntax walker, no per-verb codec, no duplicated result-shape
preparation, no recreated lifecycle, no projection rebuilt to obtain a decoder,
no JavaScript arithmetic beside SQL, no defensive re-validation of a trusted
internal value, no policy-boolean bag, no per-feature interpreter, no legacy
import or fallback, no cached absence, no public-contract change.

One thing that *looks* like a fixture-named flag and is not:
`transport-plans.ts:539` `const folded = insertCount === 1`. It is a derived
physical predicate, not a fixture name, and it is exact for this world —
`insertCount = depth + 1 + depth × fanout` is 1 iff `depth === 0`, and
`recurrence-ordinary-world.ts:13–33` attaches `children` only when
`level < recipe.depth`, so a folded recipe provably names no relation. It would
be sharper written on the semantic predicate rather than the count; that is a
preference, not a finding.

Claimed deletions that actually disappeared: `grep` finds no surviving
`/WHERE[\s\S]*"lookup"\s*=/` anywhere in `tests/` outside this review's own
negative-control probe, and no `observeFailure` in
SC-13's read half. Each replacing invariant has a falsifier that fires when it
is broken — I ran two of them (findings table above).

## Suites run for this review

Serial, through `run-vitest-safe.mjs` / `run-raptor3.mjs`. Receipts in
[`harness-reconciliation-review-receipts/`](harness-reconciliation-review-receipts).

| Suite / mode | Result | Receipt |
| --- | --- | --- |
| CS-03 extension-campaign self-test | **42 passed** | `cs03-selftest.log` |
| `cs03-extension-a-seeds` / `-b-seeds` / `-composition-seeds` | **1 passed** each, gate verified | `cs03-extension-*-seeds.log` |
| `g3-generated-transport-smoke` | **1 passed**, gate verified | `g3-generated-transport-smoke.log` |
| `g3-generated-smoke` / `g3-generated-minimization` | **6 / 1 passed**, gate verified | `g3-generated-*.log` |
| `g3-transport-seed-batch 8000` | **1 passed**, gate verified (contains folded+faulted seed 8091) | `g3-transport-seed-batch-8000.log` |
| `g4-write-transport-seed-batch 100000` | **1 passed**, gate verified (contains folded+faulted seed 100031) | `g4-write-transport-seed-batch-100000.log` |
| `g4-transport-seed-batch 50000` | **1 passed**, gate verified | `g4-transport-seed-batch-50000.log` |
| `g4-read-contracts` | **62 passed**, gate verified | `g4-read-contracts.log` |
| `g4-route-lifecycle` / `-admission` / `-cache` / `-transactions` | **8 / 7 / 7 / 13 passed**, all gate verified, all exit 0 | `g4-route-*.log` |
| `g4-lifecycle-events` / `g4-lifecycle-admission` | **3 passed** / **3 passed + 1 failed** (recorded blocker B-1c) | `g4-lifecycle-*.log` |
| CS-03 surrounding contracts (`extension-a/b/composition`, `member-scope`, `structural-reference`, `repeated-occurrence-ownership`, `extension-recipes.selftest`) | **42 passed** | `core-structure-contracts.log` |
| `measurement-selftest` (extended-local; the unit did not run it) | **7 passed** | `measurement-selftest.log` |
| `cs02-structure-measure` (extended-local) | **1 failed** — pre-existing, §18.3 confirmed | `cs02-structure-measure.log` |
| receipts self-test | **39 passed / 0 failed** | `raptor3-campaign-receipts.log` |
| CLI self-test | **10 passed / 0 failed**, 230 s, no identity-guard trip | `raptor3-cli-selftest.log` |
| whole-estate typecheck | only the two permitted Pattern `TS2345` at `pack.ts:1443` / `:2633` | `typecheck.log` |
| **Review probes** (4 files) + the unregistered §5.4 cut evidence (2 files) | **22 passed** | `review-probes.log` |
| Falsification: repaired recognizers on the clean `0cc61e61` worktree | **42 passed**; worktree restored clean | `falsify-repaired-recognizer-on-0cc61e61.log` |
| Falsification: row-count assertion mutated | **6 failed / 36 passed**, the 6 being 7133/7144/7160 × both profiles; file restored to `2b03cb0b…` | `falsify-rowcount-assertion-mutated.log` |

## Cost check

`grep -c "^+++ b/src/" reconciliation.patch` = **0**; the patch names five files,
all under `tests/`; `+50 / −19` reproduces from the patch itself. The other dirty
`tests/raptor3/g3/generation/*.ts` files carry 04:47 mtimes against this unit's
12:18–12:47, so they belong to the earlier witness-followup stream and the
patch is complete. **Incremental core and complete charged cost: 0 LOC, 0 parser
tokens, 0 bytes** — as claimed. Test-infrastructure lines are counted
separately and are not charged.

## Author claims I could not verify

1. **The `0cc61e61` / `b0ec55fa` `src/`-alias comparisons themselves.** I did not
   re-run the alias; I replaced that evidence with a full clean-worktree run for
   the CS-03 claim and with hashes + a `diff -rq` for the CS-02 claim, so the
   conclusions no longer depend on the alias. The `b0ec55fa` row is still only
   the author's alias measurement.
2. **§18.6's wall/RSS numbers.** Mine differ (different machine load); I did not
   attempt to reproduce the author's figures.
3. **§18.4's falsifier for the two one-liners** (60/2 with both reverted). I did
   not re-revert them; I attacked the resulting contract instead (finding 1).
4. **The 300-cell sweep receipt** — see finding 5; not reproducible from the
   receipt as written, though the three registered campaigns cover the same
   recipes and are green.
