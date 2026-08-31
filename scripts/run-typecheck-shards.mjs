import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { startBoundedProcess } from "./bounded-process.mjs";
import { acquireTestRunLock } from "./test-run-lock.mjs";

const projectRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const tscEntry = fileURLToPath(
  new URL("../node_modules/typescript/bin/tsc", import.meta.url)
);
const wallLimitMs = 600_000;
const TYPE_SHARD_HEAP_LIMIT_MB = 4096;
// contracts-engine is the heaviest program here and peaked at 3075.8 MiB,
// 3.8 MiB over a 3072 ceiling. Headroom, still well under the absolute cap.
const TYPE_SHARD_RSS_LIMIT_MB = 3584;
/**
 * Ambient declarations belong to every shard. src/standard-schema-spec.d.ts
 * augments "@standard-schema/spec" with StandardSchemaOf, which the scalar
 * builders use in their public `schema()` signatures. Only the production shard
 * included src/**, so every test shard was typechecking the scalars against a
 * DIFFERENT module shape than production and reporting nine phantom TS2724s.
 */
const AMBIENT_DECLARATIONS = ["src/**/*.d.ts"];
const runtimeShards = [
  {
    name: "production",
    include: ["src/**/*.ts", "benchmarks/**/*.ts", "scripts/*.ts", "demo.ts"],
  },
  ...[
    "cache",
    "instrumentation",
    "migrations",
    "operation-schemas",
    "relations",
    "scalars",
    "schema-json",
    "schema-validation",
    "validation",
  ].map((name) => ({
    name: `unit-${name}`,
    include: [`tests/unit/${name}/**/*.ts`, ...AMBIENT_DECLARATIONS],
  })),
  ...["adapters", "architecture", "drivers", "engine", "public-client"].map(
    (name) => ({
      name: `contracts-${name}`,
      include: [`tests/contracts/${name}/**/*.ts`, ...AMBIENT_DECLARATIONS],
    })
  ),
  {
    name: "support-and-providers",
    include: [
      "tests/inventory.ts",
      "tests/fixtures/**/*.ts",
      "tests/package/**/*.ts",
      "tests/providers/**/*.ts",
      "tests/types/relations/debug-relation-type.ts",
      ...AMBIENT_DECLARATIONS,
    ],
  },
];
const typeProbeProjects = [
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
].map((name) => ({
  name: `types-${name}`,
  project: resolve(projectRoot, `tests/types/${name}/tsconfig.json`),
}));

const describeError = (error) =>
  error instanceof Error ? error.message : String(error);

let releaseTestRunLock;
try {
  releaseTestRunLock = acquireTestRunLock("complete TypeScript shards");
} catch (error) {
  process.stderr.write(`${describeError(error)}\n`);
  process.exit(1);
}

const startedAt = performance.now();
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

let failed = false;
let temporaryDirectory;
try {
  temporaryDirectory = mkdtempSync(
    join(projectRoot, "node_modules/.viborm-types-")
  );
  const generatedProjects = runtimeShards.map((shard) => {
    const project = join(temporaryDirectory, `${shard.name}.json`);
    writeFileSync(
      project,
      JSON.stringify({
        extends: resolve(projectRoot, "tsconfig.json"),
        compilerOptions: { noEmit: true },
        include: shard.include.map((pattern) => resolve(projectRoot, pattern)),
      })
    );
    return { name: shard.name, project };
  });

  for (const shard of [...generatedProjects, ...typeProbeProjects]) {
    if (interrupted) {
      failed = true;
      break;
    }
    const remainingWallMs = Math.max(
      1,
      wallLimitMs - (performance.now() - startedAt)
    );
    const run = startBoundedProcess({
      arguments: [tscEntry, "--project", shard.project, "--noEmit"],
      command: process.execPath,
      // The production shard typechecks src + benchmarks + scripts + demo.ts in
      // one program and needs ~2 GiB resident. At 1280 MiB it did not merely
      // fail, it OOMed BEFORE reporting, which hid two real TS2345 errors in
      // src/cli/utils.ts. Base ran the whole typecheck at 4096 MiB.
      heapLimitMb: TYPE_SHARD_HEAP_LIMIT_MB,
      label: `TypeScript shard ${shard.name}`,
      rssLimitMb: TYPE_SHARD_RSS_LIMIT_MB,
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
      `TypeScript shard ${shard.name}: ${(outcome.wallMs / 1000).toFixed(2)}s wall, ${(outcome.peakGroupRssKb / 1024).toFixed(1)} MiB peak sampled process-group RSS (sampled ceiling ${TYPE_SHARD_RSS_LIMIT_MB} MiB). ${outcome.error ? "Teardown not verified." : "Teardown verified."}\n`
    );
    if (outcome.error) process.stderr.write(`${outcome.error.message}\n`);
    if (outcome.error || outcome.code !== 0 || outcome.stopReason) {
      failed = true;
      break;
    }
  }
} catch (error) {
  failed = true;
  process.stderr.write(`${describeError(error)}\n`);
} finally {
  try {
    if (temporaryDirectory) {
      rmSync(temporaryDirectory, { force: true, recursive: true });
    }
  } catch (error) {
    failed = true;
    process.stderr.write(
      `TypeScript shard cleanup failed: ${describeError(error)}\n`
    );
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
}

if (failed || performance.now() - startedAt > wallLimitMs) {
  process.exitCode = 1;
} else {
  process.stdout.write(
    `Complete TypeScript shards passed in ${((performance.now() - startedAt) / 1000).toFixed(2)}s.\n`
  );
}
