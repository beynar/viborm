# D-39 + D-41 — the canonical-surface check, and the short-window pin

Author: Fable. Worktree `/private/tmp/viborm-o1`, branch `o1` from `383f830c`.
`TMPDIR=/private/tmp/viborm-o1-tmp` exported for every run. Nothing committed,
staged, reset, stashed or pushed; nothing written outside this worktree except
the backup copies taken in this session's scratchpad —
`.../scratchpad/o1-falsify/{sqlite3-index,pglite-index,operation-context}.ts.bak`
for round 1 and `.../scratchpad/o1-repair-falsify/` for the repair round (§10) —
so each falsification could be undone by `cp` rather than by
`git checkout --` a dirty file. Every mutated file was restored from those
copies, verified byte-identical, and re-run green.
`/Users/arnaud/code/viborm` and `/private/tmp/viborm-o2` were never touched.

**Process disclosure.** The common brief's decision-elimination gate says to
write this note *before* the first production edit. I did not: I did D-41
(test-only) first, then made both D-39 production edits, then wrote this file.
The gate's four items are answered below (§2.1, §3.1) and §5 answers the §7
questions against the actual diff, but they were written after the edits, not
before them. Recorded rather than papered over.

---

## 1. What the two rulings are

| | D-39 | D-41 |
| --- | --- | --- |
| ledger | `g4.md`, "Rulings by Arnaud (23:40, 2026-09-17)", O-1 | same record |
| kind | production (two owners) + pins | test only |
| touches | `src/drivers/sqlite3/index.ts`, `src/drivers/pglite/index.ts`, `tests/contracts/drivers/consumable-result-proof.core.test.ts` | `tests/raptor3/g4/parity/driver-result-parser.test.ts` |

No guide paragraph names either check. Root `AGENTS.md` rule 5 (lines 174-178)
already states the rule in prose — "unchanged typed execution/parser surfaces",
"a parser middleware … stays borrowed" — and D-39 is the code catching up with
it, so the guide needed no edit (checked by grep for `canonical`, `consumable`
and `parser surface` across `AGENTS.md`, `src/query-engine/AGENTS.md`,
`src/query-engine/raptor3/AGENTS.md`). `CHANGELOG.md` is untouched: neither
ruling changes a published answer (§6, unverified claim 1).

---

## 2. D-41 — the short-window pin

### 2.1 Truth, owner, change, decisions

**Required behavior.** A chunked non-RETURNING terminal read whose SECOND window
answers one row short must raise createMany's REGISTERED refusal — the sentence
a caller can act on — and not the engine's internal "inconsistent row counts"
invariant.

**Owner — unchanged, and already correct.** `Queries.selectSeries`
(`src/query-engine/raptor3/shared/query.ts:3158-3199`) stamps every window it
cuts with its own `expectedRows.count` and its own `expectedRows.missing`;
`Queries.assertExpectedRows` (`:4209-4215`) is the one reader of that stamp; and
`OperationContext.publishedTerminal` (`shared/operation-context.ts:937-950`)
asks it once per window, before `publishedProjection`. Nothing in `src/` changed
for D-41 — the rulings unit's repair already put the fact here. What was missing
was a pin: the re-checker's probe measured it
(`../review-round2.md` §D-28 F1, receipts `r2-probe-shortwindow-repaired.log`,
`r2-probe-shortwindow-at-e821cd21a.log`) and then went away with its scratch
worktree, so the estate argued the refusal rather than pinning it (that review's
minor note 3).

**Smallest change.** One cell beside cell 5 of the D-28 pin, on the same
`RecordingSQLiteDriver` world, with one new transport class that drops a row
from the second terminal window's answer.

**The decisions that disappear.** None — this ruling removes no mechanism. It
converts one argued claim into a measured one, and the falsifier below is what
makes it worth its lines.

### 2.2 The hunks

| # | file:line | hunk | what |
| --- | --- | --- | --- |
| 1 | `tests/raptor3/g4/parity/driver-result-parser.test.ts:25-32` | header | item 5 re-punctuated, item 6 added (what a SHORT window raises) |
| 2 | `:42` | import | `QueryEngineError` from `@errors` |
| 3 | `:126-152` | new `ObservingShortWindowDriver` | extends the existing chunked transport; after `super.execute` has counted the window, the SECOND terminal read's rows are answered one short. The drop is at the PROVIDER, so nothing above the transport has been told |
| 4 | `:201-210` | `createChunkedWorld` | its parameter changes from `batch: boolean` to the transport CLASS (`ChunkedTransport`). The helper stops deciding which driver and each cell names its own — which is what let the new cell reuse it instead of gaining a second boolean, and a second boolean on a world builder is exactly the policy-boolean bag the rules forbid |
| 5 | `:352-355` | cell 5's loop | `for (const batch of [false, true])` → `for (const transport of [ObservingChunkedDriver, ObservingChunkedBatchDriver])`. Both arms preserved in order; no assertion in that cell changed |
| 6 | `:241-245` | `SHORT_WINDOW_REFUSAL` | the registered sentence as a top-level regex (Biome `useTopLevelRegex`), read from its owner in `shared/query.ts:3184` and not invented; the comment names that owner |
| 7 | `:388-419` | NEW cell 6 | below |

