import assert from "node:assert/strict";
import test from "node:test";
import {
  parseReleaseCiArguments,
  RELEASE_CI_JOBS,
  ReleaseCiError,
  ReleaseCiPendingError,
  verifyReleaseCi,
  waitForReleaseCi,
} from "../../scripts/release-ci.mjs";

const sha = "a".repeat(40);
const otherSha = "b".repeat(40);
const repository = "beynar/viborm";
const ref = "refs/heads/main";
const workflowId = 346_001_797;
const headSha = "c".repeat(40);
const parentSha = "d".repeat(40);
const treeSha = "e".repeat(40);
const headBranch = "fix/release-proof";

function workflowRun(overrides = {}) {
  return {
    conclusion: "success",
    event: "push",
    head_branch: "main",
    head_sha: sha,
    id: 200,
    path: ".github/workflows/ci.yml",
    repository: { full_name: repository },
    run_attempt: 2,
    run_number: 20,
    status: "completed",
    head_repository: { full_name: repository },
    workflow_id: workflowId,
    ...overrides,
  };
}

function workflowJob(name, overrides = {}) {
  return {
    conclusion: "success",
    head_sha: sha,
    name,
    run_attempt: 2,
    status: "completed",
    ...overrides,
  };
}

function pullRun(overrides = {}) {
  return workflowRun({
    event: "pull_request",
    head_branch: headBranch,
    head_sha: headSha,
    id: 190,
    run_attempt: 1,
    run_number: 18,
    ...overrides,
  });
}

function pullJobs(overrides = () => ({})) {
  return [
    {
      jobs: RELEASE_CI_JOBS.map((name, index) =>
        workflowJob(name, {
          head_sha: headSha,
          run_attempt: 1,
          ...overrides(index),
        })
      ),
    },
  ];
}

function mergedPull(overrides = {}) {
  return {
    base: { ref: "main" },
    head: { ref: headBranch, sha: headSha },
    merge_commit_sha: sha,
    merged_at: "2026-10-10T08:00:00Z",
    number: 90,
    ...overrides,
  };
}

function fixture(overrides = {}) {
  return {
    commits: {
      [headSha]: { parents: [{ sha: parentSha }], tree: { sha: treeSha } },
      [sha]: { parents: [{ sha: parentSha }], tree: { sha: treeSha } },
    },
    comparison: { status: "ahead" },
    pulls: [],
    pullJobsPages: pullJobs(),
    pullRunsPages: [{ workflow_runs: [pullRun()] }],
    observedPullRun: pullRun(),
    jobsPages: [
      { jobs: RELEASE_CI_JOBS.slice(0, 3).map(workflowJob) },
      { jobs: RELEASE_CI_JOBS.slice(3).map(workflowJob) },
    ],
    main: { commit: { sha }, name: "main", protected: true },
    observedRun: workflowRun(),
    repositoryState: { default_branch: "main", full_name: repository },
    runsPages: [
      { workflow_runs: [workflowRun({ id: 199, run_number: 19 })] },
      { workflow_runs: [workflowRun()] },
    ],
    workflow: {
      id: workflowId,
      name: "CI",
      path: ".github/workflows/ci.yml",
      state: "active",
    },
    ...overrides,
  };
}

// A push run that is pending, absent, or superseded falls back to the
// pull-request tree proof; this release commit is a squash of PR #90.
function pullFixture(overrides = {}) {
  return fixture({
    pulls: [mergedPull()],
    runsPages: [
      {
        workflow_runs: [
          workflowRun({ conclusion: null, status: "in_progress" }),
        ],
      },
    ],
    ...overrides,
  });
}

