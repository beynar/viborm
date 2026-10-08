import { createClient } from "@client/client";
import { createMigrationClient } from "@migrations";
import { getMigrationDriver } from "@migrations/drivers";
import type { ResolveChange } from "@migrations/types";
import { s } from "@schema";
import { PG } from "@schema/scalars/native-types";
import { VibORMErrorCode } from "@src/errors";
import { usePGliteSchemaFamily } from "@tests/fixtures/drivers/pglite";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import { describe, expect, test } from "vitest";

const family = usePGliteSchemaFamily({});
function schema(
  values: readonly ["a", "c"] | readonly ["a", "b", "c"] | readonly ["a", "b"],
  fallback: "a" | "b" | "c"
) {
  return {
    entry: s
      .model({
        id: s.string().id(),
        stamp: s
          .dateTime(PG.DATETIME.TIMESTAMP(3))
          .default("2024-01-15T10:30:00Z"),
        zoned: s.dateTime(PG.DATETIME.TIMESTAMPTZ(6)).nullable(),
        clock: s.time(PG.DATETIME.TIME(3)).default("12:30:00"),
        bit: s.string(PG.STRING.BIT(3)).nullable(),
        varbit: s.string(PG.STRING.VARBIT(8)).nullable(),
        zoneclock: s.time(PG.DATETIME.TIMETZ(3)).nullable(),
        handle: s.string(PG.STRING.VARCHAR(8)).nullable(),
        tags: s.string(PG.STRING.VARCHAR(8)).array(),
        chars: s.string(PG.STRING.CHAR(8)).array(),
        currentUtc: s.dateTime().withoutTimezone().now(),
        microStamp: s
          .dateTime(PG.DATETIME.TIMESTAMP(6))
          .withoutTimezone()
          .now(),
        microZoned: s.dateTime(PG.DATETIME.TIMESTAMPTZ(6)).now(),
        today: s.date().now(),
        currentClock: s.time().now(),
        zonedClock: s.time(PG.DATETIME.TIMETZ(3)).now(),
        ancient: s.dateTime().default("0000-01-01T00:00:00.000Z"),
        ancientDate: s.date().default("0000-01-01"),
        negative: s.int().default(-1),
        fractional: s.number().default(-0.5),
        tiny: s.number().default(1e-7),
        status: s
          .enum([...values])
          .name("adversarial_status")
          .default(fallback),
      })
      .map("roundtrip"),
  };
}

