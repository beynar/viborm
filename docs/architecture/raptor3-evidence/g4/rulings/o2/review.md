# D-40 — independent review

Reviewer: independent (not the author). Worktree `/private/tmp/viborm-o2`,
branch `o2`, base `383f830c0`. `TMPDIR=/private/tmp/viborm-o2-tmp-r` exported
for every run. Nothing committed, staged, reset, stashed or pushed; no file of
the author's was edited; nothing outside this worktree was written except the
session scratchpad. My receipts are in
`docs/architecture/raptor3-evidence/g4/rulings/o2/review-receipts/`.

## Verdict: **ACCEPT**

Both deletions are exactly the legs the measurement classified inert, and I
reproduced that measurement myself on live Docker PostgreSQL and MySQL rather
than taking the note's word. I also ran the one counterfactual the note marks as
argued rather than measured (F2) and it holds: with the pre-deletion leg
reinstalled byte-for-byte from `383f830c`, **every** row I asked — including the
two keys the MySQL helper dealt in — answers identically, class for class and
message for message. No helper with a surviving reader was removed, no cell was
weakened or skipped, every re-expressed cell pins the decoder's ownership of the
same fact, both provider red sets are byte-identical to the recorded ones on MY
runs, and the whole-estate typecheck is zero.

Four small items below are wording, not defects (§4), and the author's four open
questions plus one of mine are for Arnaud, not for me (§5). None of them blocks.

## 1. The measurement, reproduced (not taken on trust)

A recorder of my own above the SHIPPED (post-deletion) `parseResult` of each
adapter, on live Docker PostgreSQL `:55729` and MySQL `:55730`, asking the
DELETED helper — copied verbatim from `383f830c` — what it would have decided
about the very same raw; then the whole operation set run a SECOND time with the
pre-deletion leg reinstalled, on the same state, and the public answers compared.
Seven operations (`count` plain/filtered/`select:{_all}`, `exist` true/false,
`aggregate`, `findMany`, `findUnique`, `create`, `update`) on the live route and
on `$transaction([…])`.

| transport | asks | the deleted leg would have decided | answers with the leg vs without |
| --- | --- | --- | --- |
| `pg` | 20 (10 live, 10 prepared) | nothing, 20/20 | identical — live, prepared and writes |
| `mysql2` | 20 (10 live, 10 prepared) | nothing, 20/20 (the `count`/`exist` arm entered on 10, `undefined` each time) | identical — live, prepared and writes |

