# Bun 1.4 / Vitest 3.1.4 compatibility experiment

**Keep the current Node CI backend.** Bun runs the same small core selections with Vitest’s threads pool, but the CI forks pool, better-sqlite3 provider and V8 coverage gate have concrete failures. No framework/dependency upgrade or shim was attempted. The existing native Bun SQL/SQLite CI cases still pass; these failures concern replacing Node as Vitest’s host across the current locked estate, not VibORM’s Bun driver support.

Scratch checkout: `/tmp/viborm-v1-bun-vitest-experiment-checkout`, exact main `3a94e1e8a87f1866449217f96b750ef92264b7ff`. Standard filtered Git checkout omitted the historical 3.69 GB evidence archive; private `pnpm install --offline --frozen-lockfile` downloaded nothing. Tracked source/config/lock files and shared worktree/dist remain unchanged. Only two scratch probe files were added.

Actual versions: Bun 1.4.0+34cbb9a40, Node 24.14.0, Vitest 3.1.4, Tinypool 1.0.2, @vitest/coverage-v8 3.1.4, better-sqlite3 12.11.1; macOS arm64 / 14 logical CPUs. [Official Bun 1.4 notes](https://bun.com/blog/bun-v1.4) advertise Vitest fork/thread pools and V8 coverage. Installed `bun --help` confirms `--bun`; installed Vitest help confirms `--pool threads`.

## Matched results

Both sides use the same Vitest 3.1.4 binary, workspace/config, selected tests, one worker, no file parallelism, external 60s wall/1536MiB sampled process-group RSS and verified group teardown. `NODE_OPTIONS` supplies 768 MiB heap: enforced for Node; **not a proven JavaScriptCore heap ceiling** for Bun. Runtime witness separately confirms the actual Vitest worker’s `process.versions.bun`/`process.execPath`; the deliberate assertion fails with exit 1 under both engines.

| Selection | Node result / wall / sampled RSS | Bun result / wall / sampled RSS |
|---|---|---|
| Existing forks pool, 12 vector tests | 12 passed; 3.38s / 389.8MiB | No tests collected; exit 1; 11.41s / 341.5MiB |
| Diagnostic threads pool, same 12 tests | 12 passed; 2.61s / 342.1MiB | 12 passed; 2.02s / 335.8MiB |
| Threads: vector + JSON + operand, 3 files | 59 passed; 2.65s / 350.4MiB | 59 passed; 2.10s / 356.4MiB |
| Threads: runtime witness + intentional assertion failure | 1 passed + 1 failed; exit 1; 1.97s / 262.6MiB | 1 passed + 1 failed; exit 1; 1.55s / 273.2MiB |
| Threads: original SQLite native-type mapping | 7 passed; 3.49s / 443.0MiB | Suite failed; 7 skipped; exit 1; 2.68s / 449.0MiB |
| Threads: original public V8 gate, 4 files | 8 passed; 100% all 4 metrics; 3.66s / 453.2MiB | 8 file-reported passes; coverage failed; exit 1; 2.67s / 432.5MiB |
| Threads: original bun:sqlite real-runtime case | 1 passed; 2.14s / 345.9MiB | 1 passed; 2.76s / 279.0MiB |

The 59-test core pair is 20.72% lower wall under Bun on this host; it is one startup-dominated pair, not a 25% CI result. The existing bun:sqlite case is slower under Bun 2.76s versus Node 2.14s. Failed/incomplete runs are not timing wins. No hosted Linux measurement, whole-estate qualification or all 14 coverage-floor proof is claimed.

## Concrete boundaries

- **Forks:** Tinypool calls `this.process.channel?.unref()`; Bun lacks that callable IPC member. Vitest executes 0 tests, exits1, and spends 10s closing. This is the unchanged current pool configuration.
- **Native SQLite:** the existing beforeAll cannot open better-sqlite3. Direct controlled import/construction reports `ERR_DLOPEN_FAILED`: “better-sqlite3 is not yet supported in Bun.” The 7 skips are consequences of suite failure, not supported conditional passes. Bun’s distinct built-in SQLite driver passes its original case; substituting it would change the provider being tested.
- **Coverage:** unchanged public gate retains 100% floors. Node emits 100% statement/branch/function/line coverage. Bun completes all 4 test files, then @bcoe/v8-coverage 1.0.2 throws `RangeError: Maximum call stack size exceeded` in mergeRangeTreeChildren; no qualified coverage report exists. A direct inspector probe confirms methods respond but fails the strict named-function/executed-count witness under Bun; Node passes. Short sub-250ms direct probes have under-sampled RSS and are not memory benchmarks.

## Reproduction

Core arguments (same for both runtimes):

```sh
run --workspace vitest.workspace.ts --project layer-validation \
  tests/unit/validation/vector.core.test.ts \
  tests/unit/validation/json.core.test.ts \
  tests/unit/validation/operand.core.test.ts \
  --pool threads --maxWorkers=1 --minWorkers=1 --no-file-parallelism
```

Executables: `node --require /tmp/viborm-v1-bun-vitest-experiment-runtime.cjs node_modules/vitest/vitest.mjs ...` versus `bun --bun --no-install --no-env-file --require /tmp/viborm-v1-bun-vitest-experiment-runtime.cjs node_modules/vitest/vitest.mjs ...`. The Node supervisor `/tmp/viborm-v1-bun-vitest-experiment-run.mjs` owns the unchanged workspace lock/RSS/wall/teardown mechanisms and records each child’s actual exit, including expected negative controls. It uses the existing bounded-process module; no lock bypass or production launcher patch.

Coverage uses the identical existing `VIBORM_COVERAGE_SUBSYSTEM=public`, `VIBORM_COVERAGE_MODE=focused`, project `coverage-public`, `--coverage`, and matching threads override; only private reports directories differ. The original forks comparison omits the pool override.

A pure-core threads lane is a possible later isolated Linux experiment, not a drop-in CI replacement. Adopting Bun across the estate would first require upstream forks/native-addon/coverage compatibility and a defensible JSC memory policy. This experiment changes no CI or release backend.

Exact commands, counts, exits and log hashes: `/tmp/viborm-v1-bun-vitest-experiment-receipts.json`; environment/input summary: `/tmp/viborm-v1-bun-vitest-experiment-summary.json`. All 17 bounded children finished and verified teardown. Local heavy runner released.
