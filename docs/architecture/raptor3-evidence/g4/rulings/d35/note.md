# D-35 — the SQLite drivers' driver-level `parseResult` count/exists arm, deleted

Author: Fable. Worktree `/private/tmp/viborm-d35`, branch `d35` from `fd441c7f5`.
`TMPDIR=/private/tmp/viborm-d35-tmp` exported for every run. Nothing committed,
staged, stashed or pushed. The only writes outside the worktree are two backup
copies of files I was about to mutate for falsification, taken in this session's
scratchpad so the mutations could be undone by copy rather than by
`git checkout` (`sqlite3-index.ts.bak`, `parity-decoding.bak`); both files were
restored from them and re-run green.

## Release note (for the integrator)

The repo's changelog is `CHANGELOG.md`, and it has an `## Unreleased` section;
the entry is added there (hunk 9 below). Its text, as written into the file:

> The SQLite drivers (`sqlite3`, `bun-sqlite`, `d1`, `libsql`) no longer
> normalize `count`/`exist` results in their driver-level `parseResult`
> middleware. The query engine's decoder owns the meaning of a count and an
> exists answer — it asks for its own `_count` alias and reads it back — so
> those answers are unchanged on every SQLite driver. The
> `DriverResultParser.parseResult` contract itself is untouched: a consumer
> that wrapped `driver.result.parseResult` is still asked once per operation
> with the provider's raw result, and is unaffected in outcome.

The entry is the brief's required text and nothing more. An earlier draft closed
with two further sentences, claiming that an alias-losing SQLite transport (one
answering `COUNT(*)` where the engine asked for `_count`) loses a recovery here.
That claim was false and the repair round removed it (review R-1): **the deletion
has no observable difference at all**, including for such a transport, because
the recovery the arm performed was never read by this engine.
`normalizeCountResult` rewrites the column to `0viborm_count_result`
(`adapters/shared/result-parsing.ts:126-168`) while the decoder reads `_count`
(`raptor3/shared/query.ts:2941/2955/2970-2973`), and `COUNT_RESULT_KEY` has no
reader in any raw-row path — its readers (`result/cache-result-codec.ts:90`,
`result/result-shape.ts`, `client/typescript-type-renderer.ts:342`) are all over
decoded values. The arm turned one key the decoder cannot read into another key
the decoder cannot read, so such a row was refused with `V9001` before the
deletion exactly as it is after. That is measured, not reasoned: the reviewer
reconstructed the arm verbatim from `fd441c7f5`, ran it beside its absence over
the same row, and got an identical class, code and message on both arms for
`count` and for `exist` (`review-receipts/counterfactual-alias-row.log`). My own
F2 measured the after-state only; I wrote it up as though it had measured the
difference, and §5 now says what it actually measured.

## 1. The decision-elimination gate (written before the first production edit)

**Required behavior.** A `count` and an `exist` on the four SQLite drivers must
answer exactly what they answer today, and one authority must own the meaning of
those answers.

**Current owner — measured, not assumed.** Two owners are written down, and only
one of them ever answers:

- the engine's decoder. Raptor 3 aliases the count column `_count` for both
  `count` and `exist` (`src/query-engine/raptor3/shared/query.ts:2938`, `:2952`,
  `:2967-2970`) and reads that alias back out of the row it asked for;
- `sqliteResultParser.parseResult` (`src/drivers/shared/sqlite-utils.ts:46-53`),
  which for `operation === "count" | "exist"` offers `normalizeCountResult(raw)`
  to `next`. `normalizeCountResult` (`src/adapters/shared/result-parsing.ts:126`)
  recognises a single-column row whose key is `0viborm_count_result` or begins
  `count(`, so it never recognises `_count`.

The probe `receipts/arm-inert-probe.ts.txt` put a recorder above the SHIPPED arm
on a live better-sqlite3 transport and printed every raw it decided about
(`receipts/arm-inert-before.log`):

