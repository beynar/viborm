import { createClient } from "@src/client/client";
import { PlanetScaleDriver } from "@src/drivers/planetscale";
import { introspect } from "@src/migrations";
import { s } from "@src/schema";
import Decimal from "decimal.js";

const databaseUrl = process.env.PLANETSCALE_TEST_DATABASE_URL;
const namespace = process.env.PLANETSCALE_TEST_NAMESPACE;
const decimalFixtureTable = process.env.PLANETSCALE_DECIMAL_FIXTURE_TABLE;
const decimalFixtureConfigured = Boolean(
  databaseUrl && namespace && decimalFixtureTable
);
const DECIMAL_DOMAIN = { precision: 16, scale: 2 };
const PAST_DOUBLE = "99999999999999.99";
const PAST_DOUBLE_NEIGHBOUR = "99999999999999.98";

const decimalEvidence = s
  .model({
    id: s.string().id(),
    amount: s.decimal(DECIMAL_DOMAIN),
    amounts: s.decimal(DECIMAL_DOMAIN).array(),
  })
  .map(
    decimalFixtureTable ?? "__viborm_unconfigured_planetscale_decimal_fixture"
  );

describe.skipIf(!databaseUrl)("PlanetScale provider", () => {
  it("executes a connectivity-only read through the dedicated endpoint", async () => {
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

describe.skipIf(!decimalFixtureConfigured)(
  "PlanetScale fixed-decimal read-only fixture (requires URL, namespace, and table)",
  () => {
    it("introspects the marker and materializes exact typed scalar/list reads", async () => {
      // The fixture is deliberately external and read-only. D8 forbids
      // VibORM-driven PlanetScale DDL, so this leg performs only admitted
      // introspection and SELECTs. Its deterministic rows are:
      //   neighbour -> 99999999999999.98, []
      //   exact     -> 99999999999999.99, [99999999999999.99, -0.03]
      // The `amounts` column is JSON with the exact whole-column comment
      // `viborm:decimal(16,2)`.
      const client = createClient({
        schema: { decimalEvidence },
        driver: new PlanetScaleDriver({ databaseUrl, namespace }),
      });

      try {
        const snapshot = await introspect(client);
        const table = snapshot.tables.find(
          (candidate) => candidate.name === decimalFixtureTable
        );
        const amount = table?.columns.find(
          (column) => column.name === "amount"
        );
        const amounts = table?.columns.find(
          (column) => column.name === "amounts"
        );

        expect(amount).toMatchObject({
          type: "DECIMAL(16,2)",
          decimal: DECIMAL_DOMAIN,
        });
        expect(amounts).toMatchObject({
          type: "JSON",
          decimal: DECIMAL_DOMAIN,
        });

        const exactMatches = await client.decimalEvidence.findMany({
          where: { amount: { gt: PAST_DOUBLE_NEIGHBOUR } },
          select: { id: true },
        });
        expect(exactMatches).toEqual([{ id: "exact" }]);

        const rows = await client.decimalEvidence.findMany({
          orderBy: [{ amount: "asc" }, { id: "asc" }],
        });

        expect(rows.map((row) => row.id)).toEqual(["neighbour", "exact"]);
        expect(rows[0]?.amount).toBeInstanceOf(Decimal);
        expect(rows[0]?.amount.eq(PAST_DOUBLE_NEIGHBOUR)).toBe(true);
        expect(rows[1]?.amount).toBeInstanceOf(Decimal);
        expect(rows[1]?.amount.eq(PAST_DOUBLE)).toBe(true);
        expect(rows[1]?.amounts).toHaveLength(2);
        expect(rows[1]?.amounts[0]).toBeInstanceOf(Decimal);
        expect(rows[1]?.amounts[0]?.eq(PAST_DOUBLE)).toBe(true);
        expect(rows[1]?.amounts[1]?.eq("-0.03")).toBe(true);

        const aggregates = await client.decimalEvidence.aggregate({
          _min: { amount: true },
          _max: { amount: true },
          _sum: { amount: true },
          _avg: { amount: true },
        });
        expect(aggregates._min.amount?.eq(PAST_DOUBLE_NEIGHBOUR)).toBe(true);
        expect(aggregates._max.amount?.eq(PAST_DOUBLE)).toBe(true);
        expect(aggregates._sum.amount?.eq("199999999999999.97")).toBe(true);
        expect(aggregates._avg.amount?.eq(PAST_DOUBLE_NEIGHBOUR)).toBe(true);
      } finally {
        await client.$disconnect();
      }
    });
  }
);
