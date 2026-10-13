// biome-ignore-all lint/suspicious/noMisplacedAssertion: Workflow-shape helpers are invoked only from registered tests.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { coverageSubsystems } from "./coverage-policy.mjs";
import {
  CI_LOCAL_SERIAL_STAGE_LABEL,
  shardCredentialFreeCIStages,
} from "./credential-free-test-manifest.mjs";
import { RAPTOR3_DETERMINISTIC_TESTS } from "./raptor3-manifest.mjs";
import { RELEASE_CI_JOBS } from "./release-ci.mjs";

const runner = new URL("./run-credential-free-tests.mjs", import.meta.url);
const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const selectionError = /needs a substring|matched no stage/;
const shardError = /--shard/;
const jobBoundary = /^ {2}[\w-]+:\n/m;
const jobHeading = /^ {2}([\w-]+):\n/gm;
const triggerHeading = /^ {2}([a-z_]+):/gm;
const localLane = /^ {10}- lane: (.+)\n {12}select: (.+)$/gm;
const coverageGroup = /^ {10}- group: (.+)\n {12}subsystems: (.+)$/gm;
const packageNodes = /^ {8}node:\n((?: {10}- .+\n)+)/m;
const listEntry = /^ {10}- "?([^"\n]+)"?$/gm;
const shardSelect = /^--shard=([1-9]\d*)\/([1-9]\d*)$/;
const localRunCommand = /^\s+run: (pnpm test:all --ci-local(?: .*)?)$/gm;
const conditional = /^\s+(?:if|continue-on-error):/m;
const perfTimingsImport = /from "@tests\/fixtures\/perf-timings"/;
const testFile = /\.test\.ts$/;
const LOCAL_SHARDS = 8;
/** A GitHub Actions expression, spelled as the workflow spells it. */
const expression = (body) => `\${{ ${body} }}`;
const MATRIX_LANE = expression("matrix.lane");
const MATRIX_NODE = expression("matrix.node");
const MATRIX_SELECT = expression("matrix.select");
const MATRIX_SUBSYSTEMS = expression("matrix.subsystems");
const MATRIX_GROUP = expression("matrix.group");
const parallelGroup = /- parallel:/;
const jobName = /^ {4}name: (.+)$/m;
const unexpandedExpression = /\$\{\{/;
const pullRequestPathCoverage = /run-coverage\.mjs|test:coverage(?!:policy)/;
const perfTimingsVariable = /VIBORM_PERF_TIMINGS/;
const pushToMain = /\non:\n {2}push:\n {4}branches:\n {6}- main\n/;
const namedTestFile = /^ {10}(tests\/\S+\.test\.ts)$/gm;
const serialSelect = "--only 'Raptor 3 fixed'";
const localCommand = `run: pnpm test:all --ci-local ${MATRIX_SELECT}`;
const duplicatedStages = new Set([
  "pnpm test:types",
  "pnpm test:core",
  "provider-bun (visible skips when Bun is absent)",
  "provider-d1",
  "pnpm test:package",
]);

function readWorkflow(file) {
  return readFileSync(
    new URL(`../.github/workflows/${file}`, import.meta.url),
    "utf8"
  );
}

function workflowJobs(workflow) {
  const body = workflow.split("\njobs:\n")[1];
  const ids = [...body.matchAll(jobHeading)].map((match) => match[1]);
  const bodies = body.split(jobBoundary).slice(1);
  assert.equal(ids.length, bodies.length);
  return new Map(ids.map((id, index) => [id, bodies[index]]));
}

function workflowTriggers(workflow) {
  const block = workflow.split("\non:\n")[1].split("\n\n")[0];
  return [...block.matchAll(triggerHeading)].map((match) => match[1]).sort();
}

const unquote = (value) =>
  value.startsWith('"') && value.endsWith('"') ? value.slice(1, -1) : value;

function assertShallowSparseCheckouts(jobs) {
  for (const [id, job] of jobs) {
    assert(
      job.includes(
        "uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1"
      ),
      `${id} must use the pinned checkout`
    );
    assert(job.includes("fetch-depth: 1"), `${id} must check out shallow`);
    assert(
      job.includes("sparse-checkout-cone-mode: false"),
      `${id} must use a non-cone sparse checkout`
    );
    assert(
      job.includes("!/docs/architecture/raptor3-evidence/"),
      `${id} must exclude the receipt archive`
    );
  }
}

/** Returns the lane names of a valid Local providers matrix. */
function assertLocalProviderMatrix(localJob) {
  const lanes = [...localJob.matchAll(localLane)].map((match) => ({
    lane: match[1],
    select: unquote(match[2]),
  }));
  assert.deepEqual(
    lanes.map(({ select }) => select),
    [
      serialSelect,
      ...Array.from(
        { length: LOCAL_SHARDS },
        (_unused, index) => `--shard=${index + 1}/${LOCAL_SHARDS}`
      ),
    ]
  );
  assert.equal(lanes[0].lane, "Raptor 3 fixed");
  for (const { lane, select } of lanes.slice(1)) {
    const [, index, count] = select.match(shardSelect);
    assert.equal(lane, `shard ${index}/${count}`);
  }
  // One command per leg; every leg runs, on its own runner, to completion.
  assert.deepEqual(
    [...localJob.matchAll(localRunCommand)].map((match) => match[1]),
    [localCommand.slice("run: ".length)]
  );
  assert(localJob.includes(`    name: Local providers (${MATRIX_LANE})\n`));
  assert(localJob.includes("      fail-fast: false\n"));
  assert.doesNotMatch(localJob, conditional);
  assert.doesNotMatch(localJob, parallelGroup);
  return lanes.map(({ lane }) => lane);
}

function expandedJobNames(jobs) {
  const names = [];
  for (const [id, job] of jobs) {
    const name = job.match(jobName)[1];
    if (id === "local-providers") {
      for (const lane of assertLocalProviderMatrix(job)) {
        names.push(name.replace(MATRIX_LANE, lane));
      }
    } else if (name.includes(MATRIX_NODE)) {
      const nodes = [...job.match(packageNodes)[1].matchAll(listEntry)];
      for (const [, node] of nodes) {
        names.push(name.replace(MATRIX_NODE, node));
      }
    } else {
      assert.doesNotMatch(
        name,
        unexpandedExpression,
        `${id} has an unexpanded name`
      );
      names.push(name);
    }
  }
  return names;
}

function testFilesImportingPerfTimings() {
  const files = [];
  for (const entry of readdirSync(join(repositoryRoot, "tests"), {
    recursive: true,
    withFileTypes: true,
  })) {
    if (!(entry.isFile() && testFile.test(entry.name))) continue;
    if (entry.parentPath.includes("node_modules")) continue;
    const path = join(entry.parentPath, entry.name);
    if (perfTimingsImport.test(readFileSync(path, "utf8"))) {
      files.push(relative(repositoryRoot, path));
    }
  }
  return files.sort();
}

test("CI keeps every delegated check and shallow sparse checkout", () => {
  const workflow = readWorkflow("ci.yml");
  const jobs = workflowJobs(workflow);
  assert.deepEqual(
    [...jobs.keys()],
    [
      "quality",
      "core",
      "package",
      "local-providers",
      "docker-providers",
      "platform-providers",
    ]
  );
  assert.deepEqual(workflowTriggers(workflow), ["pull_request", "push"]);
  assertShallowSparseCheckouts(jobs);
  for (const [job, command] of [
    ["quality", "run: pnpm test:types"],
    ["quality", "run: pnpm test:coverage:policy"],
    ["quality", "scripts/credential-free-ci.test.mjs"],
    ["core", "run: pnpm test:core"],
    ["package", "run: pnpm test:package"],
    ["docker-providers", "--project=provider-pg\n"],
    ["docker-providers", "--project=provider-pgbouncer\n"],
    ["platform-providers", "--project=provider-bun"],
    ["platform-providers", "VIBORM_RECURSIVE_WHERE_CHECKERS: bun"],
    ["platform-providers", "--project=provider-d1"],
    ["platform-providers", "--project=provider-tenant-do"],
    ["local-providers", localCommand],
  ]) {
    assert(jobs.get(job).includes(command), `${job} must execute ${command}`);
  }
  assert(workflow.includes("git fetch --no-tags --depth=1 --filter=blob:none"));
  assert(workflow.includes("git checkout --ignore-skip-worktree-bits HEAD --"));
  // Coverage and absolute timing budgets are off the pull-request path.
  assert.doesNotMatch(workflow, pullRequestPathCoverage);
  assert.doesNotMatch(workflow, perfTimingsVariable);
  // The release proof is exactly the set of jobs this workflow runs.
  assert.deepEqual(expandedJobNames(jobs), RELEASE_CI_JOBS);

  const localJob = jobs.get("local-providers");
  for (const broken of [
    localJob.replace(serialSelect, "--only wrong"),
    localJob.replace("select: --shard=8/8", "select: --shard=7/8"),
    localJob.replace("lane: shard 3/8", "lane: shard 4/8"),
    localJob.replace(localCommand, "run: echo omitted"),
    localJob.replace("fail-fast: false", "fail-fast: true"),
    `${localJob}        continue-on-error: true\n`,
  ]) {
    assert.throws(() => assertLocalProviderMatrix(broken));
  }
});

test("coverage runs after merge, split by subsystem, merged by one gate", () => {
  const workflow = readWorkflow("coverage.yml");
  const jobs = workflowJobs(workflow);
  assert.deepEqual([...jobs.keys()], ["coverage", "merge"]);
  assert.deepEqual(workflowTriggers(workflow), [
    "push",
    "schedule",
    "workflow_dispatch",
  ]);
  assert.match(workflow, pushToMain);
  assertShallowSparseCheckouts(jobs);

  const legs = jobs.get("coverage");
  const groups = [...legs.matchAll(coverageGroup)].map((match) => ({
    group: match[1],
    subsystems: match[2].split(","),
  }));
  assert.equal(new Set(groups.map(({ group }) => group)).size, groups.length);
  // Every subsystem runs exactly once, with its own unchanged thresholds.
  const assigned = groups.flatMap(({ subsystems }) => subsystems);
  assert.equal(new Set(assigned).size, assigned.length);
  assert.deepEqual(
    assigned.toSorted(),
    coverageSubsystems.map(({ id }) => id).toSorted()
  );
  assert(legs.includes("    timeout-minutes: 40\n"));
  assert(legs.includes("      fail-fast: false\n"));
  assert(
    legs.includes(
      `run: node --max-old-space-size=768 scripts/run-coverage.mjs shard ${MATRIX_SUBSYSTEMS}\n`
    )
  );
  assert(legs.includes(`name: coverage-shards-${MATRIX_GROUP}\n`));
  assert(legs.includes("path: coverage/.shards/\n"));
  assert.doesNotMatch(legs, conditional);

  const merge = jobs.get("merge");
  assert(merge.includes("    name: Coverage gates\n"));
  assert(merge.includes("    needs: coverage\n"));
  assert(merge.includes("pattern: coverage-shards-*\n"));
  assert(merge.includes("merge-multiple: true\n"));
  assert(
    merge.includes(
      "run: node --max-old-space-size=768 scripts/run-coverage.mjs merge\n"
    )
  );
  assert.doesNotMatch(merge, conditional);
});

test("absolute timing budgets are asserted only in the nightly timing run", () => {
  const workflow = readWorkflow("perf-timings.yml");
  const jobs = workflowJobs(workflow);
  assert.deepEqual([...jobs.keys()], ["timings"]);
  assert.deepEqual(workflowTriggers(workflow), [
    "schedule",
    "workflow_dispatch",
  ]);
  assertShallowSparseCheckouts(jobs);
  const timings = jobs.get("timings");
  assert(timings.includes('      VIBORM_PERF_TIMINGS: "1"\n'));
  // Every test file whose millisecond bounds are gated runs here.
  const gated = testFilesImportingPerfTimings();
  assert(gated.length > 0);
  const named = [...timings.matchAll(namedTestFile)].map((match) => match[1]);
  assert.deepEqual(named.toSorted(), gated);
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
  // Coverage left the pull-request path, and with it the only pull-request
  // execution of part of the deterministic Raptor 3 tree; every file of that
  // tree must still be named by a stage the Local providers legs run.
  const named = new Set(
    local.flatMap((stage) =>
      stage.arguments.filter((argument) => testFile.test(argument))
    )
  );
  assert.deepEqual(
    RAPTOR3_DETERMINISTIC_TESTS.filter((file) => !named.has(file)),
    []
  );
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
  for (const count of [1, 2, 4, 7, LOCAL_SHARDS, parallel.length]) {
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
  for (let index = 2; index <= LOCAL_SHARDS; index += 1) {
    assert.deepEqual(
      stagePlan("--ci-local", `--shard=${index}/${LOCAL_SHARDS}`),
      shardCredentialFreeCIStages(local, index, LOCAL_SHARDS)
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