```
D35PROBE count raw=[{"_count":"2n"}] normalizeCountResult=undefined
D35PROBE count raw=[{"_count":"1n"}] normalizeCountResult=undefined
D35PROBE count raw=[{"_all":"2n"}]   normalizeCountResult=undefined
D35PROBE exist raw=[{"_count":"1n"}] normalizeCountResult=undefined
D35PROBE exist raw=[{"_count":"0n"}] normalizeCountResult=undefined
D35PROBE findMany raw=[{"id":"1n"},{"id":"2n"}] normalizeCountResult=undefined
D35PROBE answers={"count":2,"filteredCount":1,"countAll":{"_all":2},
                  "existTrue":true,"existFalse":false,"findMany":2}
```

The arm is asked on every `count`/`exist` (D-28 gave it its consumer) and
decides `undefined` every time: it is a pass-through this engine never reaches.
The probe file was removed once its receipt was taken — it is a measurement, not
a pin; its source is kept beside the log.

**Smallest proposed change.** Delete the arm. `parseResult` was the arm's whole
body, so the member goes with it and `sqliteResultParser` keeps `parseField`
(booleans, JSON TEXT) unchanged. `normalizeCountResult` is NOT deleted: the
MySQL **adapter** still owns that recovery at the adapter seam
(`src/adapters/databases/mysql/mysql-adapter.ts:1029-1042`), which this ruling
does not touch. `SQLite3Driver`'s canonical-surface identity keeps reading the
shipped parser, so it keeps meaning "the shipped row-level result hook, whatever
it is, is still the one installed".

**The decisions that disappear.**

| | |
| --- | --- |
| mechanism | a second normalisation of "which column carries a count", living in the driver middleware and reachable only by a provider that rewrites the engine's alias |
| consumers | `Queries.decodeResult` (`shared/query.ts:660`) — the only caller of any driver `parseResult` in `src/` — now finds no driver leg on the SQLite family and goes straight to the adapter leg, exactly as it already does for PGlite |
| replacing invariant | the engine asks for `_count` and reads `_count`; the alias it chose is the only authority on where a count lives. A provider that does not preserve an alias is an ADAPTER fact (MySQL states it once, at its own seam) |
| falsifier | `layer-drivers`, `provider-sqlite3`, `provider-libsql`, `parity-decoding.core.test.ts` (with the new D-35 cell), `driver-result-parser.test.ts`, raptor3 `g2-baseline` and `g2-contracts`, whole-estate typecheck |

