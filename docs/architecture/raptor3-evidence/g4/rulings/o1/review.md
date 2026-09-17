# Review — D-39 (canonical surface, SQLite + PGlite) and D-41 (short-window pin)

Independent reviewer. Worktree `/private/tmp/viborm-o1`, branch `o1`, HEAD
unmoved at `383f830c`. `TMPDIR=/private/tmp/viborm-o1-tmp-r` exported for every
run; one file, one project or one registered mode per call; no lock refusal was
met, so nothing was retried and no lock was removed. Nothing was committed,
staged, reset, stashed or pushed; no author file was edited; `/Users/arnaud/code/viborm`
and `/private/tmp/viborm-o2` were never touched. My own receipts are in
`review-receipts/` beside the author's `receipts/`.

## Verdict: REVISE — one item, evidence only

Both rulings are implemented correctly, at the right owners, and I reproduced
their substance myself, twice over, without editing a single file. The one
thing that does not hold up is the **falsification receipts**: both were taken
against earlier revisions of the two pinned files, and the note cites them as
if they were the delivered tree. That is a five-minute fix and nothing else in
the unit needs to change.

Nothing was deleted, weakened or skipped; typecheck is zero; every gate the
brief names that CAN run here is green on my own re-runs.

---

## 1. What I verified, and how

### 1.1 Read

Every hunk of `git diff 383f830c -- src tests CHANGELOG.md` (`CHANGELOG.md` is
untouched), the two owners in full, `consumable-result-candidate.ts`,
`Queries.selectSeries` / `assertExpectedRows` / `decodeQuery`,
`OperationContext.publishedTerminal` and `publishedProjection`, root
`AGENTS.md` rule 5, and `scripts/bounded-process.mjs`.

### 1.2 Re-runs (mine, not the author's)

| run | result | receipt |
| --- | --- | --- |
| `consumable-result-proof.core.test.ts`, both projects | 14/14 | `r-d39-consumable-result-proof.log` |
| `g4/parity/driver-result-parser.test.ts`, `extended-local` | 6/6 | `r-d41-driver-result-parser.log` |
| `layer-drivers`, whole project | 975/975, 43 files | `r-layer-drivers.log` |
| `provider-sqlite3`, whole project (live better-sqlite3) | 755 passed, 1 skipped, 6 files | `r-provider-sqlite3.log` |
| `run-raptor3.mjs g2-baseline` | 216/216, gate verified | `r-mode-g2-baseline.log` |
| `run-raptor3.mjs g3-execution-review` | 6/6, gate verified | `r-mode-g3-execution-review.log` |
| `node scripts/run-typecheck.mjs` | **exit 0, zero diagnostics**, 5.97 s, 4476.1 MiB | `r-typecheck.log` |
| `npx biome check` on the four touched files | clean, 0 diagnostics | — |
| `contracts/architecture/contract-matrix.core.test.ts` | 1 failed / 4 passed — the pre-existing red | `r-contract-matrix.log` |

### 1.3 My own probe — D-39 (`r-probe-d39-surface-legs.log`, source `probe-d39.ts.txt`)

Run through `vite-node` against the worktree's own config, so **no file was
mutated**. For each family it asks three questions of four witnesses: the
shipped leg (`hasCanonicalProducerSurface` itself), the **pre-D-39 leg
reconstructed from `383f830c`**, and what `resolveConsumableResultCandidate`
answers.

| witness | sqlite3 shipped / pre-D-39 / resolves | pglite shipped / pre-D-39 / resolves |
| --- | --- | --- |
| stock | **true** / true / **true** | **true** / true / **true** |
| result middleware | false / false / false | false / false / false |
| **field-only middleware** | **false** / **TRUE** / **false** | **false** / **TRUE** / **false** |
| re-entered adapter | false / false / false | false / false / false |

Also measured: `new SQLite3Driver().result === sqliteResultParser`,
`new PGliteDriver().result === undefined`, `sqliteResultParser.parseResult === undefined`.

This is the ruling, measured: the stock instance IS stock and the field-only
middleware is NOT, on both families — and the one answer that moves between the
old leg and the new one is exactly `withFieldMiddleware`, on both families, with
the result-middleware and adapter-re-entry answers untouched. It is a stronger
falsification than mutating the leg, because it measures both legs on the same
witnesses in one process. (It also shows the adapter object is per instance:
`stock` is still resolved AFTER the re-entered witness was built.)

### 1.4 My own probe — D-41 (`r-probe-d41-falsification-ab.log`, source `probe-d41.ts.txt`)

