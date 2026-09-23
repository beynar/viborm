# G0-02 baseline and comparison evidence

## Outcome

This report owns baseline facts, not a candidate result or a G0 pass. The
preimplementation forecast in `g0.md` remains 20,200–31,000 token-bearing lines
for the complete engine and 4,100–6,650 for S1–S4. Its original 47,625-line
navigation denominator and corresponding percentages remain visible; audited
accounting must reconcile them, not silently replace the forecast.

**Current disposition:** timing calibration remains inconclusive and is deferred
to G4 qualification. Arnaud approved proceeding with the bounded architecture
experiment despite small timing variation. The [G0 report](g0.md) records the
completed milestone under that revised policy. No measurement, numerical verdict
or adoption budget in this report was changed to produce that decision.

The final source-accounting receipt measures **49,887 token-bearing lines**
in 161 complete charged files: 64,980 physical lines and 2,292,906 source bytes.
The arithmetic is `47,625 − 1,604 + 3,747 + 119 = 49,887`: navigation lines,
less experimental projection lines, plus client and adapter/scratch integration.
The unchanged forecast therefore predicts a 59.5%–37.9% reduction against this
audited baseline. This is arithmetic reconciliation, not a measured rewrite.

| Charged owners | Files | Physical lines | Token-bearing lines | Bytes |
|---|---:|---:|---:|---:|
| Ordinary query/write engine | 146 | 60,313 | 46,021 | 2,137,893 |
| Client integration | 12 | 4,489 | 3,747 | 148,468 |
| Adapter/scratch integration | 3 | 178 | 119 | 6,545 |
| Complete charged scope | 161 | 64,980 | 49,887 | 2,292,906 |

The excluded experiment category is 20 files / 12,100 token-bearing lines,
including Pattern and the projection implementation. No production source file
differs from commit `3a291a59764eae961bb105136c155298a9f1191f`. The checkout
is dirty and is reported as such. The final executable-source/protocol manifest
hash is `5265f6a68c0216c7f7bcd06d3354f9bd99ca6478818be5b63b4cdee017122701`.
It matches every completed representative cell's pre-build source hash. Each
series retains its own complete built manifest in the machine index. Across the
four builds, differences are confined to generated `.d.mts` files; executable
source and JavaScript file/hash ledgers are identical. These are verified
per-series build identities, not a claim of one identical build hash across
series. Later executable-source edits require a new frozen receipt.

The source-accounting script uses the existing `countTokenLines` function from
`scripts/query-engine-structure.mjs` itself. It parses that function from its
source, records its hash, and calls it on each TypeScript source file. One
charged owner means one complete file. Source bytes, physical newline counts,
and parser-token-bearing line counts remain separate. Comments, JSDoc, blank
lines and end-of-file tokens do not create token-bearing lines.

The accounting manifest distinguishes these boundaries:

- The ordinary query/write engine is charged, including types and retained
  implementation glue. The non-routed Pattern directory is excluded.
- `builders/projection-select.ts` is excluded as an experimental implementation.
  Its experimental exports pass through `select-builder.ts`, but ordinary
  consumers call `buildSelectWithAliases`. That shared barrel remains charged
  whole. `operations/mutation-projection-fold.ts` also remains charged whole:
  its experimental `buildProjectionMutationFold` and private
  `returningProjectedColumns` do not entitle the retained ordinary fold to a
  fractional discount. Actual bundle module/export evidence checks this split.
- Public client composition, raw operation execution, array transaction paths,
  provider admission limits, omit traversal and result/schema introspection are
  charged as complete named owners outside the query-engine directory.
- The internal adapter seam, its scratch-reference protocol types, and the
  shared scratch-reference implementation are charged whole. The concrete
  PostgreSQL/MySQL/SQLite syntax adapters remain explicit unchanged boundaries,
  including their dialect-specific scratch installation and configuration.
  Excluding a retained syntax adapter gives no credit for deleting its scratch
  member; a candidate that changes that owner must charge the whole owner.