**What is NOT decided here.** `DriverResultParser.parseResult` stays a public
driver contract with its D-28 consumer; only the SQLite family's implementation
of it goes. After this ruling no shipped driver installs a `parseResult`
(`bun-sql`'s parser is `parseField` only) — the row-value half is the half the
estate's drivers use.

## 2. The hunks

| # | file | hunk | what |
| --- | --- | --- | --- |
| 1 | `src/drivers/shared/sqlite-utils.ts:38-50` | `sqliteResultParser` | the `parseResult` member deleted whole — the count/exists arm was its entire body, the rest being `next(raw, operation)`. `parseField` (boolean integers, `json` TEXT) is byte-identical. The header now states what the parser owns (ROW VALUES) and why it says nothing about a RESULT |
| 2 | `src/drivers/shared/sqlite-utils.ts:7` | the import | `normalizeCountResult` dropped; `parseIntegerBoolean` stays. `normalizeCountResult` itself is NOT deleted — the MySQL **adapter** (`mysql-adapter.ts:1029-1042`) is its live owner at the adapter seam, and `result-parsing.core.test.ts` keeps pinning it |
| 3 | `src/drivers/sqlite3/index.ts:77-87` | `canonicalDriverParseResult` | the identity is unchanged code — still `sqliteResultParser.parseResult`, read from the owner, so it stays true if the shipped parser ever gains a result hook again. Added: the reason it exists (root `AGENTS.md` rule 5) and why it is not written down as `=== undefined` here |
| 4 | `src/query-engine/raptor3/shared/query.ts:632-646` | `decodeResult`'s doc | comment only. It named the deleted arm as the driver leg's example; it now says no shipped driver has anything to say at that leg, names the adapter examples (PostgreSQL bigint, MySQL alias recovery) and states the decoder's ownership of `_count` |
| 5 | `tests/contracts/engine/query/parity-decoding.core.test.ts:159-188` | new cell | the fact the arm claimed, pinned at its one owner (§3) |
| 6 | `tests/contracts/drivers/driver-export-surface.core.test.ts` | the four-wrapper table lifted to `SQLITE_WRAPPERS`, `installedDriver` extracted, new cell | carries the parity cell's statement to all four drivers the release note names (§3) |
| 7 | `tests/contracts/drivers/consumable-result-proof.core.test.ts:179-199` | new cell | the re-stated surface check still discriminates (§3, F1) |
| 8 | `tests/raptor3/g4/parity/driver-result-parser.test.ts:19-23, 287-292` | two comments | the D-28 pin's header item 4 and its cell comment named the deleted arm as the live example of `next(transformed)`. Assertions untouched — the pin installs its OWN `result`, so what it measures is unchanged (5/5 before and after) |
| 9 | `CHANGELOG.md` `## Unreleased` | the release note | above |

The guide `src/query-engine/raptor3/AGENTS.md` is NOT touched: its D-17/D-28
paragraph (lines 841-852) describes the chain `driver parseResult → adapter
parseResult → decoder` and the once-per-operation rule, which are unchanged, and
it never names the SQLite arm (checked by grep for `normalis`/`count/exist`).

## 3. Per-cell re-expression

The brief names three pin files. Measured first, with a grep of the whole test
estate for `sqliteResultParser`, `normalizeCountResult` and `COUNT_RESULT_KEY`:
**no cell anywhere pinned the DRIVER-level count/exists normalisation.** The
three files pin neighbouring facts, and each is listed below with what it pinned
before and what it pins now. The fact the arm claimed is newly pinned where it
actually lives (rows 5-7); nothing was deleted, skipped or weakened.

| cell | pinned before | pins now |
| --- | --- | --- |
| `adapters/result-parsing.core.test.ts` — `describe("normalizeCountResult")` (10 cells) and `describe("COUNT_RESULT_KEY")` (1) | the HELPER: which column names it recognises (`COUNT(*)`, `count(*)`, `COUNT(DISTINCT id)`, the private key), what it refuses (`count`, a model scalar, multi-key rows, empty/garbage input), bigint carriage | unchanged, byte for byte, and green. The helper keeps a live owner — the MySQL adapter seam — so deleting these cells would have deleted coverage of a shipped behavior |
| `adapters/internals-and-geo.core.test.ts:471-480` "MySQL normalizes counts, booleans, and naive UTC datetimes" | the ADAPTER-level normalisation on MySQL: `parseResult([{ "COUNT(*)": 2 }], "count")` → `[{ "0viborm_count_result": 2 }]`, and `{ "COUNT(*)": 1 }` on `exist` | unchanged. This cell is the arm's surviving sibling: after D-35 it is the estate's only live count normalisation, at the seam that owns dialect facts |
| `adapters/internals-and-geo.core.test.ts:500-504` "SQLite publishes physical promises and otherwise passes through" | the SQLite ADAPTER's `parseResult` passes everything through | unchanged — and now the whole SQLite result chain, driver leg included, says nothing at the result boundary |
| `engine/query/parity-decoding.core.test.ts:135-157` — the two D-17 seam cells | the driver seam is REACHED, through the shipped parser's `parseField` json rule (a decoded document, and a throwing rule becoming the public error class) | unchanged (`parseField` is untouched). With the result arm gone these are the cells that show the shipped parser still reaching the seam for row values |
| `engine/query/parity-decoding.core.test.ts:159-188` — NEW | — (nothing pinned the driver-level count/exists normalisation) | the fact the arm claimed, at its one owner: with `sqliteResultParser` installed and `parseResult` absent, the measured live raw `[{_count: 2n}]` answers `count` → `2`, `[{_count: 1n}]` answers `exist` → `true`, `[{_count: 0n}]` → `false` |
| `drivers/driver-export-surface.core.test.ts` — NEW `test.each` | the four wrappers install their concrete driver lazily | + each of sqlite3, bun-sqlite, d1 and libsql publishes exactly `sqliteResultParser`, so the parity cell's statement holds for all four drivers the release note names |
| `drivers/consumable-result-proof.core.test.ts` — NEW | nothing: every cell used the synthetic `CandidateDriver` with injected eligibility, so `SQLite3Driver.hasCanonicalProducerSurface` had no pin at all | a pristine `SQLite3Driver` is a consumable candidate; one carrying a `parseResult` middleware is borrowed — the re-stated identity comparison still decides that |
| `raptor3/g4/parity/driver-result-parser.test.ts` — 5 cells (D-28) | the middleware is asked once per operation, both routes, above the row-value chain, `next(transformed)` honoured, chunked terminal once | unchanged: the pin installs its OWN `result` on an `ObservingDriver`, so the deletion cannot change what it measures. 5/5 before and after; two comments re-stated |

Live halves, unchanged and green: `sqlite3.test.ts:472,479,636` (live `count` on
better-sqlite3) and `clientRawContract`'s `exist` cells on sqlite3
(`sqlite3-scalar-roundtrip.test.ts:40`). On libsql the same `clientRawContract`
registration sits inside a pre-existing `describe.skip` (`libsql-scalars-upserts.test.ts:31`,
"DRIVER_NOT_SUPPORTED"), so libsql has NO live exists witness in this tree — that
is the state at the base commit, untouched by this ruling, and the reason the
export-surface cell (same parser object, all four drivers) is worth its lines.

## 4. The four §7 questions, against the diff

1. **Necessary decision or representation repair?** Repair. Two representations
   of one fact — "which column carries a count" — existed: the engine's `_count`
   alias and the driver arm's column sniffing. The duplicated authority is
   removed rather than synchronised.
2. **Exact deletion and replacement obligation?** Removed decision: the SQLite
   family's driver-level count/exists normalisation. Mechanism:
   `sqliteResultParser.parseResult` + `normalizeCountResult`'s column sniffing.
   Consumer: `Queries.decodeResult`, the one caller of any driver `parseResult`
   in `src/`. Replacing invariant: the engine asks for `_count` and reads
   `_count`, so the alias it chose is the only authority. Falsifier: F2 below
   (an alias-losing row now fails closed, measured). No equivalent mechanism
   moved elsewhere: `normalizeCountResult` was NOT copied into the engine, and
   its only remaining call is the MySQL adapter's, which predates this ruling.
3. **One rule across uses?** The same owner answers on both routes and all four
   drivers: the decoder's `_count` read serves `count`, `exist` and
   `count({select:{_all:true}})` (probe receipt), live and prepared (the D-28 pin
   exercises both routes through the same boundary), and the four SQLite drivers
   share one parser object (export-surface cell). The adapter seam keeps the
   dialect-level recovery for the provider that needs it (MySQL) — an
   unavoidable difference between "the alias the engine chose" and "what a
   transport did to it", not an accidental fork.
4. **What actually grew?** Production code shrank by 10 code-bearing lines and
   grew by 19 comment lines (§7). The charged query-engine census is unchanged
   in token-bearing lines: the only charged file touched is `query.ts`, and its
   diff is entirely inside one doc comment (`tokenLines` 15472, `lines` 18685
   after; the +3 physical lines are comment). Tests grew by 83 lines, counted
   separately. No new semantic rule was added anywhere.

## 5. Falsification record

| # | mutation | expected | measured | receipt |
| --- | --- | --- | --- | --- |
| F0 | none — the shipped arm observed on a live better-sqlite3 before the deletion | the arm decides `undefined` for every real count/exist | 6 asks recorded (`count` ×3 including `_all`, `exist` ×2, `findMany`), `normalizeCountResult` `undefined` every time; answers `2`, `1`, `{_all:2}`, `true`, `false`, 2 rows | `receipts/arm-inert-before.log`, probe source `receipts/arm-inert-probe.ts.txt` |
| F1 | the `driver.result.parseResult === …canonicalDriverParseResult` leg removed from `hasCanonicalProducerSurface` | the new consumable cell reddens — otherwise the re-stated check would be decoration | RED: `AssertionError: expected { Object (driver, executeEntry, …) } to be undefined`, 1 failed / 5 passed | `receipts/falsified-surface-check.log` |
| F2 | the new parity cell's count row changed from `{_count: 2n}` to `{"COUNT(*)": 2n}` (what an alias-losing provider would answer) | the cell reddens, showing it measures the decoder reading ITS alias | RED, and it fails CLOSED with the public class: `QueryEngineError V9001 — Driver "scripted" returned a malformed int scalar for operation "count": the value is absent`. **This measures the after-state only**, not a difference: with the arm reconstructed from `fd441c7f5` the same row fails closed with the identical class, code and message (review R-1, `review-receipts/counterfactual-alias-row.log`), so the cell fails closed when the alias is lost and did so before the deletion too | `receipts/falsified-alias-row.log` |

Both mutations were restored from copies taken before the edit (never
`git checkout`), and both files were re-run green afterwards:
`receipts/parity-decoding-restored.log` (10/10) and the final `layer-drivers`
run (974/974).

## 6. Verification

`TMPDIR=/private/tmp/viborm-d35-tmp` exported for every run; one file, one
project or one registered mode per call; never two at once; no lock refusal was
met and no lock was removed. Receipts in `receipts/`.

| run | result | receipt |
| --- | --- | --- |
| `engine/query/parity-decoding.core.test.ts` (`layer-query-engine`) | 10/10 (was 9 cells, +1) | `parity-decoding.log` |
| `drivers/driver-export-surface.core.test.ts` | 10/10 ×2 projects | `driver-export-surface.log` |
| `drivers/consumable-result-proof.core.test.ts` | 6/6 ×2 projects | `consumable-result-proof.log` |
| `g4/parity/driver-result-parser.test.ts` (D-28 pin, `extended-local`) | 5/5 | `driver-result-parser-pin.log` |
| `layer-drivers` (whole project, final) | **974/974, 43 files** | `layer-drivers-final.log` (earlier 973/973 before the consumable cell: `layer-drivers.log`) |
| `provider-sqlite3` (whole project) | **755 passed, 1 skipped**, 6 files | `provider-sqlite3.log` |
| `provider-libsql` (whole project) | 9 passed, 663 skipped (pre-existing `describe.skip`, DRIVER_NOT_SUPPORTED) | `provider-libsql.log` |
| `layer-query-engine` (whole project) | 643/644, 1 pre-existing red (§7) | `layer-query-engine.log` |
| `run-raptor3.mjs g2-baseline` | 216/216, gate verified | `mode-g2-baseline.log` |
| `run-raptor3.mjs g2-contracts` | 216/216, gate verified | `mode-g2-contracts.log` |
| whole-estate typecheck (final) | **0 diagnostics, exit 0**, 6.54 s, 4934 MiB peak | `typecheck-final.log` (earlier run, before the last two hunks: `typecheck.log`) |
| `npx biome check` on the six touched source/test files | no new diagnostic. One pre-existing warning: `driver-export-surface.core.test.ts:1` suppression-has-no-effect, present at `fd441c7f5` (line 1 is untouched). `query.ts`'s diagnostic SET is the base's (import sorting, trailing-comma formatting, four lint rules); none falls in the edited comment, and no `--write` was run — the import order of that file is load-bearing | — |

Wall/RSS from the bounded runner line are in each receipt; the heaviest was the
typecheck at 4934 MiB peak, the heaviest suite `layer-query-engine` at 848 MiB.

## 7. LOC, still red, unverified, blockers

**LOC** (`git diff --numstat fd441c7f5 -- src tests`):

```
 11  14  src/drivers/shared/sqlite-utils.ts
  9   0  src/drivers/sqlite3/index.ts
  8   5  src/query-engine/raptor3/shared/query.ts
 24   1  tests/contracts/drivers/consumable-result-proof.core.test.ts
 58  32  tests/contracts/drivers/driver-export-surface.core.test.ts
 31   0  tests/contracts/engine/query/parity-decoding.core.test.ts
  8   5  tests/raptor3/g4/parity/driver-result-parser.test.ts
```

src +28 −19 (net **+9**); tests +121 −38 (net +83). The production total is
positive because the three hunks each replace deleted code with the REASON for
the deletion. Code-bearing production lines, comments excluded: **+1 −11, net
−10** (the collapsed import against the seven-line arm, its four-line import
block and the three obsolete header lines) — the expected negative direction.
The charged query-engine census is unchanged in token-bearing lines (§4.4).

**Still red.** One, pre-existing and unrelated:
`tests/contracts/architecture/contract-matrix.core.test.ts` >
"inventories every executable test by owner and boundary" fails with
`tests/raptor3/candidate-handoff.test.ts: expected undefined to be defined` —
an unclassified test file committed on 2026-09-14 (`cf2cbc4e6`), untouched by
this ruling. `layer-query-engine` is otherwise 643/643. Everything in the
brief's falsifier list is green.

**Unverified claims.**

- bun-sqlite and d1 have no live transport in this environment, so "the count
  and exists answers are unchanged" is verified LIVE only on sqlite3 (and, for
  `count`, on the scripted decoder path). For those two drivers, and for libsql's
  `exist`, the claim rests on two measured facts instead: all four publish the
  same parser object (export-surface cell, green) and that object no longer has
  a result hook. I did not construct a fake D1/bun transport to go further.
