import assert from "node:assert/strict";
import test from "node:test";
import {
  acquireTestRunLock,
  currentAncestors,
  findUnownedWorkspaceVerification,
  isWorkspaceVerification,
  parseProcessTable,
} from "./test-run-lock.mjs";

const workspace = "/work/viborm";

test("a bounded descendant inherits its ancestor's workspace lock", () => {
  const releaseInheritedLock = acquireTestRunLock("nested policy witness");
  assert.doesNotThrow(() => releaseInheritedLock());
});

function baseProcessChain() {
  return [
    { pid: 1, parentPid: 0, command: "/sbin/launchd" },
    { pid: 10, parentPid: 1, command: "zsh" },
    { pid: 20, parentPid: 10, command: "pnpm run test:coverage:drivers" },
    {
      pid: 30,
      parentPid: 20,
      command: `node ${workspace}/scripts/run-coverage.mjs drivers`,
    },
    {
      pid: 40,
      parentPid: 30,
      command: `node ${workspace}/scripts/run-vitest-safe.mjs run`,
    },
  ];
}

test("parses complete process rows without truncating commands", () => {
  assert.deepEqual(
    parseProcessTable(
      "  1 0 /sbin/launchd\n 40 30 node /work/viborm/tool.mjs --label has spaces\n"
    ),
    [
      { pid: 1, parentPid: 0, command: "/sbin/launchd" },
      {
        pid: 40,
        parentPid: 30,
        command: "node /work/viborm/tool.mjs --label has spaces",
      },
    ]
  );
});

test("refuses malformed, duplicate, and incomplete process graphs", () => {
  assert.throws(() => parseProcessTable("unreadable process row\n"));
  assert.throws(() =>
    parseProcessTable("1 0 init\n1 0 duplicate process identity\n")
  );
  assert.throws(() => currentAncestors(baseProcessChain(), 999));
  assert.throws(() =>
    currentAncestors(
      [{ pid: 40, parentPid: 30, command: "node current.mjs" }],
      40
    )
  );
  assert.throws(() =>
    currentAncestors(
      [
        { pid: 30, parentPid: 40, command: "node parent.mjs" },
        { pid: 40, parentPid: 30, command: "node current.mjs" },
      ],
      40
    )
  );
});

test("excludes every direct, pnpm, and coverage-wrapper ancestor", () => {
  const processes = baseProcessChain();
  processes[2] = {
    pid: 20,
    parentPid: 10,
    command: `node ${workspace}/node_modules/typescript/bin/tsc --noEmit`,
  };

  assert.deepEqual(
    currentAncestors(processes, 40),
    new Set([40, 30, 20, 10, 1])
  );
  assert.equal(
    findUnownedWorkspaceVerification(processes, 40, workspace),
    undefined
  );
});

test("finds stale Vitest, TypeScript, tsdown, and Vitest worker processes", () => {
  for (const command of [
    `node ${workspace}/node_modules/vitest/vitest.mjs run`,
    `node ${workspace}/node_modules/typescript/bin/tsc --noEmit`,
    `node ${workspace}/node_modules/tsdown/dist/run.mjs`,
    `node ${workspace}/node_modules/tinypool/dist/entry/process.js`,
  ]) {
    const processes = [
      ...baseProcessChain(),
      { pid: 80, parentPid: 1, command },
    ];

    assert.equal(
      findUnownedWorkspaceVerification(processes, 40, workspace)?.pid,
      80
    );
  }
});

test("does not confuse a sibling path with the current workspace", () => {
  const sibling = `node ${workspace}-copy/node_modules/vitest/vitest.mjs run --config ${workspace}/vitest.workspace.ts`;
  const processes = [
    ...baseProcessChain(),
    { pid: 80, parentPid: 1, command: sibling },
  ];

  assert.equal(isWorkspaceVerification(sibling, workspace), false);
  assert.equal(
    isWorkspaceVerification(
      `node ${workspace}/node_modules/vitest/vitest.mjs-copy`,
      workspace
    ),
    false
  );
  assert.equal(
    findUnownedWorkspaceVerification(processes, 40, workspace),
    undefined
  );
});
