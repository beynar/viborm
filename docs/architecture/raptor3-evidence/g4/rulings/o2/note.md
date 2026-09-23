# D-40 — the adapter-level `parseResult` legs, measured live and deleted

Author: Fable. Worktree `/private/tmp/viborm-o2`, branch `o2` from `383f830c0`.
`TMPDIR=/private/tmp/viborm-o2-tmp` exported for every run. Nothing committed,
staged, reset, stashed or pushed. Receipts in `receipts/`.

## 1. The decision-elimination gate (written before the first production edit)

**Required behavior.** `count`, `exist`, `aggregate`, `findMany`, `findUnique`,
`create` and `update` must answer on PostgreSQL and MySQL exactly what they
answer today, on the live route and on the prepared `$transaction([…])` route,
and ONE authority must own what a count and an exists answer mean.

**Current owners — measured, not assumed.** Three are written down; one answers.

| owner | where | what it claims |
| --- | --- | --- |
| the engine's decoder | `raptor3/shared/query.ts:2955` asks for the alias `_count`, `:2970-2973` reads `rows[0]?._count` back, and `:4410-4427` (the `int` codec) turns a bigint or an integer text into a number, refusing anything else and anything outside the safe range | the count/exist answer |
| the MySQL adapter leg | `mysql-adapter.ts:1029-1042`: for `count`/`exist`, `normalizeCountResult(raw)` — recognises a single-column row keyed `0viborm_count_result` or `count(…)` and rewrites it to `0viborm_count_result` | "which column carries a count" |
| the PostgreSQL adapter leg | `postgres-adapter.ts:656-668`: `convertBigIntToNumber(raw)` over the whole raw result, returned WITHOUT calling `next` when it fires | "a COUNT comes back as a bigint and must become a number" |

**The measurement (§2).** A recorder above each SHIPPED leg on live Docker
PostgreSQL (both the `pg` and the `postgres.js` transports) and live Docker
MySQL, over seven operations × two routes: **60 asks, and the leg decides
`undefined` in all 60**. Both legs are REACHED once per operation (D-28's
consumer) and INERT: each calls `next()` with no argument and returns what
`next` answered, so the value the decoder sees is the value the provider sent.

The reason is one fact per leg, and neither is about the provider:

- MySQL: this engine names the count column `_count` and mysql2 preserves the
  alias, so the raw is `[{_count: 2}]` — which `normalizeCountResult` is written
  not to recognise (a bare `count` is a legal model scalar). It never fires.
- PostgreSQL: `Queries.decodeResult(raw: Input[], …)` hands the leg the
  operation's ROW ARRAY, and `convertBigIntToNumber` answers only for a
  `bigint`. An array is never a bigint, so the leg cannot fire whatever the
  provider answers. Measured beside it: `pg` and `postgres.js` answer
  `COUNT(*)` as the STRING `"2"`, not as a bigint at all, and the public answer
  is the number `2` — so the conversion the leg claims is already done, one
  level down, by the `int` codec, per VALUE, with a refusal the helper has not.

**Smallest proposed change.** Delete both legs whole. `AdapterResultParser.parseResult`
is a REQUIRED member of a public contract (`adapter-result-parser.ts:116`), so
each adapter keeps the member in the contract's shape — `(_raw, _operation, next) => next()`,
byte-identical to the SQLite adapter's, which has been that pass-through all
along. Their two helpers then have no reader left in `src/` and go with them
(`normalizeCountResult`, its private `extractCountValue`, `convertBigIntToNumber`).
`COUNT_RESULT_KEY` is NOT deleted: three readers survive, all over decoded
values (`result/cache-result-codec.ts:90`, `result/result-shape.ts:418,432`,
`client/typescript-type-renderer.ts:342`), and the mysql2 driver's live
alias-preservation cell names it.

**The decisions that disappear.**

| | |
| --- | --- |
| mechanism | two second owners of a scalar meaning: a column-name sniffer deciding "which column carries a count", and a bigint→number conversion applied to a row array |
| consumers | `Queries.decodeResult` (`shared/query.ts:657`) — the ONLY caller of any adapter `parseResult` in `src/` — now finds a pass-through on all three adapters |
| replacing invariant | the engine asks for `_count` and reads `_count`, so the alias it chose is the only authority on where a count lives; and the `int` codec (`query.ts:4410`) owns bigint/integer-text → number for every value, including a count, with the safe-range refusal |
| falsifier | the two new parity cells over the MEASURED live raw, per provider, each reddening when the decoder's own alias is renamed in a scratch copy of `query.ts`; plus the adapter contract cells, `driver-result-parser.test.ts`, `provider-pg`, `provider-mysql2`, the `g2-pg-contracts` and `g2-mysql-contracts` modes and the whole-estate typecheck |

**What is NOT decided here.** `DatabaseAdapter["result"]["parseResult"]` stays a
public contract with its D-28 consumer and its once-per-operation guarantee;
only the two implementations' decisions go. After this ruling no shipped adapter
and no shipped driver decides anything at the result boundary — an observation
recorded for Arnaud in §8, not acted on.

## 2. The measurement (live, before any deletion)

A recorder above each SHIPPED leg, recording per ask: the raw's shape, the raw,
what the leg's own helper decides about it (`normalizeCountResult(raw)` on
MySQL, `convertBigIntToNumber(raw)` on PostgreSQL — asked exactly as the leg
asks it), whether `next` was called and with what, and whether the leg returned
`next`'s answer or its own. Probe sources kept as `receipts/leg-probe-*.txt`;
the three files were removed from the tree once the receipts were taken
(`git status` is nine modified files plus this ruling directory).

| transport | receipt | asks | operations × routes |
| --- | --- | --- | --- |
| `pg` on Docker PostgreSQL `:55729` | `receipts/leg-probe-pg.log` | 20 | 7 × 2 |
| `postgres.js` on the same server | `receipts/leg-probe-postgresjs-2.log` | 20 | 7 × 2 |
| `mysql2` on Docker MySQL `:55730` | `receipts/leg-probe-mysql.log` | 20 | 7 × 2 |