- The consumable-result machinery has no caller in `src/` today
  (`resolveConsumableResultCandidate` / `executeConsumableResultCandidate` are
  reached only from `consumable-result-proof.core.test.ts`). The surface check I
  re-stated therefore guards a dormant mechanism. I report this as observed
  state, not as a finding — it is outside D-35 and I changed nothing about it.

**Blockers.** None. No public-contract change was needed beyond the deletion the
ruling ordered, no legacy fallback, no duplicated interpretation, and no
registered refusal was touched.

## 8. Alternatives rejected

1. **Keep `parseResult` as a pass-through** (`next(raw, operation)` with the arm
   gone). Rejected: an owner of nothing that is still asked once per operation,
   and it would leave the D-28 chain with a leg that can only return its input.
2. **Write `driver.result.parseResult === undefined` in `sqlite3/index.ts`**
   instead of keeping the identity capture. Rejected: it copies a fact
   `shared/sqlite-utils.ts` owns into a second file, and it inverts silently —
   if the shipped parser ever gained a result hook again, every `SQLite3Driver`
   would become permanently non-canonical with nothing to catch it.
3. **Delete `normalizeCountResult` with the arm.** Rejected on measurement: the
   MySQL adapter calls it, and eleven cells pin it. "Now-unreferenced helpers"
   turned out to be none.
