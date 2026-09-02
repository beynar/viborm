/**
 * Complete TypeScript checking as ONE program.
 *
 * Every file the root tsconfig.json intends - 1589 of them - is checked by the
 * native TypeScript 7 compiler (`typescript-native`, an alias of
 * typescript@7.0.2) in a single bounded process: measured 5.7 s and 5342 MiB
 * peak. The JS typescript@5.9.3 stays installed for the scripts that use the
 * compiler API, which the native package no longer ships.
 *
 * This replaces two-hundred-odd sequential 1280 MB-heap shards of the JS
 * compiler. They existed only because one JS program over this estate blew
 * that heap, and they took 37 minutes. There is no partition any more, so there
 * is no file a partition can forget, and `pnpm test` runs the complete check
 * instead of a representative lane.
 */
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  formatBoundedResourceLine,
  startBoundedProcess,
  WHOLE_ESTATE_TYPECHECK_RSS_CEILING,
} from "./bounded-process.mjs";
import { acquireTestRunLock } from "./test-run-lock.mjs";

// The alias's bin is a Node shim that execve()s the platform binary, so the
// process group the ceiling samples is the compiler itself.
const nativeTscEntry = fileURLToPath(
  new URL("../node_modules/typescript-native/bin/tsc", import.meta.url)
);
const rootProject = fileURLToPath(new URL("../tsconfig.json", import.meta.url));
// A runaway detector, like the ceiling: the measured run is under six seconds.
const WALL_LIMIT_MS = 5 * 60 * 1000;
const label = "TypeScript (whole estate, native)";

const releaseTestRunLock = acquireTestRunLock(label);
let run;
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.once(signal, () => run?.terminate("SIGTERM", "interrupted"));
}

let code = 1;
try {
  run = startBoundedProcess({
    arguments: [nativeTscEntry, "--project", rootProject, "--noEmit"],
    command: process.execPath,
    label,
    rssCeiling: WHOLE_ESTATE_TYPECHECK_RSS_CEILING,
    wallLimitMs: WALL_LIMIT_MS,
  });
  const outcome = await run.completion;
  process.stderr.write(`${formatBoundedResourceLine(label, outcome)}\n`);
  if (outcome.error) process.stderr.write(`${outcome.error.message}\n`);
  if (outcome.stopReason) {
    process.stderr.write(`${label}: stopped (${outcome.stopReason}).\n`);
  }
  code = outcome.error || outcome.stopReason ? 1 : (outcome.code ?? 1);
} finally {
  releaseTestRunLock();
}
process.exit(code);
