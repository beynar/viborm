import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_PROCESS_GROUP_RSS_LIMIT_MB,
  startBoundedProcess,
} from "./bounded-process.mjs";
import {
  EXTENDED_LOCAL_TEST_SHARDS,
  EXTENDED_LOCAL_TESTS,
  LIBSQL_PROVIDER_TESTS,
  PGLITE_PROVIDER_TESTS,
  SQLITE3_PROVIDER_TESTS,
} from "./credential-free-test-manifest.mjs";
import { acquireTestRunLock } from "./test-run-lock.mjs";

const safeVitestRunner = fileURLToPath(
  new URL("./run-vitest-safe.mjs", import.meta.url)
);

const VITEST_STAGE_HEAP_LIMIT_MB = 768;
const STAGE_RSS_LIMIT_MB = DEFAULT_PROCESS_GROUP_RSS_LIMIT_MB;
/**
 * `pnpm test` and `pnpm test:package` never carried an aggregate wall limit:
 * every launcher inside them (TypeScript shards, Vitest, tsdown) enforces its
 * own. A bounded child still needs a finite one, so those two stages carry the
 * same 24-hour "no ceiling at this level" spelling run-vitest-safe.mjs already
 * uses for watch mode, rather than an invented budget that could cut a passing
 * run short.
 */
const NO_AGGREGATE_WALL_LIMIT_MS = 86_400_000;
const JAVASCRIPT_ENTRY_POINT = /\.[cm]?js$/;

const describeError = (error) =>
  error instanceof Error ? error.message : String(error);

function vitestStage(label, wallLimitMs, project, files = []) {
  return {
    arguments: [
      safeVitestRunner,
      `--heap-limit-mb=${VITEST_STAGE_HEAP_LIMIT_MB}`,
      `--rss-limit-mb=${STAGE_RSS_LIMIT_MB}`,
      `--wall-limit-ms=${wallLimitMs}`,
      "run",
      "--workspace",
      "vitest.workspace.ts",
      "--project",
      project,
      ...files,
    ],
    command: process.execPath,
    heapLimitMb: VITEST_STAGE_HEAP_LIMIT_MB,
    label,
    wallLimitMs,
  };
}

function packageScriptStage(script) {
  const packageManager = process.env.npm_execpath;
  // Only re-enter through node when the package manager really is a JS entry
  // point. pnpm installed as @pnpm/exe sets npm_execpath to a native binary,
  // and `node <native binary>` dies with a SyntaxError before any test runs.
  const reenterThroughNode = Boolean(
    packageManager && JAVASCRIPT_ENTRY_POINT.test(packageManager)
  );
  return {
    arguments: reenterThroughNode ? [packageManager, script] : [script],
    command: reenterThroughNode ? process.execPath : packageManager || "pnpm",
    // No heap override: each launcher inside the script owns its own ceiling
    // (Vitest 768 MB, TypeScript shards 1280 MB). Imposing one here would be a
    // new limit, not the current one.
    label: `pnpm ${script}`,
    wallLimitMs: NO_AGGREGATE_WALL_LIMIT_MS,
  };
}

const stages = [
  packageScriptStage("test"),
  ...EXTENDED_LOCAL_TEST_SHARDS.map((files, index) =>
    vitestStage(
      `extended-local shard ${index + 1}/${EXTENDED_LOCAL_TEST_SHARDS.length} (${files.length} files; ${EXTENDED_LOCAL_TESTS.length} total)`,
      300_000,
      "extended-local",
      files
    )
  ),
  ...PGLITE_PROVIDER_TESTS.map((file) =>
    vitestStage(`provider-pglite: ${file}`, 1_200_000, "provider-pglite", [
      file,
    ])
  ),
  ...SQLITE3_PROVIDER_TESTS.map((file) =>
    vitestStage(`provider-sqlite3: ${file}`, 300_000, "provider-sqlite3", [
      file,
    ])
  ),
  ...LIBSQL_PROVIDER_TESTS.map((file) =>
    vitestStage(`provider-libsql: ${file}`, 300_000, "provider-libsql", [file])
  ),
  vitestStage(
    "provider-bun (visible skips when Bun is absent)",
    300_000,
    "provider-bun"
  ),
  vitestStage("provider-d1", 300_000, "provider-d1"),
  packageScriptStage("test:package"),
];

/**
 * One lock for the whole aggregate. Every nested launcher acquires the same
 * workspace lock, sees this process in its ancestor chain, and inherits the
 * ownership instead of taking its own - so no other runner can interleave
 * between two shards of a single `test:all`.
 */
let releaseTestRunLock;
try {
  releaseTestRunLock = acquireTestRunLock("credential-free test:all");
} catch (error) {
  process.stderr.write(`${describeError(error)}\n`);
  process.exit(1);
}

let activeRun;
let interrupted = false;
let interruptionCount = 0;
// Stages run detached in their own process group, so a terminal Ctrl-C never
// reaches them. Forward the signal to the active group ourselves; a second
// interruption escalates to SIGKILL.
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

let failureCode = 0;
try {
  for (const stage of stages) {
    if (interrupted) break;
    process.stdout.write(`\n[test:all] ${stage.label}\n`);
    const run = startBoundedProcess({
      arguments: stage.arguments,
      command: stage.command,
      heapLimitMb: stage.heapLimitMb,
      label: `[test:all] ${stage.label}`,
      rssLimitMb: STAGE_RSS_LIMIT_MB,
      wallLimitMs: stage.wallLimitMs,
    });
    activeRun = run;
    let outcome;
    try {
      outcome = await run.completion;
    } finally {
      if (activeRun === run) activeRun = undefined;
    }
    process.stderr.write(
      `[test:all] ${stage.label}: ${(outcome.wallMs / 1000).toFixed(2)}s wall, ${(outcome.peakGroupRssKb / 1024).toFixed(1)} MiB peak sampled process-group RSS (sampled ceiling ${STAGE_RSS_LIMIT_MB} MiB). ${outcome.error ? "Teardown not verified." : "Teardown verified."}\n`
    );
    if (outcome.error) process.stderr.write(`${outcome.error.message}\n`);
    if (outcome.error || outcome.stopReason || outcome.code !== 0) {
      failureCode = outcome.code === 0 ? 1 : outcome.code;
      break;
    }
  }
} catch (error) {
  failureCode ||= 1;
  process.stderr.write(`${describeError(error)}\n`);
} finally {
  try {
    releaseTestRunLock();
  } catch (error) {
    failureCode ||= 1;
    process.stderr.write(
      `Test-run lock release failed: ${describeError(error)}\n`
    );
  }
}

if (interrupted) failureCode ||= 1;
process.exitCode = failureCode;
