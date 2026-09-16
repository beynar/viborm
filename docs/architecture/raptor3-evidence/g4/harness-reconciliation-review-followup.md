# Independent review follow-up — G4 "Harness reconciliation (cuts, transport plans, witness one-liners)"

Round 2, after the **REVISE** verdict in
[`harness-reconciliation-review.md`](harness-reconciliation-review.md).
Reviewer: the same independent reviewer (did not write the unit, did not repair
it).

Repair narrative: [`g4/witness/note.md`](witness/note.md) §18.9 (line 2450),
with §18.1, §18.2, §18.4, §18.5, §18.7 and §18.8 corrected in place.
Repair patch: [`repair/reconciliation.patch`](witness/receipts/reconciliation/repair/reconciliation.patch)
(complete unit diff) and
[`repair/repair-delta.patch`](witness/receipts/reconciliation/repair/repair-delta.patch)
(this round only).
Follow-up receipts: [`harness-reconciliation-review-followup-receipts/`](harness-reconciliation-review-followup-receipts).
Follow-up probes: `tests/raptor3/g4/review/harness-reconciliation/` — now 7 probe
files, **23 cells**, run through the same `review.workspace.ts` scaffold; two are
new this round (`sc13-refusal-and-leak.test.ts`,
`recognizer-tapes.test.ts`) and `lookup-recognizer.test.ts` was rewritten to read
the live recognizer literal out of the scenario sources instead of keeping a
copy of it.

Identity at this review:
production `1696696474…`, harness `c8232495f9…`
([`identity-review-followup.json`](harness-reconciliation-review-followup-receipts/identity-review-followup.json)).
Both moved again from the repair round's `bc26281d…` / `49cbc09603…`: the
concurrent `src/` stream is still writing (`src/query-engine/raptor3/…` mtimes
14:38–14:39), and my own probe files move the harness fingerprint. The six files
this unit owns are **byte-identical** to the author's
[`repair/SHA256.files`](witness/receipts/reconciliation/repair/SHA256.files) —
`shasum -a 256 -c` passes on all six before and after every command below,
including the falsifications, so nothing in this review left residue and nothing
the author wrote moved under me.

## Outcome

**ACCEPT.**

Both must-fix findings are repaired, and so are all four repairable notes. The
repairs are not cosmetic: SC-13's read half now fails when the decode is lost
(I reproduced that with a mutation the author did not run — expecting the raw
stored string reddens the cell with both engines returning `[1, 0, 0]`), the
folded × faulted transport shape is a fixed witness whose falsifier names the new
recipe by name, and the narrowed CS-03 recognizer still reads **every** `lookup`
binding in **both** recorded tapes while refusing an insensitive collation. The
two registration items that were never this unit's to fix (B-R3 and the G4 read
promotion) are recorded with owner and reproduction. Cost is unchanged and still
verifiably zero: no `src/` file is in the patch.

Three note-level observations remain below (N1–N3). None breaks a stated
invariant and none hides coverage; N1 is a sentence in a doc comment that claims
more than the assertion under it measures, and I record it because the sentence
was written by this round.

## Per-finding status

