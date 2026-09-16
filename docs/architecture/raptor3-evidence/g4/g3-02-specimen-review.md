# G3-02 specimen under D-7 — independent review

**Unit.** Bounded G4 harness unit: re-express the G3-02 malformed-batch
specimen under Arnaud's D-7 decision
([brief](g4/briefs/g3-02-specimen.md) — `g4/briefs/g3-02-specimen.md`,
[author note](g4/regression/note.md) §G.1–G.9).

**Reviewer.** Independent; did not write the unit. Applied nothing — the source
already carried the change. Repaired nothing.

**Outcome: ACCEPT.** Three notes, no blocking or must-fix finding.

Receipts for everything below:
`/Users/arnaud/code/viborm/docs/architecture/raptor3-evidence/g4/g3-02-specimen-review-receipts/`.
Probes kept at
`/Users/arnaud/code/viborm/tests/raptor3/g4/review/g3-02-specimen/specimen-parity.review.test.ts`
(with its own `g3-02-review.workspace.ts`, registered nowhere).

---

## 1. The four REVISE tests, each measured

### 1.1 Only the one harness file changed — PROVEN, not inspected

`captureRaptor3Identity()` on the live tree returns
`production fce8ec0cd32c839c5517a383d92f003e090e72cb8110b8ec0e08e1f7664d6904`,
**byte-identical to the freeze-2 production fingerprint** (`g4/freeze/identity.json`,
`g4.md` "Freeze 2 (00:55, 2026-09-16)"). No production file moved.

For the harness half I recomputed the freeze fingerprint counterfactually:
re-running the manifest's own `fingerprint()` over the same file set, with
`tests/raptor3/g3/author-execution-regressions.test.ts` substituted by its
`HEAD` bytes, yields
`2b5ed066a619bf8accf7b3f503cd96f7b4b7e4aac52c1249cfa7cf751df1666c` — **exactly
the freeze-2 harness fingerprint**. So that one file is the only member of the
harness identity that changed since the freeze, and its `HEAD` bytes hash to
`688de89c…`, the author's recorded "before" (`receipts/g3-02/sha256-before.txt`).
The live file hashes to `778438ffa1729b90d5501e4994a7ede2b231bd8034a6b2bbcdc293cc163f4132`,
the author's recorded "after".

Outside the two identity perimeters: `find src tests scripts benchmarks
-newermt "2026-09-16 00:55"` returns exactly one path — the owned harness file.
`tests/contracts/adapters/dialect-vocabulary.core.test.ts` (mtime 2026-09-15
09:29) and `tests/pattern/pack/program-dump.ts` (2026-09-02) are older dirty
files from other streams. Nothing staged (`git diff --cached` empty), `HEAD`
still `0cc61e61`, both stashes dated 2026-08-25 and 2026-09-02.

`git diff --stat` for the unit: **1 file, 265 insertions, 49 deletions**, four
hunks, all inside the imports, the driver class, one new helper and cell 1.
Cells 2 and 3 are untouched.

### 1.2 The lone-statement half asserts the shipped answer — MEASURED against the shipped engine

Probe **R1**: half A's exact request (`record.createMany` with two relation-free
rows and `select`) run twice on the same `BatchOnly` + malformed-row cut, once
through `createCommandEngine(...).execute` and once through the **public client**
(`createClient(...)`, `client.record.createMany(...)`, i.e. the shipped engine).

| | candidate | shipped |
| --- | --- | --- |
| failure name / code | `QueryEngineError` / `V9001` | identical |
| message | `Driver "sqlite3" returned a malformed int scalar for operation "createMany": the value is not a canonical integer.` | identical |
| meta (less `correlationId`) | `{driver:"sqlite3", operation:"createMany", scalarType:"int"}` | identical |
| `recordSeriesProgress` | absent | absent |
| statements / batch calls | 1 / 0 | 1 / 0 |
| committed rows | `[{id:1,code:"one"},{id:2,code:"two"}]` | identical |