4. **Re-express the three named pin files by editing their cells.** Rejected
   because it would have been false: those cells pin the helper and the ADAPTER
   seam, not the driver arm (§3). Editing them to mention D-35 would have been
   patchwork over cells that already say something true.
## 9. Repair round (review verdict REVISE → resolutions applied)

`review.md` returned **REVISE** with one required resolution, R-1, in three
parts, all documentary: "The code is right… One document is wrong". I applied
exactly those three, plus one stale cross-reference corrected alongside them and
disclosed below. **No source or test file was touched in this round** — `git diff --numstat fd441c7f5 -- src tests` is byte-for-byte the
table in §7 (src +28 −19, tests +121 −38), so the code the reviewer ran green is
the code being handed over.

### What was wrong

My release note claimed an observable difference that does not exist: that an
alias-losing SQLite transport (answering `COUNT(*)` where the engine asked for
`_count`) "is no longer recovered by the driver middleware". The arm never
recovered it **under this engine**. I verified the reviewer's mechanism against
the source myself rather than taking the receipt on trust:
`normalizeCountResult` rewrites such a row to `0viborm_count_result`
(`adapters/shared/result-parsing.ts:126-168`), the decoder reads `rows[0]?._count`
(`raptor3/shared/query.ts:2941/2955/2970-2973`), and `COUNT_RESULT_KEY`'s only
readers in `src/` are `result/cache-result-codec.ts:90`,
`result/result-shape.ts:418/432` and `client/typescript-type-renderer.ts:342` —
every one of them over decoded values, none in a raw-row path. The arm turned a
key the decoder cannot read into another key the decoder cannot read. The
reviewer's counterfactual measures the same thing empirically, with the arm
reconstructed from `fd441c7f5` and run beside its absence
(`review-receipts/counterfactual-alias-row.log`: identical class, code and
message on both arms, for `count` and for `exist`).

