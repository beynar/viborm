import { sqliteGeoPointCheck } from "@adapters/databases/sqlite/storage/geo-point";
import { createClient } from "@client/client";
import { SQLite3Driver } from "@drivers/sqlite3";
import { s } from "@schema";
import {
  sqliteCanonicalDateTimePredicate,
  sqliteCanonicalTimePredicate,
} from "@src/adapters/databases/sqlite/storage/datetime";
import { isVibORMError, VibORMErrorCode } from "@src/errors";
import {
  sqliteCanonicalDateTimeExpression,
  sqliteCanonicalTimeExpression,
} from "@src/migrations";
import { createMigrationClient } from "@src/migrations/client";
import {
  compileGeneratedTransition,
  hashParent,
  rebindChecks,
  rebindDispatches,
  rebindRollback,
  sealParent,
} from "@src/migrations/compile";
import { getMigrationDriver } from "@src/migrations/drivers";
import {
  type PushOptionsV1,
  previewPush,
  pushV1,
} from "@src/migrations/push-v1";
import { SqlAssembly } from "@src/migrations/sql-assembly";
import { MemoryEstateStorage } from "@src/migrations/storage/memory";
import type { ResolveCallback, SchemaSnapshot } from "@src/migrations/types";
import {
  encodeEstateDescriptor,
  encodeSnapshot,
  encodeStateManifest,
} from "@src/migrations/v1-parse";
import { PlanningDriver } from "@tests/fixtures/drivers/planning";
import { createInMemorySQLite3Driver } from "@tests/fixtures/drivers/sqlite3";
import { describe, expect, expectTypeOf, test } from "vitest";
import { sqliteEstateDriver } from "./_estate";

const EXPECTED_ERROR_PATTERN = /^[a-f0-9]{64}$/;
const DROP_FOREIGN_LEDGER_PATTERN = /DROP.*foreign_ledger/;
const EXPECTED_ERROR_PATTERN_2 = /^\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?$/;

const SCHEMA_WRITE = /^(CREATE|ALTER|DROP|INSERT|UPDATE|DELETE|REPLACE)\b/i;

const user = s.model({
  id: s.string().id(),
  email: s.string().unique(),
});

const counter = s.model({
  id: s.int().id(),
  label: s.string(),
});

