import { spawn } from "node:child_process";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { acquireTestRunLock } from "./test-run-lock.mjs";

const LAYERS = new Set([
  "validation",
  "scalars",
  "operation-schemas",
  "relations",
  "schema-validation",
  "schema-json",
  "query-engine",
  "adapters",
  "drivers",
  "client",
  "cache",
  "instrumentation",
  "migrations",
]);

const layer = process.argv[2];
if (!(layer && LAYERS.has(layer))) {
  process.stderr.write(`Unknown test layer: ${layer ?? "<missing>"}\n`);
  process.exit(2);
}

let releaseTestRunLock;
try {
  releaseTestRunLock = acquireTestRunLock(`layer-${layer}`);
} catch (error) {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`
  );
  process.exit(1);
}

const vitestEntry = fileURLToPath(
  new URL("../node_modules/vitest/vitest.mjs", import.meta.url)
);
const tscEntry = fileURLToPath(
  new URL("../node_modules/typescript/bin/tsc", import.meta.url)
);
const existingNodeOptions = (process.env.NODE_OPTIONS ?? "")
  .replace(/--max-old-space-size(?:=|\s+)\d+/g, "")
  .trim();
const childOptions = (memoryLimitMb) => ({
  detached: process.platform !== "win32",
  env: {
    ...process.env,
    NODE_OPTIONS: [existingNodeOptions, `--max-old-space-size=${memoryLimitMb}`]
      .filter(Boolean)
      .join(" "),
  },
  stdio: "inherit",
});

const startedAt = performance.now();
const children = [
  spawn(
    process.execPath,
    [
      vitestEntry,
      "run",
      "--workspace",
      "vitest.workspace.ts",
      "--project",
      `layer-${layer}`,
      "--reporter=dot",
    ],
    childOptions(768)
  ),
  spawn(
    process.execPath,
    [tscEntry, "--project", `tests/types/${layer}/tsconfig.json`, "--noEmit"],
    childOptions(1280)
  ),
];

const signalChild = (child, signal) => {
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

let forceKill;
const terminate = (signal = "SIGTERM") => {
  for (const child of children) signalChild(child, signal);
  forceKill ??= setTimeout(() => {
    for (const child of children) signalChild(child, "SIGKILL");
  }, 1000);
};

let exceededBudget = false;
const budget = setTimeout(() => {
  exceededBudget = true;
  process.stderr.write(`Layer ${layer} exceeded the 30 second budget.\n`);
  terminate();
}, 30_000);

process.once("SIGINT", () => terminate("SIGINT"));
process.once("SIGTERM", () => terminate("SIGTERM"));
process.once("SIGHUP", () => terminate("SIGHUP"));
process.once("exit", () => {
  terminate("SIGTERM");
  releaseTestRunLock();
});

const exitCodes = await Promise.all(
  children.map(
    (child) =>
      new Promise((resolve) => {
        child.once("error", () => resolve(1));
        child.once("exit", (code) => resolve(code ?? 1));
      })
  )
);

clearTimeout(budget);
if (forceKill) clearTimeout(forceKill);
const elapsed = performance.now() - startedAt;
if (
  exceededBudget ||
  exitCodes.some((code) => code !== 0) ||
  elapsed > 30_000
) {
  terminate();
  releaseTestRunLock();
  process.exit(1);
}

releaseTestRunLock();
process.stdout.write(
  `Layer ${layer} passed in ${(elapsed / 1000).toFixed(2)}s.\n`
);
