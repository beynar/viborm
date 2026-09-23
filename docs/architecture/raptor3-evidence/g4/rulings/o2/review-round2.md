# D-40 — independent review, round 2 (the repair round)

Reviewer: independent (not the author), same reviewer as `review.md`. Worktree
`/private/tmp/viborm-o2`, branch `o2`, base `383f830c0`.
`TMPDIR=/private/tmp/viborm-o2-tmp-r` exported for every run. Nothing committed,
staged, reset, stashed or pushed; no file of the author's was edited; nothing
outside this worktree was written except my session scratchpad (the three
falsification backups). Receipts:
`docs/architecture/raptor3-evidence/g4/rulings/o2/review-receipts/round2-*`.

## Verdict: **ACCEPT**

The round's five items are applied exactly and nothing else moved. I re-derived
the diff file by file against `383f830c`, re-ran every affected file, project
and mode on the FINAL bytes, and falsified the round's new pin three ways
myself, including one mutation neither the author nor round 1 ran — which
showed the new cell is the only cell in the estate that notices the engine
dropping what an adapter hands `next`. Both provider red sets are byte-identical
to the recorded ones, `provider-sqlite3` (newly in scope, because D-43 touches
the SQLite adapter) is fully green, `provider-postgres` is identical to my
round-1 run, the whole-estate typecheck is zero and the charged census is
unchanged.

Three observations below (§4). One is a one-digit correction the author should
make; one is a ledger entry only the integrator can make; one is a placement
question for Arnaud. None blocks.

## 1. The five items, checked one by one

| item | applied? | evidence |
| --- | --- | --- |
| **O-1** the loose "all 20 asks" | YES, at BOTH sites, in the review's own clause. `mysql-adapter.ts:1032-1036` (the comment over the member at `:1037`) now reads "…deciding nothing on all 20 asks D-40 measured over seven operations and both routes on live MySQL - the `count`/`exist` arm was entered on 10 of them and answered `undefined` every time"; `internals-and-geo.core.test.ts:482-485` "…decided nothing on all 20 live asks — its `count`/`exist` arm was entered on 10 of them and answered `undefined` every time". The PostgreSQL "40 asks, 40 `undefined`" is untouched, as the review said it should be. | `git diff 383f830c` |
| **O-2** the changelog clause | YES, and the STRONGER of the two offered, verbatim: "…and a count carried under any other column was refused before this deletion exactly as it is after it…". The choice is the right one: it is the fact my round-1 counterfactual measured on BOTH states of the code, and it holds for every MySQL transport rather than only the one probed. The rest of the entry is unchanged — `CHANGELOG.md` goes `+15 → +16`, exactly the one line the longer clause costs at 79 columns; the other two bullets are byte-identical to the accepted ones. | `git diff 383f830c -- CHANGELOG.md` |
| **Q5** the premise lines | YES. Neither provider cell asserts `parseResult` any more; the `passthrough` sentinel and the local `next` helper the two lines alone used are gone with them; the history moved into the describe's doc, which NAMES `internals-and-geo.core.test.ts` as the owner instead of re-asserting the fact. Cell titles and every other assertion are unchanged from the accepted version. | `parity-decoding.core.test.ts:224-364` |
| **D-42** the seam stays | YES, and it is genuinely untouched: `AdapterResultParser["parseResult"]` keeps its signature and its requiredness, `DatabaseAdapter["result"]["parseResult"]` is not in the diff, and the only edit to `adapter-result-parser.ts`'s member is its doc (the `@example` now shows the shape all three install instead of teaching a function that no longer exists). | `git diff 383f830c -- src/adapters/adapter-result-parser.ts` |
| **D-43** one owner | YES, and completely: `passThroughParseResult` is declared once and referenced by exactly the three shipped adapters; `grep` over `src` finds no fourth copy and no other `parseResult` member anywhere; the constant is NOT on the public surface (`src/adapters/index.ts` exports the three classes and the `DatabaseAdapter` type; `database-adapter.ts` re-exports only the TYPE `AdapterResultParser`; no `exports` path reaches the module). The module is still `import type`-only at the top, so as a value module it adds no runtime import edge beyond itself — the note's cost statement is accurate. | §2 below |