Receipts: `review-receipts/review-probe-pg.log`,
`review-receipts/review-probe-mysql.log`; probe sources kept as
`review-receipts/o2r-review-probe.ts.txt`, `pg-o2r-review-probe.test.ts.txt`,
`mysql2-o2r-review-probe.test.ts.txt`, and the three probe files removed from the
tree (`git status` is the author's nine files plus the ruling directory).

The raw each provider really answers, measured again here and matching the note:
`pg` `[{"_count":"2"}]` — integer TEXT; `mysql2` `[{"_count":2}]`; `{_all}` under
its own alias; `exist` as `1`/`0`. The public answers are `2`, `true`, `false`.

**Why neither leg could fire**, checked in the source rather than inferred:
`Queries.decodeResult(raw: Input[], …)` (`raptor3/shared/query.ts:651-669`) is
the only caller of any adapter `parseResult` in `src/`, and it hands the leg the
operation's ROW ARRAY; no shipped driver can change that, because no shipped
driver installs a `DriverResultParser.parseResult` at all any more — D-35
deleted the SQLite family's, `bun-sql`'s parser carries a `parseField` only, and
`pg`, `postgres.js`, `mysql2` and `planetscale` carry no driver result parser.
An array is never a `bigint`, so the PostgreSQL leg was unreachable by
construction; MySQL names the column `_count`, which `normalizeCountResult` is
written not to recognise.

## 2. The counterfactual the note calls mechanism (F2) — now measured

`review-receipts/counterfactual.log` (source:
`review-receipts/o2r-counterfactual.core.test.ts.txt`, file removed from the
tree). The pre-deletion member — not a wrapper, the member itself, so
`next(normalized)` carries the rewritten rows exactly as before D-40 — installed
on a scripted transport carrying the real adapter:

```
mysql recognised-key  [{"COUNT(*)":2}]              WITH-LEG REJECTED QueryEngineError … the value is absent. | NO-LEG identical
mysql recognised-key exist                          WITH-LEG REJECTED QueryEngineError … the value is absent. | NO-LEG identical
mysql produced-key    [{"0viborm_count_result":2}]  WITH-LEG REJECTED QueryEngineError … the value is absent. | NO-LEG identical
mysql live alias      [{"_count":2}]                WITH-LEG RESOLVED 2 | NO-LEG RESOLVED 2
pg live alias         [{"_count":"2"}]              WITH-LEG RESOLVED 2 | NO-LEG RESOLVED 2
pg bigint carrier     [{"_count":2n}]               WITH-LEG RESOLVED 2 | NO-LEG RESOLVED 2
pg unsafe bigint      [{"_count":2n**70n}]          WITH-LEG REJECTED QueryEngineError … outside the safe range. | NO-LEG identical
```

So the MySQL leg rewrote a key the decoder cannot read into another key the
decoder cannot read — the same finding the D-35 review measured for the SQLite
arm, now measured for this adapter leg. **This deletion has no observable
difference at all, on any row, including one that loses the alias.** That is a
stronger statement than the note's, and it retires the note's fourth unverified
claim (§9) and the F2 caveat.

## 3. Verified, hunk by hunk

| hunk | verdict |
| --- | --- |
| `mysql-adapter.ts` `parseResult` | exactly the count/exist arm. `decimalRepresentation`, `decimalListRepresentation`, `parseRelation` and `parseField` (TINYINT booleans, naive UTC datetimes) byte-identical; the member is now byte-identical to the SQLite adapter's, which has been the contract's pass-through all along. |
| `mysql-adapter.ts` import + section header | `parseIntegerBoolean` still imported and still used; `normalizeCountResult` correctly dropped. The header no longer claims a count normalisation the adapter no longer does. |
| `postgres-adapter.ts` `parseResult` + import | exactly the bigint leg. `nativeScalarPassthrough`, `enumListRepresentation`, `parseRelation`, `parseField` byte-identical. Note the deleted leg `return converted` WITHOUT `next` — it could have skipped the decoder entirely; it never did, and now cannot. |
| `result-parsing.ts` | `convertBigIntToNumber`, `normalizeCountResult`, private `extractCountValue`, and the now-unused `isRecord` import deleted. `tryParseJsonString` and `parseIntegerBoolean` untouched. Grep of `src`, `tests` and `scripts`: no code reader of any deleted symbol remains (only comments naming their history). |
| `COUNT_RESULT_KEY` kept | correct — three src readers survive, all over DECODED values or shapes: `result/cache-result-codec.ts:90` (discriminates a compiled count codec by `shape.rawKeys`), `result/result-shape.ts:418,432`, `client/typescript-type-renderer.ts:342`; plus `tests/contracts/engine/query/result-aliases.core.test.ts` and the live mysql2 alias-preservation cell. Its new doc matches what I found. |
| `adapter-result-parser.ts` doc | the `@example` taught a function that no longer exists; the replacement states the seam (one operation's raw, once, D-28), that the member is required, and shows the shape all three adapters now install. Type unchanged. |
| `query.ts:632-646` doc | comment only, `+8 −8`, line-count neutral, entirely inside the doc block. `biome check` on the file: the SAME diagnostic set at base and at head (15 by my count, same five rules, same counts) — compared by checking copies of both versions, no `--write`. |
| `result-parsing.core.test.ts` | the 12 cells of the two deleted helpers removed with them; the two surviving helper describes and the `COUNT_RESULT_KEY` cell byte-identical; a header saying where each moved fact is now pinned. See O-3. |
| `internals-and-geo.core.test.ts` | the two adapter cells re-expressed over the SAME inputs (`5n`, `[{"COUNT(*)":2}]`, `{"COUNT(*)":1}`) plus the raw each provider really answers. The eight `parseField` boolean/datetime assertions and the SQLite cell's assertions are byte-identical. |
| `parity-decoding.core.test.ts` | pure addition (10 → 12). `ScriptedDriver` gains an optional adapter parameter with the old default, so the ten existing cells are unaffected; the new `counted` model is provider-limit-free. The twelve assertions carry the two helpers' facts to the owner, over the raw measured live, including two refusals with the public class. The author's F1 receipt is genuine: renaming the decoder's alias reddens both new cells AND D-35's (3 failed / 9 passed). |
| `CHANGELOG.md` | right file (`RELEASING.md:76`, no changeset mechanism), right section, D-35's wording discipline: no sentence claims a behavior difference, which is what my counterfactual confirms there is none of. See O-2 on one supporting clause. |

Nothing else changed: no `.skip`, `.only` or `todo(` added anywhere in the diff;
no guide or README names a deleted leg (`AGENTS.md`, `src/adapters/AGENTS.md`,
`src/query-engine/AGENTS.md`, `src/query-engine/raptor3/AGENTS.md`,
`src/adapters/README.md`, and every `.md` outside the evidence tree: no hits);
neither helper is on the public surface (`./adapters` exports the three adapter
classes and `DatabaseAdapter` only; no `exports` path reaches
`adapters/shared/result-parsing`), which is what makes the author's Q3 choice
defensible.

## 4. Observations (none blocking; each with its exact minimal resolution)

- **O-1 — "all 20 asks" is 10 asks on MySQL.** `mysql-adapter.ts:1029-1032` and
  `internals-and-geo.core.test.ts:483-484` say the leg was "measured answering
  `undefined` for all 20 asks". The helper was consulted on the 10 `count`/`exist`
  asks and answered `undefined` each time; on the other 10 the arm was never
  entered, which is exactly what the note's own table says. The conclusion is
  right, the count is loose. *Resolution (one clause):* "…deciding nothing on all
  20 asks — the `count`/`exist` arm was entered on 10 of them and answered
  `undefined` every time". The PostgreSQL comment's "40 asks, 40 `undefined`" is
  accurate as written: that helper was asked on every ask.
- **O-2 — one changelog clause is measured on one transport.** The MySQL bullet
  justifies "answers are unchanged" with "and MySQL preserves that alias", a fact
  measured on `mysql2` only (PlanetScale carries the same `MySQLAdapter` and was
  not probed), while the PostgreSQL bullet names its two measured transports. §2
  shows the claim does not need that clause: a row that LOSES the alias was
  refused before the deletion exactly as it is after. *Resolution (choose one):*
  name the transport ("and `mysql2` preserves that alias"), or replace the clause
  with the stronger measured fact ("and a count carried under any other column
  was refused before this deletion exactly as it is after it").
- **O-3 — 26 cells became 14 + 2.** The 12 cells of the deleted helpers could not
  survive the functions they call; the brief ordered both the deletion and the
  re-expression, and no fact about SHIPPED behavior lost coverage (I checked each
  row of the author's table against both files). It is still a cell-count drop
  that a later reader could mistake for weakening; the note's §4 table is the
  record that it is not. This is the author's Q4 and Arnaud's to settle.
- **O-4 — `provider-postgres` has no recorded baseline.** I ran it anyway for the
  record: 18 failed / 310 passed / 7 skipped, and the 18 are exactly the shared
  pre-existing families of the recorded `pg` red set (10 GeoPoint behavior, 4
  GeoPoint spatial-index planning, 4 enum references — the PostGIS-less
  container), with nothing count- or exist-related.
  `review-receipts/provider-postgres.log`, `review-postgresjs-red.txt`. That is
  corroboration, not a byte comparison; establishing a real baseline would mean
  reverting the diff, which the brief forbids.

## 5. Questions for Arnaud (not decided here)

The author's four stand as written (§9 of `note.md`): **Q1** whether the
`parseResult` seam itself should now go from both contracts, since after D-35 and
D-40 no shipped driver and no shipped adapter decides anything at the result
boundary; **Q2** whether the three byte-identical pass-throughs should become one
shared constant; **Q3** whether the changelog should name the two deleted
helpers; **Q4** whether losing the 12 helper cells was the intended trade. I add
one:

- **Q5 — the premise line in each new parity cell.** Each of the two new cells
  opens by asserting the adapter's `parseResult` is the pass-through, a fact
  `internals-and-geo.core.test.ts` already owns — the very duplication the note's
  §10 alternative 4 rejects. It reads as a premise that makes the cell
  self-contained, and it is one line; keep it, or drop both lines and let the
  cells assert only the decoder's answers?

## 6. My runs (serial, one file / project / mode per call, `TMPDIR` exported)

| run | result | receipt |
| --- | --- | --- |
| live leg probe, `pg` (both routes, 7 operations) | 20 asks, leg decides nothing, answers identical with the leg reinstalled | `review-probe-pg.log` |
| live leg probe, `mysql2` (both routes, 7 operations) | 20 asks, leg decides nothing, answers identical with the leg reinstalled | `review-probe-mysql.log` |
| counterfactual, both adapters, 7 row shapes | identical answer, class and message, WITH-LEG and NO-LEG, 7/7 | `counterfactual.log` |
| `adapters/result-parsing.core.test.ts` + `adapters/internals-and-geo.core.test.ts` (`layer-adapters`) | 14/14 and 20/20 | `adapters-contracts.log` |
| `engine/query/parity-decoding.core.test.ts` (`layer-query-engine`) | 12/12 | `parity-decoding.log` |
| `raptor3/g4/parity/driver-result-parser.test.ts` (`extended-local`) | 5/5 | `driver-result-parser-pin.log` |
| `provider-pg` (whole project) | 25 failed / 426 passed / 7 skipped — red set BYTE-IDENTICAL to `verification/rulings-pg-red.txt`: **0 regressions, 0 newly green** | `provider-pg.log`, `review-pg-red.txt` |
| `provider-mysql2` (whole project) | 165 failed / 575 passed / 1 skipped — red set BYTE-IDENTICAL to `verification/rulings-mysql-red.txt`: **0 regressions, 0 newly green** | `provider-mysql2.log`, `review-mysql-red.txt` |
| `provider-postgres` (whole project, no baseline exists) | 18 failed / 310 passed / 7 skipped, all in the recorded pre-existing families | `provider-postgres.log`, `review-postgresjs-red.txt` |
| `run-raptor3.mjs g2-pg-contracts` | 18/18, 6 files, gate verified | `mode-g2-pg-contracts.log` |
| `run-raptor3.mjs g2-mysql-contracts` | 13/13, 4 files, gate verified | `mode-g2-mysql-contracts.log` |
| `node scripts/run-typecheck.mjs` | **exit 0, zero diagnostics**, 7.10 s, 5029.6 MiB peak | `typecheck.log` |
| `npx biome check` on the 7 touched source/test files | clean, no fixes applied | — |
| `npx biome check` on `query.ts`, base vs head | identical diagnostic set, same rules, same counts | — |
| `node scripts/query-engine-structure.mjs` | `files 38, lines 18685, tokenLines 15472` — identical to the author's `structure.json` and to D-35's post-state | `structure.json` |
| LOC recount (`git diff 383f830c -- src`) | physical **+54 −127 = −73**; code-bearing **+6 −63 = −57** — the note's numbers exactly | — |

I never ran two commands at once, never met a lock refusal and never removed a
lock. The author's own receipts were audited too: re-extracting the red sets from
`receipts/provider-pg.log` and `receipts/provider-mysql2.log` with the recorded
extraction reproduces `rulings-pg-red.txt` and `rulings-mysql-red.txt` byte for
byte, and `receipts/falsified-alias-rename.log` shows the three expected reds.
The failed receipts are genuinely failed and correctly labelled
(`leg-probe-postgresjs.log` is a fixture assertion, the two `provider-pglite-reads`
logs are the 1536 MiB ceiling refusal).

## 7. Still red / unverified after this review

- Nothing this ruling caused, on either provider, on my own runs.
- `provider-postgres` has no recorded baseline (O-4); PlanetScale, PGlite,
  neon-http and bun-sql carry one of the two adapters and have no live transport
  here. For them the claim rests on §1's mechanism — the leg is handed a row
  array by its one call site and no shipped driver can alter that — plus, for
  MySQL, §2's measurement that the alias-losing case was already refused.
- D-35's one pre-existing unrelated red
  (`tests/contracts/architecture/contract-matrix.core.test.ts` naming
  `tests/raptor3/candidate-handoff.test.ts`) was not re-measured here either; it
  is untouched by this diff, which adds no unregistered test file.
