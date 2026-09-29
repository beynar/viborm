import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

const runner = new URL("./run-credential-free-tests.mjs", import.meta.url);
const selectionError = /needs a substring|matched no stage/;
const jobBoundary = /^ {2}[\w-]+:\n/m;
const duplicatedStages = new Set([
  "pnpm test:types",
  "pnpm test:core",
  "provider-bun (visible skips when Bun is absent)",
  "provider-d1",
  "pnpm test:package",
]);

test("workflow keeps every delegated check and shallow sparse checkout", () => {
  const workflow = readFileSync(
    new URL("../.github/workflows/ci.yml", import.meta.url),
    "utf8"
  );
  const jobs = workflow.split("\njobs:\n")[1].split(jobBoundary).slice(1);
  assert.equal(jobs.length, 7); // Package matrix supplies the eighth check.
  for (const job of jobs) {
    assert(job.includes("fetch-depth: 1"));
    assert(job.includes("!/docs/architecture/raptor3-evidence/"));
  }
  for (const [job, command] of [
    ["quality", "run: pnpm test:types"],
    ["core", "run: pnpm test:core"],
    ["package", "run: pnpm test:package"],
    ["platform-providers", "--project=provider-bun"],
    ["platform-providers", "--project=provider-d1"],
    ["local-providers", "run: pnpm test:all --ci-local"],
  ]) {
    const body = workflow.split(`  ${job}:\n`)[1]?.split(jobBoundary)[0];
    assert(body?.includes(command), `${job} must execute ${command}`);
  }
  assert(workflow.includes("git fetch --no-tags --depth=1 --filter=blob:none"));
  assert(workflow.includes("git checkout --ignore-skip-worktree-bits HEAD --"));
});

function listStages(...arguments_) {
  // Fail before executing an old runner that does not recognize --list.
  if (
    !readFileSync(runner, "utf8").includes('process.argv.includes("--list")')
  ) {
    throw new Error("Runner must support --list before testing its plan");
  }
  return spawnSync(
    process.execPath,
    [fileURLToPath(runner), "--list", ...arguments_],
    {
      encoding: "utf8",
      timeout: 10_000,
    }
  );
}

function stagePlan(...arguments_) {
  const run = listStages(...arguments_);
  if (run.status !== 0) {
    throw new Error(`Runner failed (${run.status}): ${run.stderr}`, {
      cause: run.error,
    });
  }
  return JSON.parse(run.stdout);
}

test("CI local selection removes only the five separately owned stages", () => {
  const full = stagePlan();
  const local = stagePlan("--ci-local");
  const duplicated = full.filter((stage) => duplicatedStages.has(stage.label));

  assert.equal(duplicated.length, duplicatedStages.size);
  assert.equal(new Set(full.map((stage) => stage.label)).size, full.length);
  assert(full.every((stage) => !Object.hasOwn(stage, "env")));
  // The entire command and all resource bounds survive, not just file names.
  assert.deepEqual(
    local,
    full.filter((stage) => !duplicatedStages.has(stage.label))
  );
  assert.deepEqual(
    [...local, ...duplicated].sort((left, right) =>
      left.label.localeCompare(right.label)
    ),
    full.toSorted((left, right) => left.label.localeCompare(right.label))
  );
  assert(local.some((stage) => stage.label.startsWith("extended-local")));
  for (const provider of ["pglite", "sqlite3", "libsql"]) {
    assert(
      local.some((stage) => stage.label.startsWith(`provider-${provider}:`))
    );
  }
  assert(local.some((stage) => stage.label.startsWith("raptor3-provider:")));
  assert(local.some((stage) => stage.label.startsWith("Raptor 3 fixed")));
});

test("the exhaustive default and focused --only interface remain available", () => {
  const full = stagePlan();
  assert.deepEqual(
    stagePlan("--only", "pnpm test:core"),
    full.filter((stage) => stage.label === "pnpm test:core")
  );
  assert.deepEqual(
    stagePlan("--ci-local", "--only", "provider-sqlite3:"),
    full.filter((stage) => stage.label.startsWith("provider-sqlite3:"))
  );
  // Historical baseline stages are deliberately opt-in rather than default.
  const focused = stagePlan("--only", "raptor3-provider:");
  assert(
    focused.length >
      full.filter((stage) => stage.label.startsWith("raptor3-provider:")).length
  );
});

test("empty or missing selections refuse before taking a test lock", () => {
  for (const arguments_ of [
    ["--only"],
    ["--only", "no-stage-with-this-name"],
    ["--ci-local", "--only", "pnpm test:core"],
  ]) {
    const run = listStages(...arguments_);
    assert.equal(run.status, 2, run.stderr);
    assert.match(run.stderr, selectionError);
    assert.equal(run.stdout, "");
  }
});