describe("adversarial PostgreSQL round trip", () => {
  test("native precision/defaults converge and enum changes stay atomic with data", async () => {
    const { driver, database, namespace } = family();
    const migrationDriver = getMigrationDriver(driver);
    const acquire = migrationDriver.generateAcquireLock(12_345);
    if (acquire === null)
      throw new Error("PostgreSQL must supply a lock statement");
    expect((await database.query<{ acquired: boolean }>(acquire)).rows).toEqual(
      [{ acquired: true }]
    );
    expect(
      (
        await database.query<{ released: boolean }>(
          "SELECT pg_advisory_unlock(12345) AS released"
        )
      ).rows
    ).toEqual([{ released: true }]);
    expect(
      (
        await database.query<{ released: boolean }>(
          "SELECT pg_advisory_unlock(12345) AS released"
        )
      ).rows
    ).toEqual([{ released: false }]);
    await database.exec("SET TIME ZONE 'Pacific/Kiritimati'");
    const initial = createClient({ schema: schema(["a", "c"], "a"), driver });
    await syncLiveSchema(initial);
    expect((await syncLiveSchema(initial)).outcome).toBe("noop");
    const defaults = await database.query<{
      date_ok: boolean;
      time_ok: boolean;
      zone_ok: boolean;
    }>(
      `INSERT INTO ${migrationDriver.escapeIdentifier(namespace)}."roundtrip" ("id", "tags", "chars") VALUES ('default-oracle', '{}', '{}') RETURNING "today"="currentUtc"::date AS date_ok, "currentClock"="currentUtc"::time(3) AS time_ok, EXTRACT(TIMEZONE FROM "zonedClock")=0 AS zone_ok`
    );
    expect(defaults.rows).toEqual([
      { date_ok: true, time_ok: true, zone_ok: true },
    ]);
    const generatedSix = await initial.entry.findUniqueOrThrow({
      where: { id: "default-oracle" },
    });
    for (const value of [generatedSix.microStamp, generatedSix.microZoned])
      expect(value).toBeInstanceOf(Date);
    await expect(
      initial.entry.findUniqueOrThrow({
        where: {
          id: "default-oracle",
          microStamp: generatedSix.microStamp,
          microZoned: generatedSix.microZoned,
        },
      })
    ).resolves.toMatchObject({ id: "default-oracle" });
    expect(
      (
        await database.query<{ stamp_ms: boolean; zoned_ms: boolean }>(
          `SELECT EXTRACT(MICROSECONDS FROM "microStamp")::bigint % 1000=0 AS stamp_ms, EXTRACT(MICROSECONDS FROM "microZoned")::bigint % 1000=0 AS zoned_ms FROM ${migrationDriver.escapeIdentifier(namespace)}."roundtrip" WHERE id='default-oracle'`
        )
      ).rows
    ).toEqual([{ stamp_ms: true, zoned_ms: true }]);
    await initial.entry.create({
      data: { id: "one", tags: [], chars: [], status: "c" },
    });
    const added = createClient({
      schema: schema(["a", "b", "c"], "b"),
      driver,
    });
    await syncLiveSchema(added);
    expect((await syncLiveSchema(added)).outcome).toBe("noop");
    expect(
      (
        await database.query<{ enumlabel: string }>(
          "SELECT enumlabel FROM pg_enum e JOIN pg_type t ON t.oid=e.enumtypid JOIN pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname=$1 AND t.typname=$2 ORDER BY enumsortorder",
          [namespace, "adversarial_status"]
        )
      ).rows.map((row) => row.enumlabel)
    ).toEqual(["a", "b", "c"]);
    await added.entry.create({
      data: { id: "two", tags: [], chars: [], status: "b" },
    });
    const removed = createClient({ schema: schema(["a", "b"], "b"), driver });
    const resolver = (change: ResolveChange) =>
      change.type === "enumValueRemoval"
        ? change.mapValues({ c: "b" })
        : change.type === "destructive"
          ? change.proceed()
          : change.reject();
    await syncLiveSchema(removed, { resolve: resolver });
    expect(
      (await removed.entry.findUnique({ where: { id: "one" } }))?.status
    ).toBe("b");
    expect((await syncLiveSchema(removed)).outcome).toBe("noop");
    await expect(
      createMigrationClient(removed).push({ dryRun: true })
    ).resolves.toMatchObject({ outcome: "noop" });
    const tableReference = `${migrationDriver.escapeIdentifier(namespace)}."roundtrip"`;
    await database.exec(
      `ALTER TABLE ${tableReference} RENAME CONSTRAINT roundtrip_pkey TO legacy_primary`
    );
    await expect(createMigrationClient(removed).push()).rejects.toMatchObject({
      code: VibORMErrorCode.FEATURE_NOT_SUPPORTED,
      message: expect.stringContaining("legacy_primary"),
    });
    expect(
      (
        await database.query<{ present: number }>(
          "SELECT 1 AS present FROM pg_constraint c JOIN pg_namespace n ON n.oid=c.connamespace WHERE n.nspname=$1 AND c.conname='legacy_primary'",
          [namespace]
        )
      ).rows
    ).toEqual([{ present: 1 }]);
    await database.exec(
      `ALTER TABLE ${tableReference} RENAME CONSTRAINT legacy_primary TO roundtrip_pkey`
    );
    // Native descending order is outside the declaration language. A dry-run
    // must preserve it and refuse instead of planning drop/create as plain ASC.
    const quote = migrationDriver.escapeIdentifier.bind(migrationDriver);
    await database.exec(
      `CREATE INDEX native_desc ON ${quote(namespace)}."roundtrip" ("negative" DESC)`
    );
    await expect(
      createMigrationClient(removed).push({ dryRun: true })
    ).rejects.toMatchObject({
      code: VibORMErrorCode.FEATURE_NOT_SUPPORTED,
      message: expect.stringContaining("native_desc"),
    });
    expect(
      (
        await database.query<{ definition: string }>(
          "SELECT pg_get_indexdef(i.oid) AS definition FROM pg_class i JOIN pg_namespace n ON n.oid=i.relnamespace WHERE n.nspname=$1 AND i.relname='native_desc'",
          [namespace]
        )
      ).rows[0]?.definition
    ).toContain("DESC");
  });
});
