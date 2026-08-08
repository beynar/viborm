import { defineContract } from "@tests/contracts/contract";
import type { Driver } from "@drivers";
import { sql } from "@sql";
import { describe, expect, test } from "vitest";

interface BatchRefSmokeOptions<TDriver extends Driver<any, any>> {
  driverName: string;
  createDriver: () => TDriver;
}

export function runBatchRefSmokeBehavior<TDriver extends Driver<any, any>>({
  driverName,
  createDriver,
}: BatchRefSmokeOptions<TDriver>) {
  describe(`${driverName} batch refs`, () => {
    test("stores and reads a generated id inside one batch", async () => {
      const driver = createDriver();
      const batchId = `smoke_${driverName.replace(/[^a-z0-9]/gi, "_")}`;
      const tableName = "__viborm_batch_ref_smoke_users";
      const createTable =
        driver.dialect === "postgresql"
          ? sql.raw`CREATE TEMP TABLE IF NOT EXISTS "__viborm_batch_ref_smoke_users" ("id" SERIAL PRIMARY KEY, "name" TEXT NOT NULL) ON COMMIT DROP`
          : sql.raw`CREATE TEMP TABLE IF NOT EXISTS "__viborm_batch_ref_smoke_users" ("id" INTEGER PRIMARY KEY AUTOINCREMENT, "name" TEXT NOT NULL)`;

      try {
        const statements = [
          createTable,
          ...driver.adapter.batchRefs.setup(batchId),
          driver.adapter.batchRefs.clear(batchId),
          sql`INSERT INTO ${driver.adapter.identifiers.escape(
            tableName
          )} (${driver.adapter.identifiers.escape("name")}) VALUES (${"Ada"})`,
          driver.adapter.batchRefs.storeLastInsertId(batchId, "user_id"),
          sql`SELECT ${driver.adapter.batchRefs.read(
            batchId,
            "user_id"
          )} AS ${driver.adapter.identifiers.escape("id")}`,
          driver.adapter.batchRefs.cleanup(batchId),
          sql`DROP TABLE IF EXISTS ${driver.adapter.identifiers.escape(
            tableName
          )}`,
        ];
        const selectIndex = statements.length - 3;
        const results = await driver._executeBatch<{ id: string | number }>(
          statements.map((statement) => driver._prepare(statement))
        );

        expect(Number(results[selectIndex]?.rows[0]?.id)).toBe(1);
      } finally {
        await driver.disconnect();
      }
    });
  });
}

export const batchRefSmokeContract = defineContract({
  id: "drivers.batch-ref-smoke",
  owningLayer: "drivers",
  tier: "extended",
  requiredCapabilities: ["sql-execution"],
  register: runBatchRefSmokeBehavior,
});
