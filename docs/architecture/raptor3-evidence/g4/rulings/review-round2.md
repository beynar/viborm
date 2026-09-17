# Review round 2 — the rulings unit's repair round

Independent reviewer, 2026-09-17. Scope: whether the repair round applied
**exactly** the resolutions of `review-d28.md` (F1–F4) and `review-d29-d32.md`
(resolutions 1–3), whether anything else moved, and whether the affected files,
modes and the whole-estate typecheck are green.

Subject: worktree `/private/tmp/viborm-rulings`, branch `rulings`. The repair is
the **working tree** over the wip commit `e821cd21a` (itself over the base
`5ac39cfd`); nothing was committed. Every run below used
`TMPDIR=/private/tmp/viborm-rulings-tmp-ra`, one file or one registered mode per
call, never two at once. Receipts:
`docs/architecture/raptor3-evidence/g4/rulings/receipts/review-round2/`.

Discipline: I wrote nothing in this worktree except this file and that receipts
directory. I edited no file of the author's. The two falsifications and one
probe below ran in my own detached scratch worktree
`/private/tmp/viborm-rulings-scratch-ra` (`e821cd21a`), whose production files I
restored from byte-exact copies under
`/private/tmp/viborm-rulings-tmp-ra/rev2/backup/` and re-checked with `shasum`
(`98cf436d8144f107938109d0f2e4b304af6039eb`); its `git status` is back to what it
was. Nothing committed, staged, reset, stashed or pushed;
`/Users/arnaud/code/viborm` and every other worktree untouched.

## Verdict: **ACCEPT**

All seven resolutions are applied, at the owners the reviews named, in the shape
they specified. The regression is gone (both modes 6/6 and 3/3 with their gates
verified), both new cells carry their own falsification — **reproduced by me, not
read** — nothing else in the tree moved, no test was deleted, weakened or
skipped, no policy boolean or new production class appeared, formatting is clean
on the lines this round owns, and the whole-estate typecheck is at zero
diagnostics. I also measured the one half of F1 that the first review could only
reason about: the per-window registered refusal fires again.

Two minor notes are recorded at the end. Neither blocks: one is a one-line
allocation the author already disclosed, the other is a stale heading in the
note.

## Resolution by resolution

| # | resolution | applied | where |
| --- | --- | --- | --- |
| D-28 F1 | row-count owner extracted; windows collected; per-window assert; one ask over `windows.flat()`; guide corrected | **yes, verbatim in substance** | `shared/query.ts:4185-4205`, `shared/operation-context.ts:918-946, 961, 984, 1465-1492`, `AGENTS.md:153-160, 850-866` |
| D-28 F2 | one cell for the caller that broke, both routes | **yes** | `tests/raptor3/g4/parity/driver-result-parser.test.ts` cell 5 |
| D-28 F3 | one `publishedProjection`, not three readers | **yes** | `operation-context.ts:918-922`, callers at `:945, 1927, 1999, 2073` |
| D-28 F4 | the note's wrong driver sentence | **yes** | `note.md` §"The SQLite count/exists normalisation" and Blocker 3 |
| D-29 R1 | a deterministic local pin for the progress companion | **yes** | `tests/raptor3/g4/parity/integration-staleness.test.ts` cell 4 |
| D-29 R2 | the companion listed as a blocker | **yes** | `note.md` Blockers item 4 |
| D-32 R3 | line references restated against the final file | **yes** | `note.md` §D-32 + "Repair round › D-32 resolution 3" |

### D-28 F1 — the window keeps its row count, the operation keeps its ask

`Queries.assertExpectedRows(query, rows)` holds both branches verbatim;
`decodeQuery` asks it (its two single-statement callers, `read` at `:887` and
the flush at `:1051`, are unchanged); `decodeTerminalResults` and
`finishTerminals`' live arm now collect `Input[][]`, one entry per window, in
dispatch order; `publishedTerminal` asks the count per window on the rows the
**provider** answered and then asks the middleware **once** over
`windows.flat()`, decoded against the shared shape with `decodeProjection`,
which carries no row-count check. That is the resolution as written.

Checked beyond the text:

- **Every multi-window caller is 1:1.** `finishMany`'s only callers pass
  `seriesQueries(...)` or `[]` (`commands/execution.ts:589-594, 691-698`,
  `operation-context.ts:1843, 1969, 2034`), and `seriesQueries` hands each chunk
  `prepared.shape` while `selectSeries` (`query.ts:3140-3183`) stamps each chunk
  its own `expectedRows.count`, so the shape premise holds and the count premise
  is exactly the one restored. `publish`/`publishPrepared` pass one window each,
  so `windows[index]!` can never be a fabricated window.
- **Single-window decoding is identical to the base.** For a non-recursive shape
  `decodeProjection` is `rows.map(...)`, so decoding the concatenation equals
  concatenating the per-window decodes; the live arm keeps the base's
  `internal = false` and its `terminal` dispatch flag (`answer(query, true)` in
  `publish`, `queries.length === 1` in `finishTerminals`).
