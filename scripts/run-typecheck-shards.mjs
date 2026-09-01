import {
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  DEFAULT_PROCESS_GROUP_RSS_LIMIT_MB,
  startBoundedProcess,
} from "./bounded-process.mjs";
import { acquireTestRunLock } from "./test-run-lock.mjs";

const projectRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const tscEntry = fileURLToPath(
  new URL("../node_modules/typescript/bin/tsc", import.meta.url)
);
// A WALL budget, not a memory one, and the honest price of the 1280 MB shard
// heap on this codebase. Provider suites alone need one program each and the
// whole estate lands near two hundred sequential tsc runs at ~9s. Memory limits
// are untouched; this is the time that buys them.
const EXHAUSTIVE_WALL_LIMIT_MS = 3_600_000;
/**
 * The fast lane's ceiling, not its expectation.
 *
 * `pnpm test` is `test:types:fast && test:core` and must finish inside five
 * minutes. The fast lane is ten shards: nine ordinary ones at ~9s plus the
 * production shard, which is 545 files and the slowest single program in the
 * estate. Three minutes is a real bound with room for that, and it leaves the
 * runtime core the rest of the five. A fast lane that blows this has stopped
 * being fast and should fail rather than quietly eat the whole budget.
 */
const FAST_WALL_LIMIT_MS = 180_000;
const TYPE_SHARD_HEAP_LIMIT_MB = 1280;
const TYPE_SHARD_RSS_LIMIT_MB = DEFAULT_PROCESS_GROUP_RSS_LIMIT_MB;
/**
 * Ambient declarations belong to every shard. src/standard-schema-spec.d.ts
 * augments "@standard-schema/spec" with StandardSchemaOf, which the scalar
 * builders use in their public `schema()` signatures. Only the production shard
 * included src/**, so every test shard was typechecking the scalars against a
 * DIFFERENT module shape than production and reporting nine phantom TS2724s.
 *
 * This is the one pattern that is allowed to be a glob, and it is deliberately
 * NOT part of any shard's `include` array: it is layered onto the generated
 * project alongside that array, so split-and-retry still has only concrete
 * files to halve. The declarations it names are also carried, exactly once, by
 * the production shard, so they are partitioned like everything else.
 */
const AMBIENT_DECLARATIONS = ["src/**/*.d.ts"];
/**
 * The former single "production" shard typechecked src, benchmarks, scripts and
 * demo as ONE program and could not fit the 1280 MB shard heap - it OOMed
 * before reporting, which is how two real TS2345 errors in src/cli/utils.ts sat
 * unseen. Measured at that heap: src/** alone peaks at 1476 MiB RSS and passes,
 * scripts + demo passes, and benchmarks/** is the part that does not - its
 * files build large schemas whose type instantiation dominates. Split into
 * halves it passes at 1450 and 1446 MiB. The benchmark shards are computed
 * from the directory so adding a benchmark cannot silently re-inflate a shard.
 */
const BENCHMARK_SHARD_SIZE = 9;

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
// Start SMALL ENOUGH THAT MOST SHARDS FIT. Starting generous is pathological:
// every oversized shard burns a full ~9s OOM before it is halved, and halving
// recurses, so a 400 KB start produced 259 shards from 56 splits. At 150 KB
// almost everything fits first time and split-and-retry below is a safety net
// for the few dense outliers rather than the main mechanism.
const TYPE_SHARD_BUDGET_BYTES = 150_000;
const TEST_FILE_SUFFIX = /\.test\.ts$/;

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

/**
 * Pack a file list into shards under the measured byte budget.
 *
 * Every multi-file shard goes through here. support-and-providers used to be
 * the one exception - a hand-built list that reached 440 KB, three times the
 * budget - so it could only ever reach a runnable size by OOMing and being
 * halved, twice, at a full ~9s per attempt. Its files are drawn from several
 * roots rather than one directory, which is the only reason it is assembled by
 * hand; that is no reason for it to skip the packer.
 */