- Other schema, validation, public inference types, SQL, provider transport,
  extension, cache and instrumentation boundaries are excluded only while
  unchanged and used identically. The machine manifest lists each source file,
  classification, reason, content hash, counts and import declarations. Any
  moved engine responsibility is a new candidate charge, not an exclusion.

Tests, benchmark fixtures, scripts, documentation and research are not shipped
engine savings. The report records the G0 test/harness/tool footprint separately.
Generated production source, runtime tables, types and glue receive the same
charge as handwritten source. Emitted runtime and declaration bytes are separate
measurements, not additional source-LOC charges.

Three measured virtual bundle fixtures cover the exported engine boundary, a
full public PostgreSQL client with a scalar schema, and that same public entry
with a relation schema and read/write uses. They use the installed rolldown
owned by tsdown, Node 22 target, ESM, tree shaking, minification, one inlined
chunk and gzip level 9. The engine-only fixture externalizes dependencies. The
full public fixtures bundle required runtime dependencies and `pg`, with
only platform built-ins and explicitly unselected optional providers external.
Each fixture's actual gzip size is measured independently; gzip sizes are not
added. Public
declaration bytes follow the actual package publication pattern, including any
unreachable shared chunk. Public `types` export reachability is reported
separately; the benchmark friend entry under `dist/internal/` is excluded by the
package's own file rule. The successful package build and matching source
manifest bind these declarations to the measured source.

| Virtual fixture | Runtime bytes | Gzip bytes | Included modules |
|---|---:|---:|---:|
| Engine boundary, dependencies external | 603,586 | 156,771 | 241 |
| Public PostgreSQL scalar client, runtime dependencies bundled | 953,377 | 262,658 | 427 |
| Public PostgreSQL relation client, runtime dependencies bundled | 953,658 | 262,788 | 427 |

All three emitted bundles exclude Pattern and `projection-select.ts`. The
mixed `select-builder.ts` exports retained in the bundles are `buildInclude`,
`buildSelect` and `buildSelectWithAliases`. The mixed mutation fold retains
`buildMutationProjectionFold` and `compileMutationDependencyFold`. These are
actual rendered-module/export observations; both mixed source files remain
charged whole.

Published declarations total 727,420 bytes across 32 files. Public `types`
export reachability accounts for 727,409 bytes; the remaining 11-byte
`dist/cli.d.mts` is still published and charged. The package rule excludes the
209-byte internal benchmark declaration. The separate G0 evidence footprint is
38 files, 438,564 bytes, 13,850 physical lines and 13,216 token-bearing lines.
None of this evidence footprint is credited as production savings.

The existing benchmark comparator keeps strict physical equality by default.
Explicit `--comparison semantic` requires the five exact `RunObservation`
fields: outcome, independent initial state, independent final state, default
calls and reached causal cuts. The shared verifier uses deep strict equality,
not a potentially ambiguous digest encoding. Physical witnesses and phase
checksums must repeat within each engine; physical differences between engines
remain in the report and are not normalized away. Existing checks still require
clean, distinct checkout/source identities. Semantic mode is evidence-only and
forces keep eligibility to false: the legacy gate does not implement Raptor 3's
signed delta-plus-uncertainty budgets. The later milestone gate owns that verdict.

Explicit `--calibrate` is a separate same-root, same-source path. It builds once
and runs five alternating fresh-process pairs against the same hashed source,
protocol and built output. It holds the existing serial test lock, uses the
existing bounded-process runner, keeps the ordinary 1,536 MiB sampled process-
group RSS ceiling, and uses a 1,280 MiB build heap and 768 MiB worker heap. It
refuses checkout/adoption options and reports `adoptionEligible: false` and
`keepGate: null`. Calibration-marked samples cannot enter the adoption path.