describe("migration v1 authenticated push", () => {
  test.each([
    "lower(label)",
    "label DESC",
    "label COLLATE NOCASE",
  ])("refuses native SQLite index %s without affecting its table, while selected external scope remains usable", async (expression) => {
    const driver = createInMemorySQLite3Driver();
    const client = createClient({
      schema: { native: s.model({ id: s.int().id(), label: s.string() }) },
      driver,
    });
    try {
      await pushV1(client);
      await driver._executeRaw(
        `CREATE INDEX native_semantics ON native (${expression})`
      );
      await driver._executeRaw("INSERT INTO native VALUES (1, ?)", [
        "preserved",
      ]);
      await expect(
        createMigrationClient(client).push({ dryRun: true })
      ).rejects.toMatchObject({
        code: VibORMErrorCode.FEATURE_NOT_SUPPORTED,
        message: expect.stringContaining("native.native_semantics"),
      });
      expect(
        (
          await driver._executeRaw<{ label: string }>(
            "SELECT label FROM native"
          )
        ).rows
      ).toEqual([{ label: "preserved" }]);
      expect(
        (
          await driver._executeRaw<{ sql: string }>(
            "SELECT sql FROM sqlite_master WHERE name='native_semantics'"
          )
        ).rows[0]?.sql
      ).toContain(expression);
      const external = createClient({
        schema: { selected: s.model({ id: s.int().id() }) },
        driver,
      });
      const migrations = createMigrationClient(external, {
        tables: ["selected"],
      });
      await migrations.push();
      expect((await migrations.push({ dryRun: true })).outcome).toBe("noop");
    } finally {
      await client.$disconnect();
    }
  });

  test("contiguous column changes rebuild once, preserve data, and inverse rebuilds once", async () => {
    const driver = createInMemorySQLite3Driver();
    const model = (nullable: boolean) =>
      s
        .model({
          id: s.int().id(),
          a: nullable ? s.string().nullable() : s.string(),
          b: nullable ? s.int().nullable() : s.int(),
        })
        .map("entry");
    const client = createClient({ schema: { entry: model(false) }, driver });
    const changed = createClient({ schema: { entry: model(true) }, driver });
    try {
      const storage = new MemoryEstateStorage();
      const original = createMigrationClient(client, { storage });
      await original.generate({ name: "required" });
      await original.apply();
      await client.entry.create({ data: { id: 1, a: "keep", b: 23 } });
      const migrations = createMigrationClient(changed, { storage });
      const generated = await migrations.generate({ name: "nullable" });
      const forward = generated.reviewSql.split("-- ROLLBACK")[0]!;
      // CREATE TEMP + copy/drop/rename is one recreation program for both columns.
      expect(forward.match(/CREATE TABLE "__new_entry"/g)).toHaveLength(1);
      expect(
        generated.reviewSql
          .slice(generated.reviewSql.indexOf("-- ROLLBACK"))
          .match(/CREATE TABLE "__new_entry"/g)
      ).toHaveLength(1);
      await migrations.apply();
      expect(
        await changed.entry.findUniqueOrThrow({ where: { id: 1 } })
      ).toEqual({ id: 1, a: "keep", b: 23 });
      await migrations.down();
      expect(await original.verify()).toEqual({ ok: true });
      expect(
        await client.entry.findUniqueOrThrow({ where: { id: 1 } })
      ).toEqual({ id: 1, a: "keep", b: 23 });
    } finally {
      await client.$disconnect();
    }
  });

  test("manual temporal repair preserves wide-offset instants, year zero and NULL", async () => {
    const driver = createInMemorySQLite3Driver();
    try {
      await driver._executeRaw(
        `CREATE TABLE "repair" ("stamp" TEXT, "clock" TEXT)`
      );
      const values = [
        "2024-01-15T10:30:00+00:00",
        "2024-01-15T23:59:59.9+23:59",
        "0000-01-01T00:00:00Z",
        "9999-12-31T23:59:59.999Z",
        null,
      ];
      for (const stamp of values)
        await driver._executeRaw("INSERT INTO repair VALUES (?,?)", [
          stamp,
          stamp === null ? null : "12:30:00.1",
        ]);
      const stampExpression = sqliteCanonicalDateTimeExpression("stamp");
      const clockExpression = sqliteCanonicalTimeExpression("clock");
      const before = await driver._executeRaw<{
        stamp: string | null;
        clock: string | null;
      }>(
        `SELECT ${stampExpression} AS stamp, ${clockExpression} AS clock FROM repair ORDER BY rowid`
      );
      expect(before.rows.map((row) => row.stamp)).toEqual(
        values.map((value) =>
          value === null ? null : new Date(value).toISOString()
        )
      );
      expect(before.rows.map((row) => row.clock)).toEqual([
        "12:30:00.100",
        "12:30:00.100",
        "12:30:00.100",
        "12:30:00.100",
        null,
      ]);
      await driver._executeRaw(
        `UPDATE repair SET stamp=${stampExpression}, clock=${clockExpression}`
      );
      expect(
        (
          await driver._executeRaw<{ valid: number }>(
            `SELECT ${sqliteCanonicalDateTimePredicate("stamp")} AND ${sqliteCanonicalTimePredicate("clock")} AS valid FROM repair`
          )
        ).rows.map((row) => row.valid)
      ).toEqual([1, 1, 1, 1, 1]);
      expect(
        (
          await driver._executeRaw(
            "SELECT stamp,clock FROM repair ORDER BY rowid"
          )
        ).rows
      ).toEqual(before.rows);
      await driver._executeRaw("INSERT INTO repair VALUES (?,?)", [
        "2024-02-30T00:00:00Z",
        "24:00:00",
      ]);
      expect(
        (
          await driver._executeRaw<{ valid: number }>(
            `SELECT ${sqliteCanonicalDateTimePredicate("stamp")} OR ${sqliteCanonicalTimePredicate("clock")} AS valid FROM repair ORDER BY rowid DESC LIMIT 1`
          )
        ).rows[0]!.valid
      ).toBe(0);
      await expect(
        driver._executeRaw(`UPDATE repair SET stamp=${stampExpression}`)
      ).rejects.toThrow();
      await expect(
        driver._executeRaw(`UPDATE repair SET clock=${clockExpression}`)
      ).rejects.toThrow();
      await driver._executeRaw('CREATE TABLE "quoted" ("a""b" TEXT)');
      await driver._executeRaw('INSERT INTO "quoted" VALUES (?)', [
        "2024-01-15T10:30:00Z",
      ]);
      expect(
        (
          await driver._executeRaw<{ value: string }>(
            `SELECT ${sqliteCanonicalDateTimeExpression('a"b')} AS value FROM quoted`
          )
        ).rows[0]!.value
      ).toBe("2024-01-15T10:30:00.000Z");
    } finally {
      await driver.disconnect();
    }
  });

  test("authenticated pre-annotation GeoPoint estate replays, verifies, and upgrades without silent precision rollback", async () => {
    const driver = createInMemorySQLite3Driver();
    const entry = s
      .model({ id: s.int().id(), location: s.point().nullable() })
      .map("entry");
    const client = createClient({ schema: { entry }, driver });
    const storage = new MemoryEstateStorage();
    try {
      const bound = getMigrationDriver(driver);
      const legacy: SchemaSnapshot = {
        tables: [
          {
            name: "entry",
            columns: [
              { name: "id", type: "INTEGER", nullable: false },
              { name: "location", type: "VIBORM_GEO_TEXT", nullable: true },
            ],
            primaryKey: { columns: ["id"] },
            indexes: [],
            foreignKeys: [],
            uniqueConstraints: [],
          },
        ],
      };
      const assembly = new SqlAssembly();
      const compiled = compileGeneratedTransition(
        [{ type: "createTable", table: legacy.tables[0]! }],
        bound,
        "artifact",
        { tables: [] },
        legacy,
        assembly
      );
      const sealed = assembly.seal();
      const estate = encodeEstateDescriptor(bound.target);
      const snapshot = encodeSnapshot(legacy);
      const parent = hashParent({
        ...sealParent(null, compiled),
        originChecks: rebindChecks(compiled.originChecks, sealed.dispatches),
        operations: rebindDispatches(compiled.operations, sealed.dispatches),
        rollback: rebindRollback(compiled.rollback, sealed.dispatches),
      });
      const state = encodeStateManifest({
        format: "1",
        estateHash: estate.estateHash,
        name: "pre-annotation",
        snapshotHash: snapshot.snapshotHash,
        sqlHash: sealed.sqlHash,
        destinationChecks: [],
        parents: [parent],
      });
      await storage.publishEstate(estate.bytes);
      await storage.publishSnapshot(snapshot.snapshotHash, snapshot.bytes);
      await storage.publishSql(sealed.sqlHash, sealed.bytes);
      await storage.publishState(state.stateId, state.bytes);
      const migrations = createMigrationClient(client, { storage });
      await migrations.apply();
      expect(await migrations.verify()).toEqual({ ok: true });
      expect(new TextDecoder().decode(sealed.bytes)).not.toContain("%!.17g");
      await driver._executeRaw(
        `INSERT INTO entry VALUES (1,json_object('longitude',?, 'latitude',?))`,
        [Math.PI, 48.123_456_789_123_45]
      );
      const upgrade = await migrations.generate({ name: "binary64" });
      expect(upgrade.operations).toHaveLength(1);
      expect(upgrade.warnings.join(" ")).toContain(
        "without rounding coordinates"
      );
      await migrations.apply();
      expect(await migrations.verify()).toEqual({ ok: true });
      expect((await migrations.generate()).outcome).toBe("noop");
      expect(await storage.readState(state.stateId)).toEqual(state.bytes);
      await expect(migrations.down()).rejects.toThrow(
        "without rounding coordinates"
      );
      const location = { longitude: Math.PI, latitude: 48.123_456_789_123_45 };
      expect(
        (await client.entry.create({ data: { id: 2, location } })).location
      ).toEqual(location);
    } finally {
      await client.$disconnect();
    }
  });

  test("legacy GeoPoint CHECK upgrades once while preserving stored doubles and NULL", async () => {
    const driver = createInMemorySQLite3Driver();
    const entry = s
      .model({ id: s.int().id(), location: s.point().nullable() })
      .map("entry");
    const client = createClient({ schema: { entry }, driver });
    try {
      const check = sqliteGeoPointCheck(
        { name: "location", nullable: true },
        (name) => `"${name}"`,
        "legacy"
      );
      await driver._executeRaw(
        `CREATE TABLE "entry" ("id" INTEGER NOT NULL PRIMARY KEY, "location" VIBORM_GEO_TEXT ${check})`
      );
      await driver._executeRaw(
        `INSERT INTO "entry" VALUES (1, json_object('longitude', ?, 'latitude', ?)), (2, NULL)`,
        [Math.PI, 48.123_456_789_123_45]
      );
      const before = await driver._executeRaw<{
        longitude: number;
        latitude: number;
      }>(
        `SELECT json_extract(location,'$.longitude') AS longitude, json_extract(location,'$.latitude') AS latitude FROM entry WHERE id=1`
      );
      expect((await pushV1(client)).outcome).toBe("applied");
      expect((await pushV1(client)).outcome).toBe("noop");
      expect(
        (await client.entry.findUniqueOrThrow({ where: { id: 1 } })).location
      ).toEqual(before.rows[0]);
      expect(
        (await client.entry.findUniqueOrThrow({ where: { id: 2 } })).location
      ).toBeNull();
      const location = { longitude: Math.PI, latitude: 48.123_456_789_123_45 };
      expect(
        (await client.entry.create({ data: { id: 3, location } })).location
      ).toEqual(location);
      expect(
        (await client.entry.findUniqueOrThrow({ where: { id: 3 } })).location
      ).toEqual(location);
    } finally {
      await client.$disconnect();
    }
  });

  test("dry-run is effect-free and force-reset dry-run does not write", async () => {
    const driver = sqliteEstateDriver();
    const client = { $driver: driver, $schema: { user } };
    const preview = await previewPush(client, { forceReset: true });
    expect(preview.consent.mode).toBe("force-reset");
    expect(
      driver.statements.filter((statement) =>
        SCHEMA_WRITE.test(statement.trim())
      )
    ).toEqual([]);
  });

  test("stale consent refuses after an external schema change", async () => {
    const driver = createInMemorySQLite3Driver();
    const client = createClient({ schema: { user }, driver });
    const preview = await previewPush(client);
    await pushV1(client);
    await expect(
      pushV1(client, { consent: preview.consent })
    ).rejects.toMatchObject({
      code: VibORMErrorCode.MIGRATION_CONSENT_MISMATCH,
    });
    await client.$disconnect();
  });

  test("consent from another driver binding is refused", async () => {
    const first = createClient({
      schema: { user },
      driver: createInMemorySQLite3Driver(),
    });
    const second = createClient({
      schema: { user },
      driver: createInMemorySQLite3Driver(),
    });
    const preview = await previewPush(first);
    await expect(
      pushV1(second, { consent: preview.consent })
    ).rejects.toMatchObject({
      code: VibORMErrorCode.MIGRATION_CONSENT_MISMATCH,
    });
    await first.$disconnect();
    await second.$disconnect();
  });

  test("ordinary dry-run plans a diff and writes nothing", async () => {
    const driver = sqliteEstateDriver();
    const client = { $driver: driver, $schema: { user } };
    const preview = await previewPush(client);
    expect(preview.consent.mode).toBe("diff");
    expect(preview.outcome).toBe("planned");
    const dry = await pushV1(client, { dryRun: true });
    expect(dry).toMatchObject({ outcome: "planned" });
    expect(
      driver.statements.filter((statement) =>
        SCHEMA_WRITE.test(statement.trim())
      )
    ).toEqual([]);
  });

  test("a non-empty push against a migration marker is refused", async () => {
    const driver = createInMemorySQLite3Driver();
    const storage = new MemoryEstateStorage();
    const client = createClient({ schema: { user }, driver });
    const migrations = createMigrationClient(client, { storage });
    await migrations.generate({ name: "init" });
    await migrations.apply();
    const post = s.model({
      id: s.string().id(),
      title: s.string(),
    });
    const next = createClient({ schema: { user, post }, driver });
    await expect(pushV1(next)).rejects.toMatchObject({
      code: VibORMErrorCode.MIGRATION_INVALID_STATE,
      message: expect.stringContaining("migration marker"),
    });
    await client.$disconnect();
  });

  test("generic force is not a V1 option", async () => {
    const client = createClient({
      schema: { user },
      driver: new PlanningDriver("sqlite"),
    });
    await expect(
      pushV1(client, { force: true } as never)
    ).rejects.toMatchObject({
      code: VibORMErrorCode.INVALID_INPUT,
      message: expect.stringContaining("unknown key force"),
    });
    expectTypeOf<PushOptionsV1>().not.toHaveProperty("force");
  });

  test("sqlite integer primary keys without AUTOINCREMENT attest", async () => {
    const client = createClient({
      schema: { counter },
      driver: createInMemorySQLite3Driver(),
    });
    const result = await pushV1(client);
    expect(result.outcome).toBe("applied");
    const second = await pushV1(client);
    expect(second.outcome).toBe("noop");
    await client.$disconnect();
  });

  test("a transactionless admitted driver still applies", async () => {
    class TransactionlessSQLite3 extends SQLite3Driver {
      override readonly supportsTransactions = false;
    }
    const driver = new TransactionlessSQLite3({ dataDir: ":memory:" });
    const client = createClient({ schema: { user }, driver });
    const result = await pushV1(client);
    expect(result.outcome).toBe("applied");
    await client.$disconnect();
  });

  test("second push is a no-op", async () => {
    const client = createClient({
      schema: { user },
      driver: createInMemorySQLite3Driver(),
    });
    const first = await pushV1(client);
    expect(first.outcome).toBe("applied");
    const second = await pushV1(client);
    expect(second.outcome).toBe("noop");
    await client.$disconnect();
  });

  test("sqlite enum CHECK is the same physical type after introspect", async () => {
    const item = s.model({
      id: s.string().id(),
      kind: s.enum(["alpha", "beta"]),
    });
    const client = createClient({
      schema: { item },
      driver: createInMemorySQLite3Driver(),
    });
    await pushV1(client);
    const second = await previewPush(client);
    expect(second.operations).toEqual([]);
    await client.$disconnect();
  });

  test("a resolved destructive change still requires consent, then applies the locked replan", async () => {
    const driver = createInMemorySQLite3Driver();
    const initial = createClient({ schema: { user }, driver });
    await pushV1(initial);
    const reducedUser = s.model({ id: s.string().id() });
    const reduced = createClient({ schema: { user: reducedUser }, driver });
    const resolve: ResolveCallback = (change) =>
      change.type === "destructive" ? change.proceed() : undefined;

    const refusal: unknown = await pushV1(reduced, { resolve }).catch(
      (error: unknown) => error
    );
    if (!isVibORMError(refusal))
      throw new Error("Expected a typed destructive-consent refusal");
    expect(refusal.toJSON()).toMatchObject({
      code: VibORMErrorCode.MIGRATION_CONSENT_REQUIRED,
      message: expect.stringContaining("push({ dryRun: true })"),
      meta: {
        command: "push",
        dialect: "sqlite",
        expectedChecksum: expect.stringMatching(EXPECTED_ERROR_PATTERN),
        expectedStatementCount: expect.any(Number),
        hint: expect.stringContaining("consent"),
      },
    });
    expect(refusal.toJSON().meta).not.toHaveProperty("preview");
    const preview = await previewPush(reduced, { resolve });
    expect(preview.destructive).toBe(true);
    await expect(
      pushV1(reduced, { consent: preview.consent })
    ).resolves.toMatchObject({ outcome: "applied" });
    await expect(pushV1(reduced)).resolves.toMatchObject({ outcome: "noop" });
    await initial.$disconnect();
  });

  test("push refuses success when the provider does not realize its statements", async () => {
    const driver = sqliteEstateDriver();
    const client = { $driver: driver, $schema: { user } };

    await expect(pushV1(client)).rejects.toMatchObject({
      code: VibORMErrorCode.MIGRATION_DRIFT,
      message: expect.stringContaining("final live fingerprint"),
    });
    expect(
      driver.statements.some((statement) => statement.startsWith("CREATE"))
    ).toBe(true);
  });
  test("managed scope preserves a foreign ledger across push, baseline and reset", async () => {
    const driver = createInMemorySQLite3Driver();
    const client = createClient({ schema: { user }, driver });
    try {
      await driver._executeRaw(
        'CREATE TABLE "foreign_ledger" (id TEXT PRIMARY KEY, stamp DATETIME, amount DECIMAL)'
      );
      await driver._executeRaw('INSERT INTO "foreign_ledger" (id) VALUES (?)', [
        "keep",
      ]);
      const live = createMigrationClient(client, { tables: ["user"] });
      const preview = await live.push({ dryRun: true });
      expect(
        preview.statements.some((statement) =>
          DROP_FOREIGN_LEDGER_PATTERN.test(statement.sql)
        )
      ).toBe(false);
      await live.push({ consent: preview.consent });
      await client.user.create({
        data: { id: "one", email: "one@example.test" },
      });
      const storage = new MemoryEstateStorage();
      const migrations = createMigrationClient(client, {
        storage,
        tables: ["user"],
      });
      const generated = await migrations.generate({ name: "adopt" });
      if (generated.stateId === null)
        throw new Error("Initial estate must publish a state");
      await migrations.baseline({ to: { id: generated.stateId } });
      expect(await migrations.verify()).toEqual({ ok: true });
      expect((await migrations.reset({ dryRun: true })).tables).toEqual([
        "user",
      ]);
      await migrations.reset();
      expect(await migrations.verify()).toEqual({ ok: true });
      expect(
        (
          await driver._executeRaw<{ id: string }>(
            'SELECT id FROM "foreign_ledger"'
          )
        ).rows
      ).toEqual([{ id: "keep" }]);
      expect(await client.user.count()).toBe(0);
    } finally {
      await client.$disconnect();
    }
  });
  test.each([
    [
      "generated",
      "CREATE TABLE legacy (id TEXT PRIMARY KEY, value INTEGER GENERATED ALWAYS AS (length(id)) STORED)",
      "generated",
    ],
    [
      "check",
      "CREATE TABLE legacy (id TEXT PRIMARY KEY, value INTEGER CHECK (value > 0))",
      "CHECK",
    ],
    ["virtual", "CREATE VIRTUAL TABLE legacy USING fts5(id, value)", "virtual"],
  ])("selected SQLite %s semantics refuse while unrelated managed tables converge", async (_label, ddl, reason) => {
    const driver = createInMemorySQLite3Driver();
    const initial = createClient({ schema: { user }, driver });
    try {
      await pushV1(initial);
      await driver._executeRaw(ddl);
      await expect(
        createMigrationClient(initial, { tables: ["user"] }).push()
      ).resolves.toMatchObject({ outcome: "noop" });
      const mapped = s
        .model({ id: s.string().id(), value: s.int() })
        .map("legacy");
      const client = createClient({ schema: { entry: mapped }, driver });
      await expect(
        createMigrationClient(client, { tables: ["legacy"] }).push({
          dryRun: true,
        })
      ).rejects.toMatchObject({ message: expect.stringContaining(reason) });
      const catalog = await driver._executeRaw<{ sql: string }>(
        "SELECT sql FROM sqlite_master WHERE name='legacy'"
      );
      expect(catalog.rows[0]?.sql).toBe(ddl);
    } finally {
      await initial.$disconnect();
    }
  });

  test("SQLite view collisions refuse without poisoning unrelated tables", async () => {
    const driver = createInMemorySQLite3Driver();
    const initial = createClient({ schema: { user }, driver });
    try {
      await pushV1(initial);
      await driver._executeRaw("CREATE VIEW external_view AS SELECT 1 AS id");
      await expect(
        createMigrationClient(initial).push()
      ).resolves.toMatchObject({ outcome: "noop" });
      const client = createClient({
        schema: { entry: s.model({ id: s.int().id() }).map("external_view") },
        driver,
      });
      await expect(createMigrationClient(client).push()).rejects.toMatchObject({
        message: expect.stringContaining("view"),
      });
      expect(
        (await driver._executeRaw("SELECT id FROM external_view")).rows
      ).toEqual([{ id: 1 }]);
    } finally {
      await initial.$disconnect();
    }
  });

  test("literal defaults backfill SQLite rows and application-only defaults refuse before effects", async () => {
    const driver = createInMemorySQLite3Driver();
    const initial = createClient({ schema: { user }, driver });
    try {
      await pushV1(initial);
      await initial.user.create({
        data: { id: "one", email: "one@example.test" },
      });
      const schema = {
        user: s.model({
          id: s.string().id(),
          email: s.string().unique(),
          names: s.string().array().default(["a,b", 'quoted"']),
          numbers: s.int().array().default([1, -2]),
          payload: s.json().default({ a: 1, nested: [null, true] }),
          documentNull: s
            .json()
            .schema({
              "~standard": {
                version: 1,
                vendor: "fixture",
                validate: () => ({ value: null }),
              },
            })
            .default({ input: true }),
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
          huge: s.bigInt().default(9007199254740993n),
          instant: s.dateTime().default(new Date("2024-01-15T10:30:00.123Z")),
          day: s.date().default(new Date("2024-01-15T10:30:00.123Z")),
        }),
      };
      const expanded = createClient({ schema, driver });
      const migrations = createMigrationClient(expanded);
      const preview = await migrations.push({ dryRun: true });
      await migrations.push({ consent: preview.consent });
      await expect(
        expanded.user.findUnique({ where: { id: "one" } })
      ).resolves.toMatchObject({
        names: ["a,b", 'quoted"'],
        numbers: [1, -2],
        payload: { a: 1, nested: [null, true] },
        normalized: { normalized: true },
        huge: 9007199254740993n,
        instant: new Date("2024-01-15T10:30:00.123Z"),
        day: new Date("2024-01-15T00:00:00.000Z"),
      });
      const document = await driver._executeRaw<{
        value: string;
        kind: string;
        sql_null: number;
      }>(
        'SELECT "documentNull" AS value, json_type("documentNull") AS kind, "documentNull" IS NULL AS sql_null FROM "user"'
      );
      expect(document.rows).toEqual([
        { value: "null", kind: "null", sql_null: 0 },
      ]);
      await expect(migrations.push()).resolves.toMatchObject({
        outcome: "noop",
      });
      const required = createClient({
        schema: {
          user: schema.user.extends({
            functionValue: s.string().default(() => "value"),
          }),
        },
        driver,
      });
      await expect(
        createMigrationClient(required).push({ dryRun: true })
      ).rejects.toMatchObject({
        message: expect.stringContaining("manual data migration"),
      });
      const columns = await driver._executeRaw<{ name: string }>(
        'PRAGMA table_info("user")'
      );
      expect(columns.rows.map((column) => column.name)).not.toContain(
        "functionValue"
      );
    } finally {
      await initial.$disconnect();
    }
  });

  test("adding a SQLite now default backfills existing rows and converges", async () => {
    const driver = createInMemorySQLite3Driver();
    const before = createClient({ schema: { user }, driver });
    try {
      await pushV1(before);
      await before.user.create({
        data: { id: "one", email: "one@example.test" },
      });
      const expanded = s.model({
        id: s.string().id(),
        email: s.string().unique(),
        createdAt: s.dateTime().now(),
        day: s.date().now(),
        clock: s.time().now(),
        clockLiteral: s.time().default("12:30:00"),
      });
      const after = createClient({ schema: { user: expanded }, driver });
      const migrations = createMigrationClient(after);
      const preview = await migrations.push({ dryRun: true });
      expect(
        preview.statements.some((statement) =>
          statement.sql.includes('CREATE TABLE "__new_user"')
        )
      ).toBe(true);
      await migrations.push({ consent: preview.consent });
      expect(
        (await after.user.findUnique({ where: { id: "one" } }))?.createdAt
      ).toBeInstanceOf(Date);
      const row = await after.user.findUniqueOrThrow({ where: { id: "one" } });
      expect(row.day).toBeInstanceOf(Date);
      expect(row.clockLiteral).toBe("12:30:00");
      expect(
        (
          await driver._executeRaw<{ value: string }>(
            'SELECT "clockLiteral" AS value FROM "user"'
          )
        ).rows
      ).toEqual([{ value: "12:30:00.000" }]);
      expect(row.clock).toMatch(EXPECTED_ERROR_PATTERN_2);
      const physical = await driver._executeRaw<{ day: string; clock: string }>(
        'SELECT "day", "clock" FROM "user"'
      );
      expect(physical.rows).toEqual([
        {
          day: row.day.toISOString().slice(0, 10),
          clock: row.clock.padEnd(12, row.clock.includes(".") ? "0" : ".000"),
        },
      ]);
      expect((await migrations.push({ dryRun: true })).outcome).toBe("noop");
    } finally {
      await before.$disconnect();
    }
  });
});