function apiFor(state, reads = []) {
  let mainReads = 0;
  const repo = `/repos/${repository}`;
  return {
    async read(endpoint) {
      reads.push(endpoint);
      if (endpoint === repo) return state.repositoryState;
      if (endpoint === `${repo}/branches/main`) {
        mainReads += 1;
        return mainReads > 1 ? (state.observedMain ?? state.main) : state.main;
      }
      if (endpoint === `${repo}/commits/${sha}/pulls?per_page=100`) {
        return state.pulls;
      }
      if (endpoint.startsWith(`${repo}/git/commits/`)) {
        return state.commits[endpoint.slice(`${repo}/git/commits/`.length)];
      }
      if (endpoint === `${repo}/compare/${parentSha}...${headSha}`) {
        return state.comparison;
      }
      if (endpoint === `${repo}/actions/runs/190`) return state.observedPullRun;
      if (endpoint.includes("/actions/runs/")) return state.observedRun;
      if (endpoint === `${repo}/actions/workflows/ci.yml`) {
        return state.workflow;
      }
      throw new Error(`Unexpected read endpoint ${endpoint}`);
    },
    async readPages(endpoint) {
      reads.push(endpoint);
      if (endpoint.includes("/workflows/ci.yml/runs?")) {
        if (endpoint.includes("event=pull_request")) {
          if (
            !(
              endpoint.includes(`head_sha=${headSha}`) &&
              endpoint.includes(`branch=${encodeURIComponent(headBranch)}`)
            )
          ) {
            throw new Error("PR run query did not constrain the PR head");
          }
          return state.pullRunsPages;
        }
        if (!endpoint.includes(`head_sha=${sha}`)) {
          throw new Error("CI run query did not constrain the release SHA");
        }
        return state.runsPages;
      }
      if (endpoint.includes("/runs/190/attempts/")) {
        return state.pullJobsPages;
      }
      if (endpoint.includes("/attempts/2/jobs?")) return state.jobsPages;
      throw new Error(`Unexpected paginated endpoint ${endpoint}`);
    },
  };
}

function verification(state = fixture(), overrides = {}) {
  return {
    api: apiFor(state),
    ref,
    repository,
    sha,
    ...overrides,
  };
}

async function expectRefusal(name, action, ErrorType, text) {
  try {
    await action();
  } catch (error) {
    if (!(error instanceof ErrorType)) throw error;
    if (!error.message.includes(text)) {
      throw new Error(
        `${name} refused with ${JSON.stringify(error.message)}, expected ${JSON.stringify(text)}`
      );
    }
    return error;
  }
  throw new Error(`${name} was accepted`);
}

