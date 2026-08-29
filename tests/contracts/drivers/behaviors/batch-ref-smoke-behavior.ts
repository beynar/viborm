import { getAdapterInternals } from "@adapters/adapter-internals";
import type { Driver } from "@drivers";
import { sql } from "@sql";
import { defineContract } from "@tests/contracts/contract";
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
    test("stores and reads an exact reference inside one batch", async () => {
      const driver = createDriver();
      const storeLastInsertId = getAdapterInternals(driver.adapter).batchRefs
        .storeLastInsertId;
      const batchId = `smoke_${driverName.replace(/[^a-z0-9]/gi, "_")}`;
      const tableName = "__viborm_batch_ref_smoke_users";
      const createTable =
        driver.dialect === "postgresql"
          ? sql.raw`CREATE TEMP TABLE IF NOT EXISTS "__viborm_batch_ref_smoke_users" ("id" SERIAL PRIMARY KEY, "name" TEXT NOT NULL) ON COMMIT DROP`
          : sql.raw`CREATE TEMP TABLE IF NOT EXISTS "__viborm_batch_ref_smoke_users" ("id" INTEGER PRIMARY KEY AUTOINCREMENT, "name" TEXT NOT NULL)`;

      try {
        if (!storeLastInsertId) {
          expect(driver.dialect).toBe("postgresql");
        }
        const publication = storeLastInsertId
          ? [
              createTable,
              sql`INSERT INTO ${driver.adapter.identifiers.escape(
                tableName
              )} (${driver.adapter.identifiers.escape(
                "name"
              )}) VALUES (${"Ada"})`,
              storeLastInsertId(batchId, "user_id"),
            ]
          : [
              getAdapterInternals(driver.adapter).batchRefs.store(
                batchId,
                "user_id",
                sql`${1}`
              ),
            ];
        const setup = getAdapterInternals(driver.adapter).batchRefs.setup(
          batchId
        );
        const statements = [
          ...setup,
          getAdapterInternals(driver.adapter).batchRefs.clear(batchId),
          ...publication,
          sql`SELECT ${getAdapterInternals(driver.adapter).batchRefs.read(
            batchId,
            "user_id"
          )} AS ${driver.adapter.identifiers.escape("id")}`,
          getAdapterInternals(driver.adapter).batchRefs.cleanup(batchId),
          sql`DROP TABLE IF EXISTS ${driver.adapter.identifiers.escape(
            tableName
          )}`,
        ];
        const selectIndex = setup.length + 1 + publication.length;
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
