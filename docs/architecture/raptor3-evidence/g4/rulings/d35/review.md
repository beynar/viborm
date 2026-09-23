# D-35 — independent review

Reviewer: independent (not the author). Worktree `/private/tmp/viborm-d35`,
branch `d35`, base `fd441c7f5`. `TMPDIR=/private/tmp/viborm-d35-tmp-r` exported
for every run. Nothing committed, staged, reset, stashed or pushed; no file of
the author's was edited. My own receipts are in
`docs/architecture/raptor3-evidence/g4/rulings/d35/review-receipts/`.

## Verdict: **REVISE**

The code is right. The deletion is exactly the arm and nothing else, the
helper it used keeps its live caller, the canonical-surface check keeps one
owner, no cell was deleted, weakened or skipped, and every falsifier in the
brief is green on my own runs. **One document is wrong**: the release note in
`CHANGELOG.md` states a behavior change that does not exist, and the note
presents it as measured when the measurement made was of the after-state only.
Two sentences out of the changelog and two corrections in `note.md` and this is
an ACCEPT.

## 1. Required resolution (R-1) — the release note claims a change that does not happen

`CHANGELOG.md` (last two sentences of the new entry):

> A custom SQLite transport that renames the count column (answering `COUNT(*)`
> instead of the `_count` the engine asked for) is no longer recovered by the
> driver middleware; that row is refused with the public error class instead.
> No shipped SQLite provider renames it.

`note.md` §Release note calls these "the ONLY observable difference the deletion
can produce, and I measured it rather than reasoned about it (falsification F2
below)", and the F2 row says the red cell shows "exactly what the arm used to
recover".

**Measured: the arm never recovered it under this engine.** F2 measured the
NEW state only. I measured the counterfactual: the arm reconstructed verbatim
from `fd441c7f5` (`{...sqliteResultParser, parseResult: <the deleted body>}`),
installed on the same `ScriptedDriver` + `SQLiteAdapter` the new cell uses, over
the same alias-losing row —
`review-receipts/counterfactual-alias-row.log`:

```
D35REVIEW count  WITH-ARM  REJECTED V9001 Driver "scripted" returned a malformed int scalar for operation "count": the value is absent.
D35REVIEW count  NO-ARM    REJECTED V9001 Driver "scripted" returned a malformed int scalar for operation "count": the value is absent.
D35REVIEW exist  WITH-ARM  REJECTED V9001 Driver "scripted" returned a malformed int scalar for operation "exist": the value is absent.
D35REVIEW exist  NO-ARM    REJECTED V9001 Driver "scripted" returned a malformed int scalar for operation "exist": the value is absent.
```

Identical class, identical code, identical message, with and without the arm.
The mechanism is plain in the source: `normalizeCountResult` rewrites the
column to `0viborm_count_result` (`adapters/shared/result-parsing.ts:126-168`),
and raptor 3 reads `_count` (`raptor3/shared/query.ts:2941/2955/2967-2973`) —
`COUNT_RESULT_KEY` has no reader in any raw-row path (`grep`: its only readers
are `result/cache-result-codec.ts:90` and `client/typescript-type-renderer.ts`,
both over DECODED values, plus `result/result-shape.ts`, which after the C-01
cutover is reached only by the type renderer). The arm turned one key the
decoder cannot read into another key the decoder cannot read. The estate
already says so in the very doc block this ruling edited: *"it reached nothing
after the result engine was retired"* (`query.ts:645-646`, pre-existing), and
the g4 ledger calls the arm inert (`g4.md:2180`).

The probe file I wrote for this measurement was removed after its receipt
(`git status` is the author's eight files plus the ruling directory).

**Exact minimal resolution.**

1. `CHANGELOG.md`: delete the two sentences quoted above. What remains is the
   brief's required text and is accurate.
2. `note.md` §Release note: delete the paragraph beginning "The last two
   sentences go beyond the brief's required text", or replace it with the
   measured fact — the deletion has **no** observable difference, including for
   a transport that loses the alias, because the recovery the arm performed was
   never read by this engine.
3. `note.md` §5, F2 row: keep the falsification (it is a good one — it shows the
   new cell measures the decoder reading ITS alias), but change "showing exactly
   what the arm used to recover" to what was measured: the cell fails closed
   when the alias is lost, and it did so before the deletion too.

This matters beyond tidiness: `CHANGELOG.md` is shipped, and the sentence tells
a user that a recovery they may believe in has just been removed. Nothing was
removed from behavior; that is the ruling's whole premise.

## 2. Recommended while that entry is open (R-2, not required for ACCEPT)

The entry says "a consumer that wrapped `driver.result.parseResult` is still
asked once per operation with the provider's raw result, and is unaffected in
outcome." True of a consumer that INSTALLS its own `parseResult` (the D-28
chain, unchanged). A consumer that CAPTURED the shipped one
(`const prior = driver.result.parseResult`) and calls it now calls `undefined`.
The brief's own wording ("unaffected in outcome") covers the outcome, so this is
not a contract break, but one clause would stop the reading: on the SQLite
drivers `result.parseResult` is now absent, so a wrapper that captured it must
check before calling. `DriverResultParser.parseResult` is optional in the type
(`driver-instrumentation.ts:93-97`), so this is a runtime-only nuance.

