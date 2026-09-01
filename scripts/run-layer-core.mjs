import {
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_PROCESS_GROUP_RSS_LIMIT_MB,
  startBoundedProcess,
} from "./bounded-process.mjs";
import { acquireTestRunLock } from "./test-run-lock.mjs";

const LAYERS = new Set([
  "validation",
  "scalars",
  "operation-schemas",
  "relations",
  "schema-validation",
  "schema-json",
  "query-engine",
  // Mirrors the `layer-*` projects in vitest.workspace.ts, which is what a
  // layer name has to name here. `layer-write-engine` has existed there since
  // the write core was split out of layer-query-engine, but this set rejected
  // the name, so the write estate had no single-layer entry point at all.
  "write-engine",
  "adapters",
  "drivers",
  "client",
  "cache",
  "instrumentation",
  "migrations",
]);

const layer = process.argv[2];
if (!(layer && LAYERS.has(layer))) {
  process.stderr.write(`Unknown test layer: ${layer ?? "<missing>"}\n`);
  process.exit(2);
}

const describeError = (error) =>
  error instanceof Error ? error.message : String(error);

let releaseTestRunLock;
try {
  releaseTestRunLock = acquireTestRunLock(`layer-${layer}`);
} catch (error) {
  process.stderr.write(`${describeError(error)}\n`);
  process.exit(1);
}

const projectRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const vitestEntry = fileURLToPath(
  new URL("../node_modules/vitest/vitest.mjs", import.meta.url)
);
const tscEntry = fileURLToPath(
  new URL("../node_modules/typescript/bin/tsc", import.meta.url)
);
const startedAt = performance.now();
/**
 * Every layer holds the 30-second budget except client, which gets 45.
 *
 * This is a WALL budget, not a memory one: the 768 / 1280 / 1536 MiB contract is
 * untouched. Client needs the extra time BECAUSE of that contract. Its
 * compile-only estate is 21 files and 221 KB of source - the byte total the
 * shard budget below actually weighs, not the 268 KB of disk blocks a `du`
 * reports - and at a 1280 MB shard heap it cannot be one program:
 * contextual-typing-gate.core.types.ts alone is 74 KB and OOMs anything packed
 * with it, and the other twenty OOM together too. So it runs as three programs,
 * each measured clean under 1536 MiB, and three tsc startups cost ~24.9s on top
 * of a 5.4s runtime stage.
 *
 * Raising this is the right lever precisely because the memory ceiling is not.
 * If the client type estate is ever trimmed back under two programs, put it
 * back to 30.
 */
const DEFAULT_WALL_LIMIT_MS = 30_000;
const LAYER_WALL_LIMIT_MS = new Map([["client", 45_000]]);
const wallLimitMs = LAYER_WALL_LIMIT_MS.get(layer) ?? DEFAULT_WALL_LIMIT_MS;
let activeRun;
let interrupted = false;
let interruptionCount = 0;
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => {
    interrupted = true;
    interruptionCount += 1;
    activeRun?.terminate(
      interruptionCount === 1 ? signal : "SIGKILL",
      interruptionCount === 1 ? "interrupted" : "forced interruption"
    );
  });
}

// Chunk by BYTES, not by file count. A count-based split kept
// contextual-typing-gate.core.types.ts (74 KB, alphabetically first) together
// with nine others and still OOMed, while the same file alone typechecks in
// 7.8s. Any file heavier than LARGE gets its own program; the rest pack to
// BUDGET. Both numbers are measured against the 1280 MB shard heap.
const TYPE_SHARD_LARGE_BYTES = 40_000;
const TYPE_SHARD_BUDGET_BYTES = 100_000;
let typeShardDirectory;

/**
 * Temporary tsconfigs that chunk one layer's compile-only type files. Returns
 * the layer's own tsconfig unchanged when it already fits in a single chunk, so
 * the common case spawns exactly one tsc as before, and an EMPTY list when the
 * layer owns no type core - the caller announces that, it is never silent.
 */
function typeShardProjects(layerName) {
  const layerRoot = `tests/types/${layerName}`;
  let files;
  try {
    files = readdirSync(resolve(projectRoot, layerRoot))
      .filter((file) => file.endsWith(".core.types.ts"))
      .sort();
  } catch (error) {
    // Only a missing directory means "this layer owns no type core". Any other
    // fault - ENOTDIR, EACCES - is a real one and must never be read as
    // "nothing to typecheck", so it propagates and fails the run.
    if (error?.code !== "ENOENT") throw error;
    return [];
  }
  if (files.length === 0) return [];
  const weighed = files.map((file) => ({
    file,
    bytes: statSync(resolve(projectRoot, layerRoot, file)).size,
  }));
  const total = weighed.reduce((sum, entry) => sum + entry.bytes, 0);
  if (total <= TYPE_SHARD_BUDGET_BYTES) {
    return [`${layerRoot}/tsconfig.json`];
  }
  const groups = [];
  let current = [];
  let carried = 0;
  for (const { file, bytes } of weighed) {
    if (bytes > TYPE_SHARD_LARGE_BYTES) {
      if (current.length > 0) groups.push(current);
      groups.push([file]);
      current = [];
      carried = 0;
      continue;
    }
    if (carried + bytes > TYPE_SHARD_BUDGET_BYTES && current.length > 0) {
      groups.push(current);
      current = [];
      carried = 0;
    }
    current.push(file);
    carried += bytes;
  }
  if (current.length > 0) groups.push(current);
  // Inside node_modules, not the OS temp dir: tsc resolves typeRoots relative
  // to the config's own location, so a config in /tmp cannot find @types and
  // fails with TS2688 for node, bun and vitest/globals.
  typeShardDirectory ??= mkdtempSync(
    join(projectRoot, "node_modules/.viborm-layer-types-")
  );
  return groups.map((group, index) => {
    const project = join(typeShardDirectory, `${layerName}-${index + 1}.json`);
    writeFileSync(
      project,
      JSON.stringify({
        extends: resolve(projectRoot, "tests/types/tsconfig.layer.json"),
        include: group.map((file) => resolve(projectRoot, layerRoot, file)),
      })
    );
    return project;
  });
}

