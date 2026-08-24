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
import { join } from "node:path";
import process from "node:process";

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

const workspaceKey = createHash("sha256")
  .update(workspaceIdentity())
  .digest("hex")
  .slice(0, 16);
const lockPath = join(tmpdir(), `viborm-test-${workspaceKey}.lock`);

function readOwner() {
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
  const lockExists = existsSync(lockPath);
  const owner = readOwner();
  if (owner && isRunning(owner.pid)) {
    throw new Error(
      `Test command refused: ${owner.label ?? "another test command"} (PID ${owner.pid}) already owns this workspace.`
    );
  }
  if (lockExists) unlinkSync(lockPath);

  let descriptor;
  try {
    descriptor = openSync(lockPath, "wx");
    writeFileSync(
      descriptor,
      JSON.stringify({ pid: process.pid, label, startedAt: Date.now() })
    );
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EEXIST") {
      const concurrent = readOwner();
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
    const current = readOwner();
    if (current?.pid === process.pid) unlinkSync(lockPath);
  };
}