test("release CI accepts only current complete exact-main proof", async () => {
  const pushReads = [];
  const proof = await verifyReleaseCi({
    api: apiFor(pullFixture({ runsPages: fixture().runsPages }), pushReads),
    ref,
    repository,
    sha,
  });
  assert.deepEqual(proof, {
    attempt: 2,
    jobs: 8,
    proof: "push",
    runId: 200,
    sha,
    status: "verified",
  });
  assert.equal(
    pushReads.some((endpoint) => endpoint.includes("/pulls")),
    false,
    "A successful push run is used without reading pull-request evidence"
  );

  await expectRefusal(
    "wrong repository",
    () =>
      verifyReleaseCi(
        verification(fixture(), { repository: "someone/viborm" })
      ),
    ReleaseCiError,
    "GITHUB_REPOSITORY must be beynar/viborm"
  );

  await expectRefusal(
    "wrong protected main SHA",
    () =>
      verifyReleaseCi(
        verification(
          fixture({
            main: { commit: { sha: otherSha }, name: "main", protected: true },
          })
        )
      ),
    ReleaseCiError,
    "Protected main"
  );

  for (const workflow of [
    {
      id: workflowId,
      name: "Other",
      path: ".github/workflows/ci.yml",
      state: "active",
    },
    {
      id: workflowId,
      name: "CI",
      path: ".github/workflows/other.yml",
      state: "active",
    },
    {
      id: workflowId,
      name: "CI",
      path: ".github/workflows/ci.yml",
      state: "disabled_manually",
    },
  ]) {
    await expectRefusal(
      "wrong workflow identity",
      () => verifyReleaseCi(verification(fixture({ workflow }))),
      ReleaseCiError,
      "active CI workflow"
    );
  }

  for (const [name, run, message] of [
    [
      "wrong run workflow",
      workflowRun({ workflow_id: workflowId + 1 }),
      "not an execution",
    ],
    ["wrong event", workflowRun({ event: "pull_request" }), "not push"],
    ["wrong branch", workflowRun({ head_branch: "feature" }), "not main"],
    [
      "wrong run repository",
      workflowRun({ repository: { full_name: "someone/viborm" } }),
      "belongs to",
    ],
  ]) {
    await expectRefusal(
      name,
      () =>
        verifyReleaseCi(
          verification(fixture({ runsPages: [{ workflow_runs: [run] }] }))
        ),
      ReleaseCiError,
      message
    );
  }

  await expectRefusal(
    "absent exact-main run",
    () =>
      verifyReleaseCi(
        verification(fixture({ runsPages: [{ workflow_runs: [] }] }))
      ),
    ReleaseCiPendingError,
    "has not started"
  );

  await expectRefusal(
    "wrong run SHA",
    () =>
      verifyReleaseCi(
        verification(
          fixture({
            runsPages: [
              { workflow_runs: [workflowRun({ head_sha: otherSha })] },
            ],
          })
        )
      ),
    ReleaseCiPendingError,
    "latest main run"
  );

  await expectRefusal(
    "new pending run supersedes old success",
    () =>
      verifyReleaseCi(
        verification(
          fixture({
            runsPages: [
              {
                workflow_runs: [
                  workflowRun({
                    id: 201,
                    run_number: 21,
                    status: "in_progress",
                    conclusion: null,
                  }),
                  workflowRun(),
                ],
              },
            ],
          })
        )
      ),
    ReleaseCiPendingError,
    "run 201 attempt 2 for aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa is in_progress"
  );

  for (const status of ["queued", "requested", "waiting", "pending"]) {
    await expectRefusal(
      `${status} run`,
      () =>
        verifyReleaseCi(
          verification(
            fixture({
              runsPages: [
                { workflow_runs: [workflowRun({ status, conclusion: null })] },
              ],
            })
          )
        ),
      ReleaseCiPendingError,
      status
    );
  }

  for (const conclusion of ["failure", "cancelled", "skipped", "timed_out"]) {
    await expectRefusal(
      `${conclusion} run`,
      () =>
        verifyReleaseCi(
          verification(
            fixture({
              runsPages: [{ workflow_runs: [workflowRun({ conclusion })] }],
            })
          )
        ),
      ReleaseCiError,
      conclusion
    );
  }

  await expectRefusal(
    "missing required job",
    () =>
      verifyReleaseCi(
        verification(
          fixture({
            jobsPages: [{ jobs: RELEASE_CI_JOBS.slice(1).map(workflowJob) }],
          })
        )
      ),
    ReleaseCiError,
    "missing required jobs: Types, format, and docs"
  );

  for (const [name, overrides, message] of [
    ["pending job", { conclusion: null, status: "in_progress" }, "in_progress"],
    ["failed job", { conclusion: "failure" }, "failure"],
    ["cancelled job", { conclusion: "cancelled" }, "cancelled"],
    ["skipped job", { conclusion: "skipped" }, "skipped"],
  ]) {
    await expectRefusal(
      name,
      () =>
        verifyReleaseCi(
          verification(
            fixture({
              jobsPages: [
                {
                  jobs: RELEASE_CI_JOBS.map((jobName, index) =>
                    workflowJob(jobName, index === 0 ? overrides : {})
                  ),
                },
              ],
            })
          )
        ),
      ReleaseCiError,
      message
    );
  }

  await expectRefusal(
    "stale job attempt",
    () =>
      verifyReleaseCi(
        verification(
          fixture({
            jobsPages: [
              {
                jobs: RELEASE_CI_JOBS.map((name, index) =>
                  workflowJob(name, index === 0 ? { run_attempt: 1 } : {})
                ),
              },
            ],
          })
        )
      ),
    ReleaseCiError,
    "stale attempt 1, not 2"
  );

  await expectRefusal(
    "attempt changed while reading jobs",
    () =>
      verifyReleaseCi(
        verification(
          fixture({
            observedRun: workflowRun({ run_attempt: 3 }),
          })
        )
      ),
    ReleaseCiPendingError,
    "changed from attempt 2 to 3"
  );

  const waitStates = [
    fixture({ runsPages: [{ workflow_runs: [] }] }),
    fixture({
      runsPages: [
        {
          workflow_runs: [
            workflowRun({ conclusion: null, status: "in_progress" }),
          ],
        },
      ],
    }),
    fixture(),
  ];
  let waitRead = 0;
  let clock = 0;
  const sleeps = [];
  const pendingMessages = [];
  const waitingApi = {
    async read(endpoint) {
      return apiFor(waitStates[Math.min(waitRead, waitStates.length - 1)]).read(
        endpoint
      );
    },
    async readPages(endpoint) {
      const current = waitStates[Math.min(waitRead, waitStates.length - 1)];
      if (endpoint.includes("/workflows/ci.yml/runs?")) waitRead += 1;
      return apiFor(current).readPages(endpoint);
    },
  };
  const waitedProof = await waitForReleaseCi({
    api: waitingApi,
    now: () => clock,
    ref,
    repository,
    sha,
    onPending: (message) => pendingMessages.push(message),
    sleepFor: async (milliseconds) => {
      sleeps.push(milliseconds);
      clock += milliseconds;
    },
    wait: true,
  });
  assert.equal(waitedProof.status, "verified");
  assert.deepEqual(sleeps, [30_000, 30_000]);
  assert.equal(pendingMessages.length, 2);

  let unexpectedSleep = false;
  const apiFailure = new Error("transport unavailable");
  await assert.rejects(
    waitForReleaseCi({
      api: {
        read: async () => {
          throw apiFailure;
        },
        readPages: async () => [],
      },
      now: () => 0,
      ref,
      repository,
      sha,
      sleepFor: async () => {
        unexpectedSleep = true;
      },
      wait: true,
    }),
    (error) => error === apiFailure
  );
  assert.equal(unexpectedSleep, false, "API failures must not be retried");

  unexpectedSleep = false;
  await expectRefusal(
    "completed failure is not retried",
    () =>
      waitForReleaseCi({
        ...verification(
          fixture({
            runsPages: [
              { workflow_runs: [workflowRun({ conclusion: "failure" })] },
            ],
          })
        ),
        now: () => 0,
        sleepFor: async () => {
          unexpectedSleep = true;
        },
        wait: true,
      }),
    ReleaseCiError,
    "failure"
  );
  assert.equal(
    unexpectedSleep,
    false,
    "Completed failures must not be retried"
  );

  await expectRefusal(
    "wait timeout",
    () =>
      waitForReleaseCi({
        api: apiFor(fixture({ runsPages: [{ workflow_runs: [] }] })),
        now: (() => {
          let reading = 0;
          return () => (reading++ === 0 ? 0 : 120 * 60_000);
        })(),
        ref,
        repository,
        sha,
        sleepFor: async () => assert.fail("Timed-out wait slept again"),
        wait: true,
      }),
    ReleaseCiError,
    "Timed out after 120 minutes"
  );

  assert.deepEqual(parseReleaseCiArguments([]), { wait: false });
  assert.deepEqual(parseReleaseCiArguments(["--wait"]), { wait: true });
  await expectRefusal(
    "unknown CLI option",
    async () => parseReleaseCiArguments(["--poll"]),
    ReleaseCiError,
    "Usage"
  );

  console.log("Release CI proof: pass");
});

