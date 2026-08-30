import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

const bunVersion = spawnSync("bun", ["--version"], { encoding: "utf8" });
const databaseUrl = process.env.PG_TEST_CONNECTION_STRING;
const decimalProbePath = fileURLToPath(
  new URL("./bun-sql-runtime-probe.ts", import.meta.url)
);
const jsonProbePath = fileURLToPath(
  new URL("./bun-sql-json-probe.ts", import.meta.url)
);

test.runIf(bunVersion.status === 0)(
  "Bun SQL close returns an awaitable cleanup promise",
  () => {
    const result = spawnSync(
      "bun",
      [
        "--eval",
        'const { SQL } = await import("bun"); if (typeof SQL !== "function") process.exit(1); const sql = new SQL({ url: "postgres://127.0.0.1:1/viborm", connectionTimeout: 1 }); const closeResult = sql.close(); if (!closeResult || typeof closeResult.then !== "function") process.exit(2); await closeResult;',
      ],
      { encoding: "utf8" }
    );

    expect(result.status, result.stderr).toBe(0);
  }
);

test.runIf(bunVersion.status === 0 && Boolean(databaseUrl))(
  "Bun SQL proves fixed-decimal transport and operations on real PostgreSQL",
  () => {
    const result = spawnSync("bun", ["run", decimalProbePath], {
      encoding: "utf8",
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("bun-sql fixed-decimal evidence passed");
  }
);

/**
 * Bun JSON-encodes a string bound to a `json`/`jsonb` parameter, so the
 * canonical JSON text the PostgreSQL adapter binds used to be stored as the
 * physical document `"[1,2,3]"` rather than `[1,2,3]`. Both spellings read back
 * as JSON, so only a live server's `jsonb_typeof` separates them — which is why
 * this contract is execution-backed rather than a statement pin.
 */
test.runIf(bunVersion.status === 0 && Boolean(databaseUrl))(
  "Bun SQL round-trips every JSON type as its own physical document",
  () => {
    const result = spawnSync("bun", ["run", jsonProbePath], {
      encoding: "utf8",
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("bun-sql json evidence passed");
  }
);
