# Compiled list decoder — work unit 1: frozen behaviour and baseline

Plan: `docs/architecture/raptor3-compiled-list-decoder-plan.md` (candidate tree).
Date 2026-09-25. No production change in this unit.

## Source identities

| | Baseline (read-only) | Candidate |
| --- | --- | --- |
| Tree | `/Users/arnaud/code/viborm-lists-base` | `/Users/arnaud/code/viborm-lists` |
| HEAD | `544ab9465d5b80a3980326f33ebe92d5ae0f1c06` (detached) | `995b5ef15` on `compiled-list-decoder` (= `127240ff9` plan doc + unit-1 pins commit) |
| Working tree | clean | clean after the commit |
| `src/query-engine/raptor3/shared/query.ts` sha256 | `ce56d8365de148c686a409f7afe3fa26180c29e7008bbaa5ed314b9d2213058d` | identical |
| `pnpm-lock.yaml` sha256 | `703a982935c98760e2798fb8397d83a3d937079c94038b085f619b925cc9a598` | identical |
| `dist/**.mjs` digest (harness `identity()`) | `639055d58bf85dbbb0b68ea88c32727a4216b0908f1b02d6b6d8fe789b29d7eb` | identical (built from the same source) |
| Node | v24.21.0 | v24.21.0 |

Both `dist/` trees were built with `node --max-old-space-size=1280 node_modules/tsdown/dist/run.mjs`
(the `package:build` entry without the lock wrapper). `dist/` is gitignored; the
baseline's `git status` stayed clean. Candidate `dist/` must be rebuilt after
unit 2 before any measurement.

## Current list decoding (file:line at `544ab9465`, `src/query-engine/raptor3/shared/query.ts`)

- `decodeProjection` :4740 compiles one reader per decoded batch (`compileReader` :5056)
  and maps the rows; an empty batch compiles nothing.
- A scalar placement (list or not) compiles to `(value) => this.decodeScalar(shape, value, internal, provider)`
  :5062-5063. `provider` is `fieldReader(shape.type)` (:760) for a PHYSICAL slot and
  `undefined` for a carried one (`carried || nested.kind !== "scalar"` :5158; collection
  rows and variant arms compile with `carried = true`, :5199 / :5066).
- `decodeScalar` :5217: SQL NULL (:5236-5243, `"a required list is null"` for a list)
  and absence (:5244, `"the value is absent"`) are answered on the RAW value before the
  chain; then `provider(raw)` once for the whole container (:5249); then
  `if (leaf.list) return this.decodeList(...)` :5250.
- `decodeList` :5460 (per LIST VALUE):
  - decimal: `decodeDecimalList` (`shared/decimal.ts:143` →
    `validation/primitives/decimal-codec.ts:335`), representation
    `adapter.result.decimalListRepresentation ?? "text"`: SQLite/MySQL `"coefficient"`
    (`sqlite-adapter.ts:917`, `mysql-adapter.ts:1049`) require a JSON TEXT container
    (`decimal-codec.ts:572-592`, a JS array is refused); PostgreSQL `"text"` walks an
    array with a counted loop and refuses holes (`decimal-codec.ts:361`). Any failure is
    the one sentence "the value is not an exact decimal list in this column's declared domain".
  - string container: enum + `enumListRepresentation === "arrayText"` (PostgreSQL only,
    `postgres-adapter.ts:717`) → `providerArrayMembers` :5723; everything else →
    `JSON.parse` :5481 (unguarded: a SyntaxError escapes untranslated).
  - non-array → `InvalidScalarResult(leaf.type, "a list scalar did not return an array")` :5482-5486.
  - **per list**: `const member = Object.freeze({ ...leaf, list: undefined, nullable: false })` :5487-5491
    (the construction the plan moves to the batch boundary).
  - `items.map((item, index) => { if (!Object.hasOwn(items as unknown[], index)) throw …sparse…; return this.decodeScalar(member, item, internal); })`
    :5492-5499. Members are CARRIED (no provider argument): they never re-enter the chain.
    `map` skips holes, so the sparse check at :5493-5497 never fires (dead in practice).
- `InvalidScalarResult` → public `QueryEngineError` "Driver "<d>" returned a malformed <type> scalar for operation "<op>": <reason>." at `operation-context.ts:703`.
- Lists never carry an identifier domain: `idDomainOfState` answers `undefined` for
  `state.array === true` (`schema/scalars/string/id-domain.ts:52`), so `leaf.id` is unset
  and members take the ordinary string arm.
- List-capable scalars: string, int, bigint, number, boolean, datetime, date, time, enum,
  decimal. `s.json()` has no `.array()`; `s.blob().array()` throws. "JSON" in the matrix
  below therefore means the JSON list CONTAINER (SQLite/MySQL), not a json-typed list.