## 3. Verified, hunk by hunk

| hunk | verdict |
| --- | --- |
| `sqlite-utils.ts` — `parseResult` member deleted | Exactly the arm. `parseField` is byte-identical (booleans, `json` TEXT); the object had no `parseRelation`. The dropped header bullet ("COUNT normalization (BigInt -> number)") described something `normalizeCountResult` never did — its removal loses nothing true. |
| `sqlite-utils.ts:7` — import collapsed | `parseIntegerBoolean` still used. `normalizeCountResult` correctly NOT deleted: `mysql-adapter.ts:1036` calls it and eleven cells in `adapters/result-parsing.core.test.ts` pin it. "Now-unreferenced helpers" really are none. |
| `sqlite3/index.ts:77-87` — the canonical identity, unchanged code + reason | Right call. The identity still reads from the owner (`sqliteResultParser.parseResult`), so it re-arms itself if the shipped parser ever gains a result hook; alternative 2 (`=== undefined` written down here) would have been a second copy of another file's fact. The reason given matches root `AGENTS.md` rule 5 ("unchanged … parser surfaces", "a parser middleware … stays borrowed"). See observation O-1 for the one thing the comparison no longer discriminates. |
| `query.ts:632-646` — `decodeResult` doc | Comment only; the diagnostic set of the file is the base's, shifted by +3 lines (compared base vs. head with `biome check`, identical 16 entries). Accurate about the driver leg. See O-2 about its adapter examples. |
| `parity-decoding.core.test.ts` — new cell | Pure addition (9 → 10). Pins the moved fact at its owner with the measured live raw (`_count: 2n` / `1n` / `0n` → `2`, `true`, `false`). The nine existing cells are untouched. |
| `driver-export-surface.core.test.ts` — table lifted, new `test.each` | The existing cell is not weakened: the inline shape guard became `installedDriver()`, same throw, same `instanceof` + `dialect` assertions. The new cell (`result === sqliteResultParser` on all four wrappers) is what carries the parity cell to bun-sqlite, d1 and libsql. |
| `consumable-result-proof.core.test.ts` — new cell | Pure addition; sound. `registerConsumableResultCandidate` keeps a `WeakMap`, so two constructed drivers leak nothing, and `new SQLite3Driver()` opens no database (`initClient` is lazy). The mutation is instance-level, so the prototype leg cannot mask it — F1's red proves the parseResult leg is load-bearing. |
| `driver-result-parser.test.ts` — two comments | Assertions untouched; the pin installs its own `result` on an `ObservingDriver`, so what it measures is unaffected. 5/5 on my run. |
| `CHANGELOG.md` | Right file (`RELEASING.md:76`; no changeset mechanism), right section. Content: R-1. |

Per-cell re-expression table (§3 of the note): **accurate**. I re-read the three
pin files the brief named. `adapters/result-parsing.core.test.ts` pins the
HELPER, `adapters/internals-and-geo.core.test.ts:470-495` pins the **MySQL
adapter** (`parseResult([{ "COUNT(*)": 2 }], "count")` → `0viborm_count_result`)
and `:497-504` the SQLite ADAPTER's pass-through. None of them pinned the driver
arm; a grep of the whole test estate for `sqliteResultParser` returns only the
three test files this ruling touched. Editing those cells would have been
patchwork, as the note says.

## 4. Runs (mine, serial, one file / project / mode per call)

