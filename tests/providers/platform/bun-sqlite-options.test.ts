import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

/**
 * platform-07 for viborm/bun-sqlite, on the real runtime: vitest cannot load
 * `bun:sqlite`, so `bun-sqlite-options-probe.ts` holds the assertions and this
 * test reports its exit code. Skipped, not failed, when Bun is not installed.
 */

const bunVersion = spawnSync("bun", ["--version"], { encoding: "utf8" });

const probePath = fileURLToPath(
  new URL("./bun-sqlite-options-probe.ts", import.meta.url)
);

test.runIf(bunVersion.status === 0)(
  "bun:sqlite keeps the caller's busy timeout and defaults to 5000 ms",
  () => {
    const result = spawnSync("bun", ["run", probePath], { encoding: "utf8" });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("busy timeout evidence passed");
  }
);
