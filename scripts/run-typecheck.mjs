/**
 * Complete TypeScript checking as ONE program.
 *
 * Every file the root tsconfig.json intends is checked by the
 * native TypeScript 7 compiler (`typescript-native`, an alias of
 * typescript@7.0.2) in a single bounded process. Serial compiler scheduling
 * keeps the complete linked-client type graph below the existing RSS ceiling;
 * the complete qualification passed in 44.32 s at 6012.3 MiB. The JS
 * typescript@5.9.3 stays installed for the scripts that use the
 * compiler API, which the native package no longer ships.
 *
 * This replaces two-hundred-odd sequential 1280 MB-heap shards of the JS
 * compiler. They existed only because one JS program over this estate blew
 * that heap, and they took 37 minutes. There is no partition any more, so there
 * is no file a partition can forget, and `pnpm test` runs the complete check
 * instead of a representative lane.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
// A runaway detector, unchanged when compiler scheduling changes.
const WALL_LIMIT_MS = 5 * 60 * 1000;
const label = "TypeScript (whole estate, native)";

/**
 * The declaration an exported extended client emits: the whole-estate program
 * runs with `--noEmit`, and an expanded client is no diagnostic at all (one
 * ordered model emitted 1.2 MB without one). Each export of the fixture must
 * stay a `VibORMClient<…>` reference and fit its budget, in bytes; measured
 * at a quarter to a half of these. Emission writes every program file, so it
 * goes to a scratch directory.
 */
const emitProject = fileURLToPath(
  new URL(
    "../tests/types/client/declaration-emit/tsconfig.json",
    import.meta.url
  )
);
const emitDeclaration =
  "tests/types/client/declaration-emit/extended-clients.d.ts";
const COMPOSED_BUDGET = 96 * 1024;
const emitBudgets = {
  base: 8 * 1024,
  ordered: 24 * 1024,
  softDeleted: 24 * 1024,
  governed: 32 * 1024,
  governedAs: 32 * 1024,
  hooked: 8 * 1024,
  composed: COMPOSED_BUDGET,
  composedAs: COMPOSED_BUDGET,
};
const EXPORTED_CONST = /^export declare const (\w+): /m;
const EACH_EXPORT = /^(?=export declare const )/m;
const CLIENT_REFERENCE = 'import("@src/index").VibORMClient<';

function declarationFailures(declaration) {
  const exports = declaration.split(EACH_EXPORT).slice(1);
  const failures = [];
  const seen = new Set();
  for (const text of exports) {
    const [head, name] = text.match(EXPORTED_CONST) ?? [];
    const budget = emitBudgets[name];
    if (budget === undefined) {
      failures.push(`${name ?? text.slice(0, 40)} has no budget`);
      continue;
    }
    seen.add(name);
    if (!text.startsWith(`${head}${CLIENT_REFERENCE}`))
      failures.push(`${name} is not written as a VibORMClient reference`);
    if (text.length > budget)
      failures.push(`${name}: ${text.length} bytes, budget ${budget}`);
  }
  for (const name of Object.keys(emitBudgets))
    if (!seen.has(name)) failures.push(`${name} was not emitted`);
  return failures;
}

const releaseTestRunLock = acquireTestRunLock(label);
let run;
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.once(signal, () => run?.terminate("SIGTERM", "interrupted"));
}

async function stage(stageLabel, options) {
  run = startBoundedProcess({
    command: process.execPath,
    label: stageLabel,
    ...options,
  });
  const outcome = await run.completion;
  process.stderr.write(`${formatBoundedResourceLine(stageLabel, outcome)}\n`);
  if (outcome.error) process.stderr.write(`${outcome.error.message}\n`);
  if (outcome.stopReason) {
    process.stderr.write(`${stageLabel}: stopped (${outcome.stopReason}).\n`);
  }
  return outcome.error || outcome.stopReason ? 1 : (outcome.code ?? 1);
}

let code = 1;
try {
  code = await stage(label, {
    arguments: [
      nativeTscEntry,
      "--project",
      rootProject,
      "--noEmit",
      "--singleThreaded",
    ],
    // This is Go's collection target, not the process limit. At 5 GiB the
    // linked type graph exceeded 300 s; 6 GiB completed in 100 s
    // at 6896 MiB RSS, inside the unchanged 8192 MiB / 300 s detectors.
    env: { ...process.env, GOMEMLIMIT: process.env.GOMEMLIMIT ?? "6GiB" },
    rssCeiling: WHOLE_ESTATE_TYPECHECK_RSS_CEILING,
    wallLimitMs: WALL_LIMIT_MS,
  });
  if (code === 0) {
    const outDir = mkdtempSync(join(tmpdir(), "viborm-declaration-emit-"));
    try {
      code = await stage("TypeScript (extended-client declarations, native)", {
        arguments: [
          nativeTscEntry,
          "--project",
          emitProject,
          "--outDir",
          outDir,
          "--singleThreaded",
        ],
        env: { ...process.env, GOMEMLIMIT: "1200MiB" },
        wallLimitMs: 60_000,
      });
      if (code === 0) {
        const failures = declarationFailures(
          readFileSync(join(outDir, emitDeclaration), "utf8")
        );
        for (const failure of failures)
          process.stderr.write(`Extended-client declarations: ${failure}\n`);
        if (failures.length > 0) code = 1;
      }
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  }
} finally {
  releaseTestRunLock();
}
process.exit(code);
