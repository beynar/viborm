import { createClient } from "@client/client";
import { PGliteDriver } from "@drivers/pglite";
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
        microClock: s.time(PG.DATETIME.TIME(6)).now(),
        microZoneClock: s.time(PG.DATETIME.TIMETZ(6)).now(),
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
  test("literal defaults backfill populated PostgreSQL rows and repeat no-op", async () => {
    const fixture = family();
    const isolatedNamespace = `${fixture.namespace}_defaults`;
    await fixture.database.exec(`CREATE SCHEMA "${isolatedNamespace}"`);
    const driver = new PGliteDriver({
      client: fixture.database,
      namespace: isolatedNamespace,
    });
    const base = s.model({ id: s.string().id() }).map("default_rows");
    const before = createClient({ schema: { entry: base }, driver });
    await syncLiveSchema(before);
    await before.entry.create({ data: { id: "one" } });
    const extended = base.extends({
      names: s
        .string()
        .array()
        .default(["a,b", 'quoted"', "slash\\", "apostrophe'"]),
      numbers: s.int().array().default([1, -2]),
      empty: s.int().array().default([]),
      flags: s.boolean().array().default([true, false]),
      payload: s.json().default({ a: 1, nested: [null, true] }),
      normalized: s
        .json()
        .schema({
          "~standard": {
            version: 1,
            vendor: "fixture",
            validate: () => ({ value: { normalized: true } }),
          },
        })
        .default({ input: true }),
      documents: s.json().default([{ a: 1 }, { quoted: "'quote\"" }]),
      huge: s.bigInt().default(9007199254740993n),
      instant: s.dateTime().default(new Date("2024-01-15T10:30:00.123Z")),
      day: s.date().default(new Date("0000-01-15T10:30:00.123Z")),
    });
    const after = createClient({ schema: { entry: extended }, driver });
    await syncLiveSchema(after);
    await expect(
      after.entry.findUnique({ where: { id: "one" } })
    ).resolves.toMatchObject({
      names: ["a,b", 'quoted"', "slash\\", "apostrophe'"],
      numbers: [1, -2],
      empty: [],
      flags: [true, false],
      payload: { a: 1, nested: [null, true] },
      normalized: { normalized: true },
      documents: [{ a: 1 }, { quoted: "'quote\"" }],
      huge: 9007199254740993n,
      instant: new Date("2024-01-15T10:30:00.123Z"),
      day: new Date("0000-01-15T00:00:00.000Z"),
    });
    await expect(syncLiveSchema(after)).resolves.toMatchObject({
      outcome: "noop",
    });
    const required = createClient({
      schema: {
        entry: extended.extends({
          generated: s.string().default(() => "value"),
        }),
      },
      driver,
    });
    await expect(
      createMigrationClient(required).push({ dryRun: true })
    ).rejects.toMatchObject({
      message: expect.stringContaining("manual data migration"),
    });
  });

  test("generated columns, partitions and mapped views refuse while excluded objects remain independent", async () => {
    const fixture = family();
    const database = fixture.database;
    const namespace = `${fixture.namespace}_native`;
    await database.exec(`CREATE SCHEMA "${namespace}"`);
    const driver = new PGliteDriver({ client: database, namespace });
    const quote = getMigrationDriver(driver).escapeIdentifier.bind(
      getMigrationDriver(driver)
    );
    await database.exec(
      `CREATE TABLE ${quote(namespace)}.generated_rows (id TEXT PRIMARY KEY, value INTEGER GENERATED ALWAYS AS (length(id)) STORED); INSERT INTO ${quote(namespace)}.generated_rows (id) VALUES ('keep'); CREATE TABLE ${quote(namespace)}.partition_rows (id INTEGER) PARTITION BY RANGE(id); CREATE VIEW ${quote(namespace)}.mapped_view AS SELECT 1 AS id`
    );
    const isolated = createClient({
      schema: { entry: s.model({ id: s.string().id() }).map("managed_rows") },
      driver,
    });
    await createMigrationClient(isolated, { tables: ["managed_rows"] }).push();
    await expect(
      createMigrationClient(isolated, { tables: ["managed_rows"] }).push()
    ).resolves.toMatchObject({ outcome: "noop" });
    for (const name of ["generated_rows", "partition_rows", "mapped_view"]) {
      const client = createClient({
        schema: { entry: s.model({ id: s.string().id() }).map(name) },
        driver,
      });
      await expect(
        createMigrationClient(client, { tables: [name] }).push({ dryRun: true })
      ).rejects.toMatchObject({
        code: VibORMErrorCode.MIGRATION_INVALID_STATE,
      });
    }
    expect(
      (
        await database.query<{ value: number }>(
          `SELECT value FROM ${quote(namespace)}.generated_rows`
        )
      ).rows
    ).toEqual([{ value: 4 }]);
    expect(
      (
        await database.query<{ id: number }>(
          `SELECT id FROM ${quote(namespace)}.mapped_view`
        )
      ).rows
    ).toEqual([{ id: 1 }]);
  });

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
      `INSERT INTO ${migrationDriver.escapeIdentifier(namespace)}."roundtrip" ("id", "tags", "chars") VALUES ('default-oracle', '{}', '{}') RETURNING "today"="currentUtc"::date AS date_ok, "currentClock"="currentUtc"::time(3) AS time_ok, EXTRACT(TIMEZONE FROM "zonedClock")=0 AS zone_ok, EXTRACT(MICROSECONDS FROM "microClock")::bigint % 1000=0 AS clock_ms, EXTRACT(MICROSECONDS FROM "microZoneClock")::bigint % 1000=0 AS zoneclock_ms, EXTRACT(TIMEZONE FROM "microZoneClock")=0 AS micro_zone_ok`
    );
    expect(defaults.rows).toEqual([
      {
        date_ok: true,
        time_ok: true,
        zone_ok: true,
        clock_ms: true,
        zoneclock_ms: true,
        micro_zone_ok: true,
      },
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
          microClock: generatedSix.microClock,
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
