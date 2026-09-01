import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  formatBoundedResourceLine,
  ISOLATED_PGLITE_PROVIDER_RSS_CEILING,
  ORDINARY_PROCESS_GROUP_RSS_CEILING,
  startBoundedProcess,
  vitestArgumentsWithSingleWorker,
  WHOLE_ESTATE_TYPECHECK_RSS_CEILING,
} from "./bounded-process.mjs";
import {
  EXTENDED_LOCAL_IMPORTED_PGLITE_SHARDS,
  EXTENDED_LOCAL_PGLITE_TESTS,
  EXTENDED_LOCAL_SHARED_FAMILY_SHARDS,
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
const vitestEntry = fileURLToPath(
  new URL("../node_modules/vitest/vitest.mjs", import.meta.url)
);

const VITEST_STAGE_HEAP_LIMIT_MB = 768;
const STAGE_RSS_LIMIT_MB = ORDINARY_PROCESS_GROUP_RSS_CEILING.limitMb;
const PGLITE_STAGE_WALL_LIMIT_MS = 1_200_000;
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

function vitestArguments(project, files) {
  return [
    "run",
    "--workspace",
    "vitest.workspace.ts",
    "--project",
    project,
    ...files,
  ];
}

function vitestStage(label, wallLimitMs, project, files = []) {
  return {
    arguments: [
      safeVitestRunner,
      `--heap-limit-mb=${VITEST_STAGE_HEAP_LIMIT_MB}`,
      `--rss-limit-mb=${STAGE_RSS_LIMIT_MB}`,
      `--wall-limit-ms=${wallLimitMs}`,
      ...vitestArguments(project, files),
    ],
    command: process.execPath,
    heapLimitMb: VITEST_STAGE_HEAP_LIMIT_MB,
    label,
    rssCeiling: ORDINARY_PROCESS_GROUP_RSS_CEILING,
    wallLimitMs,
  };
}

/**
 * The live-PGlite provider stages are the ONLY stages that carry the raised
 * ceiling, and they are the only stages this runner launches Vitest for
 * directly instead of through `run-vitest-safe.mjs`.
 *
 * Going direct is what makes the allowance real and honest at once. Every
 * bounded child is spawned detached, so it leads its own process group and a
 * launcher's sample sees only its own group: with a launcher in between, this
 * runner was sampling ~one Node process while `run-vitest-safe.mjs` privately
 * enforced the ordinary ceiling on the Vitest group that actually holds the
 * database. Only the inner ceiling ever bound, and the ceiling this runner
 * printed described a group the tests did not run in. With the launcher
 * removed there is exactly one bound on exactly one group: the number printed
 * below is the database's own peak, measured against the ceiling that killed it
 * if it breached.
 *
 * Nothing the launcher contributes is lost. The heap limit, the single-worker
 * policy and the wall limit are reproduced here; the workspace lock is already
 * held by this process for the whole aggregate, and `acquireTestRunLock`
 * returns a no-op release to any descendant of the owner, so the launcher's
 * nested acquisition was that no-op.
 *
 * Isolation is the precondition of the allowance, so it is spelled out here:
 * one file per stage, one stage per process, one live database at a time.
 */
function livePgliteProviderStage(file, project = "provider-pglite") {
  return {
    arguments: [
      vitestEntry,
      ...vitestArgumentsWithSingleWorker(vitestArguments(project, [file])),
    ],
    command: process.execPath,
    heapLimitMb: VITEST_STAGE_HEAP_LIMIT_MB,
    label: `${project}: ${file}`,
    rssCeiling: ISOLATED_PGLITE_PROVIDER_RSS_CEILING,
    wallLimitMs: PGLITE_STAGE_WALL_LIMIT_MS,
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
    // (Vitest 768 MB; the native typecheck owns its own ceiling). Imposing one here would be a
    // new limit, not the current one.
    label: `pnpm ${script}`,
    rssCeiling: ORDINARY_PROCESS_GROUP_RSS_CEILING,
    wallLimitMs: NO_AGGREGATE_WALL_LIMIT_MS,
  };
}

const EXTENDED_LOCAL_ORDINARY_COUNT =
  EXTENDED_LOCAL_TESTS.length - EXTENDED_LOCAL_PGLITE_TESTS.length;

const stages = [
  // NOT `pnpm test`. That is now the FAST default - a representative type lane
  // plus core runtime, so it stays under five minutes for everyday use. The
  // credential-free aggregate is the exhaustive gate, so it names the complete
  // type lane explicitly; inheriting `test` would have silently dropped the
  // full typecheck from test:all the moment the default was made fast.
  // One native program over the whole estate: it needs the typecheck ceiling,
  // not the ordinary 1536 the outer pnpm group would otherwise be held to.
  {
    ...packageScriptStage("test:types"),
    rssCeiling: WHOLE_ESTATE_TYPECHECK_RSS_CEILING,
  },
  packageScriptStage("test:core"),
  // The extended estate is split by what it boots. The files that open a live
  // PGlite database run ALONE under the allowlisted 2560 MiB ceiling, because
  // that allowance is conditioned on isolation and packing three of them into
  // one process is the accumulation the condition forbids. Everything else
  // keeps the ordinary 1536 MiB and the three-file packing its footprint
  // supports.
  ...EXTENDED_LOCAL_TEST_SHARDS.map((files, index) =>
    vitestStage(
      `extended-local shard ${index + 1}/${EXTENDED_LOCAL_TEST_SHARDS.length} (${files.length} files; ${EXTENDED_LOCAL_ORDINARY_COUNT} ordinary of ${EXTENDED_LOCAL_TESTS.length})`,
      300_000,
      "extended-local",
      files
    )
  ),
  // Suites on the shared worker database PACK: they take a private schema, not
  // an instance, so twelve of them cost about what one used to.
  ...EXTENDED_LOCAL_SHARED_FAMILY_SHARDS.map((files, index) => ({
    arguments: [
      vitestEntry,
      ...vitestArgumentsWithSingleWorker(
        vitestArguments("extended-local", files)
      ),
    ],
    command: process.execPath,
    heapLimitMb: VITEST_STAGE_HEAP_LIMIT_MB,
    label: `extended-local shared-family shard ${index + 1}/${EXTENDED_LOCAL_SHARED_FAMILY_SHARDS.length} (${files.length} suites)`,
    rssCeiling: ISOLATED_PGLITE_PROVIDER_RSS_CEILING,
    wallLimitMs: PGLITE_STAGE_WALL_LIMIT_MS,
  })),
  // Reached a PGlite-capable module but builds no instance of its own - the
  // docker legs gated off locally, and suites whose behavior module opens at
  // most a couple of databases. All 49 together peak at 2182 MiB.
  ...EXTENDED_LOCAL_IMPORTED_PGLITE_SHARDS.map((files, index) => ({
    arguments: [
      vitestEntry,
      ...vitestArgumentsWithSingleWorker(
        vitestArguments("extended-local", files)
      ),
    ],
    command: process.execPath,
    heapLimitMb: VITEST_STAGE_HEAP_LIMIT_MB,
    label: `extended-local imported-pglite shard ${index + 1}/${EXTENDED_LOCAL_IMPORTED_PGLITE_SHARDS.length} (${files.length} suites)`,
    rssCeiling: ISOLATED_PGLITE_PROVIDER_RSS_CEILING,
    wallLimitMs: PGLITE_STAGE_WALL_LIMIT_MS,
  })),
  ...EXTENDED_LOCAL_PGLITE_TESTS.map((file) =>
    livePgliteProviderStage(file, "extended-local")
  ),
  ...PGLITE_PROVIDER_TESTS.map((file) => livePgliteProviderStage(file)),
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

// `--only <substring>` runs just the matching stages. The full estate is 54
// process groups; verifying one lane's memory ceiling should not cost a run of
// all of them.
const onlyIndex = process.argv.indexOf("--only");
const onlyFilter = onlyIndex === -1 ? undefined : process.argv[onlyIndex + 1];
if (onlyIndex !== -1 && !onlyFilter) {
  process.stderr.write("[test:all] --only needs a substring to match\n");
  process.exit(2);
}
const selectedStages = onlyFilter
  ? stages.filter((stage) => stage.label.includes(onlyFilter))
  : stages;
if (onlyFilter && selectedStages.length === 0) {
  process.stderr.write(`[test:all] --only ${onlyFilter} matched no stage\n`);
  process.exit(2);
}

let failureCode = 0;
try {
  for (const stage of selectedStages) {
    if (interrupted) break;
    process.stdout.write(`\n[test:all] ${stage.label}\n`);
    const run = startBoundedProcess({
      arguments: stage.arguments,
      command: stage.command,
      heapLimitMb: stage.heapLimitMb,
      label: `[test:all] ${stage.label}`,
      rssCeiling: stage.rssCeiling,
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
      `${formatBoundedResourceLine(`[test:all] ${stage.label}`, outcome)}\n`
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
