import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

const bunVersion = spawnSync("bun", ["--version"], { encoding: "utf8" });
const databaseUrl = process.env.PG_TEST_CONNECTION_STRING;
const probePath = fileURLToPath(
  new URL("./bun-sql-groupby-time-step-probe.ts", import.meta.url)
);

/**
 * Bun owns the probe's process, so `groupBy` by a time step crosses the real
 * `SQL` transport and its own result decoding, against the same oracle the
 * other PostgreSQL drivers answer.
 */
test.runIf(bunVersion.status === 0 && Boolean(databaseUrl))(
  "Bun SQL groups by a time step like every other PostgreSQL driver",
  () => {
    const result = spawnSync("bun", ["run", probePath], { encoding: "utf8" });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(
      "bun-sql groupBy time-step evidence passed"
    );
  }
);