Cell 6 asserts four things and nothing more: the registered CLASS
(`QueryEngineError`; `TransactionError` is the sibling `updateMany` registers at
the same place, and it is a sibling of `QueryEngineError` under `VibORMError`,
so `instanceof QueryEngineError` already excludes it and a second
`instanceof TransactionError === false` would have been a guard with no unique
coverage); the registered SENTENCE; that both windows really reached the
provider (`terminalReads.length === 2`); and that the middleware was not asked.

### 2.3 One measured correction to the brief

The brief's "Required" sentence ends "the driver middleware still asked once".
**Measured, it is asked ZERO times.** `publishedTerminal` runs the per-window
`assertExpectedRows` loop *before* `publishedProjection`, so the refusal is
raised above the result boundary and `Queries.decodeResult` — the one caller of
any driver `parseResult` — is never reached for that operation. The cell pins
what is true (`assert.deepEqual(chunked.driver.observed, [])`) and it is
load-bearing: the F1 falsification below reddens on it as well as on the
sentence. This is also exactly what `publishedTerminal`'s own doc claims ("before
the middleware is asked anything"), so the code and its comment agree and it is
the brief's sentence that is loose. **Question for Arnaud in §7, Q1.**

### 2.4 Falsification record

| # | mutation | expected | measured | receipt |
| --- | --- | --- | --- | --- |
| F1 | `publishedTerminal` restored to the pre-repair shape of `e821cd21a` — `decodeResult(windows.flat(), operation, raw => decodeQuery(terminal, raw))`, i.e. the count taken over the CONCATENATION, inside `decodeQuery`, below the middleware (reconstructed by reading `git show e821cd21a:…/operation-context.ts:916-922`, not from memory) | cell 6 reddens with the internal message | RED, `2 failed / 4 passed`. Cell 6 — the DELIVERED cell, "raises a short window's own registered refusal, before the boundary" — fails at `driver-result-parser.test.ts:412`, on the delivered `assert.match(failure.message, SHORT_WINDOW_REFUSAL)`: `The input did not match /createMany with 'select' could not read back one of the created rows/. Input: 'Raptor 3 createMany final read returned inconsistent row counts.'` — the same message the re-checker's probe measured at `e821cd21a`. Cell 5 reddens too, with `QueryEngineError: Raptor 3 createMany final read returned inconsistent row counts.`, which is the repair round's F1 regression reappearing | `receipts/repair-d41-falsification-concatenated-count.log` |

Restored from `scratchpad/o1-repair-falsify/operation-context.ts.bak`;
the restored file's sha256 is the delivered one, `git diff -- src` showed only
the two D-39 driver hunks afterwards, and the file re-ran 6/6
(`receipts/repair-d41-pin.log`).

**Which run this row cites (review F-1, repair round).** The receipt above is F1
run against the file as DELIVERED. The round-1 receipt
`receipts/d41-falsification-concatenated-count.log` is the same mutation and the
same two failures taken before the cell's title was settled ("above the
boundary", assertion then spelled inline at `:405`); it is a genuine run, so it
is kept unaltered beside the new one rather than overwritten, and it is no
longer what this row cites.

### 2.5 Alternatives rejected

1. **Add a `short: boolean` to `createChunkedWorld`.** Rejected: a second policy
   boolean on a helper that already had one, deciding a transport. Passing the
   class removes the first boolean as well.
2. **Hard-code the refusal sentence as a string.** Rejected: a second copy of a
   fact `Queries.selectSeries` owns. The regex names the owner in its doc and
   matches the clause, the way the estate's existing pin of the same refusal does
   (`tests/raptor3/core-structure/extension-a.contract.test.ts:342-344`).
3. **Assert the middleware IS asked once**, per the brief's wording. Rejected on
   measurement: it is not, and a pin must say what happens (§2.3).
