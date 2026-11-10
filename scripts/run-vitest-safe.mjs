import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  parseHeapLimitArgument,
  parseRssLimitArgument,
  startBoundedProcess,
  vitestArgumentsWithSingleWorker,
} from "./bounded-process.mjs";
import { acquireTestRunLock } from "./test-run-lock.mjs";

const vitestEntry = fileURLToPath(
  new URL("../node_modules/vitest/vitest.mjs", import.meta.url)
);
let rssLimit;
try {
  rssLimit = parseRssLimitArgument(process.argv.slice(2));
} catch (error) {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`
  );
  process.exit(2);
}
let heapLimit;
try {
  heapLimit = parseHeapLimitArgument(rssLimit.forwardedArguments, {
    defaultMb: 768,
    maxMb: 768,
  });
} catch (error) {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`
  );
  process.exit(2);
}
const vitestArgs = heapLimit.forwardedArguments;
const wallLimitArgument = vitestArgs.find((argument) =>
  argument.startsWith("--wall-limit-ms=")
);
const wallLimitMs = Number(
  wallLimitArgument?.slice("--wall-limit-ms=".length) ?? 300_000
);
const shardArgument = vitestArgs.find((argument) =>
  argument.startsWith("--sequential-shards=")
);
const shards = Number(shardArgument?.slice("--sequential-shards=".length) ?? 1);
// One Vitest run per selected project, in turn. Vitest 4 keeps every project's
// module graph in its main process for the whole run, so a run over many
// projects outgrows a ceiling each of them fits under alone.
const EACH_PROJECT = "--each-project";
const eachProject = vitestArgs.includes(EACH_PROJECT);
if (!Number.isSafeInteger(wallLimitMs) || wallLimitMs <= 0) {
  process.stderr.write("--wall-limit-ms must be a positive integer.\n");
  process.exit(2);
}
const requestedArgs = vitestArgs.filter(
  (argument) =>
    argument !== wallLimitArgument &&
    argument !== shardArgument &&
    argument !== EACH_PROJECT
);
if (
  !Number.isSafeInteger(shards) ||
  shards < 1 ||
  (eachProject && (shards > 1 || !isNonWatchRun(requestedArgs))) ||
  (shards > 1 &&
    (!isNonWatchRun(requestedArgs) ||
      requestedArgs.some((arg) => arg.startsWith("--shard"))))
) {
  process.stderr.write(
    "--sequential-shards requires a positive integer and an unsharded non-watch run; --each-project a non-watch run without it.\n"
  );
  process.exit(2);
}
const forwardedArgs = vitestArgumentsWithSingleWorker(requestedArgs);
let releaseTestRunLock;
try {
  releaseTestRunLock = acquireTestRunLock("Vitest");
} catch (error) {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`
  );
  process.exit(1);
}
function isNonWatchRun(args) {
  return args.includes("run") || args.includes("--run");
}

let run;
let interrupted = false;
let interruptCount = 0;
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => {
    interrupted = true;
    interruptCount += 1;
    run?.terminate(interruptCount > 1 ? "SIGKILL" : signal, "interrupted");
  });
}

/** Whether `argument` (with `next`) selects projects: `--project[=]x`. */
const isProjectArgument = (argument) =>
  argument === "--project" || argument.startsWith("--project=");
const withoutProjects = (args) =>
  args.filter(
    (argument, index) =>
      !(isProjectArgument(argument) || args[index - 1] === "--project")
  );

/**
 * The runs to make: one, the shards, or one per project the arguments select
 * (listed by Vitest itself, under the same ceilings, in its own order).
 */
async function plannedRuns() {
  if (!eachProject)
    return Array.from({ length: shards }, (_, index) => ({
      label: shards === 1 ? "Vitest" : `Vitest shard ${index + 1}/${shards}`,
      args:
        shards === 1
          ? forwardedArgs
          : [...forwardedArgs, `--shard=${index + 1}/${shards}`],
    }));
  const directory = mkdtempSync(join(tmpdir(), "viborm-projects-"));
  const listing = join(directory, "files.json");
  try {
    run = startBoundedProcess({
      arguments: [
        vitestEntry,
        "list",
        "--filesOnly",
        `--json=${listing}`,
        ...requestedArgs.filter((argument) => argument !== "run"),
      ],
      command: process.execPath,
      heapLimitMb: heapLimit.heapLimitMb,
      label: "Vitest project listing",
      rssLimitMb: rssLimit.rssLimitMb,
      stdio: "ignore",
      wallLimitMs,
    });
    const outcome = await run.completion;
    run = undefined;
    if (outcome.error || outcome.stopReason || outcome.code !== 0)
      throw new Error("Vitest could not list the selected projects");
    const names = [
      ...new Set(
        JSON.parse(readFileSync(listing, "utf8")).map(
          (entry) => entry.projectName
        )
      ),
    ];
    if (names.length === 0)
      throw new Error("--each-project selected no project");
    const shared = withoutProjects(forwardedArgs);
    return names.map((name) => ({
      label: `Vitest ${name}`,
      args: [...shared, `--project=${name}`],
    }));
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
}

const startedAt = performance.now();
let failed = false;
try {
  for (const planned of await plannedRuns()) {
    if (interrupted) break;
    const remainingMs = wallLimitMs - (performance.now() - startedAt);
    if (isNonWatchRun(forwardedArgs) && remainingMs <= 0) {
      throw new Error("Vitest aggregate wall limit exceeded");
    }
    const { label } = planned;
    run = startBoundedProcess({
      arguments: [vitestEntry, ...planned.args],
      command: process.execPath,
      heapLimitMb: heapLimit.heapLimitMb,
      label,
      rssLimitMb: rssLimit.rssLimitMb,
      wallLimitMs: isNonWatchRun(forwardedArgs) ? remainingMs : 86_400_000,
    });
    const outcome = await run.completion;
    run = undefined;
    if (outcome.error) process.stderr.write(`${outcome.error.message}\n`);
    process.stderr.write(
      `${label} resources: ${(outcome.wallMs / 1000).toFixed(2)}s wall, ${(outcome.peakGroupRssKb / 1024).toFixed(1)} MiB peak sampled process-group RSS (sampled ceiling ${rssLimit.rssLimitMb} MiB). ${outcome.error ? "Teardown not verified." : "Teardown verified."}\n`
    );
    if (outcome.error || outcome.stopReason || outcome.code !== 0)
      failed = true;
    // Collect independent shard failures without hiding later regressions.
    // Resource, teardown and interruption failures still stop immediately.
    if (outcome.error || outcome.stopReason) break;
  }
} catch (error) {
  failed = true;
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`
  );
} finally {
  try {
    releaseTestRunLock();
  } catch (error) {
    failed = true;
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`
    );
  }
}
process.exitCode = interrupted || failed ? 1 : 0;
