import { spawn } from "node:child_process";
import process from "node:process";
import { resolve } from "node:path";

const [memoryArgument, wallArgument, entry, ...entryArguments] =
  process.argv.slice(2);
const memoryMb = Number(memoryArgument);
const wallLimitMs = Number(wallArgument);

if (
  !Number.isSafeInteger(memoryMb) ||
  memoryMb <= 0 ||
  !Number.isSafeInteger(wallLimitMs) ||
  wallLimitMs <= 0 ||
  !entry
) {
  process.stderr.write(
    "Usage: run-node-safe.mjs <memory-mb> <wall-limit-ms> <entry> [...args]\n"
  );
  process.exit(2);
}

const existingNodeOptions = (process.env.NODE_OPTIONS ?? "")
  .replace(/--max-old-space-size(?:=|\s+)\d+/g, "")
  .trim();
const child = spawn(
  process.execPath,
  [resolve(process.cwd(), entry), ...entryArguments],
  {
    detached: process.platform !== "win32",
    env: {
      ...process.env,
      NODE_OPTIONS: [existingNodeOptions, `--max-old-space-size=${memoryMb}`]
        .filter(Boolean)
        .join(" "),
    },
    stdio: "inherit",
  }
);

let forcedExit;
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

const wallLimit = setTimeout(() => {
  exceededWallLimit = true;
  process.stderr.write(
    `Node command exceeded its ${(wallLimitMs / 1000).toFixed(0)} second wall limit.\n`
  );
  terminate("SIGTERM");
}, wallLimitMs);

process.once("SIGINT", () => terminate("SIGINT"));
process.once("SIGTERM", () => terminate("SIGTERM"));
process.once("SIGHUP", () => terminate("SIGHUP"));
process.once("exit", () => signalChild("SIGTERM"));

child.once("error", (error) => {
  clearTimeout(wallLimit);
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});

child.once("exit", (code, signal) => {
  clearTimeout(wallLimit);
  if (forcedExit) clearTimeout(forcedExit);
  process.exitCode = exceededWallLimit ? 1 : (code ?? (signal ? 1 : 0));
});