The error was mine in a specific way worth naming: F2 measured the **after**
state only, and I wrote it up as though it had measured a **difference**. A
one-armed measurement cannot support a counterfactual claim, and the claim it
was used to support went into a shipped file.

### The three edits

| # | resolution | file | before → after |
| --- | --- | --- | --- |
| R-1.1 | delete the two sentences from the changelog entry | `CHANGELOG.md` | The entry ended "…A custom SQLite transport that renames the count column … is no longer recovered by the driver middleware; that row is refused with the public error class instead. No shipped SQLite provider renames it." Both sentences are gone; the entry now ends at "…and is unaffected in outcome." What remains is the brief's required text and is accurate. |
| R-1.1 (consequential) | the note's block quote reproduces the file | `note.md` §Release note | The quote is introduced as "Its text, as written into the file", so the same two sentences were dropped from it. Leaving them would have made the note false about the file's content. |
| R-1.2 | replace the paragraph beginning "The last two sentences go beyond the brief's required text" | `note.md` §Release note | Replaced with the measured fact: the deletion has **no** observable difference at all, including for an alias-losing transport, because the recovery the arm performed was never read by this engine — with the mechanism, the readers, and the counterfactual receipt cited. |
| R-1.3 | the F2 row must say what it measured | `note.md` §5 | "showing exactly what the arm used to recover" is gone from the *expected* column. The *measured* column now states that F2 measures the after-state only, that the same row fails closed identically with the arm reconstructed, and therefore that the cell fails closed when the alias is lost and did so before the deletion too. The falsification itself is kept — it is still the proof that the new cell measures the decoder reading ITS alias. |

