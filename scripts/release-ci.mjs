#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const CANONICAL_REPOSITORY = "beynar/viborm";
const MAIN_REF = "refs/heads/main";
const WORKFLOW_PATH = ".github/workflows/ci.yml";
const WAIT_INTERVAL_MS = 30_000;
const WAIT_TIMEOUT_MS = 120 * 60_000;
const FULL_COMMIT_SHA_PATTERN = /^[0-9a-f]{40}$/;
const PENDING_STATUSES = new Set([
  "in_progress",
  "pending",
  "queued",
  "requested",
  "waiting",
]);

export const RELEASE_CI_JOBS = Object.freeze([
  "Types, format, and docs",
  "Core tests",
  "Coverage gates",
  "Package contract (Node 22.12.0)",
  "Package contract (Node 24)",
  "Local providers",
  "PostgreSQL and MySQL providers",
  "Bun and D1 providers",
]);

export class ReleaseCiError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = "ReleaseCiError";
  }
}

export class ReleaseCiPendingError extends ReleaseCiError {
  constructor(message, options) {
    super(message, options);
    this.name = "ReleaseCiPendingError";
  }
}

function refuse(message, options) {
  throw new ReleaseCiError(message, options);
}

function pending(message) {
  throw new ReleaseCiPendingError(
    `${message}. Release can continue after exact-main CI passes`
  );
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireRecord(value, description) {
  if (!isRecord(value)) {
    refuse(`${description} must be an object`);
  }
  return value;
}

function requirePositiveInteger(value, description) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    refuse(`${description} must be a positive safe integer`);
  }
  return value;
}

function requireEnvironment(repository, ref, sha) {
  if (repository !== CANONICAL_REPOSITORY) {
    refuse(
      `GITHUB_REPOSITORY must be ${CANONICAL_REPOSITORY}; received ${JSON.stringify(repository)}`
    );
  }
  if (ref !== MAIN_REF) {
    refuse(`GITHUB_REF must be ${MAIN_REF}; received ${JSON.stringify(ref)}`);
  }
  if (typeof sha !== "string" || !FULL_COMMIT_SHA_PATTERN.test(sha)) {
    refuse("GITHUB_SHA must be a lowercase 40-character commit SHA");
  }
}

function requirePages(value, collection, description) {
  if (!Array.isArray(value) || value.length === 0) {
    refuse(`${description} pagination returned no pages`);
  }
  const entries = [];
  for (const [index, page] of value.entries()) {
    const record = requireRecord(page, `${description} page ${index + 1}`);
    if (!Array.isArray(record[collection])) {
      refuse(`${description} page ${index + 1} must contain ${collection}`);
    }
    for (const entry of record[collection]) {
      entries.push(requireRecord(entry, `${description} entry`));
    }
  }
  return entries;
}

function compareRuns(left, right) {
  for (const property of ["run_number", "id", "run_attempt"]) {
    const difference =
      requirePositiveInteger(right[property], `CI run ${property}`) -
      requirePositiveInteger(left[property], `CI run ${property}`);
    if (difference !== 0) return difference;
  }
  return 0;
}

function latestRun(runs) {
  return [...runs].sort(compareRuns)[0];
}

function requireWorkflowRun(run, workflow, sha) {
  const runId = requirePositiveInteger(run.id, "CI run id");
  const attempt = requirePositiveInteger(run.run_attempt, "CI run attempt");
  requirePositiveInteger(run.run_number, "CI run number");
  const runRepository = requireRecord(run.repository, "CI run repository");
  if (runRepository.full_name !== CANONICAL_REPOSITORY) {
    refuse(
      `CI run ${runId} belongs to ${JSON.stringify(runRepository.full_name)}, not ${CANONICAL_REPOSITORY}`
    );
  }
  if (
    run.head_repository !== null &&
    (!isRecord(run.head_repository) ||
      run.head_repository.full_name !== CANONICAL_REPOSITORY)
  ) {
    refuse(`CI run ${runId} head repository is not ${CANONICAL_REPOSITORY}`);
  }
  if (run.workflow_id !== workflow.id || run.path !== WORKFLOW_PATH) {
    refuse(`CI run ${runId} is not an execution of workflow ${WORKFLOW_PATH}`);
  }
  if (run.event !== "push") {
    refuse(`CI run ${runId} used ${JSON.stringify(run.event)}, not push`);
  }
  if (run.head_branch !== "main") {
    refuse(
      `CI run ${runId} targeted ${JSON.stringify(run.head_branch)}, not main`
    );
  }
  if (run.head_sha !== sha) {
    pending(
      `CI has not started for protected main SHA ${sha}; latest main run ${runId} used ${JSON.stringify(run.head_sha)}`
    );
  }
  if (PENDING_STATUSES.has(run.status)) {
    pending(`CI run ${runId} attempt ${attempt} for ${sha} is ${run.status}`);
  }
  if (run.status !== "completed") {
    refuse(
      `CI run ${runId} attempt ${attempt} has unknown status ${JSON.stringify(run.status)}`
    );
  }
  if (run.conclusion !== "success") {
    refuse(
      `CI run ${runId} attempt ${attempt} completed with ${JSON.stringify(run.conclusion)}, not success. Inspect https://github.com/${CANONICAL_REPOSITORY}/actions/runs/${runId}`
    );
  }
  return { attempt, runId };
}