function packShards(name, files) {
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

const directoryShards = (name, relativeDirectory) =>
  packShards(name, typescriptFilesUnder(relativeDirectory));

/**
 * The shard plan: every file the root tsconfig.json intends, partitioned.
 *
 * Exported and side-effect free so the architecture census can read the real
 * plan instead of a second copy of it. Nothing here spawns a process; the cost
 * is a directory walk and a stat per file.
 *
 * Every entry's `include` holds CONCRETE FILE PATHS. split-and-retry halves
 * that array when a shard does not fit, so a glob is indivisible: a shard that
 * bottomed out at one pattern covering every provider file could never be made
 * to fit, which is why the property is load-bearing rather than stylistic.
 */
export function typecheckShardPlan() {
  // Recursive, not top-level. `readdirSync("benchmarks")` filtered to `.ts`
  // never descended, so benchmarks/internal/operation.ts - which the root
  // tsconfig's `benchmarks/**/*.ts` plainly intends - was in no shard at all
  // and was never typechecked by this runner.
  const benchmarkFiles = typescriptFilesUnder("benchmarks");
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
   * Provider suites get one program EACH, with no packing attempt.
   *
   * Each is ~3.7M type instantiations against a measured cliff at ~3.85M, so no
   * two of them ever share a program. Letting the packer try anyway cost a full
   * ~9s OOM per pair before the split, which is what produced 250 shards from
   * 41 splits. Declaring the truth up front removes the wasted attempts.
   */
  const providerOwnShards = typescriptFilesUnder("tests/providers").map(
    (file) => ({
      name: `provider-${file.split("/").pop()?.replace(TEST_FILE_SUFFIX, "")}`,
      include: [file],
    })
  );

  const runtimeShards = [
    { name: "production", include: typescriptFilesUnder("src") },
    {
      name: "tooling",
      include: [
        // `scripts/*.ts`, matching the root tsconfig's own non-recursive
        // pattern for this directory.
        ...readdirSync(resolve(projectRoot, "scripts"))
          .filter((file) => file.endsWith(".ts"))
          .sort()
          .map((file) => `scripts/${file}`),
        "demo.ts",
      ],
    },
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
    ...[
      "adapters",
      "architecture",
      "drivers",
      "engine",
      "public-client",
    ].flatMap((name) =>
      directoryShards(`contracts-${name}`, `tests/contracts/${name}`)
    ),
    ...providerOwnShards,
    // Everything under tests/ that is neither a suite directory nor a provider:
    // the shared fixtures, the packaging suite, and the two loose files. Listed
    // as concrete files, never globs. split-and-retry halves a shard's
    // `include` array, so a glob is indivisible: this shard used to bottom out
    // at one pattern covering every provider file and could never be made to
    // fit.
    ...packShards("support-and-providers", [
      "tests/inventory.ts",
      // The loose file at the root of tests/contracts. The contracts shards are
      // built per SUBDIRECTORY, so nothing sitting directly in tests/contracts
      // is reached by any of them, and this file was in no shard at all.
      "tests/contracts/contract.ts",
      ...typescriptFilesUnder("tests/fixtures"),
      ...typescriptFilesUnder("tests/package"),
    ]),
  ];

  /**
   * The compile-only type cores, as CONCRETE FILES.
   *
   * These used to pass `tests/types/<layer>/tsconfig.json` straight through with
   * no include array, which made them the last category split-and-retry could
   * not touch: types-client OOMed and simply failed, even though the same estate
   * is already split three ways by run-layer-core for exactly this reason.
   * Packing them by byte weight lets them shard and, if a chunk still does not
   * fit, be halved like everything else.
   *
   * These walk the whole layer directory, so every `.ts` under
   * tests/types/<layer> lands here - including the non-probe scratch files such
   * as tests/types/relations/debug-relation-type.ts. That file was ALSO listed
   * by hand in support-and-providers, which typechecked it twice, once against
   * the root tsconfig and once against the layer one.
   */
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
  ].flatMap((name) =>
    // The type cores extend the layer tsconfig, not the root one.
    directoryShards(`types-${name}`, `tests/types/${name}`).map((shard) => ({
      ...shard,
      extendsPath: "tests/types/tsconfig.layer.json",
    }))
  );

  return [...runtimeShards, ...typeProbeProjects];
}