One pointer was corrected with them, disclosed here so the diff holds no
surprise: the sentence introducing the entry said "hunk 7 below" where the
hunks table (§2) lists `CHANGELOG.md` as hunk **9**. Stale cross-reference in
the very sentence R-1.2 rewrote, no substance, trivially revertible.

### R-2 — recommended by the reviewer, deliberately NOT applied

The review's §2 offers one clause for the changelog: on the SQLite drivers
`result.parseResult` is now **absent**, so a consumer that *captured* the
shipped one (`const prior = driver.result.parseResult`) rather than installing
its own must check before calling. The reviewer marks it "not required for
ACCEPT"; my repair instruction is to apply the resolutions "and nothing more",
so I left the entry alone and record it here as a decision for the integrator.

It is accurate, and I checked it: `parseResult` is optional on the type
(`driver-instrumentation.ts:94`), and a `parseField`-only parser is already a
shipped shape in this estate (`bunSQLResultParser`, `bun-sql/index.ts:97-104`),
so the post-deletion surface is not novel — the nuance is runtime-only. If the
integrator wants it, the whole change is one sentence appended to the entry:

> On these drivers `result.parseResult` is now absent rather than a no-op, so a
> consumer that captured the shipped function instead of installing its own
> middleware must check it before calling.

### Carried forward from the review (no action taken here)

