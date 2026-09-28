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

function fixture(overrides = {}) {
  return {
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

function apiFor(state) {
  return {
    async read(endpoint) {
      if (endpoint === `/repos/${repository}`) return state.repositoryState;
      if (endpoint.endsWith("/branches/main")) return state.main;
      if (endpoint.includes("/actions/runs/")) return state.observedRun;
      if (endpoint.endsWith("/actions/workflows/ci.yml")) {
        return state.workflow;
      }
      throw new Error(`Unexpected read endpoint ${endpoint}`);
    },
    async readPages(endpoint) {
      if (endpoint.includes("/workflows/ci.yml/runs?")) {
        if (!endpoint.includes(`head_sha=${sha}`)) {
          throw new Error("CI run query did not constrain the release SHA");
        }
        return state.runsPages;
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
  const proof = await verifyReleaseCi(verification());
  assert.deepEqual(proof, {
    attempt: 2,
    jobs: 8,
    runId: 200,
    sha,
    status: "verified",
  });

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