4. **Pin the short window on the batch/prepared arm too.** Rejected as
   duplication: both arms reach the same `publishedTerminal` with the same
   windows (cell 5 already drives both), so a second arm would re-measure one
   boundary. Recorded as a deliberate gap, not an oversight.

---

## 3. D-39 — a driver's result surface is stock only when it IS the shipped parser

### 3.1 Truth, owners, change, decisions

**Required behavior.** A driver instance may claim a consumable result only
while the result surface a caller can reach is the one its class ships. Any
object a caller installed at `result` is a middleware that will be handed the
provider's own row objects, and keeps the transport borrowed — whichever hook it
spells.

**Owners — two, one per family, measured at the base.**

- `SQLite3Driver.hasCanonicalProducerSurface` (`src/drivers/sqlite3/index.ts`)
  compared `driver.result.parseResult` to a static capture of
  `sqliteResultParser.parseResult`. Since D-35 deleted that arm both sides are
  `undefined`, so the leg admitted **any** object without a `parseResult` —
  including a `{ parseField }` middleware (review O-1).
- `PGliteDriver.hasCanonicalProducerSurface` (`src/drivers/pglite/index.ts`)
  spelled the same weaker question directly: `driver.result?.parseResult === undefined`.

**Smallest change.** One comparison per owner, over the whole `result` surface:
`driver.result === sqliteResultParser` and `driver.result === undefined`. The
per-arm static `SQLite3Driver.canonicalDriverParseResult` goes with it (it
existed only to capture that one hook), and each owner states the rule once in
the doc comment on its own `hasCanonicalProducerSurface`. The adapter leg is
untouched, as the ruling says.

**The decisions that disappear.**

| | |
| --- | --- |
| mechanism | "which hook of a parser makes it a middleware" — a per-arm question that had to be re-answered every time the shipped parser's shape changed, and silently weakened itself when D-35 changed it |
| consumers | `isConsumableCandidate` on each family, the only caller of each `hasCanonicalProducerSurface`; through it `registerConsumableResultCandidate`/`activateConsumableResultProducer` (`src/drivers/consumable-result-candidate.ts`) |
| replacing invariant | the object identity: a stock instance's `result` IS what its class ships there, and that is a fact each class already states in one place (SQLite's field initializer `readonly result = sqliteResultParser`; PGlite's absence of a declaration) |
| falsifier | F2 below, plus `layer-drivers`, `provider-sqlite3`, `g2-baseline`, `g3-execution-review`, whole-estate typecheck |

### 3.2 Can the two families share the statement? — no, and why

The ruling asks this explicitly. **They do not share it, and should not.** What
the two families have in common at this leg is the `===` and the sentence; what
each comparison needs — *what this class ships at `result`* — is per class and
irreducibly so: for `sqlite3` it is an imported object (`sqliteResultParser`),
for `pglite` it is the absence of a declaration. A shared helper would have to be
handed that value by each class and would then consist of `driver.result === canonical`
— a function owning no fact, which is the wrapper-only abstraction the ruling
names. The surrounding member lists differ too (SQLite also pins
`runStatement`), so nothing larger is shareable either. Each owner therefore
states the rule once, in its own doc comment, and each names the other so the
pair is discoverable from either end (`sqlite3/index.ts:226-227`,
`pglite/index.ts:240-241`). The mechanism they feed already states the rule in
prose for both, at root `AGENTS.md` rule 5.

### 3.3 The hunks

| # | file:line | hunk | what |
| --- | --- | --- | --- |
| 1 | `src/drivers/sqlite3/index.ts:77-86` (deleted) | `canonicalDriverParseResult` | the static per-arm capture, and its doc, deleted whole. Its reason moves to the check that used it |
| 2 | `src/drivers/sqlite3/index.ts:212-232` | new doc on `hasCanonicalProducerSurface` | the rule stated once for this family: the OBJECT, why (a consumable result hands out the provider's rows), the rule-5 quote, what the old question admitted, and that the adapter leg is a different question |
| 3 | `src/drivers/sqlite3/index.ts:239` | the leg | `driver.result.parseResult === SQLite3Driver.canonicalDriverParseResult` → `driver.result === sqliteResultParser` |
| 4 | `src/drivers/pglite/index.ts:227-246` | new doc | the same rule for this family, over the surface PGlite ships — which is none, so the stock surface is the ABSENCE of a parser |
| 5 | `src/drivers/pglite/index.ts:252` | the leg | `driver.result?.parseResult === undefined` → `driver.result === undefined` |
| 6 | `tests/contracts/drivers/consumable-result-proof.core.test.ts:75-162` | `installResult`, `ConsumableFamily`, `SQLITE3_FAMILY`, `PGLITE_FAMILY`, `consumableAnswers`, `STOCK_ONLY` | the witnesses per family, and the four answers taken for one family. `consumableAnswers` returns FACTS rather than asserting them: Biome's `noMisplacedAssertion` (and the project's own "assertions inside `it()`/`test()`") forbids an `expect` in a helper, so the four probes live in one function and each cell asserts its family's answer object |
| 7 | `:273-279` | the two cells | one pin per family, each `expect(consumableAnswers(FAMILY)).toEqual(STOCK_ONLY)` |