| # | Original finding | Severity | Status | How I verified it |
| --- | --- | --- | --- | --- |
| 1 | SC-13's rewritten read half cannot fail for the reason the cell exists | must-fix | **Repaired** | The cell seeds one row with raw SQL through `WitnessWorldOptions.seed`, writes `EMBEDDINGS[1]` (an id the seed did not write), pins the stored spelling, and asserts `[{ embedding: [1, 0, 0] }]` through `expectRead`, which checks the hand value against the shipped engine **and** against the candidate (`witness-world.ts:104–122`). Falsifier I ran: expect the *undecoded* value and the cell reddens — `expectRead` prints `+ embedding: [1,0,0]` against `- embedding: '[1,0,0]'` ([`falsify-sc13-expects-raw-string.log`](harness-reconciliation-review-followup-receipts/falsify-sc13-expects-raw-string.log)). Seed removed ⇒ red at the pin ([`falsify-sc13-seed-removed.log`](harness-reconciliation-review-followup-receipts/falsify-sc13-seed-removed.log)). New probe cell 4 shows the expectation is sensitive to a leaked second row. `g4-read-contracts` 62/62, registered count still 12, no manifest edit |
| 2 | The folded transport shape has no FIXED fault witness | note | **Repaired** | Seed **8611** (C11, depth 0, fanout 0, ordinary, `legal-provider-failure`) is in `representativeRecipes()`; both `TRANSPORT_PROFILES` run it inside the single registered cell, and `coverageAxis` / `recurrenceShapes` are unchanged, so no count moved (`g3-generated-transport-smoke` 1/1, gate verified). Falsifier reproduced: narrowing the fold to `insertCount === 1 && !fault` reddens the smoke naming `g3-c11-8611-0:recurrence-0; actual=INSERT; expected=INSERT,SELECT` ([`falsify-folded-fault-recipe.log`](harness-reconciliation-review-followup-receipts/falsify-folded-fault-recipe.log)); `transport-plans.ts` restored and re-hashed `e331824c…`. The §18.8 #4 census is now measured: my probe recomputes every published row from the **real** `generateG3Recipe` and reproduces all of them, including my own round-1 numbers 44/233 and 108/624 ([`folded-fault-census.test.ts`](../../../../tests/raptor3/g4/review/harness-reconciliation/folded-fault-census.test.ts)) |
| 3 | The §5.4 surrounding-cut evidence runs in no lane | must-fix (record) | **Recorded** | §18.7 carries **B-R3** with both file paths, the owner (registration writer, with the G4-02 author for counts) and the reproduction. Still true today: `grep` over `scripts/` and both workspace files finds neither `root-member-cut-trace.test.ts` nor `malformed-result-cuts.test.ts`; both remain **8 cells green** under the review scaffold. No code change was owed and none was made |
| 4 | The widened recognizer accepts collations that are not the exact-text one | note | **Repaired** | Both scenario files now read `(?: COLLATE (?:BINARY|"C"))?`. Verified against the **whole recorded tapes**, not an excerpt ([`recognizer-tapes.test.ts`](../../../../tests/raptor3/g4/review/harness-reconciliation/recognizer-tapes.test.ts)): all 10 `lookup` bindings in the current tape and all 10 in the `0cc61e61` tape still match; the old recognizer matches 0 of the current and 10 of the baseline (the staleness diagnosis); no recorded statement collates with anything but `BINARY`; `parentId` / `parentTenant` carry **no** collation in either tape, which is the measured reason their recognizers were left alone. `COLLATE NOCASE` and `COLLATE "und-x-icu"` are now refused by both files. The corrected comment is accurate: SQLite `exactTextEq` = `${column} COLLATE BINARY = ${value}` (`sqlite-adapter.ts:357–358`), Postgres = plain `=` (`postgres-adapter.ts:234`), MySQL = `(${column} = ${value} AND BINARY ${column} = ${value})` (`mysql-adapter.ts:537–538`) |
| 5 | One receipt carries no identity | note | **Withdrawn, as asked** | §18.1 no longer cites the 300-cell sweep; the receipts README labels `cs03-all-seed-sweep-after.json` **"SUPERSEDED — do not cite"** and the file is kept unmodified. The three registered campaigns that cover the same 300 recipes on both profiles are green here again (`cs03-extension-a/b/composition-seeds`, gates verified) |
| 6 | B-R2 is already stale | note | **Resolved and re-measured** | `scripts/raptor3-manifest.mjs` now reads 8 / 7 / 7 / 13 and the counts are in the registration writer's own diff, not this unit's. I re-ran all four modes at 15:0x: **8 / 7 / 7 / 13 passed, every contract gate verified, all four exit 0** ([`g4-route-*-r2.log`](harness-reconciliation-review-followup-receipts)). §18.5 and §18.8 #2 are corrected |
| 7 | The G4 read promotion is unrecorded | note | **Recorded** | §18.7 carries the registration request with the guard's file and lines. The guard still excludes them (`raptor3-campaign-receipts.test.mjs:970–986`, "G4 suites stay outside credential-free discovery while they are red"), so the request — not an edit — is the right instrument |

## New observations this round

### N1 — note — SC-13's write half asserts the generic provider failure, not the vector tier's refusal

**Location** `tests/raptor3/g4/read-codecs.test.ts:452–458` (the doc comment
this round rewrote) and `:479–483` (the parity assertion).

The new comment says: "SQLite declares no vector tier (`sqlite-adapter.ts`
`vector = unsupportedVector`). The WRITE is where the capability is asked: the
contract is a refusal with one identity". Measured, the capability tier is never
consulted on this path. `unsupportedVector` (`src/errors/query.ts:442–464`)
has three members — `literal`, `l2`, `cosine` — and a parameterized write reaches
none of them. Both engines emit

```
INSERT INTO "g4_codec_vectors" ("id", "embedded_name", "embedded_vector")
VALUES (?, ?, ?) RETURNING …
```

