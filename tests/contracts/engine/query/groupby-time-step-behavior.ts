import { MemoryCache } from "@cache/drivers/memory";
import { cache } from "@cache/extension";
import { createClient } from "@client/client";
import type { AnyDriver } from "@drivers";
import { ForbiddenError } from "@errors";
import {
  ancientGroups,
  type Clients,
  GROUPBY_TIME_STEP_CASES,
  groupByTimeStepClients,
  groupByTimeStepRows,
  groupByTimeStepSchema,
} from "@tests/contracts/engine/query/groupby-time-step-cases";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

export interface GroupByTimeStepProvider {
  readonly name: string;
  readonly createDriver: () => AnyDriver;
  /** The table name; the second model takes it with a `_d` suffix. */
  readonly table?: string;
  /**
   * Creates the two tables. Defaults to pushing the schema; a hosted
   * database creates its own tables and is emptied, never dropped.
   */
  readonly prepare?: (driver: AnyDriver, table: string) => Promise<void>;
  /**
   * The zone the driver's sessions run in, checked before the cases: a
   * period that moved with the session would only show where it is not UTC.
   */
  readonly sessionZone?: string;
}

/**
 * Every case of `groupby-time-step-cases.ts` against one PostgreSQL driver.
 * The rows are written once and deleted at the end.
 */
export function runGroupByTimeStepBehavior(
  provider: GroupByTimeStepProvider
): void {
  describe(`${provider.name}: groupBy by a time step`, () => {
    const table = provider.table ?? "groupby_time_step";
    const schema = groupByTimeStepSchema(table);
    const driver = provider.createDriver();
    const base = createClient({ schema, driver });
    let clients: Clients;

    beforeAll(async () => {
      if (provider.prepare) await provider.prepare(driver, table);
      else await syncLiveSchema(base);
      await base.facture.deleteMany({});
      await base.depense.deleteMany({});
      await base.ancien.deleteMany({});
      await base.facture.createMany({ data: [...groupByTimeStepRows.facture] });
      await base.depense.createMany({ data: groupByTimeStepRows.depense });
      await base.ancien.createMany({ data: groupByTimeStepRows.ancien });
      clients = groupByTimeStepClients(base);
    });
    afterAll(async () => {
      await base.facture.deleteMany({});
      await base.depense.deleteMany({});
      await base.ancien.deleteMany({});
      await base.$disconnect();
    });

    test.runIf(provider.sessionZone !== undefined)(
      "the sessions run in a zone other than UTC",
      async () => {
        const { rows } = await driver._executeRaw<{ zone: string }>(
          "SELECT current_setting('TimeZone') AS zone"
        );
        expect(rows[0]?.zone).toBe(provider.sessionZone);
      }
    );

    test("the rows read back as written", async () => {
      const rows = await base.facture.findMany({ orderBy: { id: "asc" } });
      expect(
        rows.map((row) => ({
          ...row,
          date: row.date.toISOString(),
          dueAt: row.dueAt?.toISOString() ?? null,
          wall: row.wall.toISOString(),
          jour: row.jour.toISOString().slice(0, 10),
          natif: row.natif.toISOString(),
          deletedAt: row.deletedAt?.toISOString() ?? null,
        }))
      ).toEqual(groupByTimeStepRows.facture);
    });

    test("$as on a model no rule names: refused, as any read of it", async () => {
      await expect(
        clients.gated.depense.groupBy({
          by: [{ date: "month" }],
          _count: true,
        })
      ).rejects.toBeInstanceOf(ForbiddenError);
    });

    test("a cached call answers the same periods, on its miss and its hit", async () => {
      const args = {
        by: ["statut" as const, { dueAt: "month" as const }],
        timeZone: "America/Montreal",
        _count: true as const,
        _sum: { montant: true as const },
      };
      const expected = await base.facture.groupBy(args);
      const cached = base
        .$extends(cache({ driver: new MemoryCache() }))
        .$withCache({});
      expect(expected).toContainEqual(expect.objectContaining({ dueAt: null }));
      expect(await cached.facture.groupBy(args)).toEqual(expected);
      expect(await cached.facture.groupBy(args)).toEqual(expected);
      // Periods before the common era: year zero, and a week of year -1.
      for (const step of ["year", "week"] as const) {
        const ancient = { by: [{ date: step }], _count: true as const };
        const direct = await base.ancien.groupBy(ancient);
        expect(direct).toContainEqual(
          expect.objectContaining({
            date: step === "year" ? "0000-01-01" : "-0001-12-27",
          })
        );
        expect(await cached.ancien.groupBy(ancient)).toEqual(direct);
        expect(await cached.ancien.groupBy(ancient)).toEqual(direct);
      }
    });

    for (const { name, run } of GROUPBY_TIME_STEP_CASES)
      test(name, async () => {
        const { actual, expected } = await run(clients);
        expect(actual).toEqual(expected);
      });
  });
}

/**
 * A period's text never follows the session's `DateStyle`: PostgreSQL spells
 * a `date` as `01/01/2026` under `SQL, DMY`, and the period is published as
 * `2026-01-01` all the same. `prepare` puts the driver's session in that style
 * after the rows are written (other reads of dates are not this check's).
 */
export function runGroupByDateStyleBehavior(provider: {
  readonly name: string;
  readonly createDriver: () => AnyDriver;
  readonly inStyle: (driver: AnyDriver) => Promise<void>;
}): void {
  test(`${provider.name}: a period's text ignores the session's DateStyle`, async () => {
    const driver = provider.createDriver();
    const { ancien } = groupByTimeStepSchema("groupby_datestyle");
    const client = createClient({ schema: { ancien }, driver });
    try {
      await syncLiveSchema(client);
      await client.ancien.createMany({ data: groupByTimeStepRows.ancien });
      await provider.inStyle(driver);
      const { rows } = await driver._executeRaw<{ style: string }>(
        "SELECT current_setting('DateStyle') AS style"
      );
      expect(rows[0]?.style).toBe("SQL, DMY");
      expect(
        await client.ancien.groupBy({
          by: [{ date: "year" }],
          _count: true,
          orderBy: { date: "asc" },
        })
      ).toEqual(ancientGroups("year", 0));
    } finally {
      await client.$disconnect();
    }
  });
}