- **The regression is gone, measured.** `g3-execution-review` **6/6** and
  `g3-author-execution-regressions` **3/3**, gates verified — the four cells the
  first review reddened.
- **The half F1 could only reason about is now measured.** A driver whose
  SECOND terminal window answers one row short (my probe, live route,
  `createMany` + `select`, four rows, bind budget 7, two windows) publishes on
  the repaired tree the window's own registered refusal — *"createMany with
  'select' could not read back one of the created rows at the primary key it
  reported…"* — and at `e821cd21a` publishes *"Raptor 3 createMany final read
  returned inconsistent row counts."* instead. Receipts
  `r2-probe-shortwindow-repaired.log` (1 passed) and
  `r2-probe-shortwindow-at-e821cd21a.log` (1 failed, the wrong sentence). So the
  per-window refusal is a live contract again, not only a structural claim. The
  probe is mine and is **not** registered — see note 3.

### D-28 F2 — the pin now covers the caller that broke

Cell 5, *"sees a chunked terminal's rows once, in input order, on both routes"*,
drives both arms, counts the terminal reads at the provider (2), asserts one ask
naming `createMany`, that the ask carries the operation's four rows in input
order, and that the published cardinality is the input's.

**Falsification reproduced.** Copied unchanged into my scratch worktree at
`e821cd21a` (production pre-repair), the file is **1 failed / 4 passed** and the
failure is the estate's own message, `QueryEngineError: Raptor 3 createMany final
read returned inconsistent row counts.`
(`r2-falsification-f1-chunked-pin-at-e821cd21a.log`). The four earlier cells stay
green, so the new cell is the one that discriminates.

### D-28 F3 — one reader of the boundary

`Queries.decodeResult` now has **exactly one** call site in `src/`
(`operation-context.ts:919`, inside `publishedProjection`); the terminal
boundary and the three set-mutation publications all go through it, and the
"a row count is a fact of the transport, not a result window" sentence is stated
once, at the boundary. No behaviour change, and `g3-bulk-result-boundary` 5/5,
`g3-bulk-series` 6/6, `g3-transaction-array` 4/4 (gates verified) cover the three
publications.

### D-28 F4 — the corrected sentence

The note now names `SQLite3Driver.canonicalDriverParseResult` and bun-sqlite's,
and states that PGlite reads its own `result` and its adapter's identity.
Verified against the source: `src/drivers/sqlite3/index.ts:76-77` defines the
canonical parser and `:221` compares `driver.result.parseResult` against it.
Blocker 3 restated with the same correction.

### D-29 resolution 1 — the companion's own deterministic pin

The fixture split is behaviour-preserving: `PlantingBatchSQLiteDriver` holds the
competing commit and the batch record, `StaleBatchSQLiteDriver` keeps
`supportsOrderedCommittedSegments = true` and its own rollback-proving loop (the
three original cells are byte-identical and still green), and
`WeakBatchSQLiteDriver` leaves the flag at the driver default and delegates to
the base loop — the recipe the resolution gave, so the rejection carries the
`statementIndex` the proof reads. The cell pins both observables the review
named (no `recordSeriesProgress`, no cache invalidation for a rejection **at a
premise**; `mayHaveCommittedSegment === true` and exactly one invalidation for a
rejection **at a write**) plus the allowance actually being spendable
(`planted === 2`).

**Falsification reproduced.** With `!rejectedBeforeAnyWrite` dropped in my
scratch copy, the cell reddens at `progressOf(refusal)` and prints the meta the
first review measured at `5ac39cfd` (`mayHaveCommittedSegment: true`,
`memberPath: [0]`, `committedSegments: 0`), the other four cells staying green
(`r2-falsification-d29-companion-conjunct-dropped.log`).

### D-29 resolution 2 and D-32 resolution 3

Blockers item 4 states the companion as a compatibility choice, with its two
public observables and the two registered cells it moved, and points at the full
statement. The D-32 line references are restated against the final file and each
one checks out: the raceability gate at `operation-context.ts:1251-1267`, the
`captureMembership` hunk at `:2571-2585`, table rows 11 and 12 at `:2584` and
`:2585`, the prepared guard's `raceable: false` at `:1408`. Row 4's disclosure
gained the stronger reason (`commands/relation-body.ts:755-766`: the excluded
identities are the ones the caller spelled). The wrong hand-off sentence about
the `flush` falsification is corrected in place at `note.md:252`.

## Nothing else moved

- `git diff --numstat e821cd21a` is **exactly five files**: the guide, the two
  production files, and the two pin files (+448 / −88). D-29's and D-32's
  production owners (`shared/transport-attempt.ts`, the `captureMembership` and
  `submit` hunks) and the two re-expressed cell files
  (`tests/contracts/drivers/behaviors/nested-write-concurrency-behavior.ts`,
  `tests/raptor3/transitions/junction-races-live.ts`) are untouched this round.
- No test deleted, weakened or skipped: both pin files go 4 → 5 cells, the
  earlier cells are byte-identical (diffed), **0** assertion lines removed, and
  no `.skip`/`.only` anywhere in the diff.
- No new production class, no policy boolean, no second reader: the middleware
  seam has one caller, the row-count fact one owner, the terminal boundary one
  wrapper over it.
- Formatting: `npx biome check` is clean on both test files; `biome format` on
  the two production files produces **no hunk inside any range this round
  touched** (this repo's profile wants no trailing comma, which is what the new
  `assertExpectedRows` refusal line has). Their remaining diagnostics are
  pre-existing.
- The LOC tables in the repair-round section match `git diff --numstat` exactly,
  both for this round (448/88) and for the unit (1205/110).

## My runs (all serial, `TMPDIR=/private/tmp/viborm-rulings-tmp-ra`)

| target | result | receipt |
| --- | --- | --- |
| `g3-execution-review` | **6/6**, gate verified | `r2-g3-execution-review.log` |
| `g3-author-execution-regressions` | **3/3**, gate verified | `r2-g3-author-execution-regressions.log` |
| `driver-result-parser.test.ts` | **5/5** | `r2-driver-result-parser.log` |
| `integration-staleness.test.ts` | **5/5** | `r2-integration-staleness.log` |
| `integration-membership-race.test.ts` | **3/3** | `r2-integration-membership-race.log` |
| `g3-bulk-series` | **6/6**, gate verified | `r2-g3-bulk-series.log` |
| `g3-bulk-result-boundary` | **5/5**, gate verified | `r2-g3-bulk-result-boundary.log` |
| `g3-transaction-array` | **4/4**, gate verified | `r2-g3-transaction-array.log` |
| `g2-transport` | **16/16**, gate verified (no recorded plan moved) | `r2-g2-transport.log` |
| `g2-baseline` | **216/216**, gate verified | `r2-g2-baseline.log` |
| `g2-contracts` | **216/216**, gate verified | `r2-g2-contracts.log` |
| `cs01-extension-a` | **6/6**, gate verified | `r2-cs01-extension-a.log` |
| `g3p03-contracts` | **6/6**, gate verified | `r2-g3p03-contracts.log` |
| `--project=provider-sqlite3` | **755 passed / 1 skipped** | `r2-provider-sqlite3.log` |
| `node scripts/run-typecheck.mjs` | **exit 0, 0 diagnostics**, ~5.0 GiB peak (run twice) | `r2-typecheck.log` |
| falsification: the chunked cell at `e821cd21a` | **1 failed / 4 passed**, the estate's message | `r2-falsification-f1-chunked-pin-at-e821cd21a.log` |
| falsification: the companion conjunct dropped | **1 failed / 4 passed**, at the progress fact | `r2-falsification-d29-companion-conjunct-dropped.log` |
| probe: a short terminal window, repaired | **1 passed** (the registered refusal) | `r2-probe-shortwindow-repaired.log` |
| probe: the same at `e821cd21a` | **1 failed** (the internal-invariant message) | `r2-probe-shortwindow-at-e821cd21a.log` |

## Minor notes (non-blocking, the integrator may take or leave)

1. **`windows.flat()` on the single-window hot path.** Every published read now
   allocates one extra copy of its row array (`[response.rows]` → `flat()`),
   where the base passed the provider's array straight to the decoder. The
   author discloses it and did not measure it; against a decode that maps every
   row and field it is small, but if it should go,
   `windows.length === 1 ? windows[0]! : windows.flat()` is the whole change and
   it moves no fact. Not a rules violation, so I did not hold the round for it.
2. **The note has two LOC statements, one stale.** `note.md` §"LOC delta" is
   still round 1's table (808 / 73, `operation-context.ts` 143/34); the final
   figures live only in "Repair round › LOC delta" (1205 / 110). Labelling the
   first "round 1" would leave the unit one current number.
3. **The short-window refusal is measured but not registered.** My probe (recipe
   and both receipts above) is the first thing in the estate to exercise a
   terminal window that answers SHORT. If Arnaud wants that refusal pinned
   rather than argued, it is ~40 lines beside cell 5 of the D-28 pin.

## Still red / not re-run by me this round

- `tests/contracts/public-client/official-cache-swr.core.test.ts` — the
  `hostileJsonReadsAtCoreBoundary` cell, the unit's blocker 1 (author's receipt
  `repair-layer-client.log`: 535 passed / 1 failed). Unchanged by this round.
- `layer-query-engine`'s pre-existing `contract-matrix` inventory cell (author's
  receipt: 642 passed / 1 failed).
- Docker **pg** and **MySQL**: not re-run here. This round changed no D-29 or
  D-32 production line, and the D-28 owners are provider-neutral, so the first
  round's pg evidence stands unremeasured — the MySQL lane remains the place
  where the F1 shape (non-returning `createMany`/`updateMany` with `select`)
  reaches production, and it is unmeasured in both rounds.
- `provider-pglite`, `provider-libsql`, `provider-postgres`, hosted-driver,
  migration and package projects, and the `layer-*` projects: I took the
  author's receipts; my own runs were the parity pins, the regression modes, the
  fixed modes above and `provider-sqlite3`.
- No CPU protocol run by me either (see note 1).