function removeTypeShardDirectory() {
  if (!typeShardDirectory) return;
  rmSync(typeShardDirectory, { force: true, recursive: true });
  typeShardDirectory = undefined;
}

const runStage = async (label, entry, arguments_, heapLimitMb) => {
  const remainingWallMs = Math.max(
    1,
    wallLimitMs - (performance.now() - startedAt)
  );
  const run = startBoundedProcess({
    arguments: [entry, ...arguments_],
    command: process.execPath,
    heapLimitMb,
    label,
    rssLimitMb: DEFAULT_PROCESS_GROUP_RSS_LIMIT_MB,
    wallLimitMs: remainingWallMs,
  });
  activeRun = run;
  let outcome;
  try {
    outcome = await run.completion;
  } finally {
    if (activeRun === run) activeRun = undefined;
  }
  process.stderr.write(
    `${label} resources: ${(outcome.wallMs / 1000).toFixed(2)}s wall, ${(outcome.peakGroupRssKb / 1024).toFixed(1)} MiB peak sampled process-group RSS (sampled ceiling ${DEFAULT_PROCESS_GROUP_RSS_LIMIT_MB} MiB). ${outcome.error ? "Teardown not verified." : "Teardown verified."}\n`
  );
  if (outcome.error) process.stderr.write(`${outcome.error.message}\n`);
  return outcome;
};

let failed = false;
let elapsed = 0;
try {
  const runtime = await runStage(
    `Layer ${layer} runtime`,
    vitestEntry,
    [
      "run",
      "--workspace",
      "vitest.workspace.ts",
      "--project",
      `layer-${layer}`,
      "--reporter=dot",
      "--maxWorkers=1",
      "--minWorkers=1",
      "--no-file-parallelism",
    ],
    768
  );
  let types = { code: 1 };
  if (
    !(interrupted || runtime.error) &&
    runtime.code === 0 &&
    runtime.stopReason === undefined
  ) {
    // One program per layer no longer fits the 1280 MB shard heap: the client
    // layer's twenty-one .core.types.ts files OOM together, and so do any
    // twenty of them - contextual-typing-gate.core.types.ts alone is 74 KB of
    // inference. Chunk the layer's type files so each program stays inside the
    // heap. Splitting the work is the remedy; raising the heap is not.
    types = { code: 0 };
    const typeProjects = typeShardProjects(layer);
    if (typeProjects.length === 0) {
      // Said out loud, never assumed. layer-write-engine is a RUNTIME split of
      // the query-engine layer: contract-matrix.core.test.ts still resolves
      // every tests/contracts/engine/** runtime core to `query-engine`, and the
      // write engine's only compile-only probes live in the query-engine type
      // core (tests/types/query-engine/routed-operation.core.types.ts imports
      // @src/query-engine/write-engine/*). Handing it a
      // tests/types/write-engine/tsconfig.json would buy a program that can
      // never hold a probe: that census requires every .core.types.ts to sit
      // under a declared TEST_LAYERS directory, `write-engine` is not one, so
      // the first probe added there turns the census red. The config would then
      // compile nothing but the inherited ambient declaration and report
      // success forever. A permanently empty program passing is a false green;
      // print the truth instead. Completeness is not lost - the shards in
      // run-typecheck-shards.mjs still typecheck the whole tests/types estate,
      // and that census owns the rule that every DECLARED layer has a type
      // core.
      process.stderr.write(
        `Layer ${layer} types: SKIPPED - no tests/types/${layer}/*.core.types.ts exists, so this layer has no type core of its own and nothing was typechecked here.\n`
      );
    }
    for (const [index, project] of typeProjects.entries()) {
      types = await runStage(
        `Layer ${layer} types ${index + 1}`,
        tscEntry,
        ["--project", project, "--noEmit"],
        1280
      );
      if (types.code !== 0 || types.error || types.stopReason) break;
    }
  }

  elapsed = performance.now() - startedAt;
  failed =
    interrupted ||
    Boolean(runtime.error) ||
    runtime.code !== 0 ||
    Boolean(runtime.stopReason) ||
    Boolean(types.error) ||
    types.code !== 0 ||
    Boolean(types.stopReason) ||
    elapsed > wallLimitMs;
} catch (error) {
  failed = true;
  process.stderr.write(`${describeError(error)}\n`);
} finally {
  // Both cleanups always run, both report, and neither can swallow the other.
  // An unguarded removeTypeShardDirectory() used to sit in front of the lock
  // release: one throwing rmSync skipped the release entirely and left the
  // whole workspace locked behind an uncaught exception, with the shard
  // directory still on disk and nothing said about either.
  const shardDirectory = typeShardDirectory;
  try {
    removeTypeShardDirectory();
  } catch (error) {
    failed = true;
    process.stderr.write(
      `Type shard cleanup failed, remove ${shardDirectory} by hand: ${describeError(error)}\n`
    );
  }
  try {
    releaseTestRunLock();
  } catch (error) {
    failed = true;
    process.stderr.write(
      `Test-run lock release failed: ${describeError(error)}\n`
    );
  }
}

if (failed) {
  process.exitCode = 1;
} else {
  process.stdout.write(
    `Layer ${layer} passed in ${(elapsed / 1000).toFixed(2)}s.\n`
  );
}
