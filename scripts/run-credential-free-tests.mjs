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
 * the provider suites all boot a live database, and PGlite is a Wasm Postgres,
 * so the 1536 MiB default that the fast lanes run under cannot hold one. That
 * is a property of PGlite rather than of the machine, so a larger CI runner
 * does not help; these lanes opt up instead, and the fast lanes keep 1536.
 *
 * 3584 is chosen, not derived. V8 grows into whatever headroom it is given, so
 * the peak tracks the ceiling: the worst shard measured 2716 MiB under a 2560
 * cap, 3119 under 3072 and 3595 under 3584. This is the lowest value at which
 * every one of the 81 shards clears, and it stays under
 * MAX_PROCESS_GROUP_RSS_LIMIT_MB. Releasing the per-test databases that ~30
 * remaining suites still hold would let it come down.
 */
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
