// biome-ignore-all lint/suspicious/noMisplacedAssertion: These shared assertions run only inside registered provider tests.
import { createClient } from "@client/client";
import type { AnyDriver } from "@drivers/driver";
import { ReadOperation } from "@query-engine/write-engine/ReadOperation";
import { s } from "@schema";
import { sql } from "@sql";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import { expect, vi } from "vitest";

const schema = {
  entry: s.model({
    id: s.string().id(),
    enabled: s.boolean(),
    recordedAt: s.dateTime(),
  }),
};

const RECORDED_AT = "2026-08-24T10:00:00.000Z";

export async function expectDirectReadMode(
  driver: AnyDriver,
  expected: "borrowed" | "consumable"
): Promise<void> {
  const client = createClient({ schema, driver });
  try {
    await syncLiveSchema(client);
    // A supplied client survives this driver's disconnect and is reinstalled by
    // identity, so repeated rounds use the same database.
    await client.entry.deleteMany();
    await client.entry.create({
      data: { id: "entry-1", enabled: true, recordedAt: RECORDED_AT },
    });
    const consumableParse = vi.spyOn(
      ReadOperation.prototype,
      "parseResultWithProgram"
    );
    consumableParse.mockClear();

    const result = await client.entry.findMany();

    expect(result).toEqual([
      {
        id: "entry-1",
        enabled: true,
        recordedAt: new Date(RECORDED_AT),
      },
    ]);
    if (expected === "consumable") {
      expect(consumableParse).toHaveBeenCalledTimes(1);
      const rows = consumableParse.mock.calls[0]?.[4];
      expect(rows).toBeDefined();
      expect(result).not.toBe(rows);
      expect(result[0]).toBe(rows?.[0]);
      return;
    }
    expect(consumableParse).not.toHaveBeenCalled();
  } finally {
    await client.$disconnect();
  }
}

export async function expectUnmarkedTypedAndRawResults(
  driver: AnyDriver
): Promise<void> {
  const context = { operation: "findMany" };
  try {
    const typed = await driver._execute<{ value: number }>(
      sql`SELECT 1 AS "value"`,
      context
    );
    const raw = await driver._executeRaw<{ value: number }>(
      'SELECT 1 AS "value"'
    );

    expect(Reflect.ownKeys(typed)).toEqual(["rows", "rowCount"]);
    expect(Object.getOwnPropertySymbols(typed)).toEqual([]);
    expect(Object.getOwnPropertySymbols(raw)).toEqual([]);
    expect(Object.getOwnPropertySymbols(context)).toEqual([]);
    expect(Reflect.ownKeys(context)).toEqual(["operation"]);
    expect(Object.getOwnPropertySymbols(driver)).toEqual([]);
    expect(Object.getOwnPropertySymbols(Object.getPrototypeOf(driver))).toEqual(
      []
    );
  } finally {
    await driver.disconnect();
  }
}