and both then raise `QueryError` / `"Query execution failed"` / code `V2001`,
the generic driver-execution failure with the underlying cause redacted. So the
"one identity" the cell compares is the identity any failing statement has.

This is **not** a regression and **not** lost coverage: the parity is real (a
candidate that refused earlier, or later, or with a different class would redden
the cell), the write half is unchanged in meaning from before the unit, and the
read half is now the cell's actual witness. It is the comment that claims more
than the assertion measures.

The same probe shows why the repair's fixture choice is load-bearing rather than
decorative: writing the id the seed *did* write raises the **same** class, so
identity alone cannot tell a duplicate key from the capability failure. Using
`EMBEDDINGS[1]` is what keeps the assertion honest.

**Probe**
[`sc13-refusal-and-leak.test.ts`](../../../../tests/raptor3/g4/review/harness-reconciliation/sc13-refusal-and-leak.test.ts)
(4 cells, green) — seeded vs unseeded parity, seeded-id vs fresh-id parity, the
identity pin (`QueryError` / `V2001` / two emitted INSERTs / not
`FeatureNotSupportedError`), and leak sensitivity.

**Resolution** (optional, for whoever next touches the cell): either pin the
code/`meta` alongside the class so the assertion says what the comment says, or
soften the comment to "both engines fail the provider write identically; the
vector tier's own refusal is witnessed by the distance path". Nothing is owed by
this unit.

### N2 — note — §18.9's closing paragraph about the reviewer's probe is stale

§18.9 "What this round deliberately did NOT do" says the reviewer's
`lookup-recognizer.test.ts:21` "declares `REPAIRED` as a local constant, so its
third cell still passes while describing a pattern no scenario file contains any
more". That was true when the note was written; the probe has since been
rewritten to read the live `lookupWhere` literal out of each scenario file, so a
silent re-widening (or a divergence between the two files) now fails there. The
sentence can be dropped.

### N3 — note — two failed receipts in this round were overwritten rather than kept

The repair README records that two earlier `raptor3-campaign-receipts` attempts
"failed on my own malformed invocation … and were overwritten by the retry". The
common brief asks that failed attempts keep their receipts. The overwritten
attempts were invocation errors that measured nothing, and the author disclosed
them in writing rather than quietly, so this is a discipline note, not a
correctness one. Every other failed attempt in both rounds is retained and
labeled (the two typecheck attempts, the three CLI attempts, the stale-evidence
retries).

## What I re-measured independently

- **The decode really is witnessed.** Not just "the cell passes": the mutation
  that expects the stored string reddens with the shipped **and** candidate
  answers printed as `[1, 0, 0]`. `expectRead` compares the hand value to the
  shipped engine first and to the candidate second, so neither engine can hide
  behind the other.
- **The seed cannot mask the refusal.** Seeded and unseeded worlds raise the same
  class for the same write; nothing lands in the table after two refused writes.
- **The narrowed recognizer lost nothing real.** Checked over all 63 statements
  of each recorded tape, not over copied excerpts.
- **The relation-scope recognizers are safe to leave alone** — measured, not
  assumed: no `parentId` / `parentTenant` binding carries a collation in either
  tape, and if one ever does, my probe fails.
- **The census reproduces from the real generator**, row by row, including the
  child-run rows and the two numbers I measured by hand in round 1.
- **B-R2 is really closed** — four modes, four gates, four zero exits, measured
  after the manifest moved.
- **B-R3 is really open** — neither file is in any manifest or workspace today.

## Suites run for this follow-up

