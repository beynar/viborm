# Review — D-28 (the driver-level `parseResult` consumer)

Independent reviewer, 2026-09-17. Scope: ruling **D-28** only — the hunks the
author's note attributes to it (`shared/query.ts` in full, and
`shared/operation-context.ts` at `answer`/`publishedTerminal`, `publish`,
`publishPrepared`, `decodeTerminalResults`, `finishTerminals`' live arm, and the
three set-mutation publications) plus its falsifier
`tests/raptor3/g4/parity/driver-result-parser.test.ts`. D-29 and D-32 belong to
the second reviewer and are untouched here.

Subject: worktree `/private/tmp/viborm-rulings`, branch `rulings`, commit
`e821cd21a` on base `5ac39cfd`. Every run below used
`TMPDIR=/private/tmp/viborm-rulings-tmp-ra`, one file or one registered mode per
call, never two at once. Receipts: `receipts/review-d28/*.log`.

## Verdict: **REVISE**

The consumer itself is right, and it is the one the brief asked for: it sits at
one owner (`Queries.decodeResult`), it is asked **once per operation** on the
live route and on the prepared/batch route — measured, not read — `next` chains
driver → adapter → decoder, the SQLite count/exists normalisation keeps exactly
one owner with no duplicate in raptor3, the pglite arrangement is untouched and
still sound, the driver contracts are green, the falsification reproduces, and
the whole-estate typecheck is at zero.

But one hunk of it — the terminal-window half — **reddens four registered cells
in two registered modes that are green at `5ac39cfd`**, and the ruling's own pin
cannot see it, because the pin does not cover that caller at all. Both are
mechanical to fix; neither needs a decision from Arnaud. Nothing else blocks.

---

## F1 (blocking) — a multi-window terminal decodes against window 0's row-count contract