The same short-window world twice in one process, the second time with
`OperationContext.prototype.publishedTerminal` replaced at runtime by the
pre-repair shape of `e821cd21a` (one count over the concatenation, inside
`decodeQuery`, below the middleware). Again **no file was mutated**.

| | class | message | windows at the provider | middleware asked |
| --- | --- | --- | --- | --- |
| as shipped | `QueryEngineError` | the REGISTERED sentence, verbatim | 2 | **0** |
| falsified | `QueryEngineError` | `Raptor 3 createMany final read returned inconsistent row counts.` | 2 | **1** |

### 1.5 The registry

`Queries.selectSeries` (`src/query-engine/raptor3/shared/query.ts:3184`) stamps
`expectedRows.missing` with `new QueryEngineError("createMany with 'select'
could not read back one of the created rows at the primary key it reported. …")`;
the `updateMany` sibling is a `TransactionError`, and `QueryEngineError` and
`TransactionError` are siblings under `VibORMError` (`src/errors/query.ts:363`,
`src/errors/transaction.ts:24`), so `instanceof QueryEngineError` already
excludes the sibling and no second guard is owed. The cell's regex is the same
spelling the estate's existing pin of that refusal uses
(`tests/raptor3/core-structure/extension-a.contract.test.ts:344`). Nothing was
invented.

---

## 2. Ruling by ruling

### D-39 — ACCEPT on substance

- **One rule, once per family, at its owner.** Each
  `hasCanonicalProducerSurface` holds exactly one comparison for the result
  surface (`driver.result === sqliteResultParser`, `driver.result === undefined`).
  No per-arm comparison survives anywhere: `canonicalDriverParseResult` is gone
  and grep finds no other stock-surface reader in `src/` (the one remaining
  `this.result?.parseResult` at `query.ts:663` is `decodeResult` asking whether
  there is a hook to call — a different question). **No policy boolean was
  added anywhere in the diff.**
- **Not shared, and the reason holds.** What differs between the families is
  the value "what this class ships at `result`" — an imported object on one
  side, the absence of a declaration on the other — and the member lists differ
  too (`runStatement`). A shared helper would be a function whose whole body is
  one `===`. I agree, and the cross-references make the pair discoverable from
  either end.
- **Pins.** All three the ruling requires are present per family, plus D-35's
  result-middleware witness, as one answer object each. They cannot pass
  vacuously: `stock: true` fails if registration ever breaks, and `toEqual`
  fails on a missing or extra key.
- **Behaviour.** No shipped path installs a `result` surface on a driver
  instance; the only assignment in `src/` is `TransactionBoundDriver`
  (`driver.ts:521`), which copies the same object onto a different prototype and
  was already excluded, and `createPinnedSessionView` uses `Object.create(this)`,
  likewise already excluded. Confirmed live on better-sqlite3 (755/1 skipped,
  unchanged) and on real `PGliteDriver` instances. The guide needed no edit:
  root `AGENTS.md` rule 5 already says "parser middleware … stays borrowed", so
  this is the code catching up with the guide.

### D-41 — ACCEPT on substance

- The cell expects the registered class and the registered sentence read from
  the owner, not a copy; both windows are proven to have reached the provider;
  and the operation refuses before the result boundary.
- **The brief's "the driver middleware still asked once" is wrong, and the
  author is right to have refused it.** My A/B measured it: as shipped the
  middleware is asked **zero** times, and "asked once" is precisely what the
  **falsified** shape produces, because the count then happens inside
  `decodeQuery`, below the middleware. Demanding "asked once" would be
  demanding the pre-repair behaviour back. `assert.deepEqual(driver.observed, [])`
  is load-bearing: it is the second assertion the falsifier moves.
- `createChunkedWorld` taking the transport class instead of `batch: boolean`
  removes a policy boolean rather than adding one; cell 5 keeps both arms, in
  order, with every assertion unchanged.
- The deliberate gap (no short-window arm on the batch/prepared transport) is
  recorded and correct: both arms reach the same `publishedTerminal`.

---

## 3. The one finding (REVISE)

**F-1 — the falsification receipts predate the delivered files.**

- `receipts/d39-falsification-per-hook-leg.log` was run against an earlier
  layout: its cells are titled `'sqlite3': a shipped driver is stock only …`
  (quoted family) and both failures are per-witness
  `expect(resolveConsumableResultCandidate(installResult(stock(), fieldM…))).toBeUndefined()`
  at `:250`. The delivered file has no such line: its cells are
  `expect(consumableAnswers(FAMILY)).toEqual(STOCK_ONLY)` at `:273-279`, and the
  witnesses live in a helper. Note §3.4 and §6 cite that receipt as the
  delivered pins' falsification, and §3.5 alternative 4 explains why the layout
  changed afterwards — so the delivered assertion form was never itself run
  under the weakened leg.