**Re-expression, disclosed.** Hunk 7 replaces D-35's cell "a shipped SQLite3
driver carrying a result middleware is borrowed" (the file's old `:179-198`).
Nothing it asserted was dropped: its two facts — a stock `SQLite3Driver` is a
candidate, one carrying a `{...sqliteResultParser, parseResult}` middleware is
not — are `stock` and `withResultMiddleware` in `STOCK_ONLY`, with the same
witness object, and two facts are added beside them. It was re-expressed rather
than left beside a new cell because a new cell would have re-asserted "a stock
driver is a candidate" a second time, in a second place, for one fact.

### 3.4 Falsification record

| # | mutation | expected | measured | receipt |
| --- | --- | --- | --- | --- |
| F2 | both legs weakened back to the per-arm comparison — `driver.result.parseResult === sqliteResultParser.parseResult` and `driver.result?.parseResult === undefined`, the base's two questions | the FIELD-ONLY case reddens in both families; nothing else moves | RED, `2 failed / 5 passed`, one per family, at the DELIVERED cells: `consumable-result-proof.core.test.ts:274` (`expect(consumableAnswers(SQLITE3_FAMILY)).toEqual(STOCK_ONLY)`) and `:278` (its PGlite sibling). In both diffs exactly ONE key moves — `withFieldMiddleware: false` → `true` — while `stock: true`, `withResultMiddleware: false` and `withReenteredAdapter: false` stay put: the strengthening is exactly the field-only case, on both families, and nothing else | `receipts/repair-d39-falsification-per-hook-leg.log` |

Restored from `scratchpad/o1-repair-falsify/{sqlite3,pglite}-index.ts.bak`,
verified by sha256 against the delivered files and by re-reading both legs, and
re-run green — 14/14 across both projects
(`receipts/repair-d39-consumable-result-proof.log`).

**Which run this row cites (review F-1, repair round).** The receipt above is F2
run against the cells as DELIVERED. The round-1 receipt
`receipts/d39-falsification-per-hook-leg.log` is the same mutation against the
earlier per-witness cell layout (its failures are at `:250`, the
`expect(resolveConsumableResultCandidate(…)).toBeUndefined()` probe that §3.5
alternative 4 replaced); it is a genuine run, so it is kept unaltered beside the
new one rather than overwritten, and it is no longer what this row cites.

### 3.5 Alternatives rejected

1. **A shared `isStockResultSurface(driver, canonical)` helper.** Rejected: §3.2.
2. **A `private static canonicalResult = undefined` on `PGliteDriver`**, so the
   comparison reads a named value instead of a literal. Rejected: it makes "this
   class ships no parser" a fact stated in two places that must be changed
   together — patchwork, and the D-35 note rejected the mirror of it (its
   alternative 2) for the same reason. The literal is right next to the reason,
   in the only file that could ever change it. **Q3 in §7.**
3. **Keeping D-35's cell and adding a new one per family.** Rejected: §3.3.
4. **`test.each` over the two families.** Rejected on formatting: Biome's
   printer breaks the curried `test.each(X)(title, fn)` into
   `test.each(\n X \n)(...)` with the parameter list exploded, and the rule is to
   fix Biome by hand rather than `--write` a whole file. Two named cells over one
   fact-producing function say the same thing and read better; a failure also
   names the family in the test title rather than in a table label.
5. **Also comparing `driver.adapter.result` by object identity.** Rejected: out
   of the ruling's scope ("the adapter leg kept as it is"), and it is a different
   question — the adapter is the driver's own object, so what is asked there is
   re-entry, not substitution.

---

## 4. Where the guide and the changelog were NOT touched

- `src/query-engine/raptor3/AGENTS.md` — its D-17/D-28 paragraph describes the
  chain and the once-per-operation rule; neither ruling changes either.
- Root `AGENTS.md` rule 5 — already states D-39's rule in prose (§1). D-39 makes
  the code match the guide, so amending the guide would have been backwards.