Its provenance is deliberately local: one installed dependency tree, a frozen
lockfile, actual direct installed versions, and before/after Node and SQLite
native-binary hashes checked by the coordinator. It does not attest against
adversarial edits to every installed dependency. Source/build hashes are checked
outside timed worker sections, but their allocation still contributes to
whole-worker peak RSS in both arms. CPU samples record that high-water mark at
measurement end, including setup but excluding subsequent teardown; full-stage
samples therefore need no duplicate memory cohort. This is not clean-revision adoption
evidence.

Cold stages recreate schema, client and registries on the existing driver and
connection; they do not measure a cold runtime import or connection opening.
Conditional creates and relation series append rows throughout the fixed
warmup/measurement history. They are not stationary-cardinality database tests.
Iteration counts therefore belong to the frozen workload protocol, not merely
to the report's statistical settings. The fixture's independent initial/final
state graphs also remain live and contribute to whole-worker peak RSS.

## Validation

All six syntax-only checks passed after the queued corrections: the accounting
script, comparator, semantics, worker, protocol and report modules. The existing
benchmark report suite also passed 41/41 tests with no failures or skips:
`node scripts/run-node-safe.mjs 768 120000 benchmarks/operation-pipeline-report.test.mjs`.
Its receipt was 2.59 seconds wall time and 79.3 MiB peak sampled process-group
RSS against the 1,536 MiB ceiling, with teardown verified.

The granted serial source checkpoint command passed:

```sh
node scripts/run-node-safe.mjs 768 120000 scripts/measure-raptor3-baseline.mjs --output docs/architecture/raptor3-evidence/baseline.json
```

Resource receipt: 4.84 seconds wall time; 361.5 MiB peak sampled process-group
RSS against the unchanged 1,536 MiB ceiling; teardown verified. This command
produced the initial `baseline.json` checkpoint with the same source counts.
Its source manifest hash was
`d4f122f1cd138fbff520a1736c62c1a8f5dc9afcdc364eec25473b17a19d2924`;
the final receipt below supersedes that evidence-source epoch.

The first protocol-only calibration attempt ran this exact command:

```sh
node --max-old-space-size=512 benchmarks/operation-pipeline-compare.mjs --calibrate --providers sqlite3 --workloads scalar-find-unique --stages full --modes cpu --iterations 100 --warmup 20 --output /Users/arnaud/code/viborm/docs/architecture/raptor3-evidence/calibration-protocol.json
```

The package build passed: 95.76 seconds wall time; 875.5 MiB peak sampled
process-group RSS; 1,536 MiB ceiling; teardown verified. The first worker then
failed during module import: `operation-pipeline-fixtures.mjs` requested the
retired named `push` export from `dist/migrations.mjs`. Its receipt was 3.76
seconds / 71.1 MiB, with teardown verified. The comparator exited 1. There were
**no performance samples, no completed pair and no calibration JSON** from this
attempt.

The fixture owner replaced the stale import/call with the common live public
API, `createMigrationClient(client).push()`, without force or storage. Source
inspection of both catalog-pinned historical baselines,
`52eef9ebfc710407e1e5fe6042e2ed5a11adf19e` and
`1d796d4e01841becfbb2f6805668ef11d270aa0e`, confirms they export and document
that same storage-free call. No version branch or production compatibility
surface is needed. The successful current-source retry below exercises the
correction. Historical execution remains unrun.

The exact protocol command above then passed after the fixture correction and
the coordinated source freeze. The build took 10.48 seconds and peaked at
1,041.5 MiB sampled process-group RSS. Ten fresh workers completed five
alternating pairs. Every bounded process stayed under 1,536 MiB and verified
teardown:

| Pair | Launch order | Wall seconds | Peak group RSS, MiB |
|---|---|---|---|
| 1 | baseline, candidate | 0.88, 1.08 | 78.7, 84.0 |
| 2 | candidate, baseline | 1.37, 1.32 | 100.5, 96.0 |
| 3 | baseline, candidate | 1.19, 1.33 | 95.4, 94.5 |
| 4 | candidate, baseline | 1.01, 1.14 | 96.4, 76.0 |
| 5 | baseline, candidate | 1.25, 1.09 | 94.6, 84.1 |