`assert.deepEqual(candidate.failure, shipped.failure)` and the row and batch
comparisons all hold. Probe **R3** repeats the whole differential on a
**transaction-capable** driver (`supportsTransactions` true, no batch): same
sentence, same meta, same rows, still equal to shipped. The cell's half-A
sentence is the shipped answer, on both transports.

### 1.3 The acknowledged-batch property is still pinned by a real batch — MEASURED

Probe **R4**, on half B's exact request (`parent.createMany` with a nested
`leftChildren.createMany` and `select`), measures the plan rather than trusting
the note:

- two acknowledged batch windows (`batchCalls === 2`), none of them pre-armed
  traffic (`batchesBeforeArm === 0`);
- window 0 carries the parent insert and holds **five** statements — scratch
  temp table, scratch clear, `INSERT INTO "g3_author_execution_parents"`, the
  `last_insert_rowid()` ref capture, `INSERT INTO "g3_author_execution_left_children"`;
- window 1 is the terminal read-back plus the scratch release;
- the single corrupted response is the terminal `SELECT`, at a statement index
  strictly **after** the parent insert — so the write window was acknowledged
  and its rows are durable *before* the malformed row arrives, which is exactly
  the "acknowledged atomic batch → truthful progress" property;
- the refusal then carries `recordSeriesProgress {atomicity:"segment",
  phase:"result", committedSegments:1, committedWriteMembers:2,
  completedMembers:2}` with the parent row and its child committed.

`lone` is therefore false for this request by its first conjunct
(`statements.length === 1`), measured as five statements in the write window —
`src/query-engine/raptor3/shared/operation-context.ts:1141-1145`, guarding
`if (this.usesBatch && !lone)` at `:1145`. The pin is not vacuous: probe **R5**
shows the cut is stated over *rows*, so the same `createMany` without `select`
answers nothing row-bearing, the cut never fires and the write succeeds.