`receipts/leg-probe-postgresjs.log` is a FAILED first attempt, kept as it
failed: the probe asserted `syncLiveSchema().applied === true`, which is false
when a previous probe run already left the table in place. The probe was changed
to reset the table instead; nothing about the leg was measured differently.

### Leg × route × operation

Both routes are the public ones: `live` is the direct call, `prepared` is
`client.$transaction([…])`. "asked" is the `parseResult` member being called;
"decides" is what its own helper answers; "read by" is who consumes that
decision.

| leg | operation | live | prepared | asked | decides | read by |
| --- | --- | --- | --- | --- | --- | --- |
| MySQL `normalizeCountResult` | `count` (plain, filtered, `select:{_all}`) | 3 asks | 3 asks | yes | `undefined` ×6 | nobody |
| MySQL | `exist` (true, false) | 2 | 2 | yes | `undefined` ×4 | nobody |
| MySQL | `aggregate` | 1 | 1 | yes, arm not entered | — | nobody |
| MySQL | `findMany` | 1 | 1 | yes, arm not entered | — | nobody |
| MySQL | `findUnique` | 1 | 1 | yes, arm not entered | — | nobody |
| MySQL | `create` | 1 | 1 | yes, arm not entered | — | nobody |
| MySQL | `update` | 1 | 1 | yes, arm not entered | — | nobody |
| PostgreSQL `convertBigIntToNumber` | every one of the seven, on `pg` AND on `postgres.js` | 10+10 | 10+10 | yes, for every verb | `undefined` ×40 | nobody |

In all 60 asks the leg called `next()` with NO argument and returned exactly
what `next` answered (`nextCalls=1 next=next() returnedNextAnswer=true` on every
line of every receipt). The value the decoder saw is the value the provider
sent, before the deletion as after it.

### What the provider actually answers, and who turns it into the public value

| | raw at the leg | public answer |
| --- | --- | --- |
| `pg` / `postgres.js` | `[{"_count":"2"}]` — integer TEXT, not a bigint | `2` |
| `mysql2` | `[{"_count":2}]` | `2` |
| both, `count({select:{_all:true}})` | `[{"_all":…}]` | `{_all: 2}` |
| both, `exist` | `[{"_count":1}]` / `[{"_count":0}]` | `true` / `false` |

The conversion is the `int` codec's, one level down and per VALUE
(`query.ts:4410-4427`): bigint → `Number`, integer text → `Number`, anything
else refused, and an unsafe integer refused. That is `convertBigIntToNumber`'s
whole meaning, already owned, with a refusal the helper never had (rule 11).

### Classification

| leg | classification | why |
| --- | --- | --- |
| MySQL count/exist arm | **reached and inert** | asked on every `count`/`exist`, decides `undefined` every time: the engine names the column `_count`, and `normalizeCountResult` recognises only `0viborm_count_result` or `count(…)` — deliberately not a bare `count`, which is a legal model scalar |
| PostgreSQL bigint conversion | **reached and inert, and unreachable by construction** | `Queries.decodeResult(raw: Input[], …)` hands it the operation's ROW ARRAY; an array is never a `bigint`, whatever the provider answers, so no transport can make this leg fire |

Neither is a "live leg" under the ruling's test — neither decides anything, so
neither has a consumer to name.

## 3. The hunks

