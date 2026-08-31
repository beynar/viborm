import { resolve } from "node:path";
import process from "node:process";
import {
  parseRssLimitArgument,
  startBoundedProcess,
} from "./bounded-process.mjs";
import { acquireTestRunLock } from "./test-run-lock.mjs";

let rssLimit;
try {
  rssLimit = parseRssLimitArgument(process.argv.slice(2));
} catch (error) {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`
  );
  process.exit(2);
}
const [memoryArgument, wallArgument, entry, ...entryArguments] =
  rssLimit.forwardedArguments;
const memoryMb = Number(memoryArgument);
const wallLimitMs = Number(wallArgument);

if (
  !Number.isSafeInteger(memoryMb) ||
  memoryMb <= 0 ||
  !Number.isSafeInteger(wallLimitMs) ||
  wallLimitMs <= 0 ||
  !entry
) {
  process.stderr.write(
    "Usage: run-node-safe.mjs [--rss-limit-mb=N] <memory-mb> <wall-limit-ms> <entry> [...args]\n"
  );
  process.exit(2);
}

let releaseTestRunLock;
try {
  releaseTestRunLock = acquireTestRunLock("bounded Node command");
} catch (error) {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`
  );
  process.exit(1);
}

let run;
try {
  run = startBoundedProcess({
    arguments: [resolve(process.cwd(), entry), ...entryArguments],
    command: process.execPath,
    heapLimitMb: memoryMb,
    label: "Node command",
    rssLimitMb: rssLimit.rssLimitMb,
    wallLimitMs,
  });
} catch (error) {
  releaseTestRunLock();
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`
  );
  process.exit(1);
}
let interrupted = false;
let interruptCount = 0;
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => {
    interrupted = true;
    interruptCount += 1;
    run.terminate(interruptCount > 1 ? "SIGKILL" : signal, "interrupted");
  });
}

const outcome = await run.completion;
let releaseError;
try {
  releaseTestRunLock();
} catch (error) {
  releaseError = error;
}
if (outcome.error) process.stderr.write(`${outcome.error.message}\n`);
if (releaseError) {
  process.stderr.write(
    `${releaseError instanceof Error ? releaseError.message : String(releaseError)}\n`
  );
}
process.stderr.write(
  `Node resources: ${(outcome.wallMs / 1000).toFixed(2)}s wall, ${(outcome.peakGroupRssKb / 1024).toFixed(1)} MiB peak sampled process-group RSS (sampled ceiling ${rssLimit.rssLimitMb} MiB). ${outcome.error ? "Teardown not verified." : "Teardown verified."}\n`
);
process.exitCode =
  interrupted || outcome.stopReason || outcome.code !== 0 || releaseError
    ? 1
    : 0;
