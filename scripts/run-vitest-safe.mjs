import { spawn, spawnSync } from "node:child_process";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { acquireTestRunLock } from "./test-run-lock.mjs";

const vitestEntry = fileURLToPath(
  new URL("../node_modules/vitest/vitest.mjs", import.meta.url)
);
const vitestArgs = process.argv.slice(2);
const wallLimitArgument = vitestArgs.find((argument) =>
  argument.startsWith("--wall-limit-ms=")
);
const wallLimitMs = Number(
  wallLimitArgument?.slice("--wall-limit-ms=".length) ?? 300_000
);
if (!Number.isSafeInteger(wallLimitMs) || wallLimitMs <= 0) {
  process.stderr.write("--wall-limit-ms must be a positive integer.\n");
  process.exit(2);
}
const forwardedArgs = vitestArgs.filter(
  (argument) => argument !== wallLimitArgument
);
let releaseTestRunLock;
try {
  releaseTestRunLock = acquireTestRunLock("Vitest");
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
const existingNodeOptions = (process.env.NODE_OPTIONS ?? "")
  .replace(/--max-old-space-size(?:=|\s+)\d+/g, "")
  .trim();
const nodeOptions = [existingNodeOptions, "--max-old-space-size=768"]
  .filter(Boolean)
  .join(" ");

const child = spawn(process.execPath, [vitestEntry, ...forwardedArgs], {
  detached: process.platform !== "win32",
  env: { ...process.env, NODE_OPTIONS: nodeOptions },
  stdio: "inherit",
});

const startedAt = performance.now();
let peakGroupRssKb = 0;
const sampleGroupRss = () => {
  if (process.platform === "win32" || child.pid === undefined) return;
  const sample = spawnSync("ps", ["-axo", "pgid=,rss="], {
    encoding: "utf8",
  });
  if (sample.status !== 0) return;
  let groupRssKb = 0;
  for (const line of sample.stdout.split("\n")) {
    const [group, rss] = line.trim().split(/\s+/);
    if (Number(group) === child.pid) groupRssKb += Number(rss) || 0;
  }
  peakGroupRssKb = Math.max(peakGroupRssKb, groupRssKb);
};
sampleGroupRss();
const resourceSampler = setInterval(sampleGroupRss, 1_000);

let forcedExit;
let wallLimit;
let exceededWallLimit = false;
const signalChild = (signal) => {
  if (child.exitCode !== null || child.pid === undefined) return;
  try {
    if (process.platform === "win32") child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch (error) {
    if (
      !(error instanceof Error && "code" in error && error.code === "ESRCH")
    ) {
      throw error;
    }
  }
};

const terminate = (signal) => {
  signalChild(signal);
  forcedExit ??= setTimeout(() => signalChild("SIGKILL"), 1_000);
};

if (forwardedArgs.includes("run")) {
  wallLimit = setTimeout(() => {
    exceededWallLimit = true;
    process.stderr.write(
      `Vitest exceeded its ${(wallLimitMs / 1000).toFixed(0)} second wall limit.\n`
    );
    terminate("SIGTERM");
  }, wallLimitMs);
}

process.once("SIGINT", () => terminate("SIGINT"));
process.once("SIGTERM", () => terminate("SIGTERM"));
process.once("SIGHUP", () => terminate("SIGHUP"));
process.once("exit", () => {
  signalChild("SIGTERM");
  releaseTestRunLock();
});

child.once("error", (error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});

child.once("exit", (code, signal) => {
  clearInterval(resourceSampler);
  sampleGroupRss();
  if (wallLimit) clearTimeout(wallLimit);
  if (forcedExit) clearTimeout(forcedExit);
  const wallSeconds = (performance.now() - startedAt) / 1_000;
  process.stderr.write(
    `Vitest resources: ${wallSeconds.toFixed(2)}s wall, ${(peakGroupRssKb / 1024).toFixed(1)} MiB peak process-group RSS.\n`
  );
  releaseTestRunLock();
  process.exitCode = exceededWallLimit ? 1 : (code ?? (signal ? 1 : 0));
});