- **O-1** — with `canonicalDriverParseResult` now `undefined`,
  `hasCanonicalProducerSurface` accepts any `result` object with no
  `parseResult`, so a `parseField`-only middleware on an instance is no longer
  caught. The reviewer judged this not a required change (the leg never claimed
  `parseField`; the consumable hazard is the result hook) and notes the stronger
  form, `driver.result === sqliteResultParser`, should be ruled for SQLite and
  PGlite together, not for SQLite alone. That is Arnaud's call, not this unit's.
- **O-2** — the adapter-level `parseResult` legs look as inert as the driver leg
  was (MySQL normalises to a key nothing in the raw path reads; PostgreSQL's
  `convertBigIntToNumber(raw)` over a row array always falls through). Reasoned
  from source by the reviewer, not measured — no live MySQL/PG here. If it
  holds, the ruling D-35 made about the driver leg is owed to the adapter leg.
  It changes nothing in this unit: `normalizeCountResult` has a caller and a
  brief cannot delete a called function.

### Verification of the repair round

Markdown only, so nothing in the test estate is affected: `grep -rl CHANGELOG
tests scripts` is empty, and neither changed file is imported anywhere.
`TMPDIR=/private/tmp/viborm-d35-tmp` exported for both runs; one at a time; no
lock refusal met, no lock removed.

| run | result | receipt |
| --- | --- | --- |
| `node scripts/run-typecheck.mjs` (whole estate) | **0 diagnostics, exit 0**, 6.24 s, 4963.3 MiB peak | `receipts/typecheck-repair.log` |
| `engine/query/parity-decoding.core.test.ts` (the ruling's own new cell) | **10/10** | `receipts/parity-decoding-repair.log` |
| `npx biome check CHANGELOG.md` | 0 files processed — Biome's config ignores Markdown, so there is no formatting fix to make by hand | — |

The brief's remaining falsifiers (`layer-drivers`, `provider-sqlite3`,
`provider-libsql`, `driver-result-parser.test.ts`, modes `g2-baseline` and
`g2-contracts`) were **not** re-run: nothing under `src/` or `tests/` changed in
this round, proven by the numstat above, and they are green in §6 on that exact
code and again on the reviewer's independent runs (`review.md` §4). Re-running
them would have measured the same bytes a third time.

### LOC

Unchanged: this round edits `CHANGELOG.md` and this note only, neither of which
is in the `src`/`tests` census. The §7 figures stand — src +28 −19 (code-bearing
production lines +1 −11, net **−10**), tests +121 −38.

### Still red, unverified, blockers after the repair

Unchanged from §7. Still red: the one pre-existing, unrelated
`contract-matrix.core.test.ts` cell naming `tests/raptor3/candidate-handoff.test.ts`
(committed 2026-09-14 in `cf2cbc4e6`, untouched here); the reviewer reproduced
it independently. Unverified: bun-sqlite and d1 have no live transport here, so
"count and exists answers unchanged" is live-verified on sqlite3 only, plus the
reviewer's O-2. **Blockers: none.** No commit, stage, reset, stash or push; no
write outside `/private/tmp/viborm-d35`.