This is only the scalar/full/CPU protocol smoke at 100 measured iterations and
20 warmup iterations, not representative calibration. Its result is explicitly
`noiseResolved: false`. Time budgets remain 5% and peak-memory budgets 10%; no
budget was adjusted:

| Metric | Baseline median | Signed delta | Uncertainty E | Budget | Smoke stability |
|---|---:|---:|---:|---:|---|
| CPU, microseconds/operation | 202.13 | 70.69 | 28.56 | 10.1065 | Unresolved |
| Wall, microseconds/operation | 203.27 | 14.3975 | 150.54582 | 10.1635 | Unresolved |
| Whole-worker peak RSS, bytes | 97,566,720 | 1,474,560 | 1,802,240 | 9,756,672 | Within budget |

Calibration stability uses `abs(delta) + E`; it is not the signed candidate
adoption gate. The peak metric is the worker's actual lifetime high-water mark,
not the runner's sampled process-group RSS in the resource table. Eight other
frozen workloads and all other selected metric cells remain unrun here.

The granted final bundle/source census command then passed:

```sh
node scripts/run-node-safe.mjs 768 120000 scripts/measure-raptor3-baseline.mjs --bundle --output docs/architecture/raptor3-evidence/baseline.json
```

Its receipt is 9.11 seconds wall time and 694.9 MiB peak sampled process-group
RSS against 1,536 MiB, with teardown verified. It refreshed `baseline.json`
with the measured bundles and declarations above. Source identity checks passed
before/after measurement and matched the successful build's source epoch.

Artifact SHA-256 receipts:

- `baseline.json`: `36c840519d4f2e5922b1d0646c1c2c650c50da43dd4aeffa0b0f4ba660b4d7e5`.
- `calibration-protocol.json`: `bf82db3eb5010bd768e46bd4ac6abcaf20b5e41576f773fc425e5811362ce3c8`.
- Frozen benchmark protocol: `db130febadc9655f9d7ff9015767b64a31aeabc5abd2265ba39f4bebbd192f51`.

Those receipts belong to the pre-transport-repair source-only epoch
`8a88f250f2e2b9d39372b60cbbf2d7a10ca49479a466be5ecb190e3c7a5db8f6`
and source-plus-build epoch
`3fe2c38ae4d6db4d7083cb7e0a8cd72bbd5684311cfa3b4b9e78d7364039ce44`.
The then-current proof footprint was 36 files / 434,244 bytes / 13,715 physical
lines / 13,089 token-bearing lines. Later receipts below supersede that epoch
without crediting its failed or partial representative runs.

The machine artifacts retain per-source and per-bundle hashes, actual installed
versions, and coordinator Node/SQLite native-binary before/after hashes. The
runtime was Node v24.20.0 on Darwin arm64; the bundle tools were tsdown
0.19.0-beta.4 and rolldown 1.0.0-beta.58, with TypeScript 5.9.3.

Measurement commands require the agreed serial slot and a pause in all source
writers whose files enter the source/protocol hash. The final census and
protocol smoke above share one frozen epoch. A later representative calibration
must freeze its proportional workload/metric/count matrix separately.

The root then froze the 20-cell representative matrix in `g0.md` before its
first run. Group A used this exact command:

```sh
node --max-old-space-size=512 benchmarks/operation-pipeline-compare.mjs --calibrate --providers sqlite3 --workloads scalar-find-unique,flat-scalar-update,fixed-collection-rowref-20,nested-conditional-found,nested-conditional-missing,key-transition-cascade,relation-series-2 --stages prepare,execute,full --modes cpu --iterations 5000 --warmup 1000 --output /Users/arnaud/code/viborm/docs/architecture/raptor3-evidence/calibration-v1-small.json
```