function requireSuccessfulJobs(jobs, runId, attempt, sha) {
  const jobsByName = new Map();
  for (const job of jobs) {
    if (!RELEASE_CI_JOBS.includes(job.name)) continue;
    if (jobsByName.has(job.name)) {
      refuse(
        `CI run ${runId} attempt ${attempt} contains duplicate job ${JSON.stringify(job.name)}`
      );
    }
    jobsByName.set(job.name, job);
  }

  const missing = RELEASE_CI_JOBS.filter((name) => !jobsByName.has(name));
  if (missing.length > 0) {
    refuse(
      `CI run ${runId} attempt ${attempt} is missing required jobs: ${missing.join(", ")}. Re-run all jobs so the latest attempt contains the complete release proof`
    );
  }

  for (const name of RELEASE_CI_JOBS) {
    const job = jobsByName.get(name);
    if (job.run_attempt !== attempt) {
      refuse(
        `CI job ${JSON.stringify(name)} belongs to stale attempt ${JSON.stringify(job.run_attempt)}, not ${attempt}`
      );
    }
    if (job.head_sha !== sha) {
      refuse(
        `CI job ${JSON.stringify(name)} used SHA ${JSON.stringify(job.head_sha)}, not ${sha}`
      );
    }
    if (job.status !== "completed" || job.conclusion !== "success") {
      refuse(
        `CI job ${JSON.stringify(name)} is ${JSON.stringify(job.status)} with conclusion ${JSON.stringify(job.conclusion)}, not completed success. Inspect https://github.com/${CANONICAL_REPOSITORY}/actions/runs/${runId}`
      );
    }
  }
}

export async function verifyReleaseCi({ api, repository, ref, sha }) {
  requireEnvironment(repository, ref, sha);
  if (
    !isRecord(api) ||
    typeof api.read !== "function" ||
    typeof api.readPages !== "function"
  ) {
    refuse("GitHub API reader must provide read and readPages functions");
  }

  const repositoryState = requireRecord(
    await api.read(`/repos/${CANONICAL_REPOSITORY}`),
    "GitHub repository"
  );
  if (
    repositoryState.full_name !== CANONICAL_REPOSITORY ||
    repositoryState.default_branch !== "main"
  ) {
    refuse(
      `GitHub API did not resolve canonical repository ${CANONICAL_REPOSITORY} with default branch main`
    );
  }

  const main = requireRecord(
    await api.read(`/repos/${CANONICAL_REPOSITORY}/branches/main`),
    "GitHub main branch"
  );
  const mainCommit = requireRecord(main.commit, "GitHub main commit");
  if (main.name !== "main" || main.protected !== true) {
    refuse("GitHub main branch must exist and be protected");
  }
  if (mainCommit.sha !== sha) {
    refuse(
      `Protected main is ${JSON.stringify(mainCommit.sha)}, not release SHA ${sha}`
    );
  }

  const workflow = requireRecord(
    await api.read(`/repos/${CANONICAL_REPOSITORY}/actions/workflows/ci.yml`),
    "GitHub CI workflow"
  );
  requirePositiveInteger(workflow.id, "CI workflow id");
  if (
    workflow.path !== WORKFLOW_PATH ||
    workflow.name !== "CI" ||
    workflow.state !== "active"
  ) {
    refuse(
      `GitHub workflow ci.yml must be the active CI workflow at ${WORKFLOW_PATH}`
    );
  }

  const runs = requirePages(
    await api.readPages(
      `/repos/${CANONICAL_REPOSITORY}/actions/workflows/ci.yml/runs?branch=main&event=push&head_sha=${sha}&per_page=100`
    ),
    "workflow_runs",
    "GitHub CI runs"
  );
  const run = latestRun(runs);
  if (run === undefined) {
    pending(`CI has not started for protected main SHA ${sha}`);
  }
  const { attempt, runId } = requireWorkflowRun(run, workflow, sha);
  const jobs = requirePages(
    await api.readPages(
      `/repos/${CANONICAL_REPOSITORY}/actions/runs/${runId}/attempts/${attempt}/jobs?per_page=100`
    ),
    "jobs",
    "GitHub CI jobs"
  );
  requireSuccessfulJobs(jobs, runId, attempt, sha);

  const observedRun = requireRecord(
    await api.read(`/repos/${CANONICAL_REPOSITORY}/actions/runs/${runId}`),
    "Reobserved GitHub CI run"
  );
  const observed = requireWorkflowRun(observedRun, workflow, sha);
  if (observed.runId !== runId || observed.attempt !== attempt) {
    pending(
      `CI run ${runId} changed from attempt ${attempt} to ${observed.attempt} while its proof was read`
    );
  }
  const observedMain = requireRecord(
    await api.read(`/repos/${CANONICAL_REPOSITORY}/branches/main`),
    "Reobserved GitHub main branch"
  );
  const observedMainCommit = requireRecord(
    observedMain.commit,
    "Reobserved GitHub main commit"
  );
  if (
    observedMain.name !== "main" ||
    observedMain.protected !== true ||
    observedMainCommit.sha !== sha
  ) {
    refuse(`Protected main changed while CI proof for ${sha} was assembled`);
  }

  return {
    attempt,
    jobs: RELEASE_CI_JOBS.length,
    runId,
    sha,
    status: "verified",
  };
}