/**
 * The fast lane's selection, by shard family.
 *
 * `pnpm test` cannot afford the complete estate - over two hundred shards at
 * ~9s - so `--fast` runs the production shard plus one shard from each
 * structurally distinct category. Ten shards. It is REPRESENTATIVE, NOT
 * EXHAUSTIVE, and the runner says so on every run.
 *
 * Each name is a FAMILY, resolved to the first shard the plan produces for it,
 * because a family's chunk count moves with the tree: `directoryShards` emits
 * `types-client` when the directory fits one program and `types-client-1` when
 * it does not. A family that resolves to nothing is a hard error rather than a
 * silently smaller lane.
 *
 * Why these ten:
 *   production             - src as one program; the code being shipped.
 *   tooling                - scripts/*.ts and demo.ts; typechecked nowhere else.
 *   benchmarks             - the densest schema-building type instantiation.
 *   unit-relations         - tests/unit, and the recursion-heaviest layer in it.
 *   contracts-engine       - tests/contracts, and the widest family in it.
 *   contracts-public-client- the public client surface's heaviest inference.
 *   support-and-providers  - tests/fixtures, tests/package and the loose files.
 *   provider-pglite        - tests/providers, whose files each need a program.
 *   types-relations        - a compile-only core on the LAYER tsconfig, which
 *                            no other family in this lane extends.
 *   types-client           - the heaviest compile-only core.
 *
 * `pnpm test:types` remains the complete, exhaustive lane; nothing here removes
 * a probe or a file from it.
 */
export const FAST_LANE_FAMILIES = Object.freeze([
  "production",
  "tooling",
  "benchmarks",
  "unit-relations",
  "contracts-engine",
  "contracts-public-client",
  "support-and-providers",
  "provider-pglite",
  "types-relations",
  "types-client",
]);

/**
 * Resolve FAST_LANE_FAMILIES against a plan, in plan order.
 *
 * An exact name wins over a prefix so `provider-pglite` selects
 * tests/providers/local/pglite.test.ts rather than whichever
 * `provider-pglite-*` sorts first.
 */
export function fastLaneShards(plan) {
  const selected = [];
  const missing = [];
  for (const family of FAST_LANE_FAMILIES) {
    const shard =
      plan.find((entry) => entry.name === family) ??
      plan.find((entry) => entry.name.startsWith(`${family}-`));
    if (shard === undefined) missing.push(family);
    else selected.push(shard);
  }
  if (missing.length > 0) {
    throw new Error(
      `Fast TypeScript lane selects families that no shard provides: ${missing.join(", ")}. Fix the selection in scripts/run-typecheck-shards.mjs.`
    );
  }
  return selected;
}

const describeError = (error) =>
  error instanceof Error ? error.message : String(error);

function parseLane(argumentList) {
  const unknown = argumentList.filter((value) => value !== "--fast");
  if (unknown.length > 0) {
    throw new Error(
      `Unknown argument(s): ${unknown.join(", ")}. The only flag is --fast.`
    );
  }
  return argumentList.includes("--fast") ? "fast" : "exhaustive";
}

function writeShardProject(directory, shard) {
  const project = join(directory, `${shard.name}.json`);
  writeFileSync(
    project,
    JSON.stringify({
      extends: resolve(projectRoot, shard.extendsPath ?? "tsconfig.json"),
      compilerOptions: { noEmit: true },
      include: [...shard.include, ...AMBIENT_DECLARATIONS].map((pattern) =>
        resolve(projectRoot, pattern)
      ),
    })
  );
  return project;
}