**No property was lost.** The old cell's exact tuple — `{atomicity:"segment",
phase:"result", committedSegments:1, committedWriteMembers:1,
completedMembers:0}` with one acknowledged batch and both rows committed — is
still pinned, on the bind-budget-split shape, at
`tests/raptor3/g4/unit02/lone-statement-transport.test.ts:400-471` ("6. a set
window that committed still publishes its record-series progress"), a
registered cell of `g4-unit02-author` which I re-ran green (19 files / 127
cells). The specimen therefore adds a structural shape instead of duplicating
the split one, as §G.3 claims.

Probe **R6** reproduces the red the unit repairs, independently of the unit's
file: a driver whose corruption cut sits **inside `executeBatch` only** — the
pre-D-7 spelling — leaves half A's request untouched (`batchCalls: 0`,
`batchCorrupted: false`), no rejection is raised and the create publishes
`[{id:1},{id:2}]`. That is qualification attempt 2's "Missing expected
rejection" exactly, and it confirms the author's falsification 1 receipt
(`receipts/g3-02/falsification-1-cut-narrowed-to-executebatch.log`, which is a
genuine red and stays labeled red).

### 1.4 No registered cell count changed

`scripts/raptor3-manifest.mjs:416-418`,
`G3_AUTHOR_EXECUTION_REGRESSION_COUNTS`, still declares **3** for this file; the
manifest is inside the harness fingerprint I reproduced at the freeze value, so
it was not edited. The file has exactly three `it` blocks, and the runner's own
contract gate verified 3 on the current bytes
(`g3-author-execution-regressions.log`: "3 passed (3)", "contract gate
verified"). `tests/raptor3/g4/review/` is explicitly skipped by
`scripts/credential-free-test-manifest.mjs:260`, so my probes move no count
either.

---

## 2. Findings

All three are **notes**. None blocks; none needs a repair before freeze 3.

### Finding 1 — note. Half B is a candidate-only pin, and the divergence from the shipped engine is wider than §G.9 says

*Location:* `tests/raptor3/g3/author-execution-regressions.test.ts:270-383`
(half B) and `g4/regression/note.md` §G.9, second bullet.
*Probe:* `tests/raptor3/g4/review/g3-02-specimen/specimen-parity.review.test.ts`
R2. `g3-02-specimen-review-receipts/probes-run-2.log` records it as a **red**
parity assertion (1 failed / 4 passed) with both engines' full observations;
`probes.log` is the final green run in which the divergence is pinned as a
measured fact rather than asserted as parity. `probes-run-1.log` is the first,
failed invocation (`--project=raptor3` collects nothing, because the raptor3
project's include list is explicit) and is kept as-is.

§G.9 records as unverified only that "the shipped engine would publish the same
**member counts**". Measured, the shipped engine does not publish the same
*failure* at all for half B's request under the same cut:

| | candidate | shipped |
| --- | --- | --- |
| batch windows | 2 (write window, then terminal window) | **1** (all seven statements in one window) |
| terminal read | `SELECT "q0"."id", "q0"."label" … ORDER BY …` | `SELECT "t0"."id" … LIMIT 1` (a fragment probe) |
| message | the malformed-scalar refusal | `Fragment output 'parent.create.id' did not resolve to a runtime value.` |
| progress | `{phase:"result", committedSegments:1, committedWriteMembers:2, completedMembers:2}` | `{phase:"member", committedSegments:0, committedWriteMembers:0, completedMembers:0, mayHaveCommittedSegment:true, memberPath:[0], totalMembers:1}` |
| durable rows | parent + child | **identical** |

Both engines leave the same rows, so the divergence is in what each *says*, not
in what each *did*, and on this shape the candidate is the more truthful of the
two (shipped reports zero committed segments for a batch it acknowledged). This
is not a regression — the pre-D-7 cell was candidate-only too (it drove
`candidate.execute` and never compared) — and half B's own comment claims a
property, not a shipped sentence. But the note's caveat should be widened from
"member counts" to "half B pins candidate behavior on a shape where the shipped
engine plans differently and answers a different failure", with the measurement
above.

*Resolution:* one sentence in §G.9 (and, if the author wishes, a pointer from
half B's comment to this receipt). No code change.

### Finding 2 — note. The cut's docblock overstates the batch entry's dispatch

*Location:* `tests/raptor3/g3/author-execution-regressions.test.ts:64-67` —
"at `execute` — which the driver's own batch entry dispatches every query
through (`drivers/driver-transaction-base.ts` `executeBatch`)".
*Probe:* read of `src/drivers/driver-transaction-base.ts:659-748`; statement
lists in R2/R4.

The loop at `:667` has two arms, and **both** choose `executeRaw` rather than
`execute` when `isVerbatimBatchQuery(query)` holds (`:684` and `:718`).
"Every query" is therefore true of every *non-verbatim* query. It happens to be
true of this specimen without qualification — all seven of half B's statements
appear in the `execute` observation list, and the one row-bearing response is
corrupted there — but the sentence is the durable explanation of why the cut is
transport-independent, so it should say "every query it does not dispatch
verbatim".

*Resolution:* four words in the docblock. No behavior change; the line citation
itself (`:667` loop, `this.execute` at `:693`) is accurate.

### Finding 3 — note. `arm()` resets three observations and leaves two behind; and one red half hides the other

*Location:* `tests/raptor3/g3/author-execution-regressions.test.ts:88-93`
(`arm()`), used at `:356` (`batchDriver.batches.find(...)`) and in both
diagnostics.
*Probe:* R4's `batchesBeforeArm` assertion.

`arm()` clears `statements`, `batchCalls` and `corrupted` but not `batches` or
`batchResults`, which `BatchOnlySQLiteDriver` also accumulates. So the window
list half B searches and prints is not aligned with the `batchCalls` it
asserts. Measured harmless today — `batchesBeforeArm === 0`, the migration
opens no batch window on this driver — but a migration that ever batched would
make the diagnostic (and, in principle, the `find`) span pre-arm traffic.

Separately: because the two halves share one `it` (necessarily — a second `it`
would move the registered count, §G.7), a red half A short-circuits half B.
The author's own falsification-1 receipt records "Half B unreached". That is an
accepted cost of the count constraint the brief imposed, not a defect, but it
is worth stating where the cell explains itself, so a future reader does not
read a green as covering both halves after a half-A failure.

*Resolution:* add `this.batches.length = 0; this.batchResults.length = 0;` to
`arm()` (or note why not), and one sentence about the short-circuit. No
behavior change either way.

---

## 3. §7 decision-elimination gate, applied to this diff myself

The diff is one test file; no `src/` byte moved. Against the four questions:

1. **What decision disappears?** "Which driver entry carries this specimen's
   fault." Verified gone: the file no longer carries a
   corrupting `executeBatch` override — `grep -n "executeBatch"` on it returns
   only `BatchOnlySQLiteDriver`'s pre-existing counting override (`:48-57`) and
   docblock prose — and the old class name `MalformedBatchResultSQLiteDriver`
   no longer occurs anywhere under `src/`, `tests/` or `scripts/`.
2. **Could a caller still express the old behavior?** Not from the cell — no
   flag, no transport branch. Reaching the old sentence requires re-narrowing
   the cut, which is R6/falsification 1 and goes red.
3. **Is any meaning stated twice?** No second authority. Half B's property and
   `lone-statement-transport.test.ts` row 6 are the same property on two
   different shapes; neither file *states* the transport rule, both *observe*
   it (`batchCalls`, window length). No second public-syntax walker, per-verb
   codec, duplicated result-shape preparation, recreated lifecycle, projection
   rebuilt for a decoder, JavaScript arithmetic beside SQL, defensive
   re-validation, policy-boolean bag, per-feature interpreter, fixture-named
   flag, legacy import, cached absence or public-contract change is introduced —
   the only new imports are `VibORMErrorCode` from `@errors` and `isRecord` from
   `@validation/value-guards`, both already used by the G2.9 precedent file.
4. **What falsifies it?** Two author falsifications, both reproduced or
   corroborated: narrowing the cut reddens half A exactly as attempt 2 did (my
   R6 reproduces the same engine behavior independently), and dropping the
   nested write reddens half B by turning it into half A.

---

## 4. Suites re-run (bounded runner, one mode per invocation, on the current tree)

Lock free throughout; every raptor3 mode's contract gate verified.

| Mode / command | Result | Wall / peak RSS | Receipt |
| --- | --- | --- | --- |
| `g3-author-execution-regressions` | **3 passed (3)**, gate verified (count 3) | 4.07 s / 527.4 MiB | `g3-author-execution-regressions.log` |
| `g3-execution-review` | 6 passed (6) | 4.07 s / 528.0 MiB | `g3-execution-review.log` |
| `g3-suppression-retry` | 2 passed (2) | 4.01 s / 522.8 MiB | `g3-suppression-retry.log` |
| `g3-transaction-array` | 4 passed (4) | 3.97 s / 535.4 MiB | `g3-transaction-array.log` |
| `g29-result-progress` | 2 passed (2) | 3.95 s / 536.0 MiB | `g29-result-progress.log` |
| `g29-dependency-boundaries` | 4 passed (4) | 4.11 s / 517.0 MiB | `g29-dependency-boundaries.log` |
| `g4-unit02-author` | 127 passed (127), 19 files | 5.90 s / 776.6 MiB | `g4-unit02-author.log` |
| `g2-generated` | 52 passed (52) | 4.80 s / 760.9 MiB | `g2-generated.log` |
| `node scripts/run-typecheck.mjs` | exactly the two permitted `pattern/pack.ts` TS2345 (`:1443`, `:2633`) | 7.02 s / 6,442.3 MiB | `typecheck.log` |
| review probes (6 cells, own workspace) | 6 passed (6) | 2.54 s / 465.8 MiB | `probes.log` |

Every count matches the author's §G.5 table for the modes both of us ran.
`g2-generated` was not in the author's mode list (it is in mine) and is green at
52/52, so D-7's own regression family is unaffected by the re-expression.

## 5. Evidence integrity

- `receipts/g3-02/identity-after.json` reproduces exactly on the live tree
  (production `fce8ec0c…`, harness `41e2b2f6…`), which is a stronger stamp than
  a per-log identity line.
- Counts in §G.5 match my independent re-runs for every overlapping mode.
- Both falsification logs are genuine reds and stay labeled as falsifications;
  `receipts/g3-02/pre-lint-edit/` is labeled in §G.5 as the earlier, identical
  green run and is not relabelled as final.
- §G.9's unverified claims are labeled; Finding 1 asks for one of them to be
  widened, not added.
- Biome, independently re-run (`biome check`, never `--write`): **8 findings in
  5 categories** — `assist/source/organizeImports` (1:1, the pre-existing
  `transaction-operation` / `sync-schema` order, present in `HEAD` too),
  4 × `lint/performance/useTopLevelRegex` (`:461`, `:477`, `:497`, `:515`, all
  in untouched cell 2), `lint/correctness/noUnusedFunctionParameters` (`:33`,
  untouched `ObservedSQLiteDriver`), `lint/suspicious/noMisplacedAssertion`
  (`:178`, untouched `transactionArray`) and one `format`. Exactly §G.6's claim:
  the round adds no new category.

## 6. Cost check

`node scripts/query-engine-structure.mjs` on the current tree is **byte-identical**
to `receipts/g3-02/query-engine-structure.log` (`diff` clean; `src/query-engine`
181 files, 86,631 physical lines, 68,606 token-lines, 3,846 functions, 8,983
branch nodes). With the production fingerprint unchanged from the freeze, the
incremental candidate **core charged LOC / parser tokens / bytes is 0 / 0 / 0**,
as §G.7 claims. The harness file itself, counted separately, goes 436 → 652
physical lines and 14,161 → 22,891 bytes — both figures confirmed.

## 7. One consequence for the integrator (not a finding)

My probes add two files under `tests/raptor3/g4/review/g3-02-specimen/`, which
are inside the harness identity (they are excluded from credential-free
discovery and from every registered mode, so no count moves). After them the
identity is

```
production fce8ec0cd32c839c5517a383d92f003e090e72cb8110b8ec0e08e1f7664d6904   (unchanged)
harness    7609b04421c3c6bcef193b8abe9600bf837e5ac856f75e2521328369432dde41
```

recorded at `g3-02-specimen-review-receipts/identity-after-review-probes.json`.
Freeze 3 must be captured after this review lands (or after the probes are
removed, if the integrator prefers) — the same way freeze 2 was captured with
the earlier review probe directories in place.

## 8. Unverified author claims, as they stand after this review

1. *"Measured on better-sqlite3 only; a provider without `RETURNING` is not
   measured here."* — still unverified; I did not run a native provider either.
   The split form is `g4/unit02/malformed-result-cuts.test.ts` cells 1/1b, green
   inside `g4-unit02-author` 127/127.
2. *"No shipped-engine comparison was run for half B's shape."* — I ran it.
   The shipped engine answers a **different failure** (Finding 1). The claim
   should be widened, not removed.
3. *"Which conjunct of `lone` half B's plan trips is inferred, not
   instrumented."* — now measured indirectly: the write window is five
   statements, so `statements.length === 1` is false on its own. The other two
   conjuncts remain uninstrumented, and the cell still asserts only the window
   and the batch count, which is the right scope.
4. *"The native provider modes and the generated campaigns were not run."* — I
   ran `g2-generated` (52/52) in addition; the native modes remain unrun by
   either of us, and no production file changed, so nothing there is at risk.