**The two identity readers are not weakened.** `drivers/sqlite3/index.ts:231`
and `drivers/pglite/index.ts:233` compare `driver.adapter.result.parseResult`
against a value each captures from ITS OWN adapter instance at construction
(`:104`, `:101`), not against another adapter's member, so one shared object
changes nothing they can detect except a replacement by the identical constant —
which is what was there. No other `parseResult` identity comparison exists in
`src`. `consumable-result-proof.core.test.ts` (the file that owns those
surfaces) is 6/6 and `provider-sqlite3` is 755 passed / 1 skipped / 0 failed.

## 2. Nothing else moved

- Ten files, and the tenth is D-43's: `sqlite-adapter.ts` joins the nine of
  round 1 (`git status`), plus this ruling directory, untracked. No new test
  file — `contract-matrix.core.test.ts`'s registration gate has nothing new to
  say.
- No `.skip`, `.only` or `todo(` anywhere in the diff's added lines. Cell
  counts: `result-parsing` 26 → 14 (round 1's O-3, unchanged this round),
  `internals-and-geo` 20 → 20, `parity-decoding` 10 → 13 (12 + the round's one
  new cell). No assertion was loosened: every re-expressed adapter expectation
  is `toBe(passthrough)`, identity against the sentinel, the strictest form
  available there.
- The two deleted helpers and the private `extractCountValue` survive only in
  COMMENTS (history), in five places; no code reader of any of them exists in
  `src`, `tests` or `scripts`. `COUNT_RESULT_KEY`'s three `src` readers
  (`cache-result-codec.ts:90`, `result-shape.ts:418,432`,
  `typescript-type-renderer.ts:342`) are intact.
- Per-file diff arithmetic reconciles with the claimed items and leaves no
  unexplained hunk. `mysql-adapter.ts` goes `12/17 → 15/20`: the import becomes
  a braced import (−1/+4), the `result-parsing` import loses one name (−4/+1),
  the section header is the accepted one (−1/+4), and the member's remaining
  signature lines go with the constant (−3 net) under a comment one line longer
  — the O-1 clause. `postgres-adapter.ts` `13/11 → 13/14` decomposes the same
  way. `query.ts` and `result-parsing.core.test.ts` are byte-unchanged since
  round 1 (`8/8` and `17/74`).
- `internals-and-geo.core.test.ts` gains 2 physical lines, both comment: the
  O-1 clause and (or) the SQLite cell's two-line note. No pre-repair copy of a
  test file exists anywhere in the estate, so I cannot bit-attribute those two
  lines between the two; I verified instead that the file's FINAL state carries
  no changed assertion versus base beyond the ones round 1 accepted, which is
  the fact that matters.

## 3. Falsification on the final bytes (mine, not the author's)

Each mutation was made in the worktree over a copy taken first into my session
scratchpad, run once, then restored with `cp` and verified with `cmp`; never
`git checkout`. The file was re-run green (13/13) afterwards
(`round2-parity-decoding-restored.log`).

| # | mutation | expected | measured | receipt |
| --- | --- | --- | --- | --- |
| FR-1 | `postgres-adapter.ts`: `parseResult: passThroughParseResult` replaced by a byte-identical inline member (the author falsified MySQL; this is the other adapter) | the identity half reddens, behavior stays green | **1 failed / 12 passed**, `AssertionError: expected [Function parseResult] to be [Function passThroughParseResult] // Object.is equality` | `round2-falsified-pg-second-copy.log` |
| FR-2 | `query.ts`: `decodeResult` still ASKS the adapter but ignores what it hands `next` (decodes `input` unconditionally) — a weaker, nastier mutation than the author's F3a, which removed the ask entirely | the custom-adapter half reddens | **1 failed / 12 passed**, and the one that reddens is the round's new cell. Nothing else in the estate notices an engine that asks the adapter and then throws its answer away | `round2-falsified-next-ignored.log` |
| FR-3 | `query.ts`: the decoder's own alias renamed where it is READ BACK (`rows[0]?._count` → `_kount`) — the brief's required falsifier, re-run because both D-40 cells changed after round 1 took it | the D-40 cells and D-35's redden | **4 failed / 9 passed**: D-35's cell, both D-40 provider cells, and the new cell (its custom-adapter half decodes a count too) | `round2-falsified-alias-rename.log` |

The author's own repair receipts were audited and are genuine: F3a and F3b each
show `1 failed / 12 passed` with the messages the note quotes, and
`repair-parity-decoding-restored.log` / `-final.log` show 13/13.

## 4. Observations (none blocking; each with its exact minimal resolution)

- **R2-1 — one LOC figure is off by one.** §11.9 records `165   5` for
  `parity-decoding.core.test.ts`; `git diff --numstat 383f830c -- tests`
  measures `166   5`, so tests are **+212 −88, net +124**, not "+211 −88, net
  +123". The file was last written at 00:44:32 and the note at 00:47:47, so
  this is a transcription slip and not a later edit. Everything else in that
  table reproduces line for line on my own recount, including both production
  figures (src **+89 −139 net −50** physical, **+18 −75 net −57** code-bearing
  — my independent comment/blank classifier agrees to the line).
  *Resolution:* `165` → `166`, and "Tests +211 −88, net +123 (was +87)" →
  "Tests +212 −88, net +124 (was +87)".
- **R2-2 — D-42 and D-43 are recorded nowhere but this note.** The ledger
  `docs/architecture/raptor3-evidence/g4.md` carries Arnaud's rulings D-38…D-41
  (record of 23:40, 2026-09-17) and has no D-42/D-43 entry, and `grep` finds the
  two identifiers nowhere else in the evidence tree. D-43 also edits
  `src/adapters/databases/sqlite/sqlite-adapter.ts`, a file this brief does not
  name — permitted by a ruling, not by the brief ("own only your files"). I
  cannot verify a ruling's provenance from inside the worktree and I do not
  treat a unit note as its own authorization; I judge the WORK, which is sound,
  measured and regression-free. *Resolution (integrator's, not the author's):*
  record D-42 and D-43 in `g4.md` beside D-38…D-41 before the squash. If the
  rulings were not in fact given, the D-43 hunk is cleanly separable — the
  constant and its doc block, the three `parseResult: passThroughParseResult`
  references with their two import edges, and the first half of the new cell —
  and removing it restores exactly the state round 1 accepted.
- **R2-3 — one adapter-seam fact now lives in the decoder's file.** Q5 removed
  the premise lines because `internals-and-geo.core.test.ts` owns what an
  adapter's leg DOES; the new cell's first half asserts that the three shipped
  members are ONE OBJECT, which no other file asserts, so it is not a second
  owner — but it is an adapter fact stated in the parity file. It is there
  because the ruling asked for one pin carrying both halves and the D-42 half
  can only be stated where the decoder runs, and FR-1/FR-2 show the two halves
  are separately falsifiable. *Resolution, if Arnaud prefers the stricter
  split:* move the three `toBe(passThroughParseResult)` lines into
  `internals-and-geo.core.test.ts`'s three adapter cells and leave the
  custom-adapter half alone under a title naming only D-42.

**Confirmed, and out of this round's scope:** the note's recorded observation
about `src/drivers/shared/sqlite-utils.ts:44-48` is accurate — its D-35 doc
still ends "Recovering a count from a provider that did NOT preserve the alias
is a dialect fact, stated once at the adapter seam by the provider that needs it
(MySQL)", and after D-40 no file states that fact; my round-1 counterfactual
measured that such a row is refused, before the deletion as after it. The author
was right not to edit a file neither brief names. *Exact change for whoever owns
it next (D-39 owns that family):* replace that sentence with "No file states it
any more: a count carried under any other column is refused by the decoder,
before D-40's deletion of the MySQL adapter leg exactly as after it."

## 5. My runs (serial, one file / project / mode per call, `TMPDIR` exported)

| run | result | receipt |
| --- | --- | --- |
| `node scripts/run-typecheck.mjs` | **exit 0, zero diagnostics**, 8.15 s, 5212.9 MiB peak | `round2-typecheck.log` |
| `engine/query/parity-decoding.core.test.ts` (`layer-query-engine`) | **13/13** | `round2-parity-decoding.log` |
| `adapters/internals-and-geo.core.test.ts` (`layer-adapters`) | 20/20 | `round2-internals-and-geo.log` |
| `adapters/result-parsing.core.test.ts` (`layer-adapters`) | 14/14 | `round2-result-parsing.log` |
| `drivers/consumable-result-proof.core.test.ts` (`layer-drivers`) | 6/6 | `round2-consumable-result-proof.log` |
| `raptor3/g4/parity/driver-result-parser.test.ts` (`extended-local`) | 5/5 | `round2-driver-result-parser-pin.log` |
| `provider-sqlite3` (whole project — new in scope with D-43) | 755 passed, 1 skipped, **0 failed** | `round2-provider-sqlite3.log` |
| `provider-pg` (whole project) | 25 failed / 426 passed / 7 skipped — red set **byte-identical** to `verification/rulings-pg-red.txt` and to the author's repair set: **0 regressions, 0 newly green** | `round2-provider-pg.log`, `round2-pg-red.txt` |
| `provider-mysql2` (whole project) | 165 failed / 575 passed / 1 skipped — red set **byte-identical** to `verification/rulings-mysql-red.txt` and to the author's repair set: **0 regressions, 0 newly green** | `round2-provider-mysql2.log`, `round2-mysql-red.txt` |
| `provider-postgres` (whole project, still no recorded baseline) | 18 failed / 310 passed / 7 skipped — red set identical to my round-1 set, all in the pre-existing GeoPoint / enum families | `round2-provider-postgres.log`, `round2-postgresjs-red.txt` |
| `run-raptor3.mjs g2-pg-contracts` | 18/18, 6 files, gate verified | `round2-mode-g2-pg-contracts.log` |
| `run-raptor3.mjs g2-mysql-contracts` | 13/13, 4 files, gate verified | `round2-mode-g2-mysql-contracts.log` |
| FR-1 / FR-2 / FR-3 falsifications, each restored and `cmp`-verified | as §3 | three `round2-falsified-*.log` |
| `npx biome check` on the 8 touched source/test files | clean, 0 diagnostics, no `--write` | — |
| `npx biome check` on `query.ts` | the same 16 diagnostics as the author's recorded base AND head lists, line for line | — |
| `node scripts/query-engine-structure.mjs` | `files 38, lines 18685, tokenLines 15472` — identical to the author's repair census and to the pre-repair one | `round2-structure.json` |
| LOC recount (`git diff --numstat 383f830c`) | src +89 −139 net −50 physical, +18 −75 net −57 code-bearing; tests +212 −88 net +124 (see R2-1); `CHANGELOG.md` +16 | — |

Every command ran alone; I met no lock refusal and removed no lock. The
extraction for both red sets is the recorded one
(`grep -E '^[[:space:]]+× ' <log> | sed -E 's/^[[:space:]]*× //; s/ [0-9]+ms$//' | sort -u`).

## 6. Still red / unverified after this round

- Nothing this ruling caused, on any of the four provider projects I ran.
- Unchanged from round 1: PlanetScale, PGlite, neon-http and bun-sql carry one
  of the two adapters and have no live transport here; for them the claim rests
  on the mechanism (the leg's one call site hands it a row array) plus, for
  MySQL, the measured refusal the changelog now states. `provider-postgres`
  still has no recorded baseline, so its 18 reds are corroboration, not a byte
  comparison.
- `layer-query-engine` was not run whole in either round, so D-35's one
  pre-existing unrelated red (`contract-matrix.core.test.ts` naming
  `tests/raptor3/candidate-handoff.test.ts`) is neither confirmed nor cleared;
  this diff adds no unregistered test file and cannot have moved it.
- The two comment lines of `internals-and-geo.core.test.ts` (§2) are not
  bit-attributable to a round; no assertion is affected either way.