**Owner** `shared/operation-context.ts:916-923` (`publishedTerminal`), reached
from `:1439-1454` (`decodeTerminalResults`, the batch and prepared terminal) and
`:1456-1470` (`finishTerminals`' live arm).

The hunk concatenates every terminal window's raw rows and decodes the whole set
once against `queries[0]`:

```ts
private publishedTerminal(queries: readonly Query[], rows: Input[]): Input[] {
  const terminal = queries[0];
  if (!terminal) return [];
  return this.queries.decodeResult(rows, this.operation, (raw) =>
    this.queries.decodeQuery(terminal, raw)
  );
}
```

The note's premise — "every window decodes against the same shape" — is true:
`seriesQueries` (`:1402`) hands every chunk `prepared.shape`. But `shape` is not
the only fact a terminal window carries. `selectSeries`
(`shared/query.ts:3140-3180`) also stamps each window with **its own**
`expectedRows.count` (that chunk's identity count) and its own registered
refusal, and `decodeQuery` (`shared/query.ts:4184-4192`) is where that contract
is enforced:

```ts
if (query.expectedRows && rows.length < query.expectedRows.count)
  throw query.expectedRows.missing;              // a registered refusal
if (query.expectedRows && rows.length > query.expectedRows.count)
  throw new QueryEngineError("Raptor 3 createMany final read returned inconsistent row counts.");
```

Asked once against `queries[0]`, that check now compares the **sum of all
windows** with **window 0's** count. Two consequences:

1. **Measured.** Any multi-window terminal read-back throws
   `QueryEngineError: Raptor 3 createMany final read returned inconsistent row
   counts.` — a legitimate operation refused with an internal-invariant message.
   Reddened cells, all green at `5ac39cfd`:

   | mode / file | cell | base | `e821cd21a` |
   | --- | --- | --- | --- |
   | `g3-execution-review` (`tests/raptor3/g3/review-execution-boundaries.test.ts`) | *reads a supported incremented key when the public result omits it* | ✓ | ✗ |
   | " | *reads through a supported compound key transition with omitted result keys* | ✓ | ✗ |
   | " | *partitions non-returning terminal reads by bind count and preserves input order* | ✓ | ✗ |
   | `g3-author-execution-regressions` (`tests/raptor3/g3/author-execution-regressions.test.ts`) | *keeps prepared cardinality independent of terminal query chunking* | ✓ | ✗ |

   `base-g3-execution-review.log` **6/6** → `head-g3-execution-review.log`
   **3 failed / 3 passed**; `base-g3-author-execution-regressions.log` **3/3** →
   `head-g3-author-execution-regressions.log` **1 failed / 2 passed**.
   Isolated to this hunk: with only `decodeTerminalResults` and
   `finishTerminals`' live arm restored to their base bodies and every other
   D-28/D-29/D-32 hunk left in place, both modes are green again
   (`isolation-terminal-hunk-reverted-*.log`, 6/6 and 3/3).

   Production reach, from the owners: `createMany`/`updateMany` with `select` on
   a provider without RETURNING (`operation-context.ts:1755-1823`, `:1923-1956`
   — i.e. MySQL), and **every** nested member read-back on every provider
   (`commands/execution.ts:589-594` and `:691-698`), whenever the read-back
   exceeds the driver's bind budget. The third reddened cell is exactly that
   shape: a non-returning driver, `createMany` + `select`, five rows, bind limit
   five → five windows of four parameters, published in input order.

2. **Reasoned, not measured** (the upper bound throws first in most splits, so I
   could not stage it without a synthetic fault): the per-window refusals
   `expectedRows.missing` — createMany's "*could not read back one of the
   created rows at the primary key it reported*" and updateMany's "*could not
   read back one of the updated rows at its final primary key*" — are no longer
   evaluated per window. For windows `[2, 1]` where the second answers zero
   rows, the total (2) equals window 0's count (2): no refusal is raised and the
   operation publishes two rows for three written ones. A refusal that cannot
   fire in the split it was written for is weakened, which the rules forbid.

**Exact minimal resolution.** Keep the middleware asked once per operation, and
keep the window→query correspondence for the row-count fact, which is the one
fact that is per window rather than per operation:

- give the row-count contract one named owner on `Queries`, extracted from
  `decodeQuery` so nothing reads it twice, e.g.
  `assertExpectedRows(query: Query, rows: number): void` holding the two
  branches verbatim, with `decodeQuery` calling it (unchanged behaviour for its
  single-query callers);
- have `decodeTerminalResults` and `finishTerminals`' live arm collect
  `Input[][]` (one entry per window — both already loop) and pass that to
  `publishedTerminal(queries, windows)`;
- in `publishedTerminal`, ask `assertExpectedRows(queries[i], windows[i].length)`
  per window on the provider's own rows, then ask `decodeResult` once over
  `windows.flat()` and decode the result against the shared shape
  (`decodeProjection(terminal.shape, …)`, which carries no row-count check — the
  count has already been decided where the window was still known, and a
  middleware that legitimately replaces the operation's rows must not be judged
  against a physical window count);
- correct the guide paragraph (`src/query-engine/raptor3/AGENTS.md:844-856`),
  which today states the shape half of the claim and omits the count half.

## F2 (blocking, same fix) — the pin does not cover the caller that broke

With `decodeTerminalResults` and `finishTerminals`' live arm reverted — the
terminal-window boundary asking the middleware **zero** times —
`driver-result-parser.test.ts` is still **4/4 green**
(`isolation-terminal-hunk-reverted-d28-pin.log`). The pin's four cells reach the
boundary only through `publish` / `publishPrepared` (reads) and the set-mutation
publications; two of the four callers the note and the guide name — the batch /
prepared terminal and the live multi-window terminal — have no falsifier at all.
That is why F1 went undetected, and the author's own note makes the multi-window
claim that no cell tests.

**Resolution.** One cell, in the same file: an operation whose terminal spans
more than one window (a non-returning driver, or `maxBindParametersPerStatement`
lowered as `RecordingSQLiteDriver` already allows, `createMany` + `select`)
asked the middleware exactly **once**, with the operation's rows, on both
routes, and published in input order. It reddens under F1's current code, which
is the point.

## F3 (minor, no-patchwork) — three near-verbatim result publications

`operation-context.ts:1984-1988` (`updateMany`) and `:2061-2065` (`deleteMany`)
are textually identical:

```ts
this.queries.decodeResult(result.rows.map(record), this.operation, (rows) =>
  q.decodeProjection(projection.shape, rows)
)
```

and `:1906-1910` (createMany's fold) is the same call over accumulated rows. The
guide already says "four callers", which is the smell: the fact "a set-mutation
publication is one result window" has three readers. One private method —
`publishedProjection(projection, rows)` beside `publishedTerminal` — collapses
them with no behaviour change, and `publishedTerminal` can be stated over it.
Not a defect; a rule-1 cleanup the unit should take while it is in this file.

## F4 (nit) — one sentence in the note names the wrong driver

Note §D-28 and blocker 3 say deleting `sqliteResultParser.parseResult` "would
also change `pglite`'s `hasCanonicalProducerSurface` question,
`driver.result?.parseResult === undefined`". PGlite's question reads **its own**
`result` (which is `undefined`) and its adapter's identity
(`src/drivers/pglite/index.ts:227-235`); the parser that would change identity is
`SQLite3Driver.canonicalDriverParseResult` (`src/drivers/sqlite3/index.ts:75-77,
221`) and bun-sqlite's. The conclusion (keep the arm, it is a public driver
surface, deleting it is Arnaud's call) is right; the reason names the wrong file.

---

## What I verified, and how

1. **One owner, asked once per operation, both routes — measured.** The author's
   pin is green in the subject tree (`head-d28-pin.log`, 4/4). Beyond it I ran my
   own counting middleware over a wider verb set (`probe-ask-counts.log`, probe
   files live in my scratch worktree only):
   - live route: `findFirst` 1, `groupBy` 1, `upsert` (update arm) 1, `upsert`
     (create arm) 1, `delete` 1, `createMany`+`select` 1, `createMany`+`select`
     with the bind budget lowered to 4 (one ask for the whole operation, answer
     correct) 1, `updateMany` → `{count}` **0**, `deleteMany` → `{count}` **0**
     (the documented exemption: a row count is a transport fact, not a result
     window);
   - prepared route (`$transaction([…])`, batch-only transport): `findFirst` 1,
     `createMany`+`select` 1 (rows = 3, one ask), `updateMany` → `{count}` 0,
     `groupBy` 1 — verbs in order, answers correct.
   No shape asked twice. Combined with the pin's six verbs on both routes, the
   "exactly once per operation" requirement holds everywhere I could reach it.
2. **`next` chains to the adapter's parse — measured.** With a counting wrapper
   installed over `driver.adapter.result.parseResult` on a pristine
   `SQLite3Driver`, the adapter leg is asked once per operation, in verb order
   (`["findMany","count","update"]`), under the driver leg
   (`probe-sqlite-parser-and-adapter-leg.log`, cell 2), and the engine's decoder
   runs beneath it (the pin's cells 3 and 4).
3. **SQLite count/exists has exactly one owner.** Raptor 3 aliases the count
   column `_count` for `count` **and** `exist` (`shared/query.ts:2927`, `:3052`,
   and the `count`/`exist` case at `:2896-2958`); `extractCountValue`
   (`src/adapters/shared/result-parsing.ts:155-168`) answers only for
   `0viborm_count_result` or a key beginning `count(`, so
   `sqliteResultParser.parseResult` passes straight through. raptor3 contains no
   second normalisation of that fact, so there is no duplicate to delete —
   keeping the driver arm is correct and its disclosure is accurate (see F4 for
   the one wrong sentence). Measured with the **shipped** parser live (a pristine
   `SQLite3Driver`, no override): `count` 2, filtered `count` 1,
   `count({select:{_all:true}})` `{_all:2}`, `exist` true/false, `_sum` 8, and
   boolean rows `[true,false]` (`probe-sqlite-parser-and-adapter-leg.log`, cell 1).
4. **The pglite arrangement is respected.** PGlite publishes no `result`, so
   `decodeResult` skips the driver leg and asks the canonical adapter parse;
   `hasCanonicalProducerSurface` compares identities only and nothing in this
   unit rebinds either one. `layer-drivers` — which includes
   `consumable-result-proof.core.test.ts` and
   `pglite-controlled-transport-coverage.core.test.ts` — is **969/969 / 43 files**
   green (`head-layer-drivers.log`), covering the sqlite3, bun-sqlite (shared
   `sqlite-*.core.test.ts`) and pglite driver contracts.
5. **The cache route is served; the cell is not green, and the author's reason is
   correct.** `official-cache-swr.core.test.ts` is **1 failed / 6 passed**
   (`head-cache-swr.log`), `hostileJsonReadsAtCoreBoundary` reads 0, expected 1.
   I re-measured the two halves independently on a copy of the cell
   (`probe-cache-route-boundary.log`): the driver `parseResult` boundary **is**
   reached on the cache route — 17 asks across the file, one per operation,
   including the background revalidation with hostile publishing on — and the
   `json()` field's `StandardSchemaV1.validate` is invoked **zero** times, so the
   hostile object is never constructed and the counter cannot move. The cell
   needs a second, separate fact (a read-path invocation of a `json()` field's
   user schema, observable for every `json().schema(…)` field on every provider),
   exactly as the note's blocker 1 and the integration note §1c say. I accept
   that as a stated blocker under the brief's own clause, and I confirm the
   brief's D-28 falsifier list therefore ships one member red **by disclosure,
   not by omission**.
6. **The falsification reproduces.** In a scratch worktree
   (`git worktree add --detach`, `/private/tmp/viborm-rulings-scratch-ra`) at
   `e821cd21a` with `shared/operation-context.ts` restored to `5ac39cfd`, the new
   pin is **4/4 red** and the middleware is asked zero times — the pre-unit state
   the integration note §1c measured.
7. **Typecheck.** `node scripts/run-typecheck.mjs`: **exit 0, zero diagnostics**,
   ~5.1 GiB peak — measured twice, in the subject worktree and in the scratch
   copy at the same commit (`head-typecheck.log`).
8. **Formatting.** `npx biome check` is clean on
   `tests/raptor3/g4/parity/driver-result-parser.test.ts`, and no diagnostic in
   either production file falls on a line in the D-28 ranges (`query.ts:619-660`;
   `operation-context.ts:880-930, 1435-1475, 1890-1915, 1970-1995, 2050-2070`).
9. **Registration.** `driver-result-parser.test.ts` is in `EXTENDED_LOCAL_TESTS`
   (191 entries; confirmed by importing the manifest), and every run reports it
   under `|extended-local|`, so it is a registered pin, not an orphan file.

### Runs (all mine, all serial, `TMPDIR=/private/tmp/viborm-rulings-tmp-ra`)

| target | result | receipt |
| --- | --- | --- |
| `g3-execution-review` @ `e821cd21a` | **3 failed / 3 passed** | `head-g3-execution-review.log` |
| `g3-execution-review` @ `5ac39cfd` | 6/6 | `base-g3-execution-review.log` |
| `g3-author-execution-regressions` @ `e821cd21a` | **1 failed / 2 passed** | `head-g3-author-execution-regressions.log` |
| `g3-author-execution-regressions` @ `5ac39cfd` | 3/3 | `base-g3-author-execution-regressions.log` |
| both modes, terminal hunk only reverted | 6/6 and 3/3 | `isolation-terminal-hunk-reverted-*.log` |
| the D-28 pin, terminal hunk only reverted | 4/4 (F2) | `isolation-terminal-hunk-reverted-d28-pin.log` |
| `driver-result-parser.test.ts` | 4/4 | `head-d28-pin.log` |
| `official-cache-swr.core.test.ts` | 1 failed / 6 passed | `head-cache-swr.log` |
| `--project=layer-drivers` | 969/969, 43 files | `head-layer-drivers.log` |
| `g3-bulk-result-boundary` | 5/5 | (run in the subject worktree, 21:07) |
| `g3-bulk-series` | 6/6 | (run in the subject worktree, 21:07) |
| `g3-transaction-array` | 4/4 | (run in the subject worktree, 21:11) |
| reviewer ask-count probes (live + prepared) | 2/2 | `probe-ask-counts.log` |
| reviewer sqlite-parser + adapter-leg probe | 2/2 | `probe-sqlite-parser-and-adapter-leg.log` |
| reviewer cache-route probe | 17 asks, 0 `validate` | `probe-cache-route-boundary.log` |
| `node scripts/run-typecheck.mjs` | exit 0, 0 diagnostics | `head-typecheck.log` |

### Not run (unverified by me)

`g4-read-contracts` refuses to run as a gate in a dirty tree (stale-evidence
harness hash — re-qualifying recorded evidence is not a reviewer's act). MySQL
and Docker pg were not exercised for D-28 (the owners are provider-neutral, but
the non-returning arms F1 reaches are MySQL's normal path, so the MySQL lane is
where F1 would show in the estate). `provider-bun` (a real Bun runtime) was not
run. The re-plan case — whether an operation that re-plans asks the middleware
once per attempt rather than once per public call — is not pinned and I did not
measure it; per attempt looks right, since only the surviving attempt publishes.

### Method note

The subject worktree is shared with the D-29/D-32 reviewer, who reverted all
three production files in place at **21:13:06** for their own falsification.
Every measurement above was taken either before that (subject-worktree runs, all
timestamped 20:58–21:12, each one whose verdict depends on the hunks carrying a
HEAD-only symptom) or in my own detached scratch worktree
`/private/tmp/viborm-rulings-scratch-ra`, which holds `e821cd21a` pristine plus
three probe files of mine and nothing else. I wrote nothing in the subject
worktree except this file and `receipts/review-d28/`. The scratch worktree is
left in place (removing it writes to the shared git dir); the integrator can drop
it with `git worktree remove --force /private/tmp/viborm-rulings-scratch-ra`.

### LOC (D-28's share of `git diff --numstat 5ac39cfd e821cd21a`)

`shared/query.ts` **+36 / −0** (all of it `decodeResult`);
`shared/operation-context.ts` **+77 / −23** across seven hunks (the D-29 and
D-32 hunks account for the remaining +66 / −11 of that file);
`tests/raptor3/g4/parity/driver-result-parser.test.ts` **+208 / −0**;
`AGENTS.md`: the result-boundary paragraph (the `@@ -840,7 +840,19 @@` hunk).
