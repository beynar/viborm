import { env } from "cloudflare:test";
import type { D1Database } from "@cloudflare/workers-types";
import { D1Driver } from "@src/drivers/d1";

declare module "cloudflare:test" {
  interface ProvidedEnv {
    DB: D1Database;
  }
}

const TABLE = "viborm_d1_driver_core";

beforeAll(async () => {
  await env.DB.exec(
    `CREATE TABLE IF NOT EXISTS ${TABLE} (id TEXT PRIMARY KEY, value TEXT NOT NULL)`
  );
});

describe("D1 binding provider", () => {
  it("executes bound writes and normalizes rows", async () => {
    const driver = new D1Driver({ database: env.DB });
    const id = crypto.randomUUID();

    await driver._executeRaw(`INSERT INTO ${TABLE} (id, value) VALUES (?, ?)`, [
      id,
      "O'Reilly",
    ]);
    const selected = await driver._executeRaw<{ id: string; value: string }>(
      `SELECT id, value FROM ${TABLE} WHERE id = ?`,
      [id]
    );

    expect(selected).toEqual({
      rows: [{ id, value: "O'Reilly" }],
      rowCount: 1,
    });
  });

  it("keeps a failed native batch atomic", async () => {
    const driver = new D1Driver({ database: env.DB });
    const id = crypto.randomUUID();

    await expect(
      driver._executeBatch([
        {
          sql: `INSERT INTO ${TABLE} (id, value) VALUES (?, ?)`,
          params: [id, "first"],
        },
        {
          sql: `INSERT INTO ${TABLE} (id, value) VALUES (?, ?)`,
          params: [id, "duplicate"],
        },
      ])
    ).rejects.toThrow();

    const selected = await driver._executeRaw<{ count: number }>(
      `SELECT COUNT(*) AS count FROM ${TABLE} WHERE id = ?`,
      [id]
    );
    expect(selected.rows).toEqual([{ count: 0 }]);
  });
});
