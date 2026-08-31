import { spawnSync } from "node:child_process";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  EXTENDED_LOCAL_TEST_SHARDS,
  EXTENDED_LOCAL_TESTS,
  PGLITE_PROVIDER_TESTS,
} from "./credential-free-test-manifest.mjs";

const safeVitestRunner = fileURLToPath(
  new URL("./run-vitest-safe.mjs", import.meta.url)
);

function run(label, command, arguments_) {
  process.stdout.write(`\n[test:all] ${label}\n`);
  const completed = spawnSync(command, arguments_, {
    cwd: process.cwd(),
    env: process.env,
    stdio: "inherit",
  });
  if (completed.error) throw completed.error;
  if (completed.status !== 0) {
    process.exit(completed.status ?? 1);
  }
}

function runPackageScript(script) {
  const packageManager = process.env.npm_execpath;
  // Only re-enter through node when the package manager really is a JS entry
  // point. pnpm installed as @pnpm/exe sets npm_execpath to a native binary,
  // and `node <native binary>` dies with a SyntaxError before any test runs.
  if (packageManager && /\.[cm]?js$/.test(packageManager)) {
    run(`pnpm ${script}`, process.execPath, [packageManager, script]);
    return;
  }
  run(`pnpm ${script}`, packageManager || "pnpm", [script]);
}

/**
 * Every stage this script runs is provider-backed: the extended-local estate and
 * the provider suites all boot a live database. A single live-PGlite suite peaks
 * around 1.6-1.7 GiB, so the 1536 MiB default cannot hold one of them — the cap
 * is a property of PGlite, not of the machine, and a bigger CI runner does not
 * help. These lanes opt up; the fast lanes keep the 1536 MiB default.
 */
// Measured across all 72 extended-local shards: PGlite-backed shards of three
// files cluster between 1.5 and 3.2 GiB. 3584 clears the observed maximum with
// headroom and still sits below MAX_PROCESS_GROUP_RSS_LIMIT_MB.
const PROVIDER_RSS_LIMIT_MB = 3584;

function runVitest(label, wallLimitMs, project, files = []) {
  run(label, process.execPath, [
    safeVitestRunner,
    "--heap-limit-mb=768",
    `--rss-limit-mb=${PROVIDER_RSS_LIMIT_MB}`,
    `--wall-limit-ms=${wallLimitMs}`,
    "run",
    "--workspace",
    "vitest.workspace.ts",
    "--project",
    project,
    ...files,
  ]);
}

runPackageScript("test");

for (const [index, files] of EXTENDED_LOCAL_TEST_SHARDS.entries()) {
  runVitest(
    `extended-local shard ${index + 1}/${EXTENDED_LOCAL_TEST_SHARDS.length} (${files.length} files; ${EXTENDED_LOCAL_TESTS.length} total)`,
    300_000,
    "extended-local",
    files
  );
}

for (const file of PGLITE_PROVIDER_TESTS) {
  runVitest(`provider-pglite: ${file}`, 1_200_000, "provider-pglite", [file]);
}

runVitest("provider-sqlite3", 300_000, "provider-sqlite3", [
  "tests/providers/local/sqlite3.test.ts",
]);
runVitest("provider-libsql", 300_000, "provider-libsql", [
  "tests/providers/local/libsql.test.ts",
]);
runVitest(
  "provider-bun (visible skips when Bun is absent)",
  300_000,
  "provider-bun"
);
runVitest("provider-d1", 300_000, "provider-d1");

runPackageScript("test:package");
