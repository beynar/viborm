# Raptor 3 compiled result decoder: report

Plan: [`raptor3-compiled-decoder-plan.md`](raptor3-compiled-decoder-plan.md).
Decision: **accepted**. There is one decoder and one provider-chain owner. The
1,000-row flat read shows a material CPU and allocation win. The small-read
cost is reproducible and sits at the plan's 5% review trigger: +4.7% CPU for
a nested one-row read in the full run, +5.7% in a later re-run of the same
source. The review accepted that cost as a documented trade-off
([Accepted trade-off](#accepted-trade-off)).

**Complete cost against `main` `e836bbd15`**, at `6f6fdd92b` with the
integrity-entry repair: `shared/query.ts` is the only production code file.

- It grows by **+75 printed SLOC, +428 TypeScript tokens and +7,285 source
  bytes**.
- The `pg-representative` client bundle grows by **+660 B raw, +216 B gzip
  and +487 B brotli**.
- At the reviewed head `8119393bd`, the figures were +71 / +404 / +6,905 and
  +558 / +194 / +416 B.
- The +34 and +37 quoted earlier were partial: +34 is the CD-04 candidate
  `ad30855e6` alone, and +37 is the post-review follow-ups alone.

See [Complete change against main](#complete-change-against-main).

## Source identity

| | Baseline | Candidate |
| --- | --- | --- |
| Commit | `e836bbd15` | `ad30855e6` |
| `dist/**.mjs` digest | `4899a274e8908298` | `7c6347aa3ebd92c5` |
| `shared/query.ts` sha256/16 | `88df750542027a47` | `a1d4b4d8cbe0753c` |
| `pnpm-lock.yaml` sha256/16 | `703a982935c98760` | `703a982935c98760` |

Both trees were clean and ran on Node v24.21.0. The measurements below are
of that candidate. The post-review commits change production source again;
[Post-review follow-ups](#post-review-follow-ups) gives their identity, cost
and re-measured cells.

## The decoder

All of the decoder lives in `src/query-engine/raptor3/shared/query.ts`
(line numbers at `eaada04aa`):

- **`compileReader` (:5055)** is the one visitor over the prepared
  `ProjectionShape`. It runs once per decoded batch, from `decodeProjection`
  (:4739). A collection, and each arm of a junction-carried variant slot, is
  read by `compileCollection` (:5189).
  - It takes each placement's invariant decisions before the first row: the
    member list, carried or physical placement, variant arms, row readers and
    recursive identity readers, and the physical slot's provider continuation.
  - It returns a reader that only does per-value work.
- **Shared rules.** Every reader goes through the same owners:
  - one scalar decoder, `decodeScalar` (:5211);
  - one document rule, `providerJson` (:456), `providerDocument` (:470) and
    `own` (:481);
  - one carrier validator, `decodeRecursiveCarrier` (:4750), which now takes
    the compiled row and identity readers.
- **One provider continuation.** `fieldReader` (:759) runs the driver, then
  the adapter, then translates errors. It is bound once per physical scalar
  slot. A carried value gets none.
- **Lifetime.** A reader holds the execution's driver parser. It is never
  stored on a shared shape or on `Queries`, and an empty batch compiles
  nothing (:4746).

Each new concept, and the decision it deletes:

| New | Deleted |
| --- | --- |
| `compileReader` | The per-value `shape.kind` dispatch.<br>Per-row `Object.keys(shape.fields)` and `Object.entries(shape.arms)`.<br>The per-member carried-status derivation.<br>`decodeValue` itself. |
| `fieldReader` | `providerValue` and the provider chain it rebuilt for every physical cell (3 closures per cell). |
| `providerDocument` | Five inline object checks: the document, the recursive carrier, a node entry, an edge entry and the variant slot's integrity entry. |
| `providerJson` | Five spellings of `typeof v === "string" ? JSON.parse(v) : v`: three in the shape walk, and the vector and point codecs'. |
| `CollectionShape` / `compileCollection` | The `rows as unknown[]` assertion on a junction-carried slot's arm, and the per-arm, per-row `shape.many` test. |
| `decodeScalar(..., provider?)` | The `carried` boolean. A carried slot with a continuation can no longer be written. |
| Empty-batch return | Compiling readers for a batch with no rows. |

## CD-04 repairs

Both repairs were found by this harness.

- **`e8517eb8b`** A `readIdentity.entries()` loop in the carrier made a
  1,000-root recursive read grow the heap 11.6% more than the baseline. A
  counted `for...of` makes it 4.4% less.
- **`ad30855e6`** An empty batch no longer compiles readers. The 0-row cells
  had cost 4–5% CPU and about 8 KB before. `fieldReader` now uses one closure
  per slot instead of two.

## Compatibility

CD-01 raised three baseline answers that were compatibility choices, not
stated contracts. Arnaud ruled on them on 2026-09-25.

| Choice | Ruling | Answer now |
| --- | --- | --- |
| A NULL or non-object **variant slot** | Changed: the slot follows the one document rule. | The malformed-result `QueryEngineError` at the slot: `polymorphic slot`, "the slot is not an object". A NULL slot used to escape as the raw `TypeError` of `Object.hasOwn`, and any other non-object was refused at its first arm, in that arm's sentence. A **public error-surface change**, recorded in `CHANGELOG.md` (Unreleased). The slot's integrity entry is read by the same rule: absent means no membership, and a present entry that is not an object (NULL, an array, a number, a string) is refused at the slot, "the integrity entry is not an object" (see below). |
| A NULL **aggregate carrier** | Kept. | Published as `null`: the carrier's shape states no nullability. |
| An empty-array **singular variant arm** | Kept. | The orphan refusal "references a missing … record": the empty array is read as the empty document the claimed-but-gone arm lowers to. |

`tests/raptor3/result-decoder.test.ts` pins the first two, beside the
root-row and relation-text answers the baseline also gives, and
`tests/raptor3/result-decoder-placements.test.ts` pins the third.

**The integrity entry, repaired after review.** `4cbf77aa0` read the
junction-carried slot's integrity entry through `providerDocument` and
treated its `undefined` as absent. An array is no document, so malformed
present evidence such as `[5]` was read as "no membership" and the read
published `subject: []`. The baseline had iterated the array's entries and
thrown the orphan refusal. The slot now refuses present evidence that is not
an object, with the same `InvalidScalarResult("polymorphic slot", …)` it
raises two lines above for the slot itself: both are a malformed provider
document at the same slot, and the operation owns the public sentence.
`Driver "<driver>" returned a malformed polymorphic slot scalar for operation
"<operation>": the integrity entry is not an object.` An absent entry still
means no membership, and a well-formed positive count is still the orphan
`QueryEngineError`. The witness in `result-decoder.test.ts` covers `[5]`, `5`,
`"text"`, `"[5]"` and NULL, the absent entry and a positive count. It fails
on the pre-repair source (`[5]` resolves). The statements VibORM issues always
build the entry as a JSON document, so only a driver or middleware that
rewrites results can observe this.

## Production cost

This section measures the CD-04 candidate `ad30855e6` only. The complete
change is in [Complete change against main](#complete-change-against-main).

`git diff e836bbd15 ad30855e6 -- src` touches one file,
`src/query-engine/raptor3/shared/query.ts`: 228 lines added and 136 deleted.
The table includes the code that moved.

| Measure | Baseline | Candidate | Delta |
| --- | ---: | ---: | ---: |
| Printed SLOC (TypeScript printer, comments removed) | 3,168 | 3,202 | +34 |
| TypeScript tokens | 28,937 | 29,116 | +179 |
| Source bytes | 211,778 | 216,579 | +4,801 |
| `measure-bundle` code lines, `src/query-engine` | 16,879 | 16,899 | +20 |
| `pg-representative` bundle raw / gzip / brotli | 543,413 / 159,362 / 134,984 | 543,602 / 159,466 / 135,341 | +189 / +104 / +357 |
| `full` bundle raw / gzip / brotli | 911,373 / 265,291 / 218,979 | 911,562 / 265,363 / 219,239 | +189 / +72 / +260 |

Most of the byte growth is comments. The net code grows: the per-batch
visitor is slightly larger than the per-row walk it replaces. There is no
deletion to claim beyond the rows above.

## Performance

### How it was measured

The harness is `benchmarks/result-decoder.mjs`:

```
node benchmarks/result-decoder.mjs --base <tree> --candidate <tree> \
  --rounds 10 --allocation-rounds 4 --cold-rounds 12 --drizzle
```

- **Fresh processes.** Every value comes from a fresh child process. The two
  trees alternate within each round (A then B, then B then A).
- **Fixture.** In-memory SQLite with identical DDL and rows.
- **Shapes:**
  - `flat` reads posts: six scalars, including a boolean and an integer.
  - `nested` adds a to-one author and two comments.
  - `variant` reads a polymorphic to-one.
  - `recursive` reads `kids: { recurse: { depth: 2 } }` with 2 children and
    2 grandchildren per root.
- **Row counts** are root rows. `rows = 0` runs the statement with nothing to
  decode.
- **Ratios.** The paired ratio is the median of the per-round
  candidate/baseline ratios. The bracket gives the minimum and maximum.
- **Noise.** Load average was 4–6 from other applications. Alternation and
  pairing absorb the drift.

**Every cell executes one statement in both trees.** In every cell, the two
trees return byte-identical public results (digests include key order,
`bigint`, `Date` and bytes). Drizzle's flat results equal VibORM's.

### Wall and CPU per operation

Values are medians in ms per operation. Paired ratios are candidate/baseline.

| Shape | Rows | CPU base | CPU cand. | CPU paired | Wall base | Wall cand. | Wall paired | Drizzle CPU |
| --- | ---: | ---: | ---: | --- | ---: | ---: | --- | ---: |
| flat | 0 | 0.0363 | 0.0362 | 0.999 [0.958–1.031] | 0.0247 | 0.0247 | 0.999 [0.976–1.027] | 0.0324 |
| flat | 1 | 0.0348 | 0.0350 | 1.009 [0.974–1.046] | 0.0242 | 0.0243 | 1.008 [0.982–1.036] | 0.0306 |
| flat | 20 | 0.0555 | 0.0561 | 1.006 [0.969–1.027] | 0.0371 | 0.0360 | 0.970 [0.926–0.986] | 0.0482 |
| **flat** | **1000** | **0.6189** | **0.5291** | **0.854 [0.816–0.865]** | **0.5623** | **0.4800** | **0.850 [0.814–0.863]** | 0.4222 |
| nested | 0 | 0.0855 | 0.0862 | 1.013 [0.990–1.034] | 0.0634 | 0.0638 | 1.008 [0.986–1.029] | – |
| nested | 1 | 0.0907 | 0.0944 | **1.047 [1.025–1.060]** | 0.0679 | 0.0694 | 1.023 [1.002–1.044] | – |
| nested | 20 | 0.1847 | 0.1847 | 0.995 [0.978–1.033] | 0.1383 | 0.1356 | 0.970 [0.958–1.017] | – |
| nested | 1000 | 3.7097 | 3.5454 | 0.957 [0.939–0.983] | 3.5228 | 3.3059 | 0.940 [0.920–0.961] | – |
| variant | 0 | 0.0936 | 0.0925 | 0.999 [0.961–1.037] | 0.0689 | 0.0687 | 0.997 [0.972–1.022] | – |
| variant | 1 | 0.0952 | 0.0973 | 1.025 [0.992–1.247] | 0.0712 | 0.0718 | 1.012 [0.983–1.335] | – |
| variant | 20 | 0.1556 | 0.1598 | 1.033 [0.995–1.051] | 0.1114 | 0.1081 | 0.975 [0.949–1.019] | – |
| variant | 1000 | 2.0139 | 1.9703 | 0.973 [0.937–1.012] | 1.8392 | 1.7326 | 0.937 [0.896–0.971] | – |
| recursive | 0 | 0.1641 | 0.1645 | 1.001 [0.942–1.017] | 0.1284 | 0.1291 | 1.005 [0.943–1.012] | – |
| recursive | 1 | 0.2553 | 0.2563 | 1.004 [0.981–1.040] | 0.2098 | 0.2094 | 1.000 [0.971–1.032] | – |
| recursive | 20 | 0.8624 | 0.8598 | 0.990 [0.969–1.017] | 0.7286 | 0.7234 | 0.990 [0.972–1.021] | – |
| recursive | 1000 | 25.724 | 25.755 | 0.999 [0.989–1.022] | 25.071 | 24.901 | 0.986 [0.970–1.005] | – |

Run spread, (max − min) / median per side, was 2–8% for every cell except
variant/1 on the candidate (21% CPU, 30% wall; one outlier round).

**Cold first operation** comes from a fresh process and a fresh client, with
the schema pushed and rows seeded by raw SQL beforehand. Over 40 rounds at 20
rows, first-operation CPU and wall paired ratios were within ±2.3% of the
baseline for every shape:

| Shape | CPU paired | Wall paired |
| --- | --- | --- |
| flat | 1.008 | 1.023 |
| nested | 1.002 | 1.009 |
| variant | 0.970 | 0.991 |
| recursive | 1.022 | 1.011 |

Per-round spread was 16–46%. The compiler's setup is not visible at cold
start.

### Allocation

This is a **heap-growth proxy**, not an allocation profile, retained memory
or RSS. Each sample is the growth in `heapUsed` across one operation. The
process runs with a 64 MB semi-space, and a forced full GC runs before each
sample. `gcInWindow` was 0 in every run.

Values are median bytes per operation.

| Shape | Rows | Base | Candidate | Ratio | Drizzle |
| --- | ---: | ---: | ---: | ---: | ---: |
| flat | 0 / 1 / 20 | 58,912 / 57,032 / 116,008 | 58,856 / 59,616 / 91,176 | 0.999 / **1.045** / 0.786 | 62,360 / 58,328 / 103,900 |
| **flat** | **1000** | **2,143,940** | **1,201,028** | **0.560** | 2,485,104 |
| nested | 0 / 1 / 20 / 1000 | 107,968 / 109,760 / 217,104 / 4,245,272 | 107,912 / 114,992 / 176,808 / 2,588,598 | 0.999 / **1.048** / 0.814 / 0.609 | – |
| variant | 0 / 1 / 20 / 1000 | 107,640 / 109,944 / 169,224 / 2,534,744 | 107,584 / 115,472 / 147,472 / 1,501,532 | 0.999 / **1.050** / 0.871 / 0.603 | – |
| recursive | 0 / 1 / 20 / 1000 | 142,256 / 165,560 / 507,114 / 16,450,914 | 145,840 / 162,436 / 491,668 / 15,735,554 | 1.026 / 0.992 / 0.970 / 0.956 | – |

### PostgreSQL and MySQL

`--provider pg` and `--provider mysql` ran against the docker PostgreSQL
(5434) and MySQL 8 (3307), each in a scratch database the harness created and
dropped. Across all 16 cells (4 shapes × 0/1/20/1,000 rows):

- the baseline and the candidate issue **1 statement** per operation;
- they return **identical result digests**, which are also identical to
  SQLite's.

No wall time is reported or inferred for these providers.

## Acceptance

- **Behaviour gates.** CD-03 qualified the decoder, and those gates were
  green on `93cf6c2e9`. After the two CD-04 repairs:
  - Typecheck passes.
  - Both result-decoder files pass.
  - All of `recursive-query/` passes on SQLite and PGlite.
  - `g4/parity` passes, driver-result-parser included.
  - `layer-query-engine` (739) and `layer-write-engine` (50, dead-symbol gate)
    pass.
  - The native PostgreSQL and MySQL recursive and read-envelope suites pass
    (see [Native qualification](#native-qualification)).
- **1,000-row flat.** CPU is −14.6% and wall −15.0% (paired). Heap growth is
  −44%. Every round showed a win.
- **Structural 1,000-row reads:**
  - nested: CPU −4.3%, wall −6.0%, heap −39%;
  - variant: CPU −2.7%, wall −6.3%, heap −40%;
  - recursive: time neutral, heap −4.4%. SQLite evaluates the recursive CTE
    per row, and that dominates the time.
- **Small reads.**
  - 0-row, 20-row and cold cells are neutral.
  - The per-batch compilation is a fixed cost that a one-row read cannot
    recover:
    - nested/1 costs +4.7% CPU (paired, every round above +2.5%) and +2.3%
      wall;
    - variant/1 costs +2.5% CPU;
    - one-row heap growth rises 4.5–5% (2.6–5.5 KB).
  - This is reproducible and sits at the plan's 5% review trigger. The
    review weighed it and accepted it
    ([Accepted trade-off](#accepted-trade-off)).
- **Authority.** There is one decoder: no flat path, no second scalar switch
  and no second provider chain.

## Post-review follow-ups

After the reviews, the rulings above and the reviewers' minor findings changed
production source again:

- `4cbf77aa0` reads the variant slot, and its integrity entry, by
  `providerDocument` (the ruling).
- `4e6d10862` removes the `rows as unknown[]` assertion. A `many: true`
  variants node now carries `CollectionShape` arms, built by
  `collectionShape`, and `compileCollection` answers `unknown[]` by type. No
  runtime guard was added.
- `adb4f5064` makes the vector and point codecs call `providerJson`.
- `adfb0ebb5` adds the missing witness for "an edge is not reachable at its
  recorded depth".
- `eaada04aa` adds the ruling to the Raptor 3 guide. The sweep found no
  stale per-row decoder sentence there.

**The two perf commits, re-reviewed.** `e8517eb8b` and `ad30855e6` add no
assertion, no second decoder and no cache on a shared shape or on `Queries`.
`fieldReader` still reads the driver's parser once, when the slot is
compiled. The 0-row return keeps the empty-batch semantics:

- it sits inside `decodeProjection`, so `decodeQuery`'s `assertExpectedRows`
  still runs first;
- `rows.map` over an empty batch returned a fresh `[]`, and so does the
  return;
- compiling a reader has no side effect.

Existing tests already reach both 0-row paths, so none was added:

- a write RETURNING with 0 rows: "carries the shipped meta for a missing
  root delete on a batch-only driver"
  (`g4/unit02/phase2-envelope-and-arithmetic`), and the selected
  `deleteMany` of `g4/parity/batch-captured-bulk`;
- a batched `flushQueued` window with 0 rows:
  `g4/parity/series-member-premise` and
  `g4/parity/blind-premise-attribution`.

This was confirmed by instrumenting the return during one run, then
reverting it.

**Identity.** Commit `eaada04aa`; `dist/**.mjs` `6195c0c84c3dad09`;
`shared/query.ts` `68b8da1c683c7276`; same lockfile and Node.

**Cost.** Measured with the method of [Production cost](#production-cost).
The bundle is measured in
[Complete change against main](#complete-change-against-main).

| `shared/query.ts` | `ad30855e6` | `eaada04aa` | Follow-ups alone | Complete, against `e836bbd15` |
| --- | ---: | ---: | ---: | ---: |
| Printed SLOC | 3,202 | 3,239 | +37 | +71 |
| TypeScript tokens | 29,116 | 29,341 | +225 | +404 |
| Source bytes | 216,579 | 218,683 | +2,104 | +6,905 |

Most of the growth is the typed collection arm: one reader per variant
cardinality, and the builder's two arm records.

**Re-measured cells.** These are the same harness and baseline (`e836bbd15`),
with 8 time rounds and 4 allocation rounds. The load average was about 6 for
the first run and 10.7 for the second.

| Cell | Metric | Before (`1dfe39dbf`) | After (`eaada04aa`) |
| --- | --- | --- | --- |
| flat / 1,000 | CPU paired | 0.850 [0.770–0.859] | 0.833 [0.801–0.910] |
| flat / 1,000 | Wall paired | 0.843 [0.738–0.854] | 0.827 [0.740–0.917] |
| flat / 1,000 | Heap, candidate bytes | 1,201,652 (0.545) | 1,200,654 (0.559) |
| nested / 1 | CPU paired | 1.057 [1.012–1.211] | 1.037 [0.993–1.088] |
| nested / 1 | Wall paired | 1.033 [0.989–1.256] | 1.005 [0.954–1.055] |
| nested / 1 | Heap, candidate bytes | 114,992 (1.048) | 115,000 (1.048) |

- The follow-ups did not move either cell materially. The candidate's heap
  growth is unchanged to within 1 KB.
- The nested/1 CPU cost is noisy. It was +4.7% in the full run and +5.7% in
  the re-run of the unchanged source, so it sits at the 5% review trigger.

Both runs returned identical public results in both trees.

**Census.** One more site, 206 in all, now also 78 inherited sites. The new
"polymorphic slot" refusal matches the old-engine corpus, and the candidate
count is unchanged at 36. The integrity-entry repair adds a second
"polymorphic slot" site: 207 in all, 79 inherited, and still 36 candidate
sentences. No new candidate sentence appears.

## Complete change against main

`git diff e836bbd15 6f6fdd92b -- src` touches two files:

- `shared/query.ts`: 310 lines added and 151 deleted. This is the only
  production code.
- the Raptor 3 guide, `src/query-engine/raptor3/AGENTS.md`: 45 added and 22
  deleted, all prose.

The method is the one in [Production cost](#production-cost):

- **Printed SLOC** counts the non-blank lines of the TypeScript printer's
  output, with comments removed.
- **Tokens** counts the leaf nodes of the parsed tree.
- **Bundle** comes from `scripts/measure-bundle.mjs` on each revision's own
  `dist/`, built at that revision with the same lockfile and esbuild. The
  baseline figures come from the read-only baseline tree.

| Measure | `e836bbd15` | `8119393bd` (reviewed) | `6f6fdd92b` (repair) | Complete delta |
| --- | ---: | ---: | ---: | ---: |
| Printed SLOC | 3,168 | 3,239 (+71) | 3,243 | **+75** |
| TypeScript tokens | 28,937 | 29,341 (+404) | 29,365 | **+428** |
| Source bytes | 211,778 | 218,683 (+6,905) | 219,063 | **+7,285** |
| `measure-bundle` code lines, `src/query-engine` | 16,879 | 16,947 (+68) | 16,951 | +72 |
| `pg-representative` raw / gzip / brotli | 543,413 / 159,362 / 134,984 | 543,971 / 159,556 / 135,400 (+558 / +194 / +416) | 544,073 / 159,578 / 135,471 | **+660 / +216 / +487** |
| `full` raw / gzip / brotli | 911,373 / 265,291 / 218,979 | 911,931 / 265,486 / 219,299 (+558 / +195 / +320) | 912,033 / 265,503 / 219,441 | +660 / +212 / +462 |

The integrity-entry repair costs +4 SLOC, +24 tokens, +380 bytes and +102 B
of raw bundle.

## Accepted trade-off

The review accepted the design with its small-read cost:

- A one-row nested read costs about **+3.7 µs CPU**: 0.0907 → 0.0944 ms,
  +4.7% in the full run, and +5.7% in one re-run.
- Larger reads gain materially. At 1,000 rows, flat is −14.6% CPU and −44%
  heap; nested is −4.3% and variant −2.7% CPU, both about −40% heap.

This is a documented choice, not an open finding. **No second, small-row
execution path is to be added**: it would be the parallel decoder the plan
forbids.

**Bounded future optimization (not a blocker).** `orphanedArm()`
(`shared/query.ts:441`) reads the arm's prepared field keys
(`Object.keys(arm.fields).length`) for every occurrence of a singular arm.
That count is invariant for a compiled arm. It could be taken once when the
slot is compiled, leaving only the per-value `Object.keys(document)` test.

## Native qualification

The three `raptor3-live-provider` suites ran on the candidate `6f6fdd92b`
(the integrity-entry repair included) against throwaway containers:
`postgres:16` with trust authentication and `mysql:8` with an empty root
password, each with a `raptor3_g2` database, on 127.0.0.1. Node v24.21.0.
Each file ran alone:

```
VIBORM_RAPTOR3_PROVIDER=<pg|mysql> VIBORM_RAPTOR3_PROVIDER_PORT=<port> \
  pnpm exec vitest run --workspace vitest.workspace.ts \
  --project raptor3-live-provider <file>
```

| Suite | PostgreSQL 16 | MySQL 8 |
| --- | --- | --- |
| `recursive-query/provider-sql-native` | pass, 3/3 | pass, 3/3 |
| `recursive-query/campaign-native` | pass, 4/4 (3 × 100 saved cases) | pass, 4/4 (3 × 100 saved cases) |
| `g4/native/read-envelope-native` | pass, 5/5 | pass, 5/5 |

Nothing was skipped and nothing failed, so no file needed a baseline run to
classify a failure. The containers were removed afterwards.

## Not established

- **libsql** skipped 668 of its 677 tests.
- **Transient allocation only.** The allocation numbers are transient heap
  growth. They make no claim about retained RAM.
