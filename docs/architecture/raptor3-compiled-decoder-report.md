# Raptor 3 compiled result decoder: report

Plan: [`raptor3-compiled-decoder-plan.md`](raptor3-compiled-decoder-plan.md).
Decision: **accepted**. There is one decoder and one provider-chain owner. The
1,000-row flat read shows a material CPU and allocation win. The small-read
cost is reproducible but stays below the plan's 5% review trigger.

## Source identity

| | Baseline | Candidate |
| --- | --- | --- |
| Commit | `e836bbd15` | `ad30855e6` |
| `dist/**.mjs` digest | `4899a274e8908298` | `7c6347aa3ebd92c5` |
| `shared/query.ts` sha256/16 | `88df750542027a47` | `a1d4b4d8cbe0753c` |
| `pnpm-lock.yaml` sha256/16 | `703a982935c98760` | `703a982935c98760` |

Both trees were clean and ran on Node v24.21.0. Later commits change no
production source: they add the harness, this report and guide text.

## The decoder

All of the decoder lives in `src/query-engine/raptor3/shared/query.ts`:

- **`compileReader` (:5027)** is the one visitor over the prepared
  `ProjectionShape`. It runs once per decoded batch, from `decodeProjection`
  (:4711).
  - It takes each placement's invariant decisions before the first row: the
    member list, carried or physical placement, variant arms, row readers and
    recursive identity readers, and the physical slot's provider continuation.
  - It returns a reader that only does per-value work.
- **Shared rules.** Every reader goes through the same owners:
  - one scalar decoder, `decodeScalar` (:5150);
  - one document rule, `providerJson` (:447), `providerDocument` (:459) and
    `own` (:470);
  - one carrier validator, `decodeRecursiveCarrier` (:4722), which now takes
    the compiled row and identity readers.
- **One provider continuation.** `fieldReader` (:748) runs the driver, then
  the adapter, then translates errors. It is bound once per physical scalar
  slot. A carried value gets none.
- **Lifetime.** A reader holds the execution's driver parser. It is never
  stored on a shared shape or on `Queries`, and an empty batch compiles
  nothing (:4718).

Each new concept, and the decision it deletes:

| New | Deleted |
| --- | --- |
| `compileReader` | The per-value `shape.kind` dispatch.<br>Per-row `Object.keys(shape.fields)` and `Object.entries(shape.arms)`.<br>The per-member carried-status derivation.<br>`decodeValue` itself. |
| `fieldReader` | `providerValue` and the provider chain it rebuilt for every physical cell (3 closures per cell). |
| `providerDocument` | Four inline "object, not array" checks: the document, the recursive carrier, a node entry and an edge entry. |
| `providerJson` | Three spellings of `typeof v === "string" ? JSON.parse(v) : v`. |
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

## Production cost

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
  - This is reproducible but below the plan's 5% review trigger. **It is the
    cell a reviewer should weigh.**
- **Authority.** There is one decoder: no flat path, no second scalar switch
  and no second provider chain.

## Not established

- **Native recursive and read-envelope suites**
  (`recursive-query/provider-sql-native`, `campaign-native`,
  `g4/native/read-envelope-native`) have not run. Their harness needs a
  `raptor3_g2` database with an empty password (CD-03).
- **libsql** skipped 668 of its 677 tests.
- **Transient allocation only.** The allocation numbers are transient heap
  growth. They make no claim about retained RAM.