- `CHANGELOG.md` — D-39 changes no published answer for any shipped driver: a
  stock instance is stock under both spellings, and the only instances whose
  classification moves are ones a caller mutated after construction, in a
  mechanism with no caller in `src/` (§6). D-41 is test-only. **Q4 in §7** asks
  whether Arnaud wants an entry anyway.

---

## 5. The four §7 questions, against the diff

1. **Necessary decision or representation repair?** Repair, both. D-39 removes a
   second representation of "which surface is stock" (a hook's identity standing
   in for an object's) that had silently stopped discriminating. D-41 adds no
   representation at all — it pins one the repair round already installed.
2. **Exact deletion and replacement obligation?** Removed decision: the per-arm
   "is THIS hook still the shipped one" question, on both families. Mechanism:
   `SQLite3Driver.canonicalDriverParseResult` and the two per-hook comparisons.
   Consumers: `isConsumableCandidate` on each family. Replacing invariant: the
   `result` object's identity against what the class ships. Falsifier: F2. No
   equivalent mechanism moved elsewhere — the deleted static has no successor,
   and the comparison reads the owning module directly.
3. **One rule across uses?** One rule, stated at each of the two owners and
   asked identically of both by one test function (§3.2, §3.3). Both families'
   witnesses are the same four; both answers are the same `STOCK_ONLY` object.
4. **What actually grew?** Production **code-bearing** lines: **+2 −4, net −2**
   (`git diff 383f830c -- src` with comments and blanks filtered: two legs
   rewritten, the two-line static deleted). Physical production lines are +43 −14
   because both hunks replace a comparison with the REASON for it. The charged
   query-engine census is unchanged **by construction**: its root is
   `src/query-engine` (`scripts/query-engine-structure.mjs:5-8`) and neither
   touched production file is under it — the drivers are an excluded shared
   boundary. Tests +188 −27, counted separately. No new semantic rule anywhere.

---

## 6. Verification

`TMPDIR=/private/tmp/viborm-o1-tmp` exported for every run; one file, one
project or one registered mode per call; never two at once; no lock refusal was
met, so no retry was needed and no lock was removed. Receipts in `receipts/`.

| run | result | wall / peak RSS | receipt |
| --- | --- | --- | --- |
| `drivers/consumable-result-proof.core.test.ts` (both projects) | **14/14** (7 ×2; was 6 ×2 — one cell became two) | 4.58 s / 518.3 MiB | `d39-consumable-result-proof.log` |
| `g4/parity/driver-result-parser.test.ts` (`extended-local`) | **6/6** (was 5, +1) | 3.19 s / 473.9 MiB | `d41-pin.log` |
| `layer-drivers` (whole project) | **975/975**, 43 files (D-35 left it at 974) | 4.92 s / 671.3 MiB | `layer-drivers.log` |
| `provider-sqlite3` (whole project, live better-sqlite3) | **755 passed, 1 skipped**, 6 files — identical to D-35's baseline | 6.09 s / 704.4 MiB | `provider-sqlite3.log` |
| `run-raptor3.mjs g2-baseline` | **216/216**, gate verified | 4.58 s / 688.7 MiB | `mode-g2-baseline.log` |
| `run-raptor3.mjs g3-execution-review` | **6/6**, gate verified | 3.18 s / 495.2 MiB | `mode-g3-execution-review.log` |
| `node scripts/run-typecheck.mjs` (whole estate) | **0 diagnostics, exit 0** (exit code confirmed by a second run) | 7.14 s / 4772.9 MiB | `typecheck.log` |
| falsification F2 (D-39), against the DELIVERED cells | **2 failed / 5 passed**, at `:274` and `:278`, only `withFieldMiddleware` moving | 4.09 s / 417.3 MiB | `repair-d39-falsification-per-hook-leg.log` |
| falsification F1 (D-41), against the DELIVERED cell | **2 failed / 4 passed**, at `:412` | 3.83 s / 453.6 MiB | `repair-d41-falsification-concatenated-count.log` |
| the same F2, round 1, against the pre-final cell layout (superseded, kept) | 2 failed / 5 passed, both at `:250` | 2.89 s / 456.7 MiB | `d39-falsification-per-hook-leg.log` |
| the same F1, round 1, against the pre-final cell title (superseded, kept) | 2 failed / 4 passed | 3.42 s / 488.3 MiB | `d41-falsification-concatenated-count.log` |
| `contracts/architecture/contract-matrix.core.test.ts` | 4/5 — the pre-existing red (§7) | 2.28 s / 301.4 MiB | `contract-matrix.log` |
| `provider-pglite` `pglite-scalars.test.ts` | **NOT RUN — ceiling breach**, 1646.8 MiB | 4.37 s | `provider-pglite-scalars.log` |
| `provider-pglite` `pglite-vector.test.ts` (the smallest such file) | **NOT RUN — ceiling breach**, 1676.9 MiB | 4.11 s | `provider-pglite-vector.log` |
| the same file with BOTH driver sources reverted to `383f830c` | **NOT RUN — ceiling breach**, 1680.9 MiB | 4.12 s | `provider-pglite-vector-at-base.log` |

`npx biome check` on the four touched files: **clean, 0 diagnostics**. Two of my
own were fixed by hand rather than by `--write`: `useTopLevelRegex` (the refusal
regex hoisted, D-41 hunk 6) and a formatter break on `test.each` (resolved by not
using `test.each`, §3.5 alternative 4). One Biome preference was read by copying
the file to the scratchpad and formatting the COPY, so the repo file was never
`--write`-n.

### The live PGlite lane — an environment blocker, measured

The brief says to run the PGlite files that exercise the surface check with
`--rss-limit-mb=2560 --heap-limit-mb=1024`. **That is not executable with the
runner the brief names.** `scripts/run-vitest-safe.mjs` rejects any
`--rss-limit-mb` above 1536 ("`--rss-limit-mb` must be a positive integer no
greater than 1536"), and `resolveProcessGroupRssCeiling`
(`scripts/bounded-process.mjs:72-97`) lets an explicit limit only ever LOWER the
selected ceiling. The 2560 `ISOLATED_PGLITE_PROVIDER_RSS_CEILING` is selectable
only from `scripts/run-credential-free-tests.mjs`, whose stages are the
exhaustive gate that unit work may not run.

So every live PGlite file breaches at the ordinary ceiling, and I measured that
this is the environment and not my change: the smallest such file breaches at
**1676.9 MiB** with the strengthened legs and at **1680.9 MiB** with both driver
sources reverted to `383f830c` — a 4 MiB difference, below sampling noise, both
above the ceiling. Nothing I could run would have told me more.

What IS measured for PGlite instead: the stock `PGliteDriver` and its three
mutated witnesses, live (`consumable-result-proof.core.test.ts`, both projects,
green, and both reddening under F2); `pglite-controlled-transport-coverage.core.test.ts`
and `supplied-pool-ownership.core.test.ts` inside `layer-drivers` (975/975). What
is NOT measured: a real PGlite database booting and calling
`activateConsumableResultProducer` through the strengthened leg. See §7 Q2 and
the unverified claim below.

---

## 7. Questions for Arnaud

These are decisions, not opinions, and I did not take them myself.

**Q1 — D-41's "asked once".** The brief's required sentence says the middleware
is "still asked once" on a short window. Measured, it is asked **zero** times:
`publishedTerminal` decides every window's count before it reaches the result
boundary (§2.3). My cell pins the measured behavior. Do you want (a) it left as
is — my recommendation, because asking a middleware about a result the operation
will refuse would hand it the provider's rows for an operation that publishes
nothing, and `publishedTerminal`'s own doc already claims this order; or (b) the
order changed so the middleware is asked first, which is an observable change to
a refusal and therefore yours?

**Q2 — the live PGlite lane.** No unit brief can run one isolated live-PGlite
file today (§6). Do you want a targeted way in — e.g. `run-vitest-safe.mjs`
gaining the `livePgliteProviderStage` shape for exactly one file — or is the
census-level evidence (`consumable-result-proof`, `layer-drivers`) the intended
ceiling for unit work, with the live lane measured only at the freeze?

**Q3 — PGlite's stock surface as a literal.** `driver.result === undefined` says
"this class ships no parser" with a literal, because there is no object to point
at. If PGlite ever installs one, that line must change with the field. I rejected
a named `canonicalResult = undefined` static as patchwork (§3.5 alternative 2).
Confirm, or take the static.

**Q4 — a changelog entry.** I wrote none (§4). D-39 changes no published answer
on any shipped driver, and the mechanism it guards has no caller in `src/`. If
you want the tightening announced anyway, it is one sentence and I will add it.

**Q5 — the re-expressed D-35 cell.** I folded D-35's cell into the SQLite family
pin rather than leaving it beside a new one, to avoid asserting "a stock driver
is a candidate" twice (§3.3). Nothing it asserted was lost. Confirm, or ask for
the old cell restored verbatim beside the new pins.

---

## 8. LOC

`git diff --numstat 383f830c -- src tests`:

```
 21   1  src/drivers/pglite/index.ts
 22  13  src/drivers/sqlite3/index.ts
101  20  tests/contracts/drivers/consumable-result-proof.core.test.ts
 87   7  tests/raptor3/g4/parity/driver-result-parser.test.ts
```

src **+43 −14** (net +29, all of it comment: code-bearing production lines are
**+2 −4, net −2**, §5.4); tests **+188 −27** (net +161), counted separately. The
charged query-engine census is unchanged by construction (§5.4).

---

## 9. Still red, unverified, blockers

**Still red.** One, pre-existing and unrelated, reproduced this round:
`tests/contracts/architecture/contract-matrix.core.test.ts` >
"inventories every executable test by owner and boundary" fails with
`tests/raptor3/candidate-handoff.test.ts: expected undefined to be defined` — an
unclassified test file committed 2026-09-14 (`cf2cbc4e6`), untouched here.
D-35 reported the same red at `fd441c7f5`. Neither ruling adds a test FILE, so
the inventory cannot have been affected by this diff.

**Unverified claims.**

1. *No shipped driver's published answers change.* Verified live on
   better-sqlite3 (`provider-sqlite3`, 755/1 skipped, unchanged) and by
   construction for both families (a stock instance is stock under either
   spelling; only a caller-mutated instance moves). NOT verified on a live PGlite
   database — the lane cannot run here (§6) — nor on bun-sqlite or d1, which have
   no transport in this environment. For PGlite the claim rests on the green
   `consumable-result-proof` cells over real `PGliteDriver` instances plus
   `layer-drivers`.
2. *The mechanism is dormant.* `resolveConsumableResultCandidate` /
   `executeConsumableResultCandidate` still have no caller in `src/` (D-35's
   observation, re-checked by grep this round), so both checks guard a mechanism
   nothing reaches today. That is state I observed, not a finding, and I changed
   nothing about it.
3. *No live short-window witness outside this pin.* Cell 6 is the estate's only
   test of a terminal window that answers SHORT, on better-sqlite3 only. The
   MySQL lane, where the non-returning `createMany … select` shape reaches
   production, stays unmeasured (the rulings unit's round-2 note says the same).

**Blockers.** One, environmental and pre-existing: the live PGlite provider lane
cannot be run under the runner this brief names (§6, Q2). No public-contract
change was needed, no legacy fallback, no duplicated interpretation, and no
registered refusal was touched — D-41 pins one exactly as registered.

---

## 10. Repair round

The reviewer's verdict was **REVISE on one item, evidence only** (`review.md`
§3, F-1): both falsification receipts were taken against earlier revisions of
the two pinned files, and §2.4/§3.4 cited them as if they were the delivered
tree. The review offered two resolutions, author's choice. **I took resolution 1
— re-run both falsifiers against the delivered files** — rather than resolution 2
(annotate the old receipts and lean on the reviewer's probes). Resolution 2
would have left a receipt-to-tree mismatch standing behind a sentence explaining
it; resolution 1 makes the fact true instead of documenting why it is not, and
the delivered assertion forms are then themselves measured under the weakened
legs, which is what a falsifier is for.

Nothing else in the unit was touched: no production file, no test file, no
guide, no changelog. After both re-runs the three mutated files were restored
and are byte-identical to the delivered tree (sha256 below), so §8's LOC is
unchanged — `git diff --numstat 383f830c -- src tests` still reads
`21 1 / 22 13 / 101 20 / 87 7`.

### 10.1 What was re-run, and what it measured

| # | mutation | measured against the DELIVERED files | receipt | wall / peak RSS |
| --- | --- | --- | --- | --- |
| F2 (D-39) | both legs weakened back to the per-arm comparison | RED, `2 failed / 5 passed` in `layer-drivers`. The two failures are the delivered cells "sqlite3: stock only while its result surface IS the shipped one" (`:274`) and "pglite: …" (`:278`), each on `expect(consumableAnswers(FAMILY)).toEqual(STOCK_ONLY)`. In both diffs exactly ONE key moves: `withFieldMiddleware: false` → `true`. `stock: true`, `withResultMiddleware: false`, `withReenteredAdapter: false` are unchanged | `receipts/repair-d39-falsification-per-hook-leg.log` | 4.09 s / 417.3 MiB |
| F1 (D-41) | `publishedTerminal` restored to `e821cd21a`'s shape (one count over the concatenation, inside `decodeQuery`, below the middleware) | RED, `2 failed / 4 passed` in `extended-local`. Cell 6 — the delivered title, "raises a short window's own registered refusal, before the boundary" — fails at `:412` on the delivered `assert.match(failure.message, SHORT_WINDOW_REFUSAL)` with `'Raptor 3 createMany final read returned inconsistent row counts.'`; cell 5 reddens with the same internal message | `receipts/repair-d41-falsification-concatenated-count.log` | 3.83 s / 453.6 MiB |

This is a strictly stronger record than round 1 on both rulings: F2 now shows
the field-only answer flipping *inside* the delivered answer object, with the
other three answers pinned green in the same diff, and F1 now fails on the
delivered `SHORT_WINDOW_REFUSAL` constant rather than on an inline regex that
no longer exists.

### 10.2 Backup, mutation, restore

Backups were copied to this session's scratchpad **before** either mutation, to
`scratchpad/o1-repair-falsify/{sqlite3-index,pglite-index,operation-context}.ts.bak`,
and each file was restored by `cp` from that copy — never by `git checkout --`
a dirty file. Restoration was verified by sha256 against the values taken from
the delivered tree before the first mutation:

```
9625542015e512baf2c10f3f1c55bbb4a4b24b75c691cfc9d8660f4c885bc60d  src/drivers/sqlite3/index.ts
56c42b95596fb171a24fc8f4485ec92497f88df35fb655198a4905ccea9d437d  src/drivers/pglite/index.ts
1fbba6fcc23d96e7256f79b5bd1281efdeb49e6cf2a3f9a804ea0a53f643a576  src/query-engine/raptor3/shared/operation-context.ts
```

All three match after restore. The falsification of D-41 mutates a file this
unit does not otherwise own (`shared/operation-context.ts`); it was mutated only
between its own two runs and left exactly as found.

### 10.3 Re-runs after the restore

| run | result | wall / peak RSS | receipt |
| --- | --- | --- | --- |
| `drivers/consumable-result-proof.core.test.ts` (both projects) | **14/14** | 4.30 s / 481.7 MiB | `repair-d39-consumable-result-proof.log` |
| `g4/parity/driver-result-parser.test.ts` (`extended-local`) | **6/6** | 3.28 s / 466.4 MiB | `repair-d41-pin.log` |
| `node scripts/run-typecheck.mjs` (whole estate) | **0 diagnostics, exit 0** | 6.77 s / 4915.3 MiB | `repair-typecheck.log` |

The affected set is exactly these: the repair changed no source and no test, so
`layer-drivers`, `provider-sqlite3`, `g2-baseline` and `g3-execution-review`
answer over a tree that is byte-identical to the one they were green on in §6,
and the reviewer re-ran all four independently (`review.md` §1.2). No lock
refusal was met, so nothing was retried and no lock was removed; one file, one
project or one mode per call, `TMPDIR=/private/tmp/viborm-o1-tmp` exported for
every run. Nothing was committed, staged, reset, stashed or pushed; nothing was
written outside this worktree except the three scratchpad backups; no test was
deleted, weakened or skipped; `/Users/arnaud/code/viborm` and
`/private/tmp/viborm-o2` were never touched. `review.md` was not edited.

### 10.4 Receipts kept, not overwritten

`receipts/d39-falsification-per-hook-leg.log` and
`receipts/d41-falsification-concatenated-count.log` are genuine runs of the same
two mutations against the earlier cell layouts. Evidence discipline says a
receipt is never relabelled or discarded, so they stay on disk unaltered and
§6 records them as superseded; the rows in §2.4, §3.4 and §6 that stand for "the
delivered tree was falsified" now cite the `repair-` receipts instead.

### 10.5 What is still open

Unchanged by this round: the still-red `contract-matrix.core.test.ts` (§9,
pre-existing, reproduced by the reviewer), the three unverified claims (§9), and
the one environmental blocker — the live PGlite lane cannot be run under the
runner the brief names, which the reviewer independently confirmed by running
`--rss-limit-mb=2560` and being refused (`review.md` §4).

**§7 Q1–Q5 remain Arnaud's to decide.** The review recommends leaving Q1 as
delivered and has no objection on Q3, Q4 or Q5, and raises one additional
observation of its own for Arnaud, not for me: `sqliteResultParser` is now named
twice in `src/drivers/sqlite3/index.ts` — at the `result` field (`:79`) and at
the comparison (`:239`). Both read the same owned object and any divergence
fails SAFE (nothing is stock), so neither the reviewer nor I treated it as
patchwork; if Arnaud wants one named source there it is his call, and I have not
made it.