- `receipts/d41-falsification-concatenated-count.log` is the same story in
  miniature: its cell is titled `… refusal, above the boundary`, the delivered
  one `… refusal, before the boundary`. Assertions unchanged; wording only.

Nothing here casts doubt on the claims — I reproduced both mechanisms myself
(§1.3, §1.4), and the delivered `toEqual(STOCK_ONLY)` cells must redden under
the weakened leg because the `withFieldMiddleware` value flips, which I
measured. It is the receipt-to-tree correspondence that fails.

**Exact minimal resolution (either, author's choice):**

1. Re-run both falsifiers against the delivered files — weaken the two legs
   from the scratchpad backups, run
   `consumable-result-proof.core.test.ts`; restore; patch `publishedTerminal`,
   run `driver-result-parser.test.ts`; restore — and replace the two receipts,
   updating the line citations in §2.4 and §3.4. **or**
2. Leave the receipts as the genuine runs they are and add one sentence to §2.4
   and §3.4 recording that each was taken against the pre-final cell layout
   (naming it), and cite `review-receipts/r-probe-d39-surface-legs.log` and
   `review-receipts/r-probe-d41-falsification-ab.log` as the falsification of
   the delivered tree.

---

## 4. Confirmed: blockers, reds, process

- **Blocker (environmental, pre-existing, confirmed).** The brief's PGlite step
  cannot be executed. `run-vitest-safe.mjs --rss-limit-mb=2560` is refused —
  I ran it: `--rss-limit-mb must be a positive integer no greater than 1536.`
  (`scripts/bounded-process.mjs:177`), and an explicit limit may only LOWER a
  ceiling (`resolveProcessGroupRssCeiling`, `:78-97`); the 2560 ceiling is
  selectable only by `run-credential-free-tests.mjs`, the exhaustive gate unit
  work may not run. The smallest live PGlite file breaches the ordinary ceiling:
  I measured **1643.1 MiB** (`r-provider-pglite-vector.log`), the author 1676.9
  with the change and 1680.9 with both drivers reverted to `383f830c` — the
  change is not the cause. The PGlite surface check is instead measured on real
  `PGliteDriver` instances in `consumable-result-proof` and in `layer-drivers`.
- **Still red, unrelated, confirmed by my own run.**
  `contract-matrix.core.test.ts` > "inventories every executable test by owner
  and boundary" fails with `tests/raptor3/candidate-handoff.test.ts: expected
  undefined to be defined`. This diff adds no test FILE, so it cannot be the
  cause.
- **Process deviation, disclosed by the author and accepted as disclosed:**
  `note.md` was written after the production edits, not before them, contrary to
  the decision-elimination gate. The gate's four items are answered against the
  actual diff.
- **LOC** as stated: `src` +43 −14 (code-bearing +2 −4), tests +188 −27; the
  charged query-engine census is untouched because neither production file is
  under `src/query-engine`.

---

## 5. Questions for Arnaud (not decided here)

The author's five stand, and I have measurements for two of them:

- **Q1 (D-41 "asked once")** — recommend (a), leave it. Measured: as shipped the
  middleware is asked zero times; "asked once" is what the falsified pre-repair
  shape does. Changing the order would hand a middleware the provider's rows for
  an operation that publishes nothing.
- **Q2 (the live PGlite lane)** — confirmed unrunnable, your call.
- **Q3 (PGlite's `undefined` literal)** — no objection from me. Note the SQLite
  mirror you may also want to rule on: `sqliteResultParser` is now named twice
  in that file, at the `result` field (`:79`) and at the comparison (`:239`).
  Both read the same owned object and divergence would fail SAFE (nothing stock),
  so I did not count it as patchwork — but if you want one named source there,
  that is your decision, not the author's.
- **Q4 (changelog)** — no shipped answer changes; I verified there is no path in
  `src/` that installs a driver `result` surface.
- **Q5 (the re-expressed D-35 cell)** — nothing was lost: the same witness object
  and the same two facts are `stock` and `withResultMiddleware` in `STOCK_ONLY`,
  with two facts added. My only observation is that the rationale prose now
  appears three times (both driver docs and the test helper's doc), the test's
  paragraph repeating the sqlite3 one closely.
