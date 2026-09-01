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

const projectRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const tscEntry = fileURLToPath(
  new URL("../node_modules/typescript/bin/tsc", import.meta.url)
);
// A WALL budget, not a memory one. The 1280 MB shard heap is what forces the
// estate into dozens of sequential programs - roughly fifty tsc startups at
// ~8s each - so ten minutes cannot hold it. Memory limits are unchanged.
const wallLimitMs = 1_800_000;
const TYPE_SHARD_HEAP_LIMIT_MB = 1280;
const TYPE_SHARD_RSS_LIMIT_MB = DEFAULT_PROCESS_GROUP_RSS_LIMIT_MB;
/**
 * Ambient declarations belong to every shard. src/standard-schema-spec.d.ts
 * augments "@standard-schema/spec" with StandardSchemaOf, which the scalar
 * builders use in their public `schema()` signatures. Only the production shard
 * included src/**, so every test shard was typechecking the scalars against a
 * DIFFERENT module shape than production and reporting nine phantom TS2724s.
 */
const AMBIENT_DECLARATIONS = ["src/**/*.d.ts"];
/**
 * The former single "production" shard typechecked src, benchmarks, scripts and
 * demo as ONE program and could not fit the 1280 MB shard heap - it OOMed
 * before reporting, which is how two real TS2345 errors in src/cli/utils.ts sat
 * unseen. Measured at that heap: src/** alone peaks at 1476 MiB RSS and passes,
 * scripts + demo passes, and benchmarks/** is the part that does not - its
 * seventeen files build large schemas whose type instantiation dominates. Split
 * into halves it passes at 1450 and 1446 MiB. The benchmark shards are computed
 * from the directory so adding a benchmark cannot silently re-inflate a shard.
 */
const BENCHMARK_SHARD_SIZE = 9;
const benchmarkFiles = readdirSync(resolve(projectRoot, "benchmarks"))
  .filter((file) => file.endsWith(".ts"))
  .sort()
  .map((file) => `benchmarks/${file}`);
const benchmarkShards = Array.from(
  { length: Math.ceil(benchmarkFiles.length / BENCHMARK_SHARD_SIZE) },
  (_unused, index) => ({
    name: `benchmarks-${index + 1}`,
    include: benchmarkFiles.slice(
      index * BENCHMARK_SHARD_SIZE,
      (index + 1) * BENCHMARK_SHARD_SIZE
    ),
  })
);

/**
 * A shard's cost is dominated by the src type closure it pulls in, so a
 * directory with hundreds of test files cannot be one program at a 1280 MB
 * heap - tests/contracts/engine alone holds 347. Chunk every directory shard by
 * file count, computed from disk so growth re-shards itself instead of silently
 * re-inflating one program.
 */
// Chunk by BYTES, not by file count. A 30-file split still OOMed
// contracts-drivers-2 at the 1280 MB heap, because cost tracks how much type
// inference a program carries, not how many files it lists. Any file heavier
// than LARGE gets its own program; the rest pack to BUDGET. 200 KB is measured,
// not guessed: against tests/contracts/engine at a 1280 MB heap, 200 KB of
// sources typechecks in 8.4s and 400 KB OOMs.
const TYPE_SHARD_LARGE_BYTES = 40_000;
// Start GENEROUS and let split-and-retry below find the real limit. A small
// budget over-shards the directories that could take more, and every shard
// pays a full tsc startup, so the cheapest correct strategy is few large
// programs plus automatic halving wherever one does not fit.
const TYPE_SHARD_BUDGET_BYTES = 400_000;

function typescriptFilesUnder(relativeDirectory) {
  const absolute = resolve(projectRoot, relativeDirectory);
  const found = [];
  for (const entry of readdirSync(absolute, { withFileTypes: true })) {
    const child = `${relativeDirectory}/${entry.name}`;
    if (entry.isDirectory()) found.push(...typescriptFilesUnder(child));
    else if (entry.name.endsWith(".ts")) found.push(child);
  }
  return found.sort();
}

function directoryShards(name, relativeDirectory) {
  const files = typescriptFilesUnder(relativeDirectory);
  const weighed = files.map((file) => ({
    file,
    bytes: statSync(resolve(projectRoot, file)).size,
  }));
  const total = weighed.reduce((sum, entry) => sum + entry.bytes, 0);
  if (total <= TYPE_SHARD_BUDGET_BYTES) return [{ name, include: files }];

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

  return groups.map((include, index) => ({
    name: `${name}-${index + 1}`,
    include,
  }));
}

const runtimeShards = [
  { name: "production", include: ["src/**/*.ts"] },
  { name: "tooling", include: ["scripts/*.ts", "demo.ts"] },
  ...benchmarkShards,
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
  ].flatMap((name) => directoryShards(`unit-${name}`, `tests/unit/${name}`)),
  ...["adapters", "architecture", "drivers", "engine", "public-client"].flatMap(
    (name) => directoryShards(`contracts-${name}`, `tests/contracts/${name}`)
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
        include: [...shard.include, ...AMBIENT_DECLARATIONS].map((pattern) =>
          resolve(projectRoot, pattern)
        ),
      })
    );
    return { name: shard.name, project, include: shard.include };
  });

  /**
   * Density varies by directory, so no single byte budget fits everywhere: at
   * 200 KB tests/contracts/engine typechecks in 8.4s while tests/contracts/
   * drivers still OOMs. Rather than guess a smaller global budget and pay for
   * over-sharding everywhere, a shard that fails and still has more than one
   * file is SPLIT IN HALF and retried. The budget is the starting point; this
   * converges on whatever the heap actually allows, and a shard that fails
   * down to a single file is a genuine failure.
   */
  const queue = [...generatedProjects, ...typeProbeProjects];
  const splitDepth = new Map();
  while (queue.length > 0) {
    const shard = queue.shift();
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
      const files = shard.include;
      const depth = splitDepth.get(shard.name) ?? 0;
      if (!(outcome.error || outcome.stopReason) && files && files.length > 1) {
        const middle = Math.ceil(files.length / 2);
        process.stderr.write(
          `TypeScript shard ${shard.name} did not fit; splitting ${files.length} files and retrying.\n`
        );
        const halves = [files.slice(0, middle), files.slice(middle)];
        queue.unshift(
          ...halves.map((include, index) => {
            const name = `${shard.name}.${index + 1}`;
            splitDepth.set(name, depth + 1);
            const project = join(temporaryDirectory, `${name}.json`);
            writeFileSync(
              project,
              JSON.stringify({
                extends: resolve(projectRoot, "tsconfig.json"),
                compilerOptions: { noEmit: true },
                include: [...include, ...AMBIENT_DECLARATIONS].map((pattern) =>
                  resolve(projectRoot, pattern)
                ),
              })
            );
            return { name, project, include };
          })
        );
        continue;
      }
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