async function main(lane) {
  const fast = lane === "fast";
  const wallLimitMs = fast ? FAST_WALL_LIMIT_MS : EXHAUSTIVE_WALL_LIMIT_MS;
  const laneLabel = fast
    ? "fast (representative) TypeScript shards"
    : "complete TypeScript shards";

  const plan = typecheckShardPlan();
  const shards = fast ? fastLaneShards(plan) : plan;
  if (fast) {
    process.stderr.write(
      `TypeScript FAST LANE: REPRESENTATIVE, NOT EXHAUSTIVE. Running ${shards.length} of ${plan.length} shards (${shards.map((shard) => shard.name).join(", ")}). Run \`pnpm test:types\` for the complete estate.\n`
    );
  }

  let releaseTestRunLock;
  try {
    releaseTestRunLock = acquireTestRunLock(laneLabel);
  } catch (error) {
    process.stderr.write(`${describeError(error)}\n`);
    process.exitCode = 1;
    return;
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
    // `extendsPath` is carried through, not dropped here: the halves that
    // split-and-retry writes below read it, so a type-probe shard that does not
    // fit must keep extending the layer tsconfig rather than silently falling
    // back to the root one.
    const generatedProjects = shards.map((shard) => ({
      name: shard.name,
      project: writeShardProject(temporaryDirectory, shard),
      include: shard.include,
      extendsPath: shard.extendsPath,
    }));

    /**
     * Density varies by directory, so no single byte budget fits everywhere: at
     * 200 KB tests/contracts/engine typechecks in 8.4s while tests/contracts/
     * drivers still OOMs. Rather than guess a smaller global budget and pay for
     * over-sharding everywhere, a shard that fails and still has more than one
     * file is SPLIT IN HALF and retried. The budget is the starting point; this
     * converges on whatever the heap actually allows, and a shard that fails
     * down to a single file is a genuine failure.
     */
    const queue = [...generatedProjects];
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
        if (
          !(outcome.error || outcome.stopReason) &&
          files &&
          files.length > 1
        ) {
          const middle = Math.ceil(files.length / 2);
          process.stderr.write(
            `TypeScript shard ${shard.name} did not fit; splitting ${files.length} files and retrying.\n`
          );
          const halves = [files.slice(0, middle), files.slice(middle)];
          queue.unshift(
            ...halves.map((include, index) => {
              const name = `${shard.name}.${index + 1}`;
              splitDepth.set(name, depth + 1);
              return {
                name,
                project: writeShardProject(temporaryDirectory, {
                  extendsPath: shard.extendsPath,
                  include,
                  name,
                }),
                include,
                extendsPath: shard.extendsPath,
              };
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

  const elapsedSeconds = ((performance.now() - startedAt) / 1000).toFixed(2);
  if (failed || performance.now() - startedAt > wallLimitMs) {
    process.exitCode = 1;
  } else if (fast) {
    process.stdout.write(
      `Fast TypeScript shards passed in ${elapsedSeconds}s. THIS LANE IS NOT EXHAUSTIVE: it typechecked ${shards.length} of the ${plan.length} shards that make up the estate. \`pnpm test:types\` runs all of them.\n`
    );
  } else {
    process.stdout.write(
      `Complete TypeScript shards passed in ${elapsedSeconds}s.\n`
    );
  }
}

/**
 * Run only when invoked as a script.
 *
 * The architecture census imports this module for `typecheckShardPlan()`, and
 * importing must never spawn tsc or take the test-run lock.
 */
function invokedAsScript() {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(entry)).href;
  } catch {
    return false;
  }
}

if (invokedAsScript()) {
  try {
    main(parseLane(process.argv.slice(2))).catch((error) => {
      process.exitCode = 1;
      process.stderr.write(`${describeError(error)}\n`);
    });
  } catch (error) {
    process.exitCode = 1;
    process.stderr.write(`${describeError(error)}\n`);
  }
}