The build passed in 18.25 seconds with 981.6 MiB peak sampled process-group RSS.
Nine cells (scalar read, scalar update and the 20-row relation read, each at
prepare/execute/full) completed all 90 workers. Their wall times ranged from
1.38 to 4.33 seconds and their peak sampled process-group RSS from 98.5 to
276.1 MiB. The next worker, conditional-found/full baseline pair 1, failed while
serializing its evidence after measurement: `JSON.stringify` at
`operation-pipeline-worker.mjs:391` refused a BigInt. Its resource receipt was
7.92 seconds and 292.5 MiB. All bounded processes verified teardown and stayed
under the unchanged 1,536 MiB ceiling.

The comparator exited 1 and emitted no `calibration-v1-small.json`. Its earlier
90 samples were not persisted as a completed calibration report and do not
establish resolved or unresolved cells. Groups B–E did not start. No source,
count or budget was changed after this failure. The transport boundary needs a
lossless representation before another representative run; converting BigInt
to an untyped string would erase evidence distinctions.

The transport repair used the `diagnosing-bugs` skill. One actual conditional-
found/full worker at one measured and one warmup operation reproduced the
same throw in 1.08 seconds / 85.6 MiB, with teardown verified. A process-only
probe located exactly `witness.statements[2].params[0]` and
`witness.statements[3].params[3]`, both `10001n`; it repeated the throw in
1.11 seconds / 85.6 MiB. No probe source was retained. Broad hypothesis
generation was skipped because the deterministic throw and exact value paths
identify report serialization directly.

Initial diagnostic-command setup attempts failed before that reproduction:
an unused nonexistent resource-format export, a missing expected-commit
environment value, and a refused zero warmup count. They are setup errors, not
benchmark samples. The corrected minimal command uses the existing bounded
process runner and serial lock, 768 MiB heap, 1,536 MiB group RSS and 120 seconds.

The actual-worker regression was written before the fix and went red on the
same BigInt throw. Its bounded receipt was 0.57 seconds / 69.7 MiB with teardown
verified. The shared value codec moved from replay into
`benchmarks/operation-pipeline-evidence.mjs`; replay still owns record admission.
Every measured worker and final measured report now uses the explicit
`{ encoding: "viborm-evidence-v1", value: ... }` envelope. Metadata-only control
outputs remain plain JSON. The coordinator decodes before comparison and
re-encodes the complete report; consumers must use `parseEvidenceReport` for
this new wire format. Strict clean-source/protocol eligibility and physical
equality remain required. Typed witness encoding retains the old record-key-
order equality rule, while semantic observations still use native deep strict
equality. There is one value interpretation, not a digest or BigInt string
substitution.

The initial repaired regression passed 2/2 tests in 0.47 seconds / 123.2 MiB,
with teardown verified. It preserves both actual `10001n` parameters through
worker, coordinator decoder and report roundtrip, and checks BigInt/string/
tag-array, undefined/missing, Date/string, negative-zero/zero, null-prototype
record and record-key-order distinctions. Five changed MJS syntax checks passed.
The existing report suite passed 41/41 in 0.25 seconds with teardown verified;
its sampler printed 0.0 MiB because the process was too short for a useful RSS
sample, not because actual peak memory was zero. These are repair checks, not
representative calibration. Source-stable G0 and baseline receipts must be
refreshed after the reviewed transport revision.

Independent review found one inherited codec defect: sparse-array holes would
become null through JSON. The new regression went red with a missing expected
exception (0.59 seconds / 171.5 MiB), then passed after one own-index refusal in
the shared array encoder. Explicit `[undefined]` still roundtrips. The final
2/2 transport suite passed in 0.48 seconds / 129.7 MiB, with teardown verified.
The reviewer found no remaining blocker in the transport diff.

The reviewed actual coordinator-to-saved-report diagnostic then ran:

```sh
node --max-old-space-size=512 benchmarks/operation-pipeline-compare.mjs --calibrate --providers sqlite3 --workloads nested-conditional-found --stages full --modes cpu --iterations 1 --warmup 1 --output /Users/arnaud/code/viborm/docs/architecture/raptor3-evidence/calibration-transport-diagnostic.json
```

It exited 0 after all ten workers. The build receipt was 2.42 seconds /
1,051.1 MiB. Workers took 0.28–0.35 seconds; nine finished too quickly for a
useful group-RSS sample (printed 0.0 MiB), and the final worker sampled
95.1 MiB. Every bounded process verified teardown under the unchanged
1,536 MiB ceiling. The comparator itself used its unchanged 512 MiB V8 heap;
this command did not separately sample the coordinator's peak RSS.

Reading the saved envelope through `parseEvidenceReport` and asserting both
physical parameter paths confirmed that both remain exactly `10001n`.
`adoptionEligible` is false and `noiseResolved` is false. One measured and one
warmup operation are defect-validation counts, not the frozen representative
counts: this diagnostic receives no matrix, calibration or adoption credit.
Its 94,409,473-byte artifact has SHA-256
`c670c4970b1042ce7c79ffeeb669827b30785ea978fa19cce9717fff09aa2f31`.
The new source-only manifest is
`1d7d5d7ff0231c3980cd969c26b508f09eddd31ae05622bdf82fa99b781a9436`;
source plus build is
`9215f5abfff142f3329f5e3238f83bddcab8a44c8bd60ece01099c6a4c0369d8`;
protocol is
`6321b8b01ce4e552b496c84c24885adf0c1a7c52ab864595cbf22bb0ecbf5a85`.
These supersede the earlier executable-protocol epoch, not its historical
receipts. Root owns the subsequent full G0 and baseline refresh. Source is
paused and the serial validation slot is released.

Root then removed report indentation without changing wire values, expanded the
actual-worker transport regression to all nine recipes, and refreshed the G0
gates. The relation-series observer was corrected to compare its actual
pre-parser SQLite capture IDs as `5000n` and `6000n`; capture-time and
pre-effect default assertions remain unchanged. Independent read-only review
confirmed that this is a fixture boundary correction, not an engine change.

The first representative cell on that reviewed source ran exactly:

```sh
node --max-old-space-size=512 benchmarks/operation-pipeline-compare.mjs --calibrate --providers sqlite3 --workloads scalar-find-unique --stages full --modes cpu --iterations 5000 --warmup 1000 --output /Users/arnaud/code/viborm/docs/architecture/raptor3-evidence/calibration-v1-scalar-full-1.json
```

It exited 0 after five alternating pairs. The fresh build took 2.34 seconds /
877.1 MiB; ten workers took 0.39–0.41 seconds and sampled 115.3–138.5 MiB group
RSS. Every bounded process verified teardown under the unchanged 1,536 MiB
ceiling. All three metrics satisfy `abs(delta) + E <= budget`:

| Metric | Baseline median | Signed delta | E | Budget |
|---|---:|---:|---:|---:|
| CPU, microseconds/operation | 25.2896 | 0.1864 | 0.6152 | 1.26448 |
| Wall, microseconds/operation | 15.4253416 | 0.0847584 | 0.3114664 | 0.77126708 |
| Whole-worker peak RSS, bytes | 148,471,808 | 1,048,576 | 1,146,880 | 14,847,180.8 |

This cell reports `noiseResolved: true` and `adoptionEligible: false`. Its
6,657,007-byte compact artifact has SHA-256
`63b20a12883062f6c067f673ccdeaed6e3ed7db668ecc64e6c7a4dbd062aadd3`.
It qualifies only scalar-find-unique/full/CPU and its accompanying wall/peak
metrics, not the remaining 19 required cells.