| run | result | receipt |
| --- | --- | --- |
| `engine/query/parity-decoding.core.test.ts` | 10/10 | `review-receipts/parity-decoding.log` |
| `g4/parity/driver-result-parser.test.ts` (D-28 pin) | 5/5 | `review-receipts/driver-result-parser-pin.log` |
| `layer-drivers` (whole project) | 974/974, 43 files | `review-receipts/layer-drivers.log` |
| `provider-sqlite3` (whole project, live better-sqlite3) | 755 passed, 1 skipped, 6 files | `review-receipts/provider-sqlite3.log` |
| `provider-libsql` (whole project) | 9 passed, 663 skipped | `review-receipts/provider-libsql.log` |
| `run-raptor3.mjs g2-baseline` | 216/216, gate verified | `review-receipts/mode-g2-baseline.log` |
| `run-raptor3.mjs g2-contracts` | 216/216, gate verified | `review-receipts/mode-g2-contracts.log` |
| `node scripts/run-typecheck.mjs` | 0 diagnostics, exit 0, 6.02 s, 5017.6 MiB peak | `review-receipts/typecheck.log` |
| `contracts/architecture/contract-matrix.core.test.ts` | 4/5 — the one red names `tests/raptor3/candidate-handoff.test.ts`, untouched here | `review-receipts/contract-matrix.log` |
| counterfactual probe (R-1) | see §1 | `review-receipts/counterfactual-alias-row.log` |
| `biome check` on the seven touched source/test files | one pre-existing warning (`driver-export-surface.core.test.ts:1`, line untouched); `query.ts` diagnostic set identical to base | — |

The libsql skips (`describe.skip`, DRIVER_NOT_SUPPORTED) are pre-existing: those
files are not in this diff. The still-red the note reports is confirmed
pre-existing and unrelated — this ruling adds no test FILE, so the inventory
cannot have been affected by it.

LOC verified: `git diff --numstat fd441c7f5 -- src tests` matches the note
exactly (src +28 −19, tests +121 −38). The production positive is three reason
comments replacing seven lines of code; code-bearing production lines go
negative, as the brief expected. `query.ts`'s change is entirely inside one doc
comment, so the charged census cannot move in token-bearing lines.

## 5. Observations (no change required here)

- **O-1 — what the surface check no longer discriminates.** With
  `canonicalDriverParseResult` now `undefined`, `hasCanonicalProducerSurface`
  accepts any `result` object that has no `parseResult` — a `{ parseField: … }`
  middleware installed on an instance used to be caught (accidentally: the stock
  value was a function), and now is not. I did not raise this to a required
  change: the leg never claimed to own `parseField` (an object carrying the
  stock `parseResult` plus a hostile `parseField` passed at the base too), the
  consumable hazard is the RESULT hook, which sees the provider's row array, and
  the estate's other consumable driver already spells exactly this weaker
  question (`pglite/index.ts:232`, `driver.result?.parseResult === undefined`) —
  which the brief puts out of scope. If Arnaud wants the stronger statement it
  is one comparison, `driver.result === sqliteResultParser`, and it should be
  ruled for both families at once, not for SQLite alone.
- **O-2 — the adapter leg looks as inert as the driver leg was.** The rewritten
  `decodeResult` doc offers two adapter examples. Neither appears reachable
  under raptor 3: MySQL's `parseResult` normalises to `0viborm_count_result`,
  which nothing in the raw path reads (§1), and PostgreSQL's calls
  `convertBigIntToNumber(raw)` on the whole row ARRAY
  (`postgres-adapter.ts:656-667`), which returns `undefined` for anything that
  is not itself a bigint, so it always falls through to `next()`. Reasoned, not
  measured (no live MySQL/PG here). If it holds, the same ruling D-35 made about
  the driver leg is owed to the adapter leg, and `normalizeCountResult`'s
  "live owner" is live only in the sense of having a caller. That does not
  change this unit: a called function cannot be deleted by this brief, and the
  author was right to keep it.
- **O-3 — the two backup copies outside the worktree** (author's preamble) are
  scratchpad copies taken so a falsification could be undone by `cp` instead of
  `git checkout`. Disclosed, benign, and the safer of the two options.

## 6. Unverified claims carried forward

- bun-sqlite and d1 have no live transport here, so "the count and exists
  answers are unchanged" is verified live on sqlite3 only. For the other three
  it rests on two green facts (all four publish the same parser object; that
  object has no result hook). The author reports this honestly; I add no
  confidence to it and did not build a fake transport either. libsql's `exist`
  witness sits inside a pre-existing `describe.skip`, as the note says.
- O-2 above is reasoned from source, not measured.
- "No lock refusal was met and no lock was removed" — unverifiable after the
  fact; I met none either.

## 7. Rules

Twelve rules of `g4/briefs/common.md`: respected. One fact one authority — the
duplicated authority is removed, not synchronised, and nothing equivalent moved
elsewhere. No policy boolean, no second reader, no new interpreter, no legacy
import, no fallback. No registered refusal touched; the one refusal that
appears (V9001 on a row with no `_count`) is the pre-existing decoder contract,
unchanged. No test deleted, weakened or skipped — three added. Pinned runtime,
serial validation through the bounded runner, evidence kept per run.
