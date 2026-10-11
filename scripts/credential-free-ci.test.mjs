import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  CI_LOCAL_SERIAL_STAGE_LABEL,
  shardCredentialFreeCIStages,
} from "./credential-free-test-manifest.mjs";

const runner = new URL("./run-credential-free-tests.mjs", import.meta.url);
const selectionError = /needs a substring|matched no stage/;
const shardError = /--shard/;
const jobBoundary = /^ {2}[\w-]+:\n/m;
const localParallelGroup = /^ {6}- parallel:\s*$/gm;
const localRunCommand = /^\s+run: (pnpm test:all --ci-local(?: .*)?)$/gm;
const conditionalChild = /^\s+(?:if|continue-on-error):/m;
const checkoutPath = /^\s+path: (\S+)$/m;
const checkoutRef = /^\s+ref: \$\{\{ github\.sha \}\}$/m;
const workingDirectory = /^\s+working-directory: (.+)$/m;
const temporaryDirectory = /^\s+TMPDIR: (.+)$/m;
const serialCommand = "pnpm test:all --ci-local --only 'Raptor 3 fixed'";
const duplicatedStages = new Set([
  "pnpm test:types",
  "pnpm test:core",
  "provider-bun (visible skips when Bun is absent)",
  "provider-d1",
  "pnpm test:package",
]);

test("workflow keeps every delegated check and shallow sparse checkout", () => {
  function assertLocalProviderCommands(localJob) {
    const parallelGroups = [...localJob.matchAll(localParallelGroup)];
    assert.equal(parallelGroups.length, 1);
    const group = localJob
      .slice(parallelGroups[0].index + parallelGroups[0][0].length)
      .split("\n      - ")[0];
    const commands = (source) =>
      [...source.matchAll(localRunCommand)].map((match) => match[1]);
    const expected = [1, 2, 3, 4].map(
      (index) => `pnpm test:all --ci-local --shard=${index}/4`
    );
    assert.deepEqual(
      commands(localJob).toSorted(),
      [serialCommand, ...expected].toSorted()
    );
    const serial = [...localJob.matchAll(localRunCommand)].find(
      (match) => match[1] === serialCommand
    );
    assert(serial.index < parallelGroups[0].index);
    assert.deepEqual(commands(group).toSorted(), expected);
    assert.equal(new Set(commands(group)).size, 4);
    assert.doesNotMatch(group, conditionalChild);
    const checkouts = localJob
      .split("\n      - ")
      .filter((step) => step.includes("uses: actions/checkout@"));
    assert.equal(checkouts.length, 4);
    assert.deepEqual(
      checkouts.map((step) => step.match(checkoutPath)?.[1]).toSorted(),
      ["shard-2", "shard-3", "shard-4", "source"]
    );
    for (const checkout of checkouts) {
      assert(
        checkout.includes(
          "uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1"
        )
      );
      assert.match(checkout, checkoutRef);
      assert(checkout.includes("fetch-depth: 1"));
      assert(checkout.includes("sparse-checkout-cone-mode: false"));
      assert(checkout.includes("!/docs/architecture/raptor3-evidence/"));
    }
    assert(
      localJob.includes(
        "defaults:\n      run:\n        working-directory: source"
      )
    );
    const lanes = group.split("\n          - ").slice(1);
    assert.equal(lanes.length, 4);
    assert.equal(lanes[0].match(workingDirectory), null);
    for (const [index, lane] of lanes.entries()) {
      if (index > 0) {
        assert.equal(
          lane.match(workingDirectory)?.[1],
          `\${{ github.workspace }}/shard-${index + 1}`
        );
      }
      assert.equal(
        lane.match(temporaryDirectory)?.[1],
        `\${{ runner.temp }}/viborm-ci-local/tmp-${index + 1}`
      );
    }
  }

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
    ["docker-providers", "--project=provider-pg\n"],
    ["docker-providers", "--project=provider-pgbouncer\n"],
    ["platform-providers", "--project=provider-bun"],
    ["platform-providers", "--project=provider-d1"],
    ["local-providers", "run: pnpm test:all --ci-local"],
  ]) {
    const body = workflow.split(`  ${job}:\n`)[1]?.split(jobBoundary)[0];
    assert(body?.includes(command), `${job} must execute ${command}`);
  }
  assert(workflow.includes("git fetch --no-tags --depth=1 --filter=blob:none"));
  assert(workflow.includes("git checkout --ignore-skip-worktree-bits HEAD --"));
  const localJob = workflow
    .split("  local-providers:\n")[1]
    .split(jobBoundary)[0];
  assertLocalProviderCommands(localJob);
  for (const broken of [
    localJob.replace(serialCommand, "pnpm test:all --ci-local --only wrong"),
    localJob.replace(serialCommand, "echo omitted"),
    `        run: ${serialCommand}\n${localJob}`,
  ]) {
    assert.throws(() => assertLocalProviderCommands(broken));
  }
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