The exact `--bundle` census command recorded above then passed again in
1.60 seconds / 670.4 MiB, with teardown verified under 1,536 MiB. Production
counts, all three runtime/gzip values and declaration bytes are unchanged.
At that checkpoint, the refreshed `baseline.json` SHA-256 was
`2c44443da576ba779190f46f69141a88b948ac33dac7346b1b258a8cbb20e3aa`.
Its source identity was explicitly asserted equal to this representative
cell's pre-build identity. The current source and built hashes appear under
Outcome; the current protocol is
`a5fbb861e58eede32e5ac6e3946e8bebbebf2593acdc0fab7ee758db15ea4993`.
No next cell or repeat ran before root metric review. Source remains paused.

After root independently verified that cell and reproduced the entire baseline
byte-for-byte, the remaining-cell slot began under the frozen stop rule. The
first two cells used the same command form as the scalar/full invocation above,
with these exact substitutions; all other flags remained unchanged:

| Stage | Iterations / warmup | Output basename |
|---|---|---|
| cold-prepare | 5,000 / 1,000 | `calibration-v1-scalar-find-unique-cold-prepare-1.json` |
| prepare, initial series | 5,000 / 1,000 | `calibration-v1-scalar-find-unique-prepare-1.json` |
| prepare, sole permitted repeat | 5,000 / 1,000 | `calibration-v1-scalar-find-unique-prepare-2.json` |

Each command completed five alternating fresh-process pairs and exited 0. Cold
preparation resolved. Steady preparation remained unresolved after its one
unchanged complete repeat, so execution stopped before the next cell:

| Cell / series | Metric | Baseline median, microseconds | Signed delta | E | Budget | `abs(delta) + E` |
|---|---|---:|---:|---:|---:|---:|
| Cold prepare / 1 | CPU | 152.2176 | 0.126 | 1.2732 | 7.61088 | 1.3992 |
| Cold prepare / 1 | Wall | 71.181175 | 0.264575 | 0.7993668 | 3.55905875 | 1.0639418 |
| Prepare / 1 | CPU | 9.7884 | 0.2526 | 0.4456 | 0.48942 | 0.6982 |
| Prepare / 1 | Wall | 4.795075 | 0.1623 | 0.3451332 | 0.23975375 | 0.5074332 |
| Prepare / 2 | CPU | 9.8884 | 0.0524 | 0.5492 | 0.49442 | 0.6016 |
| Prepare / 2 | Wall | 4.870425 | 0.0002916 | 0.2622168 | 0.24352125 | 0.2625084 |

Root separately applied the frozen 10% peak-memory test to the same raw CPU
workers; the comparator's CPU `noiseBudget` object contains time metrics only.
All four series satisfy the memory inequality, including scalar/full above:

| Remaining series | Baseline peak median, bytes | Signed delta | E | Budget |
|---|---:|---:|---:|---:|
| Cold prepare / 1 | 343,326,720 | 2,834,432 | 1,409,024 | 34,332,672 |
| Prepare / 1 | 118,128,640 | 3,162,112 | 1,867,776 | 11,812,864 |
| Prepare / 2 | 120,684,544 | 196,608 | 4,751,360 | 12,068,454.4 |

On the repeat, uncertainty alone exceeds the unchanged 5% budget for both
metrics. There was no sample removal, count adjustment, extra repeat, or budget
change. This blocked G0 performance evidence under the original rule; it is
not a candidate-engine failure. Representative status is two resolved cells,
one unresolved cell after its permitted repeat, and 17 unrun cells.

Resource receipts (all MiB values are sampled process-group RSS):

| Series | Build seconds / MiB | Worker seconds | Worker peak MiB range |
|---|---|---|---|
| Cold prepare / 1 | 2.18 / 1,032.1 | 0.74–0.83 | 321.3–331.7 |
| Prepare / 1 | 2.23 / 1,023.2 | 0.33–0.35 | 111.0–124.9 |
| Prepare / 2 | 2.17 / 1,034.5 | 0.32–0.36 | 111.2–126.6 |