| # | file | hunk | what |
| --- | --- | --- | --- |
| 1 | `src/adapters/databases/mysql/mysql-adapter.ts` | `result.parseResult` | the count/exists arm deleted whole; the member stays in the contract's shape, `(_raw, _operation, next) => next()`. `parseField` (TINYINT booleans, naive UTC datetimes) and `decimalListRepresentation` are byte-identical |
| 2 | same, import + section header | `normalizeCountResult` dropped from the import (`parseIntegerBoolean` stays); the RESULT PARSING header said "normalize counts, booleans, and naive UTC datetimes" and now says what this adapter owns (row VALUES) and why it says nothing about a RESULT |
| 3 | `src/adapters/databases/postgres/postgres-adapter.ts` | `result.parseResult` | the bigint conversion deleted whole; same contract shape. The import of `convertBigIntToNumber` goes; `nativeScalarPassthrough`, `enumListRepresentation`, `parseRelation` and `parseField` are byte-identical. The comment states the measurement and names the codec that owns an integer's width |
| 4 | `src/adapters/shared/result-parsing.ts` | `convertBigIntToNumber`, `normalizeCountResult`, `extractCountValue` deleted; the `isRecord` import goes with them | no reader remains in `src/` (grep in §7). `COUNT_RESULT_KEY` stays and its doc now names its three real readers, all over DECODED values |
| 5 | `src/adapters/adapter-result-parser.ts` | the `parseResult` contract doc | its `@example` taught `normalizeCountResult`, which no longer exists. It now states what the seam is (one operation's raw, once, D-28), that the member is required, that a result's meaning is the decoder's and a value's is `parseField`'s, and shows the pass-through every shipped adapter installs |
| 6 | `src/query-engine/raptor3/shared/query.ts` | `decodeResult`'s doc | comment only, line-count neutral. It named the two deleted legs as the live adapter examples ("PostgreSQL answers a COUNT as a bigint, MySQL recovers a count whose alias its transport did not preserve"); it now says neither provider leg says anything, and names D-35 and D-40 together |
| 7 | `tests/contracts/adapters/result-parsing.core.test.ts` | the two describes of the deleted helpers removed; the file header says where each fact they pinned is now pinned | §4 |
| 8 | `tests/contracts/adapters/internals-and-geo.core.test.ts` | the PostgreSQL and MySQL adapter result cells re-expressed over the SAME inputs | §4 |
| 9 | `tests/contracts/engine/query/parity-decoding.core.test.ts` | `ScriptedDriver` takes its adapter; a provider-limit-free `counted` model; two new cells, one per provider | §4 |
| 10 | `CHANGELOG.md` `## Unreleased` | three bullets | §5 |

The guides are NOT touched. `src/query-engine/raptor3/AGENTS.md` mentions
`parseResult` twice: line 848 states the CHAIN (driver → adapter → decoder,
once per operation), which is unchanged, and line 1126 is about the client's raw
seam. Neither names a leg (checked by grep for `normalizeCountResult`,
`convertBigIntToNumber`, "normalize count", "count column" across
`AGENTS.md`, `src/adapters/AGENTS.md`, `src/query-engine/AGENTS.md`,
`src/query-engine/raptor3/AGENTS.md`, `src/adapters/README.md`: no hits).

## 4. Per-cell re-expression

Measured first, with a grep of the whole test estate for `parseResult`,
`normalizeCountResult`, `convertBigIntToNumber` and `COUNT_RESULT_KEY`. Nothing
was deleted, weakened or skipped: every fact below is pinned after this ruling,
and the two legs' own facts are pinned over the raw MEASURED live.

| cell | pinned before | pins now |
| --- | --- | --- |
| `adapters/result-parsing.core.test.ts` — `describe("tryParseJsonString")` (7), `describe("parseIntegerBoolean")` (6) | the two surviving shared helpers | unchanged, byte for byte, green |
| `adapters/result-parsing.core.test.ts` — `describe("COUNT_RESULT_KEY")` (1) | the constant's value | unchanged. The key keeps three readers (`cache-result-codec.ts:90`, `result-shape.ts:418,432`, `typescript-type-renderer.ts:342`) and a live provider cell (`providers/docker/mysql2.test.ts:112`, alias preservation), so it is not deleted |
| `adapters/result-parsing.core.test.ts` — `describe("convertBigIntToNumber")` (2 cells) | the HELPER: `5n`/`0n`/`BigInt(100)` → numbers; a number, a string and `null` fall through | the helper is gone with its last caller. The fact is the `int` codec's and is pinned in `parity-decoding` (row below): a bigint `_count` answers `2`, an integer TEXT `_count` answers `2`, and — stronger than the fall-through — an unsafe integer is REFUSED with the public class |
| `adapters/result-parsing.core.test.ts` — `describe("normalizeCountResult")` (10 cells) | the HELPER: which column it recognises (`COUNT(*)`, `count(*)`, `COUNT(DISTINCT id)`, the private key, a bare object, bigint carriage) and what it refuses (`count`, a model scalar, multi-key rows, empty/garbage) | the helper is gone with its last caller. "Which column carries a count" is the decoder's, and is pinned in `parity-decoding` (rows below): the answer comes from the alias the engine asked for, and BOTH keys this helper dealt in — the `COUNT(*)` it recognised and the `0viborm_count_result` it produced — fail closed with the public class, which is what they did before the deletion too |
| `adapters/internals-and-geo.core.test.ts` — "PostgreSQL converts top-level bigint and otherwise passes through" | `parseResult(5n, "count", next)` → `5`; a number, a relation and a field pass through | renamed "PostgreSQL passes every result through". SAME inputs: `5n` now passes through, and a row array `[{_count:"5"}]` — the shape the seam is actually handed, which the old cell never used — passes through too. `parseRelation`/`parseField` assertions unchanged |
| `adapters/internals-and-geo.core.test.ts` — "MySQL normalizes counts, booleans, and naive UTC datetimes" | `parseResult([{ "COUNT(*)": 2 }], "count")` → `[{0viborm_count_result: 2}]`, the same on `exist`, and pass-through for a non-count row and a non-count verb | renamed "MySQL normalizes booleans and naive UTC datetimes, and passes results through". SAME inputs, now passing through, PLUS `[{_count: 2}]` — the raw mysql2 actually answers. The eight `parseField` boolean/datetime assertions are byte-identical |
| `adapters/internals-and-geo.core.test.ts` — "SQLite publishes physical promises and otherwise passes through" | the SQLite adapter's pass-through | unchanged; one comment added saying it is now the shape all three adapters share |
| `engine/query/parity-decoding.core.test.ts` — the three "fails closed" cells and the two D-17 seam cells | unchanged | unchanged, green |
| `engine/query/parity-decoding.core.test.ts` — the D-35 cell | the SQLite family's count/exists answers with no driver result hook | assertions unchanged, green. One comment adjusted: it named `normalizeCountResult` in the present tense, and that helper is now deleted |
| `engine/query/parity-decoding.core.test.ts` — NEW "PostgreSQL answers the count and the exists from the decoder alone" | — | the leg is the contract's pass-through, and over the raw MEASURED on `pg`/`postgres.js` (`[{_count:"2"}]`, `"1"`, `"0"`) the answers are `2`, `true`, `false`; a bigint carrier answers `2` and `2n**70n` is refused with the public class |
| `engine/query/parity-decoding.core.test.ts` — NEW "MySQL answers them from the decoder alone, and only under its own alias" | — | the same for the raw MEASURED on mysql2 (`[{_count:2}]`, `1`, `0`), plus: `[{"COUNT(*)":2}]` and `[{"0viborm_count_result":2}]` both fail closed with the public class |
| `raptor3/g4/parity/driver-result-parser.test.ts` (D-28, 5 cells) | the middleware is asked once per operation, both routes, above the row-value chain, `next(transformed)` honoured, chunked terminal once | unchanged and green (5/5): the pin installs its OWN `result` on an `ObservingDriver` over a SQLite adapter, so neither deleted leg is in its path |
| `providers/docker/mysql2.test.ts:112` "preserves every private result alias exactly" | the mysql2 driver preserves nine private aliases including `COUNT_RESULT_KEY` | unchanged and green (in the 575 passing cells of the provider run) |

## 5. The release note

`CHANGELOG.md` has an `## Unreleased` section (`RELEASING.md:76`; no changeset
mechanism), and the entry is added there, one bullet per provider whose leg is
deleted plus one for the contract:

> - The MySQL adapter no longer normalizes `count`/`exist` results in its
>   adapter-level `parseResult`. The query engine's decoder owns the meaning of
>   a count and an exists answer — it asks for its own `_count` alias and reads
>   it back, and MySQL preserves that alias — so those answers are unchanged, on
>   the live route and inside `$transaction([…])`.
> - The PostgreSQL adapter no longer converts a bigint in its adapter-level
>   `parseResult`. That leg was offered the operation's row array rather than a
>   value, and an integer's width is owned by the query engine's own scalar
>   codec, which turns a bigint or an integer text into a number and refuses one
>   outside the safe integer range. Count answers are unchanged on both the `pg`
>   and the `postgres.js` transport.
> - `DatabaseAdapter["result"]["parseResult"]` is untouched: it remains a
>   required member, still asked once per operation with the provider's raw
>   result, and on all three shipped adapters it is now the pass-through the
>   SQLite adapter has always installed.

Every sentence is measured (§2) and none claims a difference: **this deletion
has no observable difference at all**, on either provider, on either route, for
any of the seven operations — that is the D-35 review's lesson (R-1) applied
before the fact rather than after it. An earlier draft of the entry also named
the two deleted helpers; they are not on the public surface (`src/adapters/index.ts`
exports the three adapter classes and `DatabaseAdapter` only, and the package
`exports` map has no path that reaches `adapters/shared/result-parsing`), so
naming them in a user-facing changelog would state a change no user can observe.
They are recorded here instead. That choice is a question for Arnaud (§9, Q3).

## 6. The four §7 questions, against the diff

1. **Necessary decision or representation repair?** Repair, twice. One fact —
   "where a count lives" — had two representations (the engine's `_count` alias
   and MySQL's column sniffing); one fact — "how wide an integer is" — had two
   (the `int` codec and PostgreSQL's `convertBigIntToNumber`). Both duplicates
   are removed rather than synchronised, and neither was reachable.
2. **Exact deletion and replacement obligation?** Removed decisions: the MySQL
   adapter's count/exists normalisation and the PostgreSQL adapter's bigint
   conversion. Mechanisms: `normalizeCountResult` + `extractCountValue`'s column
   sniffing, and `convertBigIntToNumber` over a row array. Consumer of both:
   `Queries.decodeResult` (`shared/query.ts:657`), the only caller of any
   adapter `parseResult` in `src/`. Replacing invariants: the alias the engine
   asked for is the only authority on where a count lives, and the `int` codec
   is the only authority on an integer's width. Falsifier: §7's F1/F2. No
   equivalent mechanism moved elsewhere — nothing was copied into the engine,
   and `COUNT_RESULT_KEY`'s three surviving readers are all over decoded values
   and predate this ruling.
3. **One rule across uses?** One owner answers for both providers, both routes
   and all seven operations (§2's 60 asks), and the two new parity cells state
   it per provider over the raw each one actually answers. After D-35 and D-40
   the result boundary has exactly one owner on every shipped provider: no
   driver and no adapter decides anything there.
4. **What actually grew?** Nothing. Production shrank by 73 physical lines and
   by 57 code-bearing lines (§8). The charged query-engine census is unchanged
   (`receipts/structure.json`: `files 38, lines 18685, tokenLines 15472`,
   identical to D-35's post-state) — the only charged file touched is `query.ts`
   and its diff is entirely inside one doc comment, line-count neutral. Tests
   grew by 87 lines, counted separately. No new semantic rule anywhere.

## 7. Falsification record

| # | mutation | expected | measured | receipt |
| --- | --- | --- | --- | --- |
| F0 | none — both SHIPPED legs observed on live Docker PostgreSQL (`pg` and `postgres.js`) and MySQL before any deletion | each leg decides `undefined` for every real operation | 60 asks recorded across 7 operations × 2 routes × 3 transports; `normalizeCountResult` `undefined` on all 10 count/exist asks, `convertBigIntToNumber` `undefined` on all 40; `next()` with no argument and the leg returning `next`'s answer on all 60; answers `2`, `1`, `{_all:2}`, `true`, `false`, `{_sum:{rank:8}}`, 2 rows, id 1, id 3, rank 9 — the same on both routes | `receipts/leg-probe-pg.log`, `leg-probe-postgresjs-2.log`, `leg-probe-mysql.log`; sources `receipts/leg-probe-*.txt` |
| F1 | the decoder's own alias renamed `_count` → `_countFALSIFIED` in a scratch copy of `query.ts`, at all three places that ask for it, shape it and read it back | BOTH new cells redden — otherwise they would be measuring the adapter, not the decoder | RED, both: `promise rejected "QueryEngineError: Driver "scripted" returned a malformed int scalar…" instead of resolving`, at the PostgreSQL cell's `[{_count:"2"}]` count and at the MySQL cell's `[{_count:2}]` count. D-35's own cell reddened with them (3 failed / 9 passed), which is the same fact one ruling earlier | `receipts/falsified-alias-rename.log` |
| F2 | the two keys the deleted MySQL helper dealt in, as rows the decoder is asked to read — `[{"COUNT(*)":2}]` (what it RECOGNISED) and `[{"0viborm_count_result":2}]` (what it PRODUCED) | both fail closed with the public class, and did so before the deletion too | RED-by-design inside the MySQL cell, green as a refusal: both reject with `QueryEngineError`. This is measured on the AFTER state; the claim that it held BEFORE is the mechanism, not a second measurement: the produced key has no reader in any raw-row path (`COUNT_RESULT_KEY`'s three readers are all over decoded values), so the helper rewrote a key the decoder cannot read into another key the decoder cannot read — the same finding the D-35 review measured empirically for the SQLite arm (`d35/review-receipts/counterfactual-alias-row.log`) | `receipts/parity-decoding-restored.log` (12/12) |

The F1 mutation was restored from a copy taken before the edit
(`…/scratchpad/query.ts.bak`, never `git checkout`), verified byte-identical
(`cmp`), and the file re-run green: `receipts/parity-decoding-restored.log`,
12/12. The only writes outside the worktree in this session are that backup copy
and the two biome diagnostic listings under `/private/tmp/viborm-o2-tmp`.

## 8. Verification

`TMPDIR=/private/tmp/viborm-o2-tmp` exported for every run; one file, one
project or one registered mode per call; never two at once; no lock refusal was
met and no lock was removed. Receipts in `receipts/`.

| run | result | receipt |
| --- | --- | --- |
| `adapters/result-parsing.core.test.ts` (`layer-adapters`) | 14/14 (was 26 cells; the 12 that pinned the two deleted helpers are re-expressed per §4) | `result-parsing.log` |
| `adapters/internals-and-geo.core.test.ts` (`layer-adapters`) | 20/20 | `internals-and-geo.log` |
| `engine/query/parity-decoding.core.test.ts` (`layer-query-engine`) | **12/12** (was 10, +2) | `parity-decoding-final.log`; `parity-decoding-restored.log` is the same 12/12 immediately after the F1 mutation was undone |
| `raptor3/g4/parity/driver-result-parser.test.ts` (D-28 pin, `extended-local`) | 5/5 | `driver-result-parser-pin.log` |
| `provider-pg` (whole project) | 25 failed, 426 passed, 7 skipped, 4 files — **red set byte-identical to `verification/rulings-pg-red.txt`: 0 regressions, 0 newly green** | `provider-pg.log`, extracted set `o2-pg-red.txt` |
| `provider-mysql2` (whole project) | 165 failed, 575 passed, 1 skipped, 8 files — **red set byte-identical to `verification/rulings-mysql-red.txt`: 0 regressions, 0 newly green** | `provider-mysql2.log`, extracted set `o2-mysql-red.txt` |
| `run-raptor3.mjs g2-pg-contracts` | 18/18, 6 files, gate verified | `mode-g2-pg-contracts.log` |
| `run-raptor3.mjs g2-mysql-contracts` | 13/13, 4 files, gate verified | `mode-g2-mysql-contracts.log` |
| whole-estate typecheck (final) | **0 diagnostics, exit 0**, 6.23 s, 4985.6 MiB peak | `typecheck-final-2.log`. Four runs are kept in order: `typecheck-1.log` caught one TS2345 of mine (a `"postgres"` literal where the `Dialect` is `"postgresql"`), `typecheck-2.log` was the first clean one, `typecheck-final.log` ran after the falsification was undone, and `typecheck-final-2.log` is the one taken on the FINAL bytes — the by-hand formatting fix below landed after `typecheck-final.log`, so both it and `parity-decoding-final.log` were re-taken rather than claimed |
| `npx biome check` on the seven touched source/test files | clean, 0 diagnostics. One formatting diagnostic of mine was fixed BY HAND (no `--write`): an arrow-chain wrap in the new parity helper | — |
| `npx biome check src/query-engine/raptor3/shared/query.ts` | **identical 16-entry diagnostic set at the base and at head** (compared by swapping in `383f830c`'s file and restoring from the backup copy), all pre-existing, none inside the edited comment. No `--write` was run: that file's import order is load-bearing | — |
| `node scripts/query-engine-structure.mjs` | charged census unchanged: `files 38, lines 18685, tokenLines 15472` | `structure.json` |

The red-set comparison used the same extraction the recorded files were made
with, validated by reproducing both recorded files byte-for-byte from the
recorded logs before comparing:
`grep -E '^[[:space:]]+× ' <log> | sed -E 's/^[[:space:]]*× //; s/ [0-9]+ms$//' | sort -u`.

## 9. LOC, still red, unverified, questions for Arnaud, blockers

**LOC** (`git diff --numstat 383f830c -- src tests`):

```
 14   9  src/adapters/adapter-result-parser.ts
 12  17  src/adapters/databases/mysql/mysql-adapter.ts
 13  11  src/adapters/databases/postgres/postgres-adapter.ts
  7  82  src/adapters/shared/result-parsing.ts
  8   8  src/query-engine/raptor3/shared/query.ts
 27   9  tests/contracts/adapters/internals-and-geo.core.test.ts
 17  74  tests/contracts/adapters/result-parsing.core.test.ts
131   5  tests/contracts/engine/query/parity-decoding.core.test.ts
```

src **+54 −127, net −73**; code-bearing production lines (comments and blanks
excluded) **+6 −63, net −57**; comments net −8. Tests +175 −88, net +87.
`CHANGELOG.md` +15, outside the census. The production direction is negative, as
the brief expected.

**Still red.** Nothing this ruling caused. The two provider projects carry
exactly their recorded pre-existing reds (25 pg, 165 mysql), cell for cell. I
did not run `layer-query-engine` whole, so D-35's one pre-existing red
(`contract-matrix.core.test.ts` naming `tests/raptor3/candidate-handoff.test.ts`)
is neither confirmed nor cleared here; it is untouched by this diff.

**Unverified claims.**

- The MySQL leg is measured live on `mysql2` only. PlanetScale carries the same
  `MySQLAdapter` and has no live transport in this environment, so for it the
  claim rests on the mechanism (the engine names `_count`; the helper never
  recognised `_count`) rather than on a measurement.
- Likewise `pglite` and `neon-http` carry the `PostgresAdapter` and were not
  probed. For them the PostgreSQL claim rests on the argument that the leg is
  handed a row ARRAY at its one call site, which no transport can change, and on
  two live PostgreSQL transports agreeing. I TRIED to run the one PGlite file
  with count coverage (`tests/providers/local/pglite-reads.test.ts`, the
  `countAggregateWindowContract` registration) and could not, twice, for a
  harness reason: PGlite needs the estate's own 2560 MiB ceiling
  (`ISOLATED_PGLITE_PROVIDER_RSS_CEILING`), the file peaked at 1654.7 MiB
  against the ordinary 1536, and `run-vitest-safe.mjs` refuses
  `--rss-limit-mb` above 1536 — that ceiling is reachable only through
  `run-credential-free-tests.mjs`'s staged runner, which is an aggregate this
  brief forbids during unit work. Both attempts are kept as they failed
  (`receipts/provider-pglite-reads.log`, `provider-pglite-reads-2.log`).
- `provider-postgres` (postgres.js) was PROBED live but its project was not run:
  no recorded red set exists for it (`verification/RUN.log` covers core,
  provider-local, provider-pg and provider-mysql only), so a run would produce a
  number with nothing to compare it to, and establishing a baseline would mean
  reverting the diff in this worktree, which the brief forbids.
- F2's "and did so before the deletion too" is mechanism plus the D-35 review's
  measurement of the same helper, not a counterfactual I ran myself on MySQL.

**Questions for Arnaud (decisions I did not take).**

- **Q1 — the seam itself.** After D-35 and D-40, NO shipped driver and NO
  shipped adapter decides anything at the result boundary: three identical
  pass-throughs implement a required contract member, and `Queries.decodeResult`
  walks a two-leg chain that can only return its input. Keeping it is what the
  brief ordered and what I did. Deleting `parseResult` from both the adapter and
  the driver contracts — and with it the chain in `decodeResult` — is the next
  ruling if the seam is not owed to out-of-estate adapters. I did not weigh it.
- **Q2 — the SQLite adapter.** Its `parseResult` was already the pass-through,
  so D-40 leaves three byte-identical members in three files. If Q1 keeps the
  seam, one shared `passThroughResult` constant would give that shape one owner;
  that is a change to a file this brief does not name, so I did not make it.
- **Q3 — the release note's scope.** I dropped the sentences naming the two
  deleted helpers, because neither is reachable through the package's `exports`
  map, and a changelog that announces an unobservable removal repeats D-35's
  R-1 failure in the other direction. If you want them named, the whole change
  is one clause per bullet.
- **Q4 — `result-parsing.core.test.ts`'s 12 cells.** The brief ordered the
  helpers deleted and this file's pins re-expressed; a cell cannot survive the
  function it calls, so the 12 cells became two cells at the owner carrying
  twelve assertions over the raw measured live (six per provider: the leg's
  pass-through, the count, both exists answers, and two refusals). That is a net
  loss of cell COUNT and a net gain of facts pinned over real provider answers.
  If you would rather the helper cells had been kept by keeping the helpers,
  this ruling inverts.

**Blockers.** None. No public-contract change was needed beyond the two
deletions the ruling ordered, no legacy fallback, no duplicated interpretation,
and no registered refusal was touched.

## 10. Alternatives rejected

1. **Keep either leg as a live leg.** Rejected on measurement: 60 live asks, 60
   `undefined`. Neither decides anything, so neither has a consumer to name.
2. **Delete the `parseResult` member from the two adapters.** Rejected: it is a
   REQUIRED member of a public contract (`adapter-result-parser.ts:116`), the
   brief says the contract stays, and PGlite's canonical-surface identity
   captures `adapter.result.parseResult` at construction
   (`drivers/pglite/index.ts:101`) — an `undefined` there would make that
   comparison `undefined === undefined` and stop discriminating, which is
   exactly the O-1 hazard D-39 is ruling on for the driver side.
3. **Keep `normalizeCountResult` and `convertBigIntToNumber` so their 12 cells
   could stay.** Rejected: the brief orders unreferenced helpers deleted, and a
   helper kept only to be tested is a second owner with no caller. The facts
   were moved, not dropped (§4).
4. **Re-express the helper cells in place by calling the adapters' `parseResult`
   instead.** Rejected: `internals-and-geo.core.test.ts` already pins each
   adapter's result parser, so that would be a second owner of the same pin —
   patchwork over a cell that already says the true thing.
5. **Put the new cells in a new test file.** Rejected: an unregistered test file
   is what `contract-matrix.core.test.ts` is already red about (D-35 §7), and
   both facts belong in the decoder's own parity file beside D-35's cell.

## 11. Repair round (after the review)

Applied EXACTLY five things: the review's two minor resolutions (O-1, O-2), the
integrator's answer to the review's fifth question (Q5), and Arnaud's two
rulings on my own questions (D-42, D-43). Nothing else was touched. Receipts of
this round are the `receipts/repair-*` files; every run below was taken on the
FINAL bytes, one file, project or mode per call, `TMPDIR=/private/tmp/viborm-o2-tmp`
exported, never two at once, no lock refusal met and no lock removed.

### 11.1 O-1 — the loose "all 20 asks" clause (two sites, one correction)

The review named both places that said the MySQL leg was "measured answering
`undefined` for all 20 asks": the adapter comment and the adapter contract cell.
The helper was consulted on the 10 `count`/`exist` asks only; on the other 10
the arm was never entered. Both now carry the review's clause.

| file | now reads |
| --- | --- |
| `src/adapters/databases/mysql/mysql-adapter.ts` (the `parseResult` comment) | "deciding nothing on all 20 asks D-40 measured over seven operations and both routes on live MySQL - the `count`/`exist` arm was entered on 10 of them and answered `undefined` every time" |
| `tests/contracts/adapters/internals-and-geo.core.test.ts` (the MySQL cell) | "…decided nothing on all 20 live asks — its `count`/`exist` arm was entered on 10 of them and answered `undefined` every time" |

The PostgreSQL comment's "40 asks, 40 `undefined`" is untouched: that helper was
asked on every ask, which the review confirmed is accurate as written.

### 11.2 O-2 — the changelog's MySQL bullet

Of the two resolutions offered I took the STRONGER MEASURED FACT, in the
reviewer's own words. The bullet's middle clause is now:

> …it asks for its own `_count` alias and reads it back, **and a count carried
> under any other column was refused before this deletion exactly as it is
> after it** — so those answers are unchanged, on the live route and inside
> `$transaction([…])`.

Why that one rather than naming `mysql2`: the clause it replaces ("and MySQL
preserves that alias") was measured on one transport, and naming the transport
would have left the sentence true only of the transport probed — PlanetScale
carries the same `MySQLAdapter` and has no live transport here (§9). The
replacement is measured on BOTH states of the code (the review's counterfactual,
`review-receipts/counterfactual.log`: `[{"COUNT(*)":2}]` and
`[{"0viborm_count_result":2}]` rejected identically with and without the leg,
class and message) and it holds for every MySQL transport, because it does not
depend on alias preservation at all. The rest of the entry is unchanged.

### 11.3 Q5 — the premise line in each new parity cell

Dropped, per the integrator. Each of the two new cells opened by asserting the
adapter's `parseResult` is the pass-through — a fact
`internals-and-geo.core.test.ts` already owns, which is the second reader §10's
alternative 4 rejects. Removed with them: the `passthrough` symbol and the
`next` helper the two premise lines alone used. The history they carried (what
each leg used to offer, and why neither could fire) moved into the describe's
doc comment, which now NAMES the owner of the pass-through fact instead of
re-asserting it. The two cells now assert only the decoder's answers over the
raw measured live. Cell titles and every other assertion are unchanged.

### 11.4 D-42 — the seam stays (no contract change)

`AdapterResultParser.parseResult` keeps its signature and stays a REQUIRED
member of the public contract; `DatabaseAdapter["result"]["parseResult"]` is
untouched. The only edit in `src/adapters/adapter-result-parser.ts` is its doc:
it now points at the one constant below it instead of repeating the
pass-through's body in prose and in an `@example`. The changelog's third bullet
already said the member is untouched and still says exactly that. D-43 adds no
bullet: three identical members becoming one object changes no answer and adds
no public symbol (§11.5), and announcing an unobservable internal is the D-35
review's R-1 failure in the other direction (§5).

### 11.5 D-43 — one owner for the three byte-identical members

`passThroughParseResult` is exported from **`src/adapters/adapter-result-parser.ts`**
and referenced by all three shipped adapters:

| file | before | after |
| --- | --- | --- |
| `src/adapters/databases/sqlite/sqlite-adapter.ts` | its own 5-line member | `parseResult: passThroughParseResult` |
| `src/adapters/databases/mysql/mysql-adapter.ts` | its own 5-line member | the same, under the corrected comment of §11.1 |
| `src/adapters/databases/postgres/postgres-adapter.ts` | its own 5-line member | the same, comment unchanged |

**Why that file and not `src/adapters/shared/result-parsing.ts`.** The fact
being given an owner is a fact about the CONTRACT — what the required member is
when a dialect decides nothing about a result — and the contract is declared in
`adapter-result-parser.ts`, whose own doc already stated that shape twice, in
prose and in an `@example`. Putting the value anywhere else would leave the
sentence describing it in one file and the value in another, which is the drift
this round exists to remove, one file later; beside the member, the doc can
`{@link}` it and the two cannot disagree. `shared/result-parsing.ts` is the
module of ROW-VALUE helpers with an `undefined`-means-not-handled sentinel
(`tryParseJsonString`, `parseIntegerBoolean`): the pass-through is neither a
parsing utility nor a sentinel-returning helper, and after D-40 the PostgreSQL
adapter no longer imports that module at all — filing the contract's shape there
would put it back on an import edge it had just lost.

The cost, stated: `adapter-result-parser.ts` was a type-only module (it erased
completely at runtime) and is now a value module holding one 5-line arrow with
no runtime import of its own, so it adds no import edge beyond itself. The
constant is deliberately NOT added to the package's `exports` surface:
`src/adapters/index.ts` exports the three adapter classes and `DatabaseAdapter`,
D-42 keeps the MEMBER public, and no ruling asked for a new public symbol (§11.8).

**The identity is safe where identity is read.** Two shipped drivers compare an
adapter's `parseResult` against the one they captured at construction
(`drivers/sqlite3/index.ts:104,231`, `drivers/pglite/index.ts:101,233`). Each
instance's captured value is now the shared constant, so a caller replacing the
member after construction is still detected; the only newly-undetectable
replacement is installing that same constant, which is what was there. Pinned
green by `consumable-result-proof.core.test.ts` (6/6) and by `provider-sqlite3`
(755 passed, 1 skipped, 0 failed).

### 11.6 The pin (one cell, both halves)

`tests/contracts/engine/query/parity-decoding.core.test.ts`, inside the existing
D-40 describe: **"the three shipped adapters share one pass-through, and a
custom adapter's own is still asked"**.

| half | what it asserts |
| --- | --- |
| D-43 | `new SQLiteAdapter().result.parseResult`, `new MySQLAdapter()`'s and `new PostgresAdapter()`'s each `toBe(passThroughParseResult)` — IDENTITY, not behavior. What each leg DOES stays `internals-and-geo.core.test.ts`'s cell (§11.3's ownership, applied to the new cell too) |
| D-42 | a `CustomAdapter` (the SQLite adapter carrying a `parseResult` of its own) is asked EXACTLY once, with the operation's verb and its own rows (`[{ operation: "count", raw: [{ zz_count: 2 }] }]`), and what it hands `next` is what the decoder reads: it recovers a count from `zz_count`, an alias the engine never asked for, and the public answer is `2` |

Why this file rather than the adapter one: the second half can only be stated
where the decoder runs, and the ruling asked for ONE pin carrying both. The
describe's title still states the shipped estate's choice; the cell's own
comment says that choice is not the seam's nature.

### 11.7 Falsification (this round)

| # | mutation | expected | measured | receipt |
| --- | --- | --- | --- | --- |
| F3a | in a scratch copy of `query.ts`, `decodeResult`'s `adapterDecode` replaced by a direct `decode(input as Input[])` — the adapter seam is no longer asked at all | the new cell reddens | RED, and ONLY it: **1 failed / 12 passed**, `AssertionError: promise rejected "QueryEngineError: Driver "scripted" returned a malformed int scalar for operation "count": the value is absent." instead of resolving`. The other twelve cells stay green — which is the point: before this pin, nothing in the file noticed the adapter seam going unasked | `receipts/repair-falsified-seam-unasked.log` |
| F3b | in a scratch copy of `mysql-adapter.ts`, `parseResult: passThroughParseResult` replaced by a BYTE-IDENTICAL inline member | the identity half reddens while behavior stays green | RED: **1 failed / 12 passed**, `AssertionError: expected [Function parseResult] to be [Function passThroughParseResult] // Object.is equality` | `receipts/repair-falsified-second-copy.log` |

Both mutations were restored from copies taken before the edit
(`…/scratchpad/query.ts.bak`, `mysql-adapter.ts.bak`), verified byte-identical
with `cmp`, never `git checkout`; the file was re-run green immediately after
(`receipts/repair-parity-decoding-restored.log`, 13/13) and again on the final
bytes.

### 11.8 Verification (this round, final bytes)

| run | result | receipt |
| --- | --- | --- |
| `engine/query/parity-decoding.core.test.ts` (`layer-query-engine`) | **13/13** (12 + the new pin) | `repair-parity-decoding-final.log` |
| `adapters/internals-and-geo.core.test.ts` (`layer-adapters`) | 20/20 | `repair-internals-and-geo.log` |
| `adapters/result-parsing.core.test.ts` (`layer-adapters`) | 14/14 | `repair-result-parsing.log` |
| `drivers/consumable-result-proof.core.test.ts` (`layer-drivers`) | 6/6 — the cells that read an adapter's canonical `parseResult` IDENTITY, the one place sharing one object across adapters could have changed an answer | `repair-consumable-result-proof.log` |
| `raptor3/g4/parity/driver-result-parser.test.ts` (`extended-local`) | 5/5 | `repair-driver-result-parser-pin.log` |
| `provider-sqlite3` (whole project — the SQLite adapter changed) | 755 passed, 1 skipped, **0 failed** | `repair-provider-sqlite3.log` |
| `provider-pg` (whole project) | 25 failed / 426 passed / 7 skipped — red set **byte-identical** to `verification/rulings-pg-red.txt`: 0 regressions, 0 newly green | `repair-provider-pg.log`, `repair-pg-red.txt` |
| `provider-mysql2` (whole project) | 165 failed / 575 passed / 1 skipped — red set **byte-identical** to `verification/rulings-mysql-red.txt`: 0 regressions, 0 newly green | `repair-provider-mysql2.log`, `repair-mysql-red.txt` |
| `run-raptor3.mjs g2-pg-contracts` | 18/18, 6 files, gate verified | `repair-mode-g2-pg-contracts.log` |
| `run-raptor3.mjs g2-mysql-contracts` | 13/13, 4 files, gate verified | `repair-mode-g2-mysql-contracts.log` |
| `node scripts/run-typecheck.mjs` | **0 diagnostics, exit 0**, 9.73 s, 4937.3 MiB peak | `repair-typecheck-final.log` (`repair-typecheck.log` is the same, 0/exit 0, taken before the last comment edit) |
| `npx biome check` on the six touched files | clean, 0 diagnostics, no `--write` | — |
| `npx biome check` on all nine changed source/test files | the only 15 errors + 1 info are `query.ts`'s pre-existing set, unchanged: it was restored byte-identical from the F3a backup | — |
| `node scripts/query-engine-structure.mjs` | `diff` against the pre-repair census: **identical** | `repair-structure.json` |

The red-set extraction is the recorded one:
`grep -E '^[[:space:]]+× ' <log> | sed -E 's/^[[:space:]]*× //; s/ [0-9]+ms$//' | sort -u`.

`receipts/repair-provider-local.log` is a FAILED attempt kept as it failed:
`provider-local` is a GROUP of the staged runner, not a vitest project ("No
projects matched the filter"), and the SQLite family's project is
`provider-sqlite3`, which is the run recorded above.

One further failed attempt has NO receipt, and I say so rather than
reconstruct one: the first `g2-pg-contracts` run was launched without
`VIBORM_RAPTOR3_PROVIDER_PORT`, the live-provider world refused it ("Required
live provider loopback port is missing or invalid", 6 suites failed to collect,
no test run), and the retry with the connection string and port exported wrote
over the same receipt path.

### 11.9 LOC, still red, unverified, open questions, blockers

**LOC** (`git diff --numstat 383f830c -- src tests`, after this round):

```
 41   9  src/adapters/adapter-result-parser.ts
 15  20  src/adapters/databases/mysql/mysql-adapter.ts
 13  14  src/adapters/databases/postgres/postgres-adapter.ts
  5   6  src/adapters/databases/sqlite/sqlite-adapter.ts
  7  82  src/adapters/shared/result-parsing.ts
  8   8  src/query-engine/raptor3/shared/query.ts
 29   9  tests/contracts/adapters/internals-and-geo.core.test.ts
 17  74  tests/contracts/adapters/result-parsing.core.test.ts
165   5  tests/contracts/engine/query/parity-decoding.core.test.ts
```

src **+89 −139, net −50** physical (was −73; the round's 23 lines are the
constant's doc block); code-bearing production lines **+18 −75, net −57** —
IDENTICAL to the pre-repair net, because the three 5-line members it deleted pay
for the one constant and its three imports. Tests +211 −88, net +123 (was +87).
`CHANGELOG.md` +16, outside the census. The production direction stays negative.

**Still red.** Nothing this ruling caused. Both provider projects carry exactly
their recorded pre-existing reds, cell for cell; `provider-sqlite3` is fully
green. `layer-query-engine` was not run whole in this round either, so D-35's
one pre-existing red (`contract-matrix.core.test.ts` naming
`tests/raptor3/candidate-handoff.test.ts`) is neither confirmed nor cleared; it
is untouched by this diff, which adds no unregistered test file.

**Unverified claims.** §9's list stands, minus F2's caveat, which the review's
counterfactual measured and retired (§11.2 now rests on that measurement). New
to this round: nothing. PlanetScale, PGlite, neon-http and bun-sql still carry
one of the two adapters with no live transport here; for them the claim rests on
the mechanism and, for MySQL, on the measured refusal the changelog now states.

**Observation recorded, not acted on (out of this round's scope).**
`src/drivers/shared/sqlite-utils.ts:44-48` — D-35's doc on `sqliteResultParser`
still says "Recovering a count from a provider that did NOT preserve the alias
is a dialect fact, stated once at the adapter seam by the provider that needs it
(MySQL)". D-40 deleted that adapter leg, so the sentence names a fact no file
states any more. Comment only, in a file neither this brief nor the review
names; one clause fixes it in the next ruling that owns that file.

**Open questions.** Q1 is answered by D-42 (the seam stays) and Q2 by D-43 (one
owner, §11.5). Q3 (should the changelog name the two deleted helpers?) and Q4
(the 12 helper cells, the review's O-3) are still Arnaud's. One more, from this
round: should `passThroughParseResult` be re-exported on the package's public
surface, so an adapter written outside this estate can satisfy the required
member with the one object instead of writing a fourth copy? D-42 makes the
member public; it does not by itself make the constant reachable, and I did not
add a public symbol no ruling asked for.

**Blockers.** None.
