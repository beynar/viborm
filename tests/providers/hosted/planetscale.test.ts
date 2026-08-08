import { PlanetScaleDriver } from "@src/drivers/planetscale";

const databaseUrl = process.env.PLANETSCALE_TEST_DATABASE_URL;

describe.skipIf(!databaseUrl)("PlanetScale provider", () => {
  it("executes and normalizes a read through the dedicated endpoint", async () => {
    const driver = new PlanetScaleDriver({ databaseUrl });

    try {
      const selected = await driver._executeRaw<{ value: number }>(
        "SELECT 1 AS value"
      );
      expect(selected.rows).toEqual([{ value: 1 }]);
      expect(selected.rowCount).toBe(1);
    } finally {
      await driver._disconnect();
    }
  });
});
