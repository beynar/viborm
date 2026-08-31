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
if (!Number.isSafeInteger(wallLimitMs) || wallLimitMs <= 0) {
  process.stderr.write("--wall-limit-ms must be a positive integer.\n");
  process.exit(2);
}
const requestedArgs = vitestArgs.filter(
  (argument) => argument !== wallLimitArgument
);
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
let run;
try {
  run = startBoundedProcess({
    arguments: [vitestEntry, ...forwardedArgs],
    command: process.execPath,
    heapLimitMb: heapLimit.heapLimitMb,
    label: "Vitest",
    rssLimitMb: rssLimit.rssLimitMb,
    wallLimitMs: forwardedArgs.includes("run") ? wallLimitMs : 86_400_000,
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
if (outcome.error) {
  process.stderr.write(`${outcome.error.message}\n`);
}
if (releaseError) {
  process.stderr.write(
    `${releaseError instanceof Error ? releaseError.message : String(releaseError)}\n`
  );
}
process.stderr.write(
  `Vitest resources: ${(outcome.wallMs / 1000).toFixed(2)}s wall, ${(outcome.peakGroupRssKb / 1024).toFixed(1)} MiB peak sampled process-group RSS (sampled ceiling ${rssLimit.rssLimitMb} MiB). ${outcome.error ? "Teardown not verified." : "Teardown verified."}\n`
);
process.exitCode =
  interrupted || outcome.stopReason || outcome.code !== 0 || releaseError
    ? 1
    : 0;
