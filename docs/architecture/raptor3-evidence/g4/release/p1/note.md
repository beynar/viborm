# Release unit "P1" — the D-28 decode cell profiled and repaired

Author: the `P1` release unit (ruling D-61). Brief:
[`../../briefs/`](../../briefs/) plus this unit's own brief; the twelve rules of
[`../../briefs/common.md`](../../briefs/common.md) and `ELEGANCE.md` bind.
Worktree `/private/tmp/viborm-p1`, branch `p1`, base
`9058df3bf448a64959ebb43ea2839f56602f7e5f` (commit 33), whose `src` is
byte-identical to the measured `36c87710a` (`git diff --stat 36c87710a -- src`
empty, checked before any edit). Baseline
`5a37bcd7f371fe393cf7cecb8ec9f82ef8bd3062` in `/private/tmp/viborm-perf-baseline`.

**One production file changed, one hunk, 25 insertions / 11 deletions, net
zero engine token-LOC.** Nothing was committed, staged, reset, stashed, checked
out or formatted; no lock file was removed; `benchmarks/**`, `scripts/**` and
`tests/**` are untouched (`git diff --stat 9058df3bf -- tests benchmarks scripts`
is empty).

---

## 0. The headline, in five sentences

1. The cell reproduces: `fixed-collection-rowref-1000/parse` reads **CPU 1.073,
   wall 1.112** against the shipped-engine baseline, on the protocol's own
   `operation-pipeline-compare.mjs` with the series' counts — the perf unit's
   1.079 / 1.094 CPU and 1.120 / 1.138 wall, same single statement on both sides.
