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
if (!Number.isSafeInteger(wallLimitMs) || wallLimitMs <= 0) {
  process.stderr.write("--wall-limit-ms must be a positive integer.\n");
  process.exit(2);
}
const requestedArgs = vitestArgs.filter(
  (argument) => argument !== wallLimitArgument && argument !== shardArgument
);
if (
  !Number.isSafeInteger(shards) ||
  shards < 1 ||
  (shards > 1 &&
    (!isNonWatchRun(requestedArgs) ||
      requestedArgs.some((arg) => arg.startsWith("--shard"))))
) {
  process.stderr.write(
    "--sequential-shards requires a positive integer and an unsharded non-watch run.\n"
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

const startedAt = performance.now();
let failed = false;
try {
  for (let shard = 1; shard <= shards && !interrupted; shard++) {
    const remainingMs = wallLimitMs - (performance.now() - startedAt);
    if (isNonWatchRun(forwardedArgs) && remainingMs <= 0) {
      throw new Error("Vitest aggregate wall limit exceeded");
    }
    const label = shards === 1 ? "Vitest" : `Vitest shard ${shard}/${shards}`;
    run = startBoundedProcess({
      arguments: [
        vitestEntry,
        ...forwardedArgs,
        ...(shards === 1 ? [] : [`--shard=${shard}/${shards}`]),
      ],
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
