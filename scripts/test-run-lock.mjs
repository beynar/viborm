import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";

function workspaceRoot() {
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: process.cwd(),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return resolve(process.cwd());
  }
}

function workspaceIdentity() {
  try {
    return execFileSync(
      "git",
      ["rev-parse", "--path-format=absolute", "--git-common-dir"],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }
    ).trim();
  } catch {
    return process.cwd();
  }
}

let workspaceState;

function getWorkspaceState() {
  if (workspaceState !== undefined) return workspaceState;
  const workspaceKey = createHash("sha256")
    .update(workspaceIdentity())
    .digest("hex")
    .slice(0, 16);
  workspaceState = {
    lockPath: join(tmpdir(), `viborm-test-${workspaceKey}.lock`),
    projectRoot: workspaceRoot(),
  };
  return workspaceState;
}

const PROCESS_TABLE_ROW_PATTERN = /^\s*(\d+)\s+(\d+)\s+(.+)$/;
const TRAILING_SLASHES_PATTERN = /\/+$/;
const PATH_TERMINATOR_PATTERN = /[\s"'`]/;

const WORKSPACE_VERIFICATION_MARKERS = [
  "/node_modules/vitest/vitest.mjs",
  "/node_modules/typescript/bin/tsc",
  "/node_modules/typescript-native/bin/tsc",
  "/node_modules/@typescript/typescript-",
  "/node_modules/tsdown/dist/run.mjs",
  "/node_modules/tinypool/dist/entry/process.js",
];

export function parseProcessTable(output) {
  const processes = [];
  const pids = new Set();
  for (const line of output.split("\n")) {
    if (line.trim().length === 0) continue;
    const match = line.match(PROCESS_TABLE_ROW_PATTERN);
    if (!match) {
      throw new Error("The process table contains an unreadable row.");
    }
    const pid = Number(match[1]);
    const parentPid = Number(match[2]);
    if (
      !Number.isSafeInteger(pid) ||
      pid <= 0 ||
      !Number.isSafeInteger(parentPid) ||
      parentPid < 0 ||
      pids.has(pid)
    ) {
      throw new Error(
        "The process table contains an invalid process identity."
      );
    }
    pids.add(pid);
    processes.push({ pid, parentPid, command: match[3] });
  }
  return processes;
}

function readProcesses() {
  const output = execFileSync("ps", ["-ww", "-axo", "pid=,ppid=,command="], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  return parseProcessTable(output);
}

export function currentAncestors(processes, currentPid) {
  const byPid = new Map(processes.map((entry) => [entry.pid, entry]));
  let current = byPid.get(currentPid);
  if (!current) {
    throw new Error("The current process is absent from the process table.");
  }
  const ancestors = new Set([currentPid]);
  while (current.parentPid > 0) {
    if (ancestors.has(current.parentPid)) {
      throw new Error("The process table contains an ancestor cycle.");
    }
    ancestors.add(current.parentPid);
    const parent = byPid.get(current.parentPid);
    if (!parent) {
      throw new Error("The current process ancestor chain is incomplete.");
    }
    current = parent;
  }
  return ancestors;
}

export function isWorkspaceVerification(command, workspace) {
  const root = workspace.replace(TRAILING_SLASHES_PATTERN, "");
  const workspacePath = `${root}/`;
  let searchFrom = 0;
  while (searchFrom < command.length) {
    const rootIndex = command.indexOf(workspacePath, searchFrom);
    if (rootIndex < 0) return false;
    const pathTail = command
      .slice(rootIndex + root.length)
      .split(PATH_TERMINATOR_PATTERN, 1)[0];
    if (
      WORKSPACE_VERIFICATION_MARKERS.some((marker) => pathTail.endsWith(marker))
    ) {
      return true;
    }
    searchFrom = rootIndex + workspacePath.length;
  }
  return false;
}

export function findUnownedWorkspaceVerification(
  processes,
  currentPid,
  workspace
) {
  const ancestors = currentAncestors(processes, currentPid);
  return processes.find(
    (entry) =>
      !ancestors.has(entry.pid) &&
      isWorkspaceVerification(entry.command, workspace)
  );
}

function assertNoOrphanVerification(projectRoot) {
  let active;
  try {
    active = findUnownedWorkspaceVerification(
      readProcesses(),
      process.pid,
      projectRoot
    );
  } catch {
    throw new Error(
      "Test command refused: the process table could not be inspected for stale workspace verification processes."
    );
  }
  if (active) {
    throw new Error(
      `Test command refused: workspace verification PID ${active.pid} is still active without owning the current command chain.`
    );
  }
}

function readOwner(lockPath) {
  try {
    return JSON.parse(readFileSync(lockPath, "utf8"));
  } catch {
    return undefined;
  }
}

function isRunning(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
}

export function acquireTestRunLock(label) {
  const { lockPath, projectRoot } = getWorkspaceState();
  const lockExists = existsSync(lockPath);
  const owner = readOwner(lockPath);
  if (owner && isRunning(owner.pid)) {
    let ancestors;
    try {
      ancestors = currentAncestors(readProcesses(), process.pid);
    } catch {
      throw new Error(
        "Test command refused: the process table could not be inspected for inherited workspace lock ownership."
      );
    }
    if (ancestors.has(owner.pid)) {
      return () => {
        // The lock is owned by an ancestor process, which releases it itself.
      };
    }
    throw new Error(
      `Test command refused: ${owner.label ?? "another test command"} (PID ${owner.pid}) already owns this workspace.`
    );
  }
  if (lockExists) {
    throw new Error(
      `Test command refused: the workspace lock is stale or unreadable. Confirm that no verification process remains, then remove ${lockPath} before retrying.`
    );
  }
  assertNoOrphanVerification(projectRoot);

  let descriptor;
  try {
    descriptor = openSync(lockPath, "wx");
    writeFileSync(
      descriptor,
      JSON.stringify({ pid: process.pid, label, startedAt: Date.now() })
    );
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EEXIST") {
      const concurrent = readOwner(lockPath);
      throw new Error(
        `Test command refused: ${concurrent?.label ?? "another test command"} already owns this workspace.`
      );
    }
    throw error;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }

  let released = false;
  return () => {
    if (released) return;
    released = true;
    const current = readOwner(lockPath);
    if (current?.pid !== process.pid) return;
    try {
      unlinkSync(lockPath);
    } catch (error) {
      if (
        !(error instanceof Error && "code" in error && error.code === "ENOENT")
      ) {
        throw error;
      }
    }
  };
}
