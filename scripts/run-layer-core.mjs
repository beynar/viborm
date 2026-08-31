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

const vitestEntry = fileURLToPath(
  new URL("../node_modules/vitest/vitest.mjs", import.meta.url)
);
const tscEntry = fileURLToPath(
  new URL("../node_modules/typescript/bin/tsc", import.meta.url)
);
const startedAt = performance.now();
const wallLimitMs = 30_000;
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
    types = await runStage(
      `Layer ${layer} types`,
      tscEntry,
      ["--project", `tests/types/${layer}/tsconfig.json`, "--noEmit"],
      1280
    );
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