Serial, through `run-vitest-safe.mjs` / `run-raptor3.mjs`, with the workspace
lock respected (three route modes and the CLI self-test had to wait for another
stream's Vitest; the waits and retries are in the receipts).

| Suite / mode | Result | Receipt |
| --- | --- | --- |
| Review probes (7 files) + the unregistered §5.4 cut evidence (2 files) | **31 passed** (23 probe + 8 evidence) | `review-probes-3.log` |
| `g4-read-contracts` | **62 passed**, gate verified, exit 0 | `g4-read-contracts-r2.log` |
| CS-03 extension-campaign self-test | **42 passed** | `cs03-selftest-r2.log` |
| `cs03-extension-a-seeds` / `-b-seeds` / `-composition-seeds` | **1 passed** each, gates verified, exit 0 | `cs03-extension-*-seeds-r2.log` |
| `g3-generated-transport-smoke` | **1 passed**, gate verified, exit 0 (one stale-evidence retry, both logs kept) | `g3-generated-transport-smoke-r2.log`, `…-retry.log` |
| `g3-generated-smoke` / `g3-generated-minimization` | **6 / 1 passed**, gates verified | `g3-generated-smoke-r2.log`, `g3-generated-minimization-r2.log` |
| `g3-transport-seed-batch 8000` | **1 passed**, gate verified | `g3-transport-seed-batch-8000-r2.log` |
| `g4-write-transport-seed-batch 100000` | **1 passed**, gate verified | `g4-write-transport-seed-batch-100000-r2.log` |
| `g4-transport-seed-batch 50000` | **1 passed**, gate verified | `g4-transport-seed-batch-50000-r2.log` |
| `g4-route-lifecycle` / `-admission` / `-cache` / `-transactions` | **8 / 7 / 7 / 13 passed**, gates verified, **all exit 0** | `g4-route-*-r2.log` |
| receipts self-test | **39 passed / 0 failed** | `raptor3-campaign-receipts-r2.log` |
| whole-estate typecheck | only the two permitted Pattern `TS2345` at `pack.ts:1443` / `:2633` (8.41 s, 5804.5 MiB) | `typecheck-r2.log` |
| CLI self-test | **10 passed / 0 failed**, 236 s, no identity-guard trip (an earlier attempt at 14:41 failed 10/10 on the workspace lock and is retained unchanged) | `raptor3-cli-selftest-r2.log`, `raptor3-cli-selftest.log` |
| Falsification: SC-13 expects the undecoded string | **1 failed** (the decode witness), file restored | `falsify-sc13-expects-raw-string.log` |
| Falsification: SC-13 seed removed | **1 failed** at the spelling pin, file restored | `falsify-sc13-seed-removed.log` |
| Falsification: fold withheld from faulted replies | **1 failed**, naming `g3-c11-8611-0:recurrence-0`, file restored | `falsify-folded-fault-recipe.log` |

`biome format` on the five edited files reports deviations only outside this
unit's hunks (read-codecs at 44–56 / 158–160 / 180–181 / 247–249 / 326,
extension-a at 141 / 304–306 / 330–342, extension-composition at 67–76 /
557–562 / 734–761), which matches §18.9 R-8's claim even though its enumerated
line numbers have since shifted. `biome check` reports 88 pre-existing
`noMisplacedAssertion` diagnostics in the helper functions of
`read-codecs.test.ts`; none is on a line this unit wrote.

## Cost check

`grep -c "^+++ b/src/"` over
[`repair/reconciliation.patch`](witness/receipts/reconciliation/repair/reconciliation.patch)
is **0**; the patch names six files, all under `tests/`; `git apply --stat`
reproduces **+111 / −29**, and the delta patch reproduces **+81 / −35**. Both
patches **reverse-apply cleanly** against the working tree, so the patch is the
change. The dirty `src/` files carry another stream's mtimes (13:29, 14:11,
14:38–14:39) and none is in the patch. **Incremental core and complete charged
cost: 0 LOC, 0 parser tokens, 0 bytes**, as claimed. Test-infrastructure lines
are counted separately and are not charged.

## §7 gate, re-applied to the repair delta

Four files, all harness. No second public-syntax walker, no per-verb codec, no
duplicated result-shape preparation, no recreated lifecycle, no projection
rebuilt to obtain a decoder, no JavaScript arithmetic beside SQL, no defensive
re-validation of a trusted internal value, no policy-boolean bag, no per-feature
interpreter, no fixture-named flag, no legacy import or fallback, no cached
absence, no public-contract change. The one added fixture (seed 8611) is an
ordinary member of an existing hand-written matrix and changes no registered
count; the one added world hook (`seed:`) is the mechanism `WitnessWorld` already
exposes for raw-SQL seeding, not a new lifecycle.

## Author claims I could not verify

1. **§18.9's wall/RSS figures.** Mine differ (different machine load); I did not
   try to reproduce them.
2. **The author's own two SC-13 falsifiers** (`repair/falsify-sc13-*.log`). I did
   not re-run his exact mutations; I ran my own, including one he did not
   (expecting the undecoded string), which attacks the same claim more directly.
3. **The `zz-probe.test.ts` explanation for attempt 1's ten `TS2741`.** That file
   no longer exists, so the attribution to the concurrent G4-02 stream is not
   checkable after the fact; what is checkable is that today's whole-estate
   typecheck is clean apart from the two permitted Pattern errors.
4. **That the two B-R3 files are the *only* §5.4 surrounding-cut evidence** for
   the root-`create` fold. I verified they are unregistered and green and that
   `g4/unit02/note.md` §P.11.3 cites them; I did not audit unit02's record for a
   third file.
