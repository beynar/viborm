# Raptor 3 batch-compiled list decoding: report

Plan: [`raptor3-compiled-list-decoder-plan.md`](raptor3-compiled-list-decoder-plan.md).
It extends PR #50's batch compilation boundary
([`raptor3-compiled-decoder-report.md`](raptor3-compiled-decoder-report.md)).

**Decision: accepted.**

- **Behaviour.** Qualified behaviour is identical to `main` `544ab9465`.
- **One authority.** There is still one decoder authority, and the per-list
  construction site is deleted.
- **List-heavy gain.** List-heavy reads show a CPU and heap-growth benefit
  that repeats in most rounds: 12/12 rounds below one for the root parse-only
  1000-row cells at every list length, 9 to 11 of 12 for the full-client
  1000-row cells (table below, with the per-cell counts).
- **Controls.** The non-list controls show no material regression. The
  largest repeatable control cost is **+1.4%** on a parse-only scalar read of
  one row (about 5 ns per op). The same read through the full client is flat.
  Two fixed heap costs come with the change and are disclosed rather than
  hidden by the medians: every scalar leaf's compiled reader now closes over
  the (usually absent) list reader, a deterministic **+32 B** per one-row
  scalar-only read (5,200 → 5,232 B parse-only; 36,232 → 36,264 B through the
  client), and a list placement whose values are all NULL still builds its
  element descriptor once per batch although no element is decoded.

**Complete production cost** against `544ab9465`. `shared/query.ts` is the
only production file changed.

- **Source:** +3 printed SLOC, +21 TypeScript tokens, +704 source bytes
  (+54/−38 lines).
- **`pg-representative` bundle:** +36 B raw, +9 B gzip, −56 B brotli.

## Source identity

| | Baseline | Candidate |
| --- | --- | --- |
| Commit | `544ab9465` | `80bf6998b` (implementation `04eda67bf`, then tests only) |
| `dist/**.mjs` digest | `639055d58bf85dbb` | `c42197d23ecd6e2f` |
| `shared/query.ts` sha256/16 | `ce56d8365de148c6` | `dc5bcbbe200f98c2` |
| `pnpm-lock.yaml` sha256/16 | `703a982935c98760` | `703a982935c98760` |

Both trees were clean. Each `dist/` was rebuilt with tsdown from its own tree
before measuring. Both ran on Node v24.21.0.

## The change

All line numbers below are in `src/query-engine/raptor3/shared/query.ts` at
`80bf6998b`.

**New: `compileList` (:5473).** `compileReader` (:5057) calls it once for each
list leaf of a decoded batch (:5064), beside the physical slot's provider
continuation.
- It chooses between the decimal whole-list codec (`decodeDecimalList`, :5476)
  and the ordinary container once.
- It derives the member's non-null leaf once (:5489).
- The reader it returns runs from `decodeScalar` (:5256). That call comes after
  the unchanged NULL and absence checks and after the single provider leg for
  the whole container.
- Each member is a carried value, decoded by `decodeScalar` itself.

**Deleted: `decodeList`.** It spread and froze a member leaf for every returned
list, and it re-chose the decimal path for every value.
- The pre-existing `items as unknown[]` assertion goes with it.
- There is no second list path, no copied scalar switch, no reader cache, no
  change to shape, SQL or provider parsing, and nothing per row.

**Ownership.**
- The reader belongs to the batch, like every PR #50 reader. It is never
  stored on the prepared shape or on `Queries`.
- `src/query-engine/raptor3/AGENTS.md` now states this lifetime, next to the
  PR #50 lifetime paragraph.

## Behaviour

**Unit 3 (adversarial qualification)** was on the same production source.

Test files:
- `tests/raptor3/result-decoder-lists.test.ts`, 13 cells;
- `tests/raptor3/result-decoder-lists-native.test.ts`, 4 cells on native
  PostgreSQL 16 and MySQL 8.

