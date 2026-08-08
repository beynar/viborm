import { spawnSync } from "node:child_process";
import { expect, test } from "vitest";

const bunVersion = spawnSync("bun", ["--version"], { encoding: "utf8" });

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