test("serial stage and CI shards partition every unchanged stage exactly once", () => {
  const local = stagePlan("--ci-local");
  const original = JSON.stringify(local);
  const serial = local.filter(
    (stage) => stage.label === CI_LOCAL_SERIAL_STAGE_LABEL
  );
  assert.equal(serial.length, 1);
  assert.deepEqual(stagePlan("--ci-local", "--only", "Raptor 3 fixed"), serial);
  const parallel = local.filter(
    (stage) => stage.label !== CI_LOCAL_SERIAL_STAGE_LABEL
  );
  for (const count of [1, 2, 4, 7, parallel.length]) {
    const shards = Array.from({ length: count }, (_unused, index) =>
      shardCredentialFreeCIStages(local, index + 1, count)
    );
    const combined = [...serial, ...shards.flat()];
    assert.equal(combined.length, local.length);
    assert.equal(
      new Set(combined.map((stage) => stage.label)).size,
      local.length
    );
    for (const shard of shards) {
      assert(shard.length > 0);
      const labels = new Set(shard.map((stage) => stage.label));
      // Deep equality also pins commands, heap/RSS/wall bounds and file arguments.
      assert.deepEqual(
        shard,
        parallel.filter((stage) => labels.has(stage.label))
      );
    }
    for (const [index, shard] of shards.entries()) {
      assert.deepEqual(
        shard,
        parallel.filter((_stage, position) => position % count === index)
      );
    }
    assert.deepEqual(
      combined.toSorted((left, right) => left.label.localeCompare(right.label)),
      local.toSorted((left, right) => left.label.localeCompare(right.label))
    );
    assert.deepEqual(stagePlan("--ci-local", `--shard=1/${count}`), shards[0]);
  }
  assert.equal(JSON.stringify(local), original);
  for (const index of [2, 3, 4]) {
    assert.deepEqual(
      stagePlan("--ci-local", `--shard=${index}/4`),
      shardCredentialFreeCIStages(local, index, 4)
    );
  }
});

test("invalid or ambiguous shards refuse before taking a test lock", () => {
  const local = stagePlan("--ci-local");
  for (const arguments_ of [
    ["--shard=1/4"],
    ["--ci-local", "--shard"],
    ["--ci-local", "--shard=0/4"],
    ["--ci-local", "--shard=5/4"],
    ["--ci-local", "--shard=1/0"],
    ["--ci-local", "--shard=1.5/4"],
    ["--ci-local", "--shard=1/9007199254740992"],
    ["--ci-local", `--shard=1/${local.length}`],
    ["--ci-local", `--shard=1/${local.length + 1}`],
    ["--ci-local", "--shard=1/4", "--shard=2/4"],
    ["--ci-local", "--shard=1/4", "--only", "provider-pglite:"],
  ]) {
    const run = listStages(...arguments_);
    assert.equal(run.status, 2, run.stderr);
    assert.match(run.stderr, shardError);
    assert.equal(run.stdout, "");
  }
});