## Behaviour matrix (baseline answer → pin)

New pins are in `tests/raptor3/result-decoder-lists.test.ts` (commit `995b5ef15`,
11 tests, sha256/16 `603c5a0baa1636ac`); "L:n" = its line.

| Case | Baseline answer | Pinned by |
| --- | --- | --- |
| Empty list, text `"[]"` and provider `[]`, string/int/enum/decimal/uuid-format | `[]` | L:210; SQLite physical root for all 10 kinds: `g4/read-codecs.test.ts:152` (specimen 3) |
| Populated list from text and from provider array | members decoded by the element codec | L:210 |
| Nullable list SQL NULL | `null`, chain not asked for it | L:250 |
| Required list SQL NULL (string, enum, decimal) | `…malformed <string\|enum\|decimal> scalar…: a required list is null.` before the chain | L:250 |
| Absent list column (required and nullable) | `…: the value is absent.` before the chain | L:250 |
| Container not an array (`'{"a":1}'`, object, `5`, `"5"`, `'"text"'`, `true`) | `…malformed string scalar…: a list scalar did not return an array.` | L:288 |
| List text not JSON (`"[1,"`, `"{LOW}"` on SQLite, `""`) | raw `SyntaxError`, not `QueryEngineError` (parity; same as relation text, `result-decoder.test.ts:967`) | L:288 |
| Member of wrong type (`["ok",42]`) | `…string…: the value is not a string.` | L:313 |
| Null member (`[null]`, and `["x",null]` in a NULLABLE list) | `…string…: a required scalar is null.` (member leaf is `nullable: false`) | L:313 |
| int member `"x"` / `1.5` / `2^53+1n` | `not a canonical integer` / `outside the safe range` / `outside the safe range` | L:313 |
| enum member not declared | `…enum…: the value is not a declared enum member.` | L:313 |
| **Sparse provider list** (driver parser or carried document) | **holes PRESERVED** (length kept, no own index at holes); a present bad member beside a hole is still refused. PARITY, not a refusal; policy question is separate (plan §"Known baseline issue") | L:340 |
| Enum list, PostgreSQL (`arrayText`) | `"{LOW,HIGH}"`, `"{}"`, quoted `'{"HIGH",LOW}'`, provider array → members; `'["LOW"]'` → `enum`/"a list scalar did not return an array"; `"{LOW,NULL}"` → "a required scalar is null"; undeclared → enum refusal | L:390 |
| Non-enum list on PostgreSQL given as text | read as JSON; `"{a}"` → `SyntaxError` | L:390 |
| Enum list, MySQL/SQLite (JSON container) | JSON text or provider array → members; `"{LOW}"` → `SyntaxError` | L:390 |
| Decimal list, SQLite/MySQL (coefficient) | `'["150","-1"]'` → Decimals 1.5/-0.01; `"[]"` → `[]`; provider ARRAY, unscaled text, `[null]`, non-array JSON, bad JSON → one whole-list refusal | L:432 |
| Decimal list, PostgreSQL (text) | `["1.50","-0.01"]` → Decimals; `[]`; `[null]`, over-scale, **hole**, `"{1.00}"`, `"[]"` text → the whole-list refusal (a hole IS refused here) | L:432 |
| Decimal list chain / freshness | one ask `["decimal", <container>]` per list, never per member; fresh array and fresh `Decimal`s per read | L:432; also `g4/read-codecs.test.ts:165` |
| Identifier-format list (`s.string().uuid().array()`) | members publish the stored spelling (upper-case kept), no identifier codec | L:210, L:666 |
| Physical list: chain | asked ONCE per list with the ELEMENT type and the whole container (`["string",'["a","b"]']`, `["int","[1,2]"]`, `["enum",'["LOW"]']`); members never asked | L:490; counts also in `result-decoder-placements.test.ts:410` |
| Carried list (to-many row, variant arm) | never asked; a carried list held as TEXT is JSON-parsed by the list reader (parity) | L:490; to-one/reversed/recursive/aggregate carried in `result-decoder-placements.test.ts:438` |
| Fresh result identity | a frozen shared provider array → a fresh, unfrozen array per row and per read; same for a carried frozen array | L:581 |
| Root / to-many / variant / RETURNING (create, update `push`) / borrowed interactive tx, real SQLite | lists as written, incl. empty and uuid-format | L:666; string/decimal/DateTime lists at RETURNING, series, packaged, borrowed, cache: `result-decoder-placements.test.ts:632`, `:722`, `:791` |
| Driver `parseResult` middleware handing JS arrays | read like any container; fresh per row | L:720 |
| Concurrent clients with different parsers | each execution's own chain | `result-decoder-placements.test.ts:823` (lists in its SCALARS) |
| Native PostgreSQL arrays / enum arrays / decimal TEXT[] and MySQL JSON lists on real servers | NOT pinned in unit 1 (unit 3 per the plan); PGlite round-trip of every list kind incl. enum arrays exists in `tests/contracts/public-client/all-field-types.test.ts:557` | — |

