import { NeonHTTPDriver } from "@src/drivers/neon-http";

const databaseUrl = process.env.NEON_TEST_DATABASE_URL;

describe.skipIf(!databaseUrl)("Neon HTTP provider", () => {
  it("executes and normalizes a read through the dedicated endpoint", async () => {
    const driver = new NeonHTTPDriver({ databaseUrl });

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