The runs below gave the same answers on both trees:
- the existing decoder and placement suites;
- the focused list-codec suites;
- `provider-pg`, `provider-postgres` and `provider-mysql2`;
- `raptor3-live-provider`.

Every red is pre-existing and identical on `544ab9465`: the named files and
counts per lane, and the raw benchmark records, are in
[`list-decoder-evidence/README.md`](list-decoder-evidence/README.md).

**This harness adds a second check.** For each cell it compares:
- the number of provider statements;
- the provider result-chain asks, by type, of a full read and of a parse-only
  read;
- a digest of both public results.

The two trees must agree on all of these, and they did in every cell. Each
worker also checks, before and after it measures:
- the full and parse-only answers equal the generator's rows, which were
  first read back raw from SQLite;
- a malformed member is refused;
- a sparse provider list keeps its holes (see [Sparse lists](#sparse-lists)).

**What the chain sees.** A physical list asks the chain once per list, and a
carried list never asks it. For example:
- root, 1 row: `{"boolean":1,"int":2,"string":3}` on both trees;
- carried, 1 shelf: `{"string":2}`, the shelf's own columns only.

## Performance

### How it was measured

**Harness:** `benchmarks/result-decoder-lists.mjs`. It runs in-memory SQLite,
with the schema pushed by the product's migration and rows seeded by raw SQL.

**The table and the reads.** Records have four ordinary columns plus a string
list and an int list, each list holding 0, 4 or 32 members. Four reads are
measured:
- `root`: physical list slots;
- `carried`: the same lists inside a to-many relation document;
- `scalar`: the root read with the list columns left unselected (a control);
- `nested`: the carried read with the list columns left unselected (a
  control).

**Stages.** Every cell runs in two stages:
- `parse`: the prepared operation's `parseResult` over one frozen raw result;
- `full`: the public client call.

**Process discipline.** Every value comes from a fresh process, and the two
trees alternate order each round.
- 12 timing rounds (wall and CPU per op).
- 4 separate heap rounds. Heap growth is a **proxy**: forced GC, a 64 MB
  semi-space and the median growth across one op, with no GC observed in any
  window. It is not retained memory and not RSS.
- 40 cold rounds (a fresh client's first operation).
- A 16-round pass of the one-row parse cells at 10× iterations.

**Ratios.** Each ratio is candidate ÷ base within one round. The tables show
the paired median, the interquartile range, and the rounds below 1.

The broader non-list controls come from PR #50's own harness,
`benchmarks/result-decoder.mjs`, run on the same two trees: 10 timing, 4 heap
and 20 cold rounds.

### List-heavy reads

| Cell | CPU p50 [p25, p75] (<1) | Wall p50 | Heap proxy p50 (<1) |
| --- | --- | --- | --- |
| root parse 20 × 0 | 0.791 [0.786, 0.797] (12/12) | 0.816 | 0.863 (4/4) |
| root parse 20 × 4 | 0.906 [0.900, 0.916] (12/12) | 0.887 | 0.881 (4/4) |
| root parse 1000 × 0 | 0.798 [0.790, 0.810] (12/12) | 0.778 | 0.726 (4/4) |
| root parse 1000 × 4 | 0.897 [0.884, 0.904] (12/12) | 0.891 | 0.796 (4/4) |
| root parse 1000 × 32 | 0.969 [0.963, 0.975] (12/12) | 0.967 | 0.903 (4/4) |
| carried parse 1000 × 0 | 0.887 [0.883, 0.900] (12/12) | 0.893 | 0.801 (4/4) |
| carried parse 1000 × 4 | 0.924 [0.914, 0.934] (12/12) | 0.924 | 0.811 (4/4) |
| carried parse 1000 × 32 | 0.970 [0.957, 0.983] (12/12) | 0.968 | 0.905 (4/4) |
| root full 20 × 0 | 0.980 [0.968, 0.983] (12/12) | 0.962 | 0.937 (4/4) |
| root full 1000 × 0 | 0.906 [0.894, 0.918] (12/12) | 0.902 | 0.828 (4/4) |
| root full 1000 × 4 | 0.927 [0.919, 0.944] (11/12) | 0.931 | 0.873 (4/4) |
| root full 1000 × 32 | 0.971 [0.949, 0.992] (9/12) | 0.966 | 0.934 (4/4) |
| carried full 1000 × 0 | 0.960 [0.948, 0.971] (11/12) | 0.961 | 0.827 (4/4) |
| carried full 1000 × 4 | 0.982 [0.971, 0.990] (10/12) | 0.986 | 0.850 (4/4) |
| carried full 1000 × 32 | 0.988 [0.980, 1.000] (9/12) | 0.986 | 0.927 (4/4) |

`rows × members` is per list. The gain shrinks as lists grow, because member
decoding dominates long lists, as the plan predicted. A full read dilutes it
further with SQLite's own work. Every 20-row carried cell is at or below
0.999 CPU and 0.958 heap.

### Single-row and small reads

**The one-row cost.** A batch with one row and one list per placement still
compiles the list reader and gains nothing back.
- Heap proxy: +224 B (two lists) on a root one-row read, stable across rounds.
  That is +2.4% to +3.1% of parse-only growth and +0.5% to +0.6% of full
  growth.
- Carried one-row reads (one shelf, two items) are 0.995–0.999, because their
  second item already reuses the reader.

**Time, one row, parse-only.** p50 [p25, p75] (<1 of n):

| Cell | 1× window, 12 rounds | 10× window, 16 rounds |
| --- | --- | --- |
| root × 0 | 1.019 [1.004, 1.025] (2/12) | 0.999 [0.988, 1.009] (9/16) |
| root × 4 | 1.013 [1.006, 1.021] (3/12) | 1.014 [1.006, 1.024] (1/16) |
| root × 32 | 1.076 [1.012, 1.115] (2/12) | **0.876** [0.860, 0.901] (13/16) |
| carried × 0 | 0.988 [0.982, 0.996] (9/12) | 0.982 [0.976, 0.988] (15/16) |
| carried × 4 | 0.999 [0.985, 1.003] (6/12) | 0.982 [0.979, 0.987] (16/16) |
| carried × 32 | 1.059 [1.010, 1.130] (3/12) | 1.005 [0.983, 1.030] (7/16) |

**The 32-member one-row cells are bimodal per process on BOTH trees.** Root
base runs cluster at about 2.3 and 3.0 µs, and candidate runs at about 2.4
and 3.3 µs.
- The sign of the ratio flips with window length: 1.076 at 1×, 0.876 at 10×.
- An earlier exploratory run at 100× (10 rounds, not part of this report's
  data) gave 0.88.
- This is V8 tiering in a 2–3 µs op, not a stable cost. Nothing about it is
  claimed as a gain either.

**The repeatable small cost** is about +1.4% on a one-row parse-only read,
with and without lists:
- root × 4: 1.014;
- the `scalar` control: 1.014 [1.008, 1.028], 2/16 below one.

That is about 5 ns of a 0.35–0.85 µs op, well below the plan's 5% trigger.
Through the public client, both reads are flat:
- root full 1 × 4: 0.996;
- `scalar` full 1: 0.985 CPU, 0.995 wall.

**Empty and cold reads.**
- Empty read (0 rows) is flat: parse 0.990 CPU, full 1.004 CPU, identical
  heap.
- Cold first operation, 40 rounds: root 1 row 0.991, root 20 rows 1.012,
  carried 20 rows 0.995. Their interquartile ranges straddle 1.

### Non-list controls

**This harness's controls.** All are within ±1.5% on CPU at every row count
in both stages:
- `scalar`: parse 1.015 / 1.005 / 0.994; full 0.985 / 1.003 / 0.995;
- `nested`: parse 1.005 / 1.003 / 1.000; full 0.999 / 1.003 / 1.002.

**PR #50's harness (flat, nested, variant, recursive at 0/1/20/1000 rows, full
reads).**
- Every paired CPU median is between 0.985 and 1.024.
- The largest is variant with 0 rows, at 1.024 [0.996, 1.040] CPU and 1.017
  wall. That cell compiles nothing list-related.
- Heap-proxy medians are between 0.983 and 1.017, and every 0- and 1-row cell
  is within +0.1%.
- Cold first operations are 0.992–1.008.
- Result digests and statement counts are identical.

**One unstable heap cell.** The heap proxy for the 1,000-row `scalar` read
does not repeat on either tree. Across processes, base ranges from about 335
to 715 KB and candidate from about 340 to 597 KB. A 10-round rerun gave a paired median of 0.975
[0.822, 1.023], after 1.201 in the first 4 rounds. Its per-row code is
unchanged, so this is not read as a cost or a gain.

## Production cost

| | Baseline | Candidate | Δ |
| --- | ---: | ---: | ---: |
| `shared/query.ts` printed SLOC (TS printer, comments removed) | 3,243 | 3,246 | +3 |
| TypeScript tokens | 29,365 | 29,386 | +21 |
| Source bytes | 219,063 | 219,767 | +704 |
| `measure-bundle` src code lines (query-engine) | 16,951 | 16,957 | +6 |
| `pg-representative` raw / gzip / brotli (B) | 544,073 / 159,578 / 135,471 | 544,109 / 159,587 / 135,415 | +36 / +9 / −56 |
| `full` raw / gzip / brotli (B) | 912,033 / 265,503 / 219,441 | 912,069 / 265,511 / 219,425 | +36 / +8 / −16 |
| `dist` runtime `.mjs` bytes | 986,018 | 986,054 | +36 |

Both columns come from `node scripts/measure-bundle.mjs` over each tree's
freshly built `dist/`.

## Sparse lists

**The known baseline issue is preserved, not resolved.** `items.map` skips
holes, so a plain hole never reaches the own-index check
(`a list scalar returned a sparse array`, :5511), and a sparse provider list
is published with its holes, on both trees. The check is NOT dead: an index
that is present on the array's prototype chain but not own is visited by
`map` and refused there, on both trees. That is the guard's unique coverage,
pinned as parity in `tests/raptor3/result-decoder-lists.test.ts`
("the own-index guard's one reachable input"). Do not delete it.
- `tests/raptor3/result-decoder-lists.test.ts:341` pins this as **baseline
  parity**.
- This harness checks it in every worker.

Neither the test nor this change is evidence that sparse lists are refused.
Whether they should be refused is a separate correctness policy question. It
needs a decision before any production change to this behaviour, and this
change does not make it.

## Not established

- **Timing providers.** Only SQLite was timed. PostgreSQL and MySQL were
  qualified for behaviour (unit 3), not for time.
- **Heap figures.** They are a heap-growth proxy, not retained memory or RSS.
- **Machine load.** The machine was a loaded desktop: 1-minute load 4–8 across
  14 cores. Alternation places that drift on both sides, but absolute
  microseconds are not portable.
- **Decimal, enum and identifier lists.** They were not timed separately.
  They go through the same compiled reader, and only the ordinary string and
  int lists were measured.
- **Reproduction.** Build `dist/` in both trees, then run:
  `node benchmarks/result-decoder-lists.mjs --base <tree> --candidate <tree>
  --rounds 12 --allocation-rounds 4 --cold-rounds 40`. For the one-row pass,
  add `--measures time --scale 10 --cells '^(root|scalar|carried|nested)\|parse\|1\|' --rounds 16`.
  For the controls: `node benchmarks/result-decoder.mjs --base <tree>
  --candidate <tree> --rounds 10 --allocation-rounds 4 --cold-rounds 20`.