2. The cost is **one line**: `decodeValue`'s object arm rebuilt every decoded
   document through `Object.fromEntries(Object.entries(shape.fields).map(…))`,
   which carries **48.9 % of the whole `parse` profile** (53.5 % of
   `decodeValue`'s ticks) and makes the decoder allocate **2.51×** the shipped
   engine's bytes per row (1702 B against 677 B).
3. The fact that line re-derives per ROW — *which members this document has* —
   is a fact of the PREPARED PROJECTION: `Queries.prepareProjection` states it
   once and freezes it on the shape. The shipped engine derived it once too
   (`ResultParser.getFieldChain` → `createRowParser`, whose per-field `steps[i]`
   closures are compiled per query and cached; 1.20 % and 0.52 % of its profile)
   and per row only wrote `result[key] = …`.
4. The repair reads the shape the decoder already holds and writes the document
   directly. **Nothing else changed**: one owner, no cache, no policy boolean,
   no second reader, no mode branch, no new fact, no observable moved.
5. After: the cell reads **0.655 / 0.649 CPU and 0.681 / 0.674 wall** on two
   alternating five-replicate series — against plan §7's ≤ 1.05 budget — and
   **no other cell got worse**; allocation per row falls 1702 B → 847 B.

---

## 1. Reproducing the cell, before any change

`operation-pipeline-compare.mjs` as the series ran it
(`g4/release/perf/receipts/series-driver.mjs:95–125`), five replicates per side,
fresh process per sample, tree clean:

```
TMPDIR=/private/tmp/viborm-p1-tmp node --max-old-space-size=512 \
  benchmarks/operation-pipeline-compare.mjs \
  --baseline-dir /private/tmp/viborm-perf-baseline \
  --baseline-commit 5a37bcd7f371fe393cf7cecb8ec9f82ef8bd3062 \
  --candidate-dir /private/tmp/viborm-p1 \
  --candidate-commit 9058df3bf448a64959ebb43ea2839f56602f7e5f \
  --providers sqlite3 --comparison semantic \
  --workloads fixed-collection-rowref-1000 --stages parse --modes cpu \
  --iterations 1000 --warmup 200 --output …/before__parse__cpu.json
```

| | baseline | candidate | ratio | perf unit, pass 1 / 2 |
| --- | ---: | ---: | ---: | ---: |
| CPU µs/op (median of 5) | 482.693 | 517.940 | **1.073** | 1.079 / 1.094 |
| wall µs/op (median of 5) | 464.322 | 516.100 | **1.112** | 1.120 / 1.138 |
| statement count | 1 / 1 / 1 / 1 / 1 | 1 / 1 / 1 / 1 / 1 | — | 1 / 1 |

Samples, baseline: 473.41 · 485.82 · 482.69 · 474.60 · 529.66. Candidate:
505.11 · 517.94 · 524.48 · 518.25 · 497.77. Semantic digest identical on both
sides (`c583a3ea…`).
Receipt: [`receipts/cells/before__parse__cpu.json.gz`](receipts/cells/before__parse__cpu.json.gz).
Machine load 6.34 / 7.48 / 7.84 before, ~7.5 after
([`receipts/runs/machine-load.txt`](receipts/runs/machine-load.txt)).

**Per row** (the workload publishes 1,000 rows per operation): baseline
**482.7 ns/row**, candidate **517.9 ns/row** — the candidate is **+35.2 ns/row**.

The workload is `user.findMany({ where: { id: { startsWith: "user_" } },
orderBy: { id: "asc" }, select: { id: true, posts: { select: { title: true } } },
take: 1000 })`, and `parse` is `capability.parseResult(rawFixture)` over a frozen
raw result, so nothing but the decode boundary is inside the bracket.

---

## 2. The profile, and where the CPU goes

Instrument: perf pass 2's own `prof-stage.mjs` and `gc-stage.mjs`
(`g4/perf2/receipts/instruments/`), copied into `$TMPDIR` and re-pathed — they
profile the MEASURED LOOP only (inspector `Profiler.start`/`stop` around it,
50 µs sampling), so module loading and fixture setup are excluded. perf2's
`analyze-prof.mjs` needs a `@jridgewell/trace-mapping` copy this tree does not
carry, so its aggregation was re-implemented over Node's built-in `SourceMap`
([`receipts/instruments/analyze-prof2.mjs`](receipts/instruments/analyze-prof2.mjs));
[`analyze-lines2.mjs`](receipts/instruments/analyze-lines2.mjs) adds the
line-level pass, and prints the GENERATED line's own text beside the mapped
TypeScript position so no attribution rests on the mapping alone. 3,000
iterations, 300 warmup.

### 2.1 The candidate: one function, then one line

[`receipts/profiles/cand-parse.functions.txt`](receipts/profiles/cand-parse.functions.txt)
(minified build, the one the cell is measured on; 608.79 µs/op in the profiled run):

| self | share | function |
| ---: | ---: | --- |
| 1499.80 ms | **86.86 %** | `decodeValue` @ `shared/query.ts:4437` |
| 43.54 ms | 2.52 % | (garbage collector) |
| 34.16 ms | 1.98 % | `own` @ `shared/query.ts:408` |
| 34.00 ms | 1.97 % | `decodeScalar` @ `shared/query.ts:4521` |
| 27.72 ms | 1.61 % | `decodeProjection`'s row `.map` @ `:4375` |
| 15.54 ms | 0.90 % | `decodeProjection` @ `:4368` |
| 14.92 ms | 0.86 % | `preparedParser` @ `shared/operation-context.ts:1124` |
| 9.41 ms | 0.55 % | the collection arm's `.map` @ `:4482` |
| 0.83 ms | 0.05 % | `publishedTerminal` @ `operation-context.ts:1084` |
| 0.50 ms | 0.03 % | `providerValue` @ `shared/query.ts:663` |
| 0.21 ms | 0.01 % | the adapter `parseResult` arm @ `shared/query.ts:702` |
| 0.17 ms | 0.01 % | `Queries.decodeResult` @ `shared/query.ts:697` |
| 0.04 ms | 0.00 % | `adapters/adapter-result-parser.ts:196` |

Inside `decodeValue`, line by line, from an unminified build of the same source
([`receipts/profiles/cand-parse-nomin.decodeValue-lines.txt`](receipts/profiles/cand-parse-nomin.decodeValue-lines.txt)):

| ticks | of `decodeValue` | of the profile | line |
| ---: | ---: | ---: | --- |
| 9454 | **53.52 %** | **48.92 %** | `return Object.fromEntries(Object.entries(shape.fields).map(([field, nested]) => […]))` — `query.ts:4504` |
| 6404 | 36.25 % | 33.14 % | `const decoded = typeof value === "string" ? JSON.parse(value) : value` — `:4447` |
| 692 | 3.92 % | 3.58 % | the function prologue — `:4437` |
| 478 | 2.71 % | 2.47 % | the scalar dispatch — `:4443` |
| 324 | 1.83 % | 1.68 % | the collection arm's `decoded.map(…)` (the row-reference decode) — `:4482` |
| 99 | 0.56 % | 0.51 % | `own` — `:408` |

### 2.2 The brief's five questions, answered by the profile

1. **Per-row codec dispatch.** `decodeScalar` is **1.97 %** and `providerValue`
   **0.03 %**. It is not the cost.
2. **Are the per-operation `parseResult` legs consulted per ROW anywhere?**
   **No.** `Queries.decodeResult` is 0.01 % of the profile, its adapter arm
   0.01 %, the shipped SQLite adapter's own parser 0.00 % — three sampled hits
   each, which is one call per operation over 3,000 operations, exactly what
   D-28 says (`publishedProjection` asks it once, at the operation's boundary).
   The driver's `parseResult` is `undefined` on the sqlite3 driver, so the
   `driverParse ? … : adapterDecode(raw)` arm takes the short leg; the adapter's
   is the pass-through D-35/D-40 left. Neither is a per-row cost, before or
   after this unit.
3. **The row-reference decode.** The `posts` window is one `JSON.parse` per row
   (inside the 33.14 % above) plus `decoded.map(…)` at **1.68 %**.
4. **Allocation shape.** An object per row **and, per FIELD per row, two
   two-element arrays** — one built by `Object.entries`, one by `.map` — plus
   the two backing arrays and the `Object.fromEntries` result. For this
   workload's shape (2 members at the row, 1 in the nested post document) that
   is ~12 allocations per row against the shipped engine's compiled writes.
   Measured, not counted: **allocation per row 1702.25 B against 677.06 B,
   a ratio of 2.514** (protocol `alloc` mode, 4096 B sampling, five replicates
   per side — [`receipts/cells/before__parse__alloc.json.gz`](receipts/cells/before__parse__alloc.json.gz)).
   `--trace-gc` over a 1,200-operation run
   ([`receipts/profiles/trace-gc-summary.txt`](receipts/profiles/trace-gc-summary.txt)):
   **68 scavenges on the baseline, 146 on the candidate** (2.15×), total pause
   18.05 ms against 18.33 ms. The pause is NOT the cost — the allocation work
   itself is, which is why the CPU gap is ~8 % while the GC pause is ~2.4 % of
   wall on both sides.
5. **`assertExpectedRows` and the projection walk.** `assertExpectedRows` takes
   no sample of its own; its caller `publishedTerminal` is 0.05 % in total.
   `decodeProjection` and its row `.map` are 0.90 % + 1.61 %.

### 2.3 The baseline, for the same work

[`receipts/profiles/base-parse.functions.txt`](receipts/profiles/base-parse.functions.txt)
(551.77 µs/op in the profiled run):

| self | share | function |
| ---: | ---: | --- |
| 576.25 ms | **37.75 %** | `tryParseJsonString` @ `adapters/shared/result-parsing.ts:38` — the JSON.parse leg |
| 190.38 ms | 12.47 % | a compiled scalar step @ `result/result-row-parser.ts:366` |
| 148.65 ms | 9.74 % | `result/result-parser-contract.ts:151` |
| 98.51 ms | 6.45 % | `result/relation-result-parser.ts:15` |
| 80.69 ms | 5.29 % | `parseRowArray` @ `result/result-row-parser.ts:177` |
| 18.38 ms | 1.20 % | `ResultParser.getFieldChain` @ `result/ResultParser.ts:452` |
| 7.96 ms | 0.52 % | `ResultParser.getNestedRowParser` @ `:512` |

**That is the whole comparison.** Both engines spend about a third of the cell
on the same `JSON.parse` of the relation window, and about half on walking the
row's members. The shipped engine's half is a chain of closures **compiled once
per query and cached** (`getFieldChain` / `getNestedRowParser` at 1.2 % and
0.5 % are the compilation, amortised over 3,000 operations), each of which does
`result[key] = parsers.parseField(…)` — a plain member write into a plain
object (`result-row-parser.ts:366-377`). The candidate's half is
`Object.entries` + `.map` + `Object.fromEntries`, re-derived **per row**.

---

## 3. The repair: one owner, one hunk

**The fact:** *which members a projected document has.* Its owner is
`Queries.prepareProjection`, which builds `shape.fields` once per prepared
projection and freezes it (`shared/query.ts:3611`, `:3752-3753`); the guide
already states it — "`Queries.prepareProjection` owns one immutable alias-free
projection description and decoder shape … `decodeProjection` consumes its shape"
(`raptor3/AGENTS.md:161-164`). A provider row carries only the VALUES for that
member list. Materialising the list again for every row was the re-derivation.

**The hunk** — `src/query-engine/raptor3/shared/query.ts:4503-4528`, inside
`decodeValue`'s object arm, the only place that built a decoded document:

```diff
     const source = record(decoded);
-    return Object.fromEntries(
-      Object.entries(shape.fields).map(([field, nested]) => [
-        field,
-        this.decodeValue(
-          nested,
-          own(source, field),
-          internal,
-          carried || nested.kind !== "scalar",
-        ),
-      ]),
-    );
+    const document: Input = {};
+    for (const field of Object.keys(shape.fields)) {
+      const nested = shape.fields[field]!;
+      document[field] = this.decodeValue(
+        nested,
+        own(source, field),
+        internal,
+        carried || nested.kind !== "scalar",
+      );
+    }
+    return document;
```

(plus the fourteen comment lines that state the fact, its owner and why the
member write is plain.)

**What disappears** (§7's four questions, against the actual diff):

- *Mechanism.* One decoded document is now built by writing its members, not by
  materialising a key/value list and reading it back. No mechanism is added.
- *Consumers.* None. `decodeValue` is still the single walker, reached only
  through `decodeQuery` / `decodeProjection` (`AGENTS.md:118-122`); the member
  read is still `own()`; the recursion, the shapes, the refusals and the leaf
  decoder are untouched.
- *Replacing invariant.* The destination key is a **schema identifier** or one
  of this engine's own `_`-prefixed carrier names, so a plain member write
  cannot reach an inherited accessor. `schema/identifier.ts`'s
  `isValidSchemaIdentifier` refuses every own property name of
  `Object.prototype` — `__proto__` among them — through its
  `OBJECT_PROTOTYPE_PROPERTY_NAMES` check (`identifier.ts:4-6`, `:14`); the
  grammar `/^[a-zA-Z_][a-zA-Z0-9_]*$/` alone does not, since it matches
  `__proto__` — and `schema/hydration.ts:74-75`
  asserts it over `Object.keys(state.shape)`, which is a model's scalars AND its
  relations, at hydration. `parity-decoding.core.test.ts:124-130` already states
  exactly this for this decoder, in the tree: *"the schema's identifier preflight
  refuses such a field when the schema is hydrated … which is a stronger
  statement than the cell made."* The shape BUILDERS already take that write
  (`fields[name] = …` at `query.ts:3622`, `:4217`, `:4224`); the decoder now
  takes the same one.
- *Falsifier.* §5.

**Member order is preserved by construction.** `Object.keys` and
`Object.entries` are both `EnumerableOwnProperties` over `O.[[OwnPropertyKeys]]`,
so they enumerate the same names in the same order; the document's key order is
what it was.

**Rejected, with its measurement.** `for…in` is about 5 % faster again
(291 / 294 µs/op against `Object.keys`' ~306, same instrument —
[`receipts/runs/variant-trials.txt`](receipts/runs/variant-trials.txt)) and was
**not** taken: it walks the prototype chain, so an enumerable property on
`Object.prototype` would add a member to every decoded document. `Object.keys`
reads OWN keys only, which is the rule `decodeValue` already takes on the
provider side through `own()`. `Object.entries` with a plain write (365 /
367 µs/op) keeps half the allocation and was also rejected.

---

## 4. The cells, before and after

### 4.1 The instrument after the change, and why it had to change

`operation-pipeline-compare.mjs` **refuses a dirty candidate worktree** — twice:
`validateCheckout` throws on `git status --porcelain` output
(`benchmarks/operation-pipeline-compare.mjs:259-260`) and `verifyTargetEvidence`
rejects any sample whose `metadata.clean` is not `true` (`:747-753`). The repair
is uncommitted by this unit's own rules, and `benchmarks/**` is a protocol path,
so the comparison after the change was run **by driving the protocol's own
worker directly**
([`receipts/instruments/pair-run.mjs`](receipts/instruments/pair-run.mjs)):
five replicates, the same alternating order `checkoutOrder` produces, one fresh
process per sample, the same env and `NODE_OPTIONS=--max-old-space-size=2048`
`runChild` sets, the same median the report takes. The candidate arm runs in the
worker's own **calibration mode** (`VIBORM_BENCH_CALIBRATION_SOURCE_SHA256`,
`operation-pipeline-worker.mjs:126-136`, `:382-388`) — the protocol's own
mechanism for measuring a tree that is not a committed checkout, which pins the
`src`+`benchmarks`+`scripts`+`dist` fingerprint before AND after the measured
loop. **Stated as a deviation**: these after-cells are not
`measurementProtocolValid` reports, and the worker marks them `calibrationOnly`.

**The deviation is bounded by a control.** The same direct-worker instrument was
run on the **unchanged** tree (base copy restored, rebuilt, `git diff` empty):
it reads the unrepaired cell at **CPU 1.109 / wall 1.156**, against the protocol
compare's 1.073 / 1.112 and the perf unit's 1.079–1.094 / 1.120–1.138 — the same
cell, slightly higher under the evening's load. The instrument reproduces the
series before it is used to judge the repair
([`receipts/cells/control__parse__cpu__sameInstrument.json.gz`](receipts/cells/control__parse__cpu__sameInstrument.json.gz)).

### 4.2 `fixed-collection-rowref-1000/parse`, the D-28 cell

| | CPU ratio | wall ratio | candidate µs/op | ns per row |
| --- | ---: | ---: | ---: | ---: |
| perf unit, pass 1 / 2 | 1.079 / 1.094 | 1.120 / 1.138 | — | — |
| **before**, protocol compare | **1.073** | **1.112** | 517.94 | 517.9 |
| control, direct worker, unchanged tree | 1.109 | 1.156 | 523.24 | 523.2 |
| **after**, series A | **0.655** | **0.681** | 319.54 | 319.5 |
| **after**, series B | **0.649** | **0.674** | 313.39 | 313.4 |
| budget (plan §7) | ≤ 1.05 | ≤ 1.05 | | |

Statement count 1/1 on every sample of every run; semantic digest
`c583a3ea…` identical on both arms of every run. Receipts:
[`after__parse__cpu__seriesA.json.gz`](receipts/cells/after__parse__cpu__seriesA.json.gz),
[`seriesB`](receipts/cells/after__parse__cpu__seriesB.json.gz).
Load 7.14–7.32 at the start of each series, 7.27–7.29 at the end.

**Allocation**, protocol `alloc` mode, five replicates per side:

| | baseline B/row | candidate B/row | ratio |
| --- | ---: | ---: | ---: |
| before | 677.06 | 1702.25 | **2.514** |
| after | 682.94 | 847.28 | **1.241** |

**855 bytes per row removed**, which is the mechanism §2.2 named.

**The profile after**
([`cand-parse-after.functions.txt`](receipts/profiles/cand-parse-after.functions.txt),
[`cand-parse-after-nomin.decodeValue-lines.txt`](receipts/profiles/cand-parse-after-nomin.decodeValue-lines.txt)):
`decodeValue`'s self time falls from 1499.80 ms of 1726.8 (86.86 %) to
936.53 ms of 1206.9 (77.60 %) — in per-operation terms 529 → 320 µs/op, and the
whole profiled cost 608.8 → 412.1 µs/op, so the removal accounts for essentially
the entire gain. The line that carried 48.92 % is gone: the member write is
**10.59 %** and the `Object.keys` loop head **3.43 %**, and `JSON.parse` is now
the dominant term at **56.37 %** — which is the shape the baseline profile has.

### 4.3 Every other cell the brief names, re-measured

Each one run, cpu mode, five replicates per side, same instrument on both sides
of the "after" column. The "before" column is the protocol compare on the clean
tree, measured by this unit in the same session.

| cell | before CPU / wall | after CPU / wall | verdict |
| --- | ---: | ---: | --- |
| `fixed-collection-rowref-1000/parse` | 1.073 / 1.112 | **0.652** / 0.678 (2 series) | repaired |
| `fixed-collection-rowref-1000/full` | 1.015 / 1.039 | **0.819** / 0.826 | better |
| `fixed-collection-rowref-20/parse` | 0.642 / 0.938 | **0.438** / 0.593 | better |
| `fixed-collection-rowref-20/full` | 0.977 / 1.035 | **0.921** / 0.976 | better |
| `scalar-find-unique/execute` | 0.961 / 0.960 | **0.977** / 0.975 | held |

`scalar-find-unique/execute` is +1.6 % between the two readings and stays under
parity; the stage is `driver._executeRaw` plus the raw consumer and reaches no
decoder at all, so the movement is the instrument and the machine, not this
change. Every other cell moved the way the repair predicts, and
`fixed-collection-rowref-1000/full` — the end-to-end read that CONTAINS this
decode, and which the perf note recorded moving 1.026 → 1.062 with it (§4.4) —
comes back to **0.819**. Statement count 1/1 and an identical semantic digest on
every sample of every cell. Receipts under
[`receipts/cells/`](receipts/cells/).

---

## 5. Falsifiers

Every mutation was made in a BACKUP COPY of the file and undone by copying the
copy back; no `git checkout` was used at any point.

| | mutation | expectation | result |
| --- | --- | --- | --- |
| **FA** | `Object.keys(shape.fields)` → `…​.slice(1)` (one member of every document dropped) | the decode families must fail | **12 failures** — 6 of 13 in `parity-decoding.core.test.ts`, 3 of 4 in `projection-preparation.test.ts` on each of its two projects ([`receipts/runs/falsifier-FA.log`](receipts/runs/falsifier-FA.log)) |
| **FD** | `Object.keys(shape.fields)` → `…​.reverse()` (member ORDER inverted) | probe: is order pinned? | **0 failures** across `parity-decoding`, `projection-preparation`, `g4/unit01/repairs` ([`falsifier-FD.log`](receipts/runs/falsifier-FD.log)). Order is not pinned by these families; the change preserves it by construction (§3), which is a derivation, not a measurement — recorded in §9. |
| **F1** | `carried \|\| nested.kind !== "scalar"` → `carried` (an argument the hunk did NOT change, carried verbatim) | probe of the families' reach | **0 failures** in `parity-decoding` + `g4/parity/json-read-schema` ([`falsifier-F1.log`](receipts/runs/falsifier-F1.log)). An observation about the estate's coverage of the carried-value rule, NOT a statement about this change; recorded in §9. |

**FA is the falsifier of record**: the hunk is on the live path, and the
behaviour pins of the decode boundary cover it.

**The perf falsifier is the cell's own receipt** (§4.2): two alternating series
plus a control run of the same instrument on the unchanged tree.

---

## 6. Runs

Whole-estate typecheck: **0 diagnostics, `EXIT=0`** — run once after the hunk
([`receipts/runs/typecheck.txt`](receipts/runs/typecheck.txt)) and again on the
final tree, after the guide, ledger and perf-note edits
([`typecheck-final.txt`](receipts/runs/typecheck-final.txt)). A last smoke of the
decode families on that same final tree is 21 / 21
([`final-smoke.log`](receipts/runs/final-smoke.log)).

| run | result |
| --- | --- |
| `tests/contracts/engine/query/parity-decoding.core.test.ts` | 13 / 13 |
| `projection-preparation` + `g4/unit01/repairs` + `cache-result-codec-boundaries` + `g4/parity/json-read-schema` + `drivers/provider-result-contracts` | 8 files, **280 / 280** |
| `tests/raptor3/g4/parity/`, first half (14 files) | 23 project-files, **140 / 140** |
| `tests/raptor3/g4/parity/`, second half (13 files, in four groups plus three solo) | **74 + 52 + 30 + 12 + 39 + 3 + 2 = 212 / 212** |
| `read-aggregates`, `operation-program-read-contracts`, `select-mode-capability-matrix`, `result-aliases`, `provider-result-contracts` (extra read path) | 10 / 4 / 3 / 14 / 230, all green |
| `node scripts/run-raptor3.mjs g2-baseline` | gate verified, `EXIT=0` |
| `node scripts/run-raptor3.mjs g2-contracts` | gate verified, `EXIT=0` |
| `node scripts/run-raptor3.mjs g1-compare` | gate verified, `EXIT=0` |
| `pnpm test:all --only "Raptor 3 fixed"` | **82 files, 864 / 864**, `EXIT=0` |

**One environment note, not a failure.** The second half of `g4/parity/` run as
one vitest invocation exceeds the runner's 1536 MiB sampled process-group RSS
ceiling (1602.8 MiB) and the runner stops it; so does a four-file mixed group.
Split into groups of three and three solo files, every file passes. The ceiling
is the runner's, not this change's: the files are heavy across four vitest
projects. Logs under [`receipts/runs/`](receipts/runs/).

**Census**: `node scripts/raptor3-refusal-census.mjs` — **public refusals 23
distinct sentences at 30 sites**, total 192 sites. Unchanged
([`receipts/runs/census.txt.gz`](receipts/runs/census.txt.gz)).

**Biome**, per changed file, against the base copy of the same file (the
formatter was NOT run — `shared/query.ts` carries a pre-existing `format`
diagnostic):

| | base copy | after |
| --- | ---: | ---: |
| `format` | 1 | 1 |
| `lint/complexity/useSimplifiedLogicExpression` | 4 | 4 |
| `lint/correctness/noUnusedFunctionParameters` | 3 | 3 |
| `lint/correctness/noUnusedVariables` | 1 | 1 |
| `lint/style/useDefaultSwitchClause` | 2 | 2 |
| `lint/style/noParameterProperties` | 4 | 4 |
| `assist/source/organizeImports` | 1 | 1 |
| **total diagnostics** | **16** | **16** |

Identical, category for category
([`biome-base.txt`](receipts/runs/biome-base.txt),
[`biome-after.txt`](receipts/runs/biome-after.txt)). The hunk itself adds no new
format complaint: the file's whole-file formatter diff goes from 329 hunks to
**328**, and the two hunks inside the changed region are the file's existing
trailing-comma style, present on the same lines in the base copy.

**LOC**, `node scripts/query-engine-structure.mjs`, `src/query-engine/**`:

| metric | base | after | Δ |
| --- | ---: | ---: | ---: |
| token-LOC | 16,036 | **16,036** | **0** |
| physical lines | 20,319 | 20,333 | +14 (the comment) |
| functions | 1,095 | 1,094 | −1 (the `.map` arrow) |
| parameters | 1,653 | 1,652 | −1 |
| branch nodes | 2,561 | 2,562 | +1 (the `for…of`) |

The eleven token-lines removed and the eleven added are the same count, so the
engine's charged size does not move.

---

## 7. What did NOT change

No error class, no refusal sentence, no decoded value, no member name, no member
order, no public type, no adapter or driver seam, no shape, no test. Every cell
in §4 reports the same `semanticDigest` on both arms, and the harness's own
`verifyContract` (a `deepEqual` of the whole published result against the rows
the fixture wrote, plus `assertSemanticDigest` between the prepared/raw path and
the public full path) runs on every sample.

---

## 8. Commit message draft

```
perf(raptor3): the decoded document's member list is the projection's fact, not the row's — the D-28 cell repaired (D-61)

`decodeValue`'s object arm rebuilt every decoded document through
`Object.fromEntries(Object.entries(shape.fields).map(…))`. The member list it
materialises is a fact of the PREPARED PROJECTION — `prepareProjection` states
it once and freezes it on the shape — so a row was paying to re-derive it:
48.9 % of the `fixed-collection-rowref-1000/parse` profile and 2.51x the shipped
engine's bytes per row (1702 B against 677 B), which is the whole of D-61's
cell. The shipped engine derived it once too (`ResultParser.getFieldChain` ->
`createRowParser`, compiled per query and cached) and per row only wrote
`result[key] = …`.

The decoder now reads the shape it already holds and writes the document
directly. `Object.keys`, never `for…in`: the member list is the shape's own
keys, exactly as `own` reads the provider's. The write is plain because the
destination key is a schema identifier — `schema/identifier.ts` refuses every
`Object.prototype` own name, `__proto__` among them, at hydration — or one of
this engine's own carrier names, which is the write the shape builders already
take.

`fixed-collection-rowref-1000/parse` 1.073 -> 0.655 / 0.649 CPU and 1.112 ->
0.681 / 0.674 wall over two alternating five-replicate series against plan §7's
1.05; allocation per row 1702 B -> 847 B; `fixed-collection-rowref-1000/full`
1.015 -> 0.819 and no other cell worse. Falsifier: dropping one member of every
document fails 12 pins across the decode families. Typecheck 0, the parity
directory green, the fixed lane 864/864, census 23 public refusals unchanged,
Biome identical to the base copy, engine token-LOC unchanged at 16,036.
Evidence: docs/architecture/raptor3-evidence/g4/release/p1/.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
```

---

## 9. Unverified, and limits

1. **The machine was not quiet.** An interactive desktop session ran throughout;
   the 1-minute load average stayed between 6.3 and 8.9 for the whole unit
   ([`machine-load.txt`](receipts/runs/machine-load.txt)). Every cell is a
   paired, alternating five-replicate comparison measured inside one window,
   which is what the protocol's design bounds this against, but the absolute
   microsecond figures are not comparable with a quiet box's, and a ratio this
   far under budget (0.65 against 1.05) is what makes the verdict safe rather
   than the precision of any single sample.
2. **The after-cells are not `measurementProtocolValid` reports.** The compare
   coordinator refuses a dirty candidate tree, so they were produced by driving
   the protocol's worker directly in its calibration mode (§4.1). The control
   run bounds the substitution; it does not make the after-cells protocol
   reports. A committed tree should be re-measured with
   `operation-pipeline-compare.mjs` before the release number is quoted.
3. **Member ORDER is not pinned by any test I ran** (falsifier FD). The change
   preserves it by the specification of `Object.keys` / `Object.entries`; that
   is a derivation, not a measurement.
4. **The carried-value argument is not pinned by the decode families I ran**
   (falsifier F1): replacing `carried || nested.kind !== "scalar"` with
   `carried` left `parity-decoding` and `g4/parity/json-read-schema` green. That
   argument is unchanged by this hunk and the observation is about the estate's
   coverage, not about this unit; a pin for a `json`/`bigint`/`blob` leaf read
   THROUGH a relation window would close it. Not repaired here (it is a test,
   and this unit adds none).
5. **The same per-row materialisation survives in two siblings of the repaired
   arm, unmeasured and unrepaired**: `Object.entries(shape.arms)` at
   `query.ts:4463` and `Object.entries(orphans)` at `:4457` in the VARIANTS arm
   run once per row of a polymorphic read, and `decodeRecursive` builds two
   `JSON.stringify` keys per occurrence (`:4417`, `:4424`). D-61 names one cell
   and this unit repaired one owner's one line; the `variant-*` and recursive
   workloads were not profiled. Recorded so the sibling is not lost.
6. **The profile instrument `await`s a stage the worker declares sync.** perf
   pass 2's `prof-stage.mjs` is kept as it was written (`await runOne(i)`), which
   adds one promise per iteration; it is the same on both arms and ~0.02 % of a
   500 µs operation, and no number in §4 comes from it — it is used for
   attribution only.
7. **`analyze-prof2.mjs` / `analyze-lines2.mjs` are re-implementations** of
   perf2's `analyze-prof.mjs` aggregation over Node's built-in `SourceMap`,
   because the `@jridgewell/trace-mapping` copy perf2 resolved is not installed
   in this worktree. The line-level pass prints the GENERATED line's own text, so
   every attribution in §2.1 can be read without trusting the mapping; the
   unminified builds used for it were rebuilt to match each profile's source
   before the analysis was regenerated.
8. **Blockers: none.** No observable moved, so nothing here is a ruling.

---

## 10. What this unit leaves in the working tree

| path | |
| --- | --- |
| `src/query-engine/raptor3/shared/query.ts` | the one production hunk, `:4503-4528` (+25 / −11) |
| `src/query-engine/raptor3/AGENTS.md` | one paragraph beside the D-28 one (§3's fact, its owner, and the two things not to do) |
| `docs/architecture/raptor3-evidence/g4.md` | the `**P1 — …**` ledger record, after D-63's |
| `docs/architecture/raptor3-evidence/g4/release/perf/note.md` | a dated addendum inside §4.4, closing B4; the section itself is not rewritten |
| `docs/architecture/raptor3-evidence/g4/release/p1/` | this note and its receipts (new) |

Nothing else. `git diff --stat 9058df3bf448a64959ebb43ea2839f56602f7e5f -- tests
benchmarks scripts` is empty; `scripts/raptor3-manifest.mjs` is untouched.

---

## 11. Repair round — 2026-09-20

One review finding, minor, documentation in both of its instances: the sentence
that licenses the plain member write named the WRONG mechanism. The invariant it
states is TRUE and is unchanged — only its attribution moved.

**The finding.** §3's *Replacing invariant* bullet and the guide paragraph
(`AGENTS.md:915`) attributed the `__proto__` exclusion to
`schema/identifier.ts`'s identifier GRAMMAR, and the note quoted the regex. The
grammar does not exclude it: `__proto__` is a leading `_` and eight more
characters all inside `[a-zA-Z0-9_]`, so `/^[a-zA-Z_][a-zA-Z0-9_]*$/` MATCHES
it (`node -e '/^[a-zA-Z_][a-zA-Z0-9_]*$/.test("__proto__")'` → `true`). The
refusal is a SEPARATE conjunct of the same function: `identifier.ts:4-6` builds
`OBJECT_PROTOTYPE_PROPERTY_NAMES` from
`Object.getOwnPropertyNames(Object.prototype)` — twelve names, `__proto__`
among them — and `:14`'s `!OBJECT_PROTOTYPE_PROPERTY_NAMES.has(value)` is the
conjunct `isValidSchemaIdentifier` refuses on. The hunk's own comment
(`query.ts:4514-4515`), the commit draft (§8) and the ledger record
(`g4.md:3372`) each name the FILE rather than the grammar and are correct as
written; none of the three was touched.

**The two edits**, one clause each, no behaviour change:

| file | change |
| --- | --- |
| `note.md:245-250` (§3) | the mechanism named: `isValidSchemaIdentifier` refuses through its `OBJECT_PROTOTYPE_PROPERTY_NAMES` check (`identifier.ts:4-6`, `:14`), and the grammar alone does not, since it matches `__proto__` |
| `AGENTS.md:915` | "`schema/identifier.ts`'s grammar excludes" → "`schema/identifier.ts`'s `isValidSchemaIdentifier` refuses"; the two lines after it re-wrapped, no word changed |

**What did NOT move.** No engine file: `git diff --stat` against the base still
shows `shared/query.ts` alone at +25 / −11, the same hunk, and
`git diff 36c87710a -- src/query-engine/raptor3/shared/query.ts` is the diff it
was (the file's mtime predates this round). Nothing under `tests`,
`benchmarks` or `scripts` — that stat is still empty. **The engine did not
move, so no cell was re-measured**: §4's numbers stand as recorded, and §10's
table of what this unit leaves in the tree is unchanged.

| run | result |
| --- | --- |
| `tests/contracts/engine/query/parity-decoding.core.test.ts` — the pin §3 cites for this very invariant | **13 / 13** ([`repair-parity-decoding.log`](receipts/runs/repair-parity-decoding.log)) |
| `node scripts/run-typecheck.mjs` | **0 diagnostics, `EXIT=0`** ([`repair-typecheck.txt`](receipts/runs/repair-typecheck.txt)) |
| `node scripts/raptor3-refusal-census.mjs` | **public refusals 23 distinct sentences at 30 sites**, total 192 — unchanged ([`repair-census.txt.gz`](receipts/runs/repair-census.txt.gz)) |
| Biome, per changed file against the base copy | both changed files are Markdown and `biome.jsonc` does not process `.md`: the check reports the path as ignored for the changed file AND for its base copy, identical on the two sides ([`repair-biome.txt`](receipts/runs/repair-biome.txt)) |

Machine load during the round: `20:48 up 20 days, load averages: 7.22 6.44
6.69`. No measurement was taken under it, and none was needed.

**Blockers: none.** The invariant, and every pin of it, is what it was; the
sentence now says why.

---

## 12. FC-05 addendum — the key-list claim, corrected (2026-09-21)

Added by FC-05, which the closure handoff charged with correcting this note's
strongest sentence before anyone acted on it. Nothing above is rewritten; §4's
measurements, §5's falsifiers and §6's runs stand exactly as recorded.

**The claim.** §3's *What disappears* says: *"One decoded document is now built
by writing its members, not by materialising a key/value list and reading it
back."* §2's lead-in says *"Materialising the list again for every row was the
re-derivation."* Read together they say the per-row list is gone.

**What is actually in the tree.** `shared/query.ts`'s object arm still opens
with `for (const field of Object.keys(shape.fields))`. `Object.keys` allocates a
fresh string array **per decoded document**. What P1 removed is the *pair*
materialisation — `Object.entries` (one array plus one two-element array per
field), the `.map` closure and the `Object.fromEntries` read-back — which is
where the 1702 B → 847 B per row came from. The correct sentence is therefore:
*one decoded document is now built by writing its members, instead of
materialising a key/value PAIR list and reading it back; the member NAME list is
still materialised once per document.*

**Why FC-05 did not change it.** The handoff allows a further decoder change
only if the prepared shape ALREADY owns the member list without a second
decoder, a mutable shape mirror or an unmeasured framework. It does not: every
`{ kind: "object" }` shape in the estate is built from a `fields` record alone
(`prepareProjection`, `grouped`, `junction`, `relationShape`, the recursive
carriers and now `Queries.scalarQuery`), so giving the shape a `names` array
would add a second representation of the same fact at every one of those
builders — exactly the mutable mirror the rule forbids — and the protocol's
committed-tree comparator this note's own §9 requires is not available to a unit
working in a dirty worktree. It stays a **measured-experiment candidate**, with
its premise now stated accurately. The same is true of the two polymorphic
enumeration sites named beside it in the handoff.
