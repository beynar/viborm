// Provider ownership integration; intentionally outside the core lane.
import { MemoryCache } from "@cache/drivers/memory";
import { cache } from "@cache/extension";
import { createClient } from "@client/client";
import type { AnyDriver } from "@drivers";
import { PGliteDriver } from "@drivers/pglite";
import { sqliteResultParser } from "@drivers/shared";
import { SQLite3Driver } from "@drivers/sqlite3";

import { ReadOperation } from "@query-engine/write-engine/ReadOperation";
import { s } from "@schema";
import { afterEach, describe, expect, test, vi } from "vitest";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";

const schema = {
  entry: s.model({
    id: s.string().id(),
    enabled: s.boolean(),
    recordedAt: s.dateTime(),
  }),
};

const RECORDED_AT = "2026-08-24T10:00:00.000Z";

async function seed(driver: AnyDriver): Promise<void> {
  const client = createClient({ schema, driver });
  await syncLiveSchema(client);
  await client.entry.create({
    data: { id: "entry-1", enabled: true, recordedAt: RECORDED_AT },
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("executor-proven consumable rows", () => {
  test("reuses SQLite3 roots only on an ordinary direct read", async () => {
    const driver = new SQLite3Driver();
    const client = createClient({ schema, driver });
    await seed(driver);

    const consumableParse = vi.spyOn(
      ReadOperation.prototype,
      "parseResultWithProgram"
    );
    const original = sqliteResultParser.parseResult;
    if (!original) throw new Error("SQLite result middleware is absent.");
    let middlewareRows: unknown[] | undefined;
    let middlewareCalls = 0;

    consumableParse.mockClear();
    const direct = await client.entry.findMany();
    const directCall = consumableParse.mock.calls[0];
    const directRows = directCall?.[4];
    expect(consumableParse).toHaveBeenCalledTimes(1);
    expect(directRows).toBeDefined();
    expect(directCall?.[0].result).toBe(directRows);
    expect(direct).not.toBe(directRows);
    expect(direct[0]).toBe(directRows?.[0]);
    expect(direct[0]?.enabled).toBe(true);
    expect(direct[0]?.recordedAt).toEqual(new Date(RECORDED_AT));

    try {
      const official = createClient({ schema, driver }).$extends(
        cache({ driver: new MemoryCache() })
      );
      consumableParse.mockClear();
      const officialMiss = await official.$withCache().entry.findMany();
      expect(consumableParse).not.toHaveBeenCalled();
      consumableParse.mockClear();
      const officialHit = await official.$withCache().entry.findMany();
      expect(consumableParse).not.toHaveBeenCalled();
      expect(officialHit).toEqual(officialMiss);
      expect(officialHit).not.toBe(officialMiss);

      sqliteResultParser.parseResult = (raw, operation, next) => {
        if (operation === "findMany" && Array.isArray(raw)) {
          middlewareRows = raw;
          middlewareCalls += 1;
        }
        return original(raw, operation, next);
      };

      middlewareRows = undefined;
      middlewareCalls = 0;
      consumableParse.mockClear();
      const transactional = await client.$transaction(
        async (tx) => await tx.entry.findMany()
      );
      const transactionRows = middlewareRows;
      expect(middlewareCalls).toBe(1);
      expect(consumableParse).not.toHaveBeenCalled();
      expect(transactionRows).toBeDefined();
      expect(transactional[0]).not.toBe(transactionRows?.[0]);
      expect(transactionRows?.[0]).toMatchObject({
        enabled: 1n,
        recordedAt: RECORDED_AT,
      });

      middlewareRows = undefined;
      middlewareCalls = 0;
      consumableParse.mockClear();
      const [batched] = await client.$transaction([client.entry.findMany()]);
      const batchRows = middlewareRows;
      expect(middlewareCalls).toBe(1);
      expect(consumableParse).not.toHaveBeenCalled();
      expect(batchRows).toBeDefined();
      expect(batched[0]).not.toBe(batchRows?.[0]);
      expect(batchRows?.[0]).toMatchObject({
        enabled: 1n,
        recordedAt: RECORDED_AT,
      });

      middlewareRows = undefined;
      middlewareCalls = 0;
      consumableParse.mockClear();
      const raw = await client.$queryRaw<{
        enabled: bigint;
        recordedAt: string;
      }>`SELECT "enabled", "recordedAt" FROM "entry"`;
      expect(consumableParse).not.toHaveBeenCalled();
      expect(middlewareCalls).toBe(0);
      expect(raw).toEqual([{ enabled: 1n, recordedAt: RECORDED_AT }]);
    } finally {
      sqliteResultParser.parseResult = original;
      await client.$disconnect();
    }
  });

  test("reuses PGlite roots for conversion on an ordinary direct read", async () => {
    const driver = new PGliteDriver();
    const client = createClient({ schema, driver });
    await seed(driver);

    const consumableParse = vi.spyOn(
      ReadOperation.prototype,
      "parseResultWithProgram"
    );

    try {
      consumableParse.mockClear();
      const parsed = await client.entry.findMany();
      const rows = consumableParse.mock.calls[0]?.[4];

      expect(consumableParse).toHaveBeenCalledTimes(1);
      expect(rows).toBeDefined();
      expect(parsed).not.toBe(rows);
      expect(parsed[0]).toBe(rows?.[0]);
      expect(parsed[0]?.recordedAt).toEqual(new Date(RECORDED_AT));

      consumableParse.mockClear();
      const nativeIdentity = await client.entry.findMany({
        select: { id: true, enabled: true },
      });
      expect(consumableParse).toHaveBeenCalledTimes(1);
      expect(consumableParse.mock.calls[0]?.[4]).toBeUndefined();
      expect(nativeIdentity).toEqual([{ id: "entry-1", enabled: true }]);
    } finally {
      await client.$disconnect();
    }
  });

  test("copies frozen replacements from custom driver and adapter root middleware", async () => {
    const driver = new SQLite3Driver();
    const client = createClient({ schema, driver });
    await seed(driver);
    const consumableParse = vi.spyOn(
      ReadOperation.prototype,
      "parseResultWithProgram"
    );
    const originalDriverParse = sqliteResultParser.parseResult;
    const originalAdapterParse = driver.adapter.result.parseResult;
    if (!originalDriverParse) {
      throw new Error("SQLite result middleware is absent.");
    }
    const driverRow = Object.freeze({
      id: "driver-row",
      enabled: 0n,
      recordedAt: RECORDED_AT,
    });
    const adapterRow = Object.freeze({
      id: "adapter-row",
      enabled: 1n,
      recordedAt: RECORDED_AT,
    });
    let retainedRows: unknown[] | undefined;

    try {
      sqliteResultParser.parseResult = (raw, operation, next) => {
        if (operation === "findMany" && Array.isArray(raw)) {
          retainedRows = raw;
        }
        return originalDriverParse(raw, operation, next);
      };
      consumableParse.mockClear();
      const retainedParsed = await client.entry.findMany();
      expect(consumableParse).toHaveBeenCalledTimes(1);
      expect(consumableParse.mock.calls[0]?.[4]).toBeUndefined();
      expect(retainedRows).toBeDefined();
      expect(retainedParsed[0]).not.toBe(retainedRows?.[0]);
      expect(retainedRows?.[0]).toMatchObject({
        enabled: 1n,
        recordedAt: RECORDED_AT,
      });

      sqliteResultParser.parseResult = (raw, operation, next) =>
        operation === "findMany"
          ? next([driverRow], operation)
          : originalDriverParse(raw, operation, next);
      consumableParse.mockClear();
      const driverParsed = await client.entry.findMany();
      expect(consumableParse).toHaveBeenCalledTimes(1);
      expect(consumableParse.mock.calls[0]?.[4]).toBeUndefined();
      expect(driverParsed[0]).not.toBe(driverRow);
      expect(driverParsed[0]).toEqual({
        id: "driver-row",
        enabled: false,
        recordedAt: new Date(RECORDED_AT),
      });
      expect(driverRow.enabled).toBe(0n);

      sqliteResultParser.parseResult = originalDriverParse;
      driver.adapter.result.parseResult = (raw, operation, next) =>
        operation === "findMany"
          ? next([adapterRow])
          : originalAdapterParse(raw, operation, next);
      consumableParse.mockClear();
      const adapterParsed = await client.entry.findMany();
      expect(consumableParse).toHaveBeenCalledTimes(1);
      expect(consumableParse.mock.calls[0]?.[4]).toBeUndefined();
      expect(adapterParsed[0]).not.toBe(adapterRow);
      expect(adapterParsed[0]).toEqual({
        id: "adapter-row",
        enabled: true,
        recordedAt: new Date(RECORDED_AT),
      });
      expect(adapterRow.enabled).toBe(1n);
    } finally {
      sqliteResultParser.parseResult = originalDriverParse;
      driver.adapter.result.parseResult = originalAdapterParse;
      await client.$disconnect();
    }
  });
});