Every bounded process verified teardown under the unchanged 1,536 MiB ceiling.
Each report retains the same source-only manifest
`5265f6a68c0216c7f7bcd06d3354f9bd99ca6478818be5b63b4cdee017122701`.
The decoded raw reports remain intact, with SHA-256 receipts:

- Cold prepare / 1: `845a2013bd3c1eb198aacf870d97c8db5a95a4f4bb3ed94d64b50559a24831fd`.
- Prepare / 1: `e04fc170817925c0cbbfe45e8f7f39ceb3a642d465cc2601b4d282ab2b4e385e`.
- Prepare / 2: `66a1a1464758ffe5da07e57e67d5761b82a197e422813dd7513b63aa2d0619e9`.

The serial slot was released immediately after the unresolved repeat. No
remaining workload was run because it cannot clear this required-cell blocker.

### Final source-bound receipts and storage

After the last calibration build, root reran the same `--bundle` census command
in 1.58 seconds / 558.7 MiB. Its independent unchanged repeat took 1.63 seconds /
694.6 MiB and reproduced the **entire artifact byte-for-byte**; both verified
teardown under the unchanged 1,536 MiB ceiling. The current 1,027,889-byte
`baseline.json` has SHA-256
`cd71b8182dfe325168baff54e3823fba70a2973d49a575907049ccb07b9c6fdc`.
The earlier `2c44443…` checkpoint above remains history. Declaration rebuilds
changed declaration filenames/content hashes only, not their total bytes;
source counts, runtime bundle hashes/gzip sizes and executable-source identity
are unchanged. The current baseline records the final declaration files.

Root and the independent adversary checked the decisive timing calculation from
native decoded samples. The adversary also recomputed all saved medians, MADs,
differences, uncertainty and budgets across all four representative series and
confirmed five samples per side, fixed counts and matching executable identities.
This verifies the inconclusive decision, not a candidate performance result.

All six emitted calibration/diagnostic JSON reports are now stored losslessly as
`.json.gz`, not as uncompressed `.json` files. Reproduction commands above keep
their original output paths. The [machine index](g0.json) records compressed
bytes/SHA-256 and decoded bytes/SHA-256 separately. The previously recorded raw
hashes apply after decompression; no samples were removed. Current reports use
`parseEvidenceReport` from `benchmarks/operation-pipeline-evidence.mjs` after
decompression. Only the historical `calibration-protocol.json.gz` smoke remains
plain JSON. The separate contract archives retain both the current full passing
CLI suite and the earlier source epoch with its failed run.

## Risks

The source and bundle baselines are measured. Representative old-versus-old
calibration is inconclusive and deferred: two of 20 cells resolved, steady scalar preparation
remained unresolved after its allowed repeat, and 17 cells are unrun. The
earlier 100/20 scalar protocol smoke retains its unresolved time
noise; no later receipt changes that result. These receipts do not qualify all nine
workloads, the semantic rewrite lane, or an adoption decision. Root-owned G0
contract/CLI evidence remains separate; this report does not infer an aggregate
pass from isolated retries. This timing limitation no longer blocks G1 under
the approved stage-specific policy, but complete performance qualification is
still required before adoption. No G1 engine code is present.

Compact tagged reports avoid the diagnostic's indentation expansion, but one
completed cell does not prove that a 13-cell aggregate fits. Single-cell invocations preserve
the frozen 20 cells, counts, five-pair alternation and budgets without raising
limits or adding a report-streaming framework.

Untimed SQL observation overrides the semantic fixture's driver execution
methods. That fixture uses borrowed-result parsing, while the separate timed
fixture keeps its stock owned-result eligibility. The new contract-write helper
also checks one stock public result before timing; the existing read/scalar/bulk
helpers compare manual prepared parsing with observed public execution. Those
helpers therefore do not by themselves qualify owned-result reuse correctness.
The existing ownership contract estate remains a separate required source of
evidence.