test("release CI accepts a tree-equivalent pull-request proof", async () => {
  const pullProof = {
    attempt: 1,
    headSha,
    jobs: 8,
    proof: "pull-request-tree",
    pullRequest: 90,
    runId: 190,
    sha,
    status: "verified",
  };
  assert.deepEqual(
    await verifyReleaseCi(verification(pullFixture())),
    pullProof
  );
  for (const runsPages of [
    [{ workflow_runs: [] }],
    [{ workflow_runs: [workflowRun({ head_sha: otherSha })] }],
  ]) {
    assert.deepEqual(
      await verifyReleaseCi(verification(pullFixture({ runsPages }))),
      pullProof,
      "An absent or superseded push run also falls back to the PR proof"
    );
  }

  for (const [name, overrides, message] of [
    ["no associated pull request", { pulls: [] }, "0 pull requests merged"],
    [
      "unmerged pull request",
      { pulls: [mergedPull({ merged_at: null })] },
      "0 pull requests merged",
    ],
    [
      "pull request merged into another branch",
      { pulls: [mergedPull({ base: { ref: "next" } })] },
      "0 pull requests merged",
    ],
    [
      "pull request that did not produce the release commit",
      { pulls: [mergedPull({ merge_commit_sha: otherSha })] },
      "0 pull requests merged",
    ],
    [
      "different tree",
      {
        commits: {
          ...fixture().commits,
          [headSha]: {
            parents: [{ sha: parentSha }],
            tree: { sha: otherSha },
          },
        },
      },
      `Tree of ${sha} differs from pull request #90 head ${headSha}`,
    ],
    [
      "merge commit release",
      {
        commits: {
          ...fixture().commits,
          [sha]: {
            parents: [{ sha: parentSha }, { sha: headSha }],
            tree: { sha: treeSha },
          },
        },
      },
      "must have exactly one parent",
    ],
    [
      "parent not an ancestor of the PR head",
      { comparison: { status: "diverged" } },
      '"diverged" of pull request #90 head',
    ],
    [
      "failed PR run",
      {
        pullRunsPages: [
          { workflow_runs: [pullRun({ conclusion: "failure" })] },
        ],
      },
      'completed with "failure"',
    ],
    [
      "pending PR run",
      {
        pullRunsPages: [
          {
            workflow_runs: [
              pullRun({ conclusion: null, status: "in_progress" }),
            ],
          },
        ],
      },
      "is in_progress",
    ],
    [
      "PR run on another branch",
      {
        pullRunsPages: [{ workflow_runs: [pullRun({ head_branch: "other" })] }],
      },
      `not ${headBranch}`,
    ],
    [
      "PR run from a fork",
      {
        pullRunsPages: [
          {
            workflow_runs: [
              pullRun({ head_repository: { full_name: "someone/viborm" } }),
            ],
          },
        ],
      },
      "head repository is not",
    ],
    [
      "PR run missing a job",
      {
        pullJobsPages: [
          {
            jobs: pullJobs()[0].jobs.slice(1),
          },
        ],
      },
      "missing required jobs: Types, format, and docs",
    ],
    [
      "PR run failed job",
      {
        pullJobsPages: pullJobs((index) =>
          index === 7 ? { conclusion: "failure" } : {}
        ),
      },
      "Bun and D1 providers",
    ],
    [
      "PR run stale job attempt",
      {
        pullRunsPages: [{ workflow_runs: [pullRun({ run_attempt: 2 })] }],
        observedPullRun: pullRun({ run_attempt: 2 }),
      },
      "stale attempt 1, not 2",
    ],
    [
      "PR job for another commit",
      {
        pullJobsPages: pullJobs((index) =>
          index === 0 ? { head_sha: sha } : {}
        ),
      },
      `not ${headSha}`,
    ],
    [
      "PR run attempt changed while reading jobs",
      { observedPullRun: pullRun({ run_attempt: 2 }) },
      "changed from attempt 1 to 2",
    ],
  ]) {
    const error = await expectRefusal(
      name,
      () => verifyReleaseCi(verification(pullFixture(overrides))),
      ReleaseCiPendingError,
      message
    );
    assert.ok(
      error.message.startsWith(
        `CI run 200 attempt 2 for ${sha} is in_progress; pull-request tree proof does not hold: `
      ),
      `${name} must leave the exact-main push run as the pending proof`
    );
  }

  for (const conclusion of ["failure", "cancelled"]) {
    const error = await expectRefusal(
      `completed ${conclusion} push run despite a PR proof`,
      () =>
        verifyReleaseCi(
          verification(
            pullFixture({
              runsPages: [{ workflow_runs: [workflowRun({ conclusion })] }],
            })
          )
        ),
      ReleaseCiError,
      `completed with "${conclusion}"`
    );
    assert.equal(error instanceof ReleaseCiPendingError, false);
  }

  await expectRefusal(
    "main moved while the PR proof was read",
    () =>
      verifyReleaseCi(
        verification(
          pullFixture({
            observedMain: {
              commit: { sha: otherSha },
              name: "main",
              protected: true,
            },
          })
        )
      ),
    ReleaseCiError,
    "Protected main changed"
  );

  console.log("Release CI pull-request tree proof: pass");
});