Falsification (temporary edits to a scratch copy-restored `query.ts`, sha verified
unchanged afterwards): `Array.from` instead of `map` (visits holes) fails only L:340;
returning the provider's `items` fails only L:581; `nullable: leaf.nullable` on the
member fails only L:313.

## Harness

- Recovered `benchmarks/scalar-list-poc.mjs` from `54791a327` (sha256 of the original
  `f4b1108b2b3df0e6…`) to `scratchpad/lists/scalar-list-poc.orig.mjs`; working copy
  `scratchpad/lists/scalar-list-poc.mjs` (sha256 `97993d4ce5c1a8cd…`).
- Changes: defaults `--base /Users/arnaud/code/viborm-lists-base`,
  `--candidate /Users/arnaud/code/viborm-lists`; rows 1/20/1000 (PoC: 1/1000; 20-row
  budgets 2000 parse / 600 full iterations, 60 warm-ups); a STORAGE anchor: raw
  `SELECT` of all 1000 stored rows compared with the written values serialized exactly
  as the INSERT did, plus a per-member re-derivation of the generator formula (so the
  expected rows are anchored to what SQLite holds, not to any decoder's output); the
  prepared statement's digest must match inside each A/B pair; load average in metadata.
- Retained PoC checks per worker: parse-only and full answers `deepStrictEqual` to the
  expected rows before and after measuring; `["valid",42]` refused; sparse `new Array(2)`
  preserved (parity).
- Fixture: SQLite in-memory, 1000 rows × (id text, title, boolean, int, string list,
  int list), each list of length 0/4/32; reads `findMany({orderBy:{id:"asc"}, take:N})`.
  `parse` stage = `capability.parseResult(frozen raw)`; `full` = public client.
- Commands:
  `node scalar-list-poc.mjs --rounds 8 --out base-time.jsonl` then
  `node scalar-list-poc.mjs --rounds 4 --heap --out base-heap.jsonl`
  (cwd `scratchpad/lists/`). Raw: `base-time.jsonl` (sha256 `8c529d3fbedf…`),
  `base-heap.jsonl` (`48c2ffcdf874…`).

## Baseline measurement

The candidate side at this point is the UNCHANGED source (identical `dist` digest),
so each run is an **A/A calibration**: the baseline values, plus the noise band a
unit-4 paired ratio must beat. Load average 5.0–7.0 (other desktop activity).
Every pair had identical semantic and statement digests; every worker verified storage.

### Time (8 alternating fresh-process rounds; µs per operation, medians)

| Stage | Rows | Len | Base CPU | Base wall | A/A CPU paired [min–max] | A/A wall paired [min–max] | Base CPU spread |
|---|---|---|---:|---:|---|---|---:|
| parse | 1 | 0 | 2.89 | 0.93 | 1.025 [0.918–1.073] | 1.014 [0.932–1.063] | 8.0% |
| parse | 1 | 4 | 3.24 | 1.12 | 1.007 [0.986–1.036] | 1.019 [0.943–1.063] | 6.9% |
| parse | 1 | 32 | 4.11 | 2.56 | 1.011 [0.948–1.027] | 1.021 [0.948–1.032] | 4.5% |
| parse | 20 | 0 | 14.84 | 7.80 | 1.004 [0.955–1.058] | 0.991 [0.956–1.023] | 9.4% |
| parse | 20 | 4 | 19.95 | 12.96 | 0.991 [0.948–1.026] | 1.003 [0.926–1.016] | 12.2% |
| parse | 20 | 32 | 55.64 | 48.93 | 1.009 [0.973–1.062] | 1.008 [0.968–1.071] | 7.7% |
| parse | 1000 | 0 | 358.28 | 297.94 | 0.976 [0.823–1.038] | 0.981 [0.817–1.025] | 28.7% |
| parse | 1000 | 4 | 715.25 | 645.41 | 0.988 [0.934–1.025] | 0.989 [0.943–1.013] | 6.9% |
| parse | 1000 | 32 | 2119.19 | 2021.10 | 1.008 [0.907–1.022] | 1.009 [0.864–1.023] | 15.5% |
| full | 1 | 0 | 42.94 | 27.15 | 0.994 [0.939–1.011] | 0.989 [0.934–1.017] | 18.3% |
| full | 1 | 4 | 42.60 | 27.53 | 1.000 [0.951–1.061] | 0.991 [0.769–1.069] | 19.9% |
| full | 1 | 32 | 45.96 | 29.45 | 0.996 [0.952–1.058] | 0.980 [0.965–1.070] | 5.5% |
| full | 20 | 0 | 95.75 | 49.66 | 1.003 [0.779–1.056] | 1.009 [0.817–1.076] | 26.8% |
| full | 20 | 4 | 96.06 | 54.08 | 1.014 [0.976–1.050] | 1.029 [0.960–1.082] | 9.1% |
| full | 20 | 32 | 136.86 | 95.37 | 0.999 [0.984–1.026] | 0.997 [0.980–1.013] | 7.0% |
| full | 1000 | 0 | 878.07 | 687.06 | 0.994 [0.941–1.112] | 1.007 [0.929–1.122] | 10.3% |
| full | 1000 | 4 | 1278.76 | 1108.52 | 0.987 [0.955–1.027] | 0.983 [0.950–1.017] | 7.6% |
| full | 1000 | 32 | 2808.99 | 2595.99 | 1.002 [0.767–1.035] | 1.001 [0.714–1.034] | 32.0% |

A/A paired medians fall within 0.976–1.025; single rounds range 0.71–1.12. A unit-4
claim should rest on paired medians clearly outside ±2.5% and on the per-round
distribution, not a median alone. The parse-1 cells time ~60 ms windows (PoC budget
kept for comparability) and are the noisiest relative to their size.

### Heap growth (4 rounds, 8 forced-GC samples per worker, `--max-semi-space-size=64`; bytes/op medians)

Transient heap-growth proxy, not retained memory. `gcInWindow` was 0 in every sample.

| Stage | Rows | Len | Base | A/A other side | A/A ratio | Base spread |
|---|---|---|---:|---:|---:|---:|
| parse | 1 | 0 | 10,704 | 10,640 | 0.994 | 0.6% |
| parse | 1 | 4 | 10,928 | 10,928 | 1.000 | 0.0% |
| parse | 1 | 32 | 12,496 | 12,496 | 1.000 | 0.5% |
| parse | 20 | 0 | 41,496 | 41,496 | 1.000 | 0.0% |
| parse | 20 | 4 | 47,320 | 47,288 | 0.999 | 0.0% |
| parse | 20 | 32 | 80,376 | 80,376 | 1.000 | 0.0% |
| parse | 1000 | 0 | 1,055,460 | 1,057,800 | 1.002 | 0.2% |
| parse | 1000 | 4 | 1,470,624 | 1,470,624 | 1.000 | 0.0% |
| parse | 1000 | 32 | 3,021,490 | 3,028,842 | 1.002 | 1.4% |
| full | 1 | 0 | 40,340 | 40,340 | 1.000 | 0.1% |
| full | 1 | 4 | 40,676 | 40,676 | 1.000 | 0.1% |
| full | 1 | 32 | 42,200 | 42,304 | 1.002 | 0.5% |
| full | 20 | 0 | 84,092 | 83,896 | 0.998 | 0.5% |
| full | 20 | 4 | 90,852 | 90,564 | 0.999 | 0.4% |
| full | 20 | 32 | 132,764 | 132,812 | 1.000 | 0.3% |
| full | 1000 | 0 | 1,763,900 | 1,763,436 | 1.000 | 0.0% |
| full | 1000 | 4 | 2,247,400 | 2,247,400 | 1.000 | 0.0% |
| full | 1000 | 32 | 4,319,498 | 4,317,636 | 1.000 | 0.2% |

Reproduction check against the PoC report's baseline (full, 1000 rows): 0 → 1,763,900
vs 1,769,244 (−0.3%); 4 → 2,247,400 vs 2,247,400 (exact); 32 → 4,319,498 vs 4,316,792 (+0.06%).
The heap proxy is stable to well under 1% A/A, so a unit-4 heap delta of a few KB at
1000 rows is resolvable; a one-row delta of 240–492 B (the PoC's) is ~1% of 40 KB and
also resolvable.

## Gates run in unit 1 (candidate, tests-only change)

- `raptor3` project: `result-decoder.test.ts` 26/26, `result-decoder-placements.test.ts`
  11/11, `result-decoder-lists.test.ts` 11/11, `g4/read-codecs.test.ts` 12/12.
- `layer-query-engine`: `gate-inventory-census` 2/2, `core-taxonomy-census` 4/4.
- `node --test scripts/raptor3-campaign-receipts.test.mjs` 41/41; `scripts/raptor3-cli.test.mjs` 10/10.
- Biome (`--max-diagnostics=500`) clean on both touched files; `tsc` (typescript-native,
  full project) clean.
- Not run: lock-taking scripts (`test:types`, `test:package`, `test:core`), provider
  projects, native containers — not required by unit 1.