function parseJson(output, description) {
  try {
    return JSON.parse(output);
  } catch (cause) {
    refuse(`${description} returned invalid JSON`, { cause });
  }
}

function runGh(endpoint, paginated) {
  const arguments_ = ["api", "-H", "Accept: application/vnd.github+json"];
  if (paginated) arguments_.push("--paginate", "--slurp");
  arguments_.push(endpoint);
  const execution = spawnSync("gh", arguments_, {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    timeout: 15_000,
  });
  if (execution.error !== undefined) {
    refuse(`Cannot run gh api for ${endpoint}`, { cause: execution.error });
  }
  if (execution.status !== 0) {
    refuse(
      `gh api failed for ${endpoint} with exit status ${JSON.stringify(execution.status)}`
    );
  }
  return parseJson(execution.stdout, `gh api ${endpoint}`);
}

export function createGithubApiReader() {
  return {
    read: (endpoint) => runGh(endpoint, false),
    readPages: (endpoint) => runGh(endpoint, true),
  };
}

function sleep(milliseconds) {
  return new Promise((resolvePromise) => {
    setTimeout(resolvePromise, milliseconds);
  });
}

export async function waitForReleaseCi({
  wait = false,
  now = Date.now,
  onPending = () => {
    // Library callers opt into progress reporting.
  },
  sleepFor = sleep,
  ...verification
}) {
  const deadline = now() + WAIT_TIMEOUT_MS;
  let lastPendingMessage;
  for (;;) {
    try {
      return await verifyReleaseCi(verification);
    } catch (error) {
      if (!(error instanceof ReleaseCiPendingError && wait)) throw error;
      const remaining = deadline - now();
      if (remaining <= 0) {
        refuse(
          `Timed out after 120 minutes waiting for exact-main CI. Last observation: ${error.message}`
        );
      }
      if (error.message !== lastPendingMessage) {
        onPending(error.message);
        lastPendingMessage = error.message;
      }
      await sleepFor(Math.min(WAIT_INTERVAL_MS, remaining));
    }
  }
}

export function parseReleaseCiArguments(argv) {
  if (argv.length === 0) return { wait: false };
  if (argv.length === 1 && argv[0] === "--wait") return { wait: true };
  refuse("Usage: node scripts/release-ci.mjs [--wait]");
}

export async function runReleaseCiCli(argv, environment = process.env) {
  const options = parseReleaseCiArguments(argv);
  const proof = await waitForReleaseCi({
    api: createGithubApiReader(),
    ref: environment.GITHUB_REF,
    repository: environment.GITHUB_REPOSITORY,
    sha: environment.GITHUB_SHA,
    wait: options.wait,
    onPending: (message) => {
      process.stderr.write(`release-ci: waiting: ${message}\n`);
    },
  });
  process.stdout.write(`${JSON.stringify(proof)}\n`);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === SCRIPT_PATH) {
  try {
    await runReleaseCiCli(process.argv.slice(2));
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unknown release CI failure";
    process.stderr.write(`release-ci: ${message}\n`);
    process.exitCode = 1;
  }
}
