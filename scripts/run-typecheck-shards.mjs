import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_PROCESS_GROUP_RSS_LIMIT_MB,
  startBoundedProcess,
} from "./bounded-process.mjs";
import { acquireTestRunLock } from "./test-run-lock.mjs";

const projectRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const tscEntry = fileURLToPath(
  new URL("../node_modules/typescript/bin/tsc", import.meta.url)
);
const wallLimitMs = 600_000;
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
  ].map((name) => ({ name: `unit-${name}`, include: [`tests/unit/${name}/**/*.ts`] })),
  ...["adapters", "architecture", "drivers", "engine", "public-client"].map(
    (name) => ({
      name: `contracts-${name}`,
      include: [`tests/contracts/${name}/**/*.ts`],
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
      heapLimitMb: 1280,
      label: `TypeScript shard ${shard.name}`,
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
      `TypeScript shard ${shard.name}: ${(outcome.wallMs / 1000).toFixed(2)}s wall, ${(outcome.peakGroupRssKb / 1024).toFixed(1)} MiB peak sampled process-group RSS (sampled ceiling ${DEFAULT_PROCESS_GROUP_RSS_LIMIT_MB} MiB). ${outcome.error ? "Teardown not verified." : "Teardown verified."}\n`
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
    process.stderr.write(`TypeScript shard cleanup failed: ${describeError(error)}\n`);
  } finally {
    try {
      releaseTestRunLock();
    } catch (error) {
      failed = true;
      process.stderr.write(`Test-run lock release failed: ${describeError(error)}\n`);
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
