import { createClient } from "@client/client";
import { createMigrationClient } from "@migrations";
import { compileGeneratedTransition } from "@migrations/compile";
import { diff, isDestructiveOperation } from "@migrations/differ";
import { getMigrationDriver } from "@migrations/drivers";
import { mysqlMigrationDriver } from "@migrations/drivers/mysql";
import { postgresMigrationDriver } from "@migrations/drivers/postgres";
import { sqlite3MigrationDriver } from "@migrations/drivers/sqlite";
import { generateV1 } from "@migrations/generate-v1";
import { inlineEnumValues } from "@migrations/push/enum-removals";
import {
  fingerprintSnapshot,
  normalizeDefault,
  normalizeType,
} from "@migrations/push-fingerprint";
import { applyResolutions } from "@migrations/resolver";
import { serializeModels } from "@migrations/serializer";
import { SqlAssembly } from "@migrations/sql-assembly";
import { MemoryEstateStorage } from "@migrations/storage/memory";
import {
  assertEstateTargetMatches,
  normalizeManagedTables,
  selectManagedSnapshot,
} from "@migrations/target";
import type { SchemaSnapshot, TableDef } from "@migrations/types";
import { derivedMigrationName, sortOperations } from "@migrations/utils";
import {
  encodeEstateDescriptor,
  parseEstateDescriptor,
} from "@migrations/v1-parse";
import { s } from "@schema";
import { hydrateSchemaNames } from "@schema/hydration";
import { DbNull, JsonNull } from "@schema/json-null";
import { PG } from "@schema/scalars/native-types";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import { PlanningDriver } from "@tests/fixtures/drivers/planning";
import { describe, expect, test } from "vitest";
import { ddlContext, pgEstateDriver } from "./_estate";

const MISSING_RESOLUTION_PATTERN = /Missing resolution/;
const SCOPE_PATTERN = /scope/;
const BOUNDARY_PATTERN = /boundary/;

const table = (name: string): TableDef => ({
  name,
  columns: [{ name: "id", type: "integer", nullable: false }],
  indexes: [],
  uniqueConstraints: [],
  foreignKeys: [],
});
const snapshot = (item: TableDef): SchemaSnapshot => ({ tables: [item] });

describe("adversarial migration regressions", () => {
  test("native precision-six Time clocks generate logical milliseconds", () => {
    for (const type of [PG.DATETIME.TIME(6), PG.DATETIME.TIMETZ(6)]) {
      const field = s.time(type).now();
      expect(
        postgresMigrationDriver.getDefaultExpression(field, field["~"].state)
      ).toBe("timezone('UTC', CURRENT_TIME(3))");
    }
    expect(
      normalizeDefault("timezone('UTC', CURRENT_TIME(3))", "timetz(6)")
    ).toBe(
      normalizeDefault("timezone('UTC'::text, CURRENT_TIME(3))", "timetz(6)")
    );
    expect(
      normalizeDefault("timezone('UTC', CURRENT_TIME(3))", "timetz(6)")
    ).not.toBe(normalizeDefault("timezone('UTC', CURRENT_TIME)", "timetz(6)"));
  });

  test("transformed JSON document-null defaults do not become SQL NULL", () => {
    const schema = {
      entry: s.model({
        id: s.int().id(),
        document: s
          .json()
          .schema({
            "~standard": {
              version: 1,
              vendor: "fixture",
              validate: () => ({ value: null }),
            },
          })
          .default({ input: true }),
        nullableDocument: s
          .json()
          .nullable()
          .schema({
            "~standard": {
              version: 1,
              vendor: "fixture",
              validate: () => ({ value: null }),
            },
          })
          .default({ input: true }),
        sqlNull: s.json().nullable().default(null),
        missing: s.json().nullable().default(DbNull),
      }),
    };
    hydrateSchemaNames(schema);
    for (const driver of [
      postgresMigrationDriver,
      mysqlMigrationDriver,
      sqlite3MigrationDriver,
    ]) {
      const table = serializeModels(schema, { migrationDriver: driver })
        .tables[0];
      const columns = new Map(
        table?.columns.map((column) => [column.name, column])
      );
      const documentNull = driver.dialect === "mysql" ? "('null')" : "'null'";
      expect(columns.get("document")?.default).toBe(documentNull);
      expect(columns.get("nullableDocument")?.default).toBe(documentNull);
      expect(columns.get("sqlNull")?.default).toBe(
        driver.dialect === "sqlite" ? "NULL" : undefined
      );
      expect(columns.get("missing")?.default).toBe(
        driver.dialect === "sqlite" ? "NULL" : undefined
      );
      if (!table) throw new Error("Expected serialized table");
      expect(
        driver.generateCreateTable(
          { type: "createTable", table },
          { destination: "artifact" }
        )
      ).not.toContain("NOT NULL DEFAULT NULL");
    }
  });

  test("literal defaults use scalar transforms exactly once and retain sentinel/function contracts", () => {
    let stringCalls = 0;
    let jsonCalls = 0;
    const stringSchema = {
      "~standard": {
        version: 1,
        vendor: "fixture",
        validate: () => {
          stringCalls++;
          return { value: "NORMALIZED" };
        },
      },
    } satisfies StandardSchemaV1<string>;
    const jsonSchema = {
      "~standard": {
        version: 1,
        vendor: "fixture",
        validate: () => {
          jsonCalls++;
          return { value: { normalized: true } };
        },
      },
    } satisfies StandardSchemaV1;
    const schema = {
      entry: s.model({
        id: s.int().id(),
        text: s.string().schema(stringSchema).default("input"),
        document: s.json().schema(jsonSchema).default({ input: true }),
        generated: s
          .string()
          .schema(stringSchema)
          .default(() => "input"),
      }),
    };
    hydrateSchemaNames(schema);
    for (const driver of [
      postgresMigrationDriver,
      mysqlMigrationDriver,
      sqlite3MigrationDriver,
    ]) {
      stringCalls = 0;
      jsonCalls = 0;
      const table = serializeModels(schema, { migrationDriver: driver })
        .tables[0];
      expect(
        table?.columns.find((column) => column.name === "text")?.default
      ).toContain("NORMALIZED");
      expect(
        table?.columns.find((column) => column.name === "document")?.default
      ).toContain('{"normalized":true}');
      expect(
        table?.columns.find((column) => column.name === "generated")?.default
      ).toBeUndefined();
      expect(stringCalls).toBe(1);
      expect(jsonCalls).toBe(1);
    }
    expect(
      mysqlMigrationDriver.finalizeTable({
        ...table("entry"),
        primaryKey: { columns: ["id"], name: "public_selector" },
      }).primaryKey?.name
    ).toBe("PRIMARY");
  });

  test("literal list, object, bigint and Date defaults have physical DDL on every dialect", () => {
    const schema = {
      entry: s.model({
        id: s.int().id(),
        names: s
          .string()
          .array()
          .default(["a,b", 'quoted"', "slash\\", "'apostrophe"]),
        numbers: s.int().array().default([1, -2]),
        payload: s.json().default({ a: 1, nested: [null, true] }),
        huge: s.bigInt().default(9007199254740993n),
        instant: s.dateTime().default(new Date("2024-01-15T10:30:00.123Z")),
        day: s.date().default(new Date("2024-01-15T10:30:00.123Z")),
      }),
    };
    hydrateSchemaNames(schema);
    for (const driver of [
      postgresMigrationDriver,
      mysqlMigrationDriver,
      sqlite3MigrationDriver,
    ]) {
      const columns = new Map(
        serializeModels(schema, {
          migrationDriver: driver,
        }).tables[0]?.columns.map((column) => [column.name, column])
      );
      for (const name of [
        "names",
        "numbers",
        "payload",
        "huge",
        "instant",
        "day",
      ])
        expect(columns.get(name)?.default).toBeDefined();
      expect(columns.get("huge")?.default).toBe("9007199254740993");
      expect(columns.get("instant")?.default).toContain(
        driver.dialect === "mysql"
          ? "2024-01-15 10:30:00.123"
          : "2024-01-15T10:30:00.123Z"
      );
    }
    expect(normalizeDefault(`'{1,-2}'`, "integer[]")).toBe(
      normalizeDefault(`'{"1","-2"}'`, "integer[]")
    );
    expect(
      normalizeDefault(`'{"a": 1, "nested": [null, true]}'`, "jsonb")
    ).toBe(normalizeDefault(`'{"nested":[null,true],"a":1}'`, "jsonb"));
  });

  test("JSON defaults distinguish document null, SQL NULL, and JSON string null", () => {
    const schema = {
      entry: s.model({
        id: s.int().id(),
        literal: s.json().default(null),
        explicit: s.json().nullable().default(JsonNull),
        missing: s.json().nullable().default(DbNull),
        nullable: s.json().nullable().default(null),
        text: s.json().default("null"),
        flag: s.json().default(true),
      }),
    };
    hydrateSchemaNames(schema);
    for (const driver of [
      postgresMigrationDriver,
      mysqlMigrationDriver,
      sqlite3MigrationDriver,
    ]) {
      const table = serializeModels(schema, { migrationDriver: driver })
        .tables[0]!;
      const columns = new Map(
        table.columns.map((column) => [column.name, column])
      );
      const jsonNull = driver.dialect === "mysql" ? "('null')" : "'null'";
      expect(columns.get("literal")?.default).toBe(jsonNull);
      expect(columns.get("explicit")?.default).toBe(jsonNull);
      const absent = driver.dialect === "sqlite" ? "NULL" : undefined;
      expect(columns.get("missing")?.default).toBe(absent);
      expect(columns.get("nullable")?.default).toBe(absent);
      expect(columns.get("text")?.default).toBe(
        driver.dialect === "mysql" ? `('"null"')` : `'"null"'`
      );
      expect(columns.get("flag")?.default).toBe(
        driver.dialect === "mysql" ? "('true')" : "'true'"
      );
      const ddl = driver.generateCreateTable(
        { type: "createTable", table },
        { destination: "artifact" }
      );
      expect(ddl).not.toContain("NOT NULL DEFAULT NULL");
    }
  });

  test("equivalent readable PK and unique physical names refuse adoption before effects", async () => {
    const desired = snapshot({
      ...table("entry"),
      primaryKey: { columns: ["id"], name: "entry_pkey" },
    });
    for (const current of [
      snapshot({
        ...table("entry"),
        primaryKey: { columns: ["id"], name: "legacy_pk" },
      }),
      snapshot({
        ...table("entry"),
        uniqueConstraints: [{ name: "legacy_unique", columns: ["id"] }],
      }),
    ]) {
      const wanted = current.tables[0]?.primaryKey
        ? desired
        : snapshot({
            ...table("entry"),
            uniqueConstraints: [{ name: "entry_id_key", columns: ["id"] }],
          });
      await expect(
        diff(current, wanted, { refuseConstraintNameChurn: true })
      ).rejects.toThrow("different physical name");
    }
  });

  test("native microsecond DateTime now defaults canonicalize only the generated millisecond clock", () => {
    expect(
      normalizeDefault(
        "date_trunc('milliseconds', CURRENT_TIMESTAMP)",
        "timestamptz(6)"
      )
    ).toBe(
      normalizeDefault(
        "date_trunc('milliseconds'::text, CURRENT_TIMESTAMP)",
        "timestamptz(6)"
      )
    );
    expect(
      normalizeDefault(
        "date_trunc('milliseconds', (CURRENT_TIMESTAMP AT TIME ZONE 'UTC'))",
        "timestamp(6)"
      )
    ).toBe(
      normalizeDefault(
        "date_trunc('milliseconds'::text, (CURRENT_TIMESTAMP AT TIME ZONE 'UTC'::text))",
        "timestamp(6)"
      )
    );
    expect(
      normalizeDefault(
        "date_trunc('second', CURRENT_TIMESTAMP)",
        "timestamptz(6)"
      )
    ).not.toBe(
      normalizeDefault(
        "date_trunc('milliseconds', CURRENT_TIMESTAMP)",
        "timestamptz(6)"
      )
    );
  });

  test("PostgreSQL UTC current-time defaults compare with catalog casts without losing temporal intent", () => {
    expect(normalizeDefault("timezone('UTC', CURRENT_TIME)", "timetz(3)")).toBe(
      normalizeDefault(
        "timezone('UTC'::text, CURRENT_TIME)",
        "time(3) with time zone"
      )
    );
    expect(
      normalizeDefault("(CURRENT_TIMESTAMP AT TIME ZONE 'UTC')", "date")
    ).toBe(
      normalizeDefault("((CURRENT_TIMESTAMP AT TIME ZONE 'UTC'::text))", "date")
    );
    expect(
      normalizeDefault("timezone('Europe/Paris', CURRENT_TIME)", "timetz(3)")
    ).not.toBe(normalizeDefault("timezone('UTC', CURRENT_TIME)", "timetz(3)"));
  });

  test("vector preflight refuses missing driver attestation and missing extension proof", async () => {
    const desired = snapshot({
      ...table("entry"),
      columns: [{ name: "embedding", type: "vector(3)", nullable: false }],
    });
    const driver = pgEstateDriver("public");
    const migrations = getMigrationDriver(driver);
    await expect(
      migrations.preflightSchemaRequirements([desired], (query, params) =>
        driver._executeRaw(query, params)
      )
    ).rejects.toThrow("pgvector: true");
    expect(driver.statements).toEqual([]);
    driver.adapter.capabilities.supportsVector = true;
    driver.respond = () => [{ ready: false }];
    await expect(
      migrations.preflightSchemaRequirements([desired], (query, params) =>
        driver._executeRaw(query, params)
      )
    ).rejects.toThrow("extension-owned vector type");
    driver.respond = () => [{ ready: true }];
    await expect(
      migrations.preflightSchemaRequirements([desired], (query, params) =>
        driver._executeRaw(query, params)
      )
    ).resolves.toBeUndefined();
    expect(
      driver.statements.every(
        (statement) =>
          statement === "<connect>" ||
          statement.trimStart().startsWith("SELECT")
      )
    ).toBe(true);
  });

  test("dialect key admission refuses illegal carriers and increment layouts", () => {
    for (const type of ["JSON", "LONGTEXT", "BLOB"])
      expect(() =>
        mysqlMigrationDriver.finalizeTable({
          ...table("keys"),
          columns: [{ name: "id", type, nullable: false }],
          primaryKey: { columns: ["id"] },
        })
      ).toThrow("cannot directly index");
    expect(() =>
      mysqlMigrationDriver.finalizeTable({
        ...table("keys"),
        columns: [
          { name: "id", type: "INTEGER", nullable: false, autoIncrement: true },
        ],
      })
    ).toThrow("first in an ordinary key");
    expect(() =>
      sqlite3MigrationDriver.finalizeTable({
        ...table("keys"),
        columns: [
          { name: "id", type: "INTEGER", nullable: false, autoIncrement: true },
        ],
      })
    ).toThrow("sole non-null INTEGER primary key");
    const valid = {
      ...table("keys"),
      columns: [
        { name: "id", type: "INTEGER", nullable: false, autoIncrement: true },
      ],
      primaryKey: { columns: ["id"] },
    };
    expect(
      sqlite3MigrationDriver
        .generateCreateTable(
          {
            type: "createTable",
            table: sqlite3MigrationDriver.finalizeTable(valid),
          },
          { destination: "artifact" }
        )
        .match(/PRIMARY KEY/g)
    ).toHaveLength(1);
    const keyed = mysqlMigrationDriver.finalizeTable({
      ...valid,
      primaryKey: undefined,
      indexes: [{ name: "counter_key", columns: ["id"], unique: false }],
    });
    const ddl = mysqlMigrationDriver.generateCreateTable(
      { type: "createTable", table: keyed },
      { destination: "artifact" }
    );
    expect(ddl).toContain("KEY `counter_key` (`id`)");
    expect(ddl).not.toContain("CREATE INDEX");
  });

  test("BC zoned defaults use the same instant parser as provider results", () => {
    expect(
      normalizeDefault("'0001-01-01 01:00:00+01 BC'", "timestamptz(3)")
    ).toBe("0000-01-01T00:00:00.000Z");
    expect(
      normalizeDefault(
        "'0001-01-01T00:00:00.000Z BC'",
        "timestamp(3) with time zone"
      )
    ).toBe("0000-01-01T00:00:00.000Z");
  });

  test("generates an authenticated initial estate", async () => {
    const client = createClient({
      schema: { user: s.model({ id: s.string().id() }) },
      driver: new PlanningDriver("sqlite"),
    });
    expect(
      await generateV1(client, new MemoryEstateStorage(), { dryRun: true })
    ).toMatchObject({ outcome: "preview" });
  });
  test.each([
    ["TIMESTAMP(3)", "timestamp(3) without time zone"],
    ["TIMESTAMPTZ(6)[]", "timestamp(6) with time zone[]"],
    ["TIME(4)", "time(4) without time zone"],
    ["TIMETZ(2)", "time(2) with time zone"],
    ["VARCHAR(8)[]", "character varying(8)[]"],
    ["CHAR(8)[]", "character(8)[]"],
    ["VARBIT(9)", "bit varying(9)"],
  ])("normalizes built-in typmods %s", (declared, live) =>
    expect(normalizeType(declared)).toBe(normalizeType(live)));
  test.each([
    ["-1", "'-1'", "integer"],
    ["-0.5", "'-0.5'", "double precision"],
    ["1e-7", "'0.0000001'", "double precision"],
    ["'12:30'", "'12:30:00'", "time"],
    ["'2024-01-15T10:30:00.000Z'", "'2024-01-15 10:30:00'", "timestamp(3)"],
    ["CURRENT_TIMESTAMP", "now()", "timestamp"],
  ])("compares typed default %s", (declared, live, type) =>
    expect(normalizeDefault(declared, type)).toBe(
      normalizeDefault(live, type)
    ));
  test("does not round distinct bigint default literals together", () =>
    expect(normalizeDefault("9007199254740993", "bigint")).not.toBe(
      normalizeDefault("9007199254740992", "bigint")
    ));
  test("a total unique index and matching unique constraint converge", async () => {
    const before = {
      ...table("sessions"),
      indexes: [{ name: "sessions_token_key", columns: ["id"], unique: true }],
    };
    const after = {
      ...table("sessions"),
      uniqueConstraints: [{ name: "sessions_token_key", columns: ["id"] }],
    };
    expect((await diff(snapshot(before), snapshot(after))).operations).toEqual(
      []
    );
    const driver = getMigrationDriver(pgEstateDriver("public"));
    expect(fingerprintSnapshot(snapshot(before), driver)).toBe(
      fingerprintSnapshot(snapshot(after), driver)
    );
  });
  test("missing rename decisions refuse", () => {
    const old = table("old");
    const next = table("next");
    expect(() =>
      applyResolutions(
        [
          {
            type: "ambiguousTable",
            droppedTable: "old",
            addedTable: "next",
            droppedTableDef: old,
            addedTableDef: next,
          },
        ],
        new Map()
      )
    ).toThrow(MISSING_RESOLUTION_PATTERN);
  });
  test("renaming a table with all columns renamed still asks", async () => {
    const next = {
      ...table("next"),
      columns: [{ name: "newId", type: "integer", nullable: false }],
    };
    const result = await diff(snapshot(table("old")), snapshot(next));
    expect(result.operations).toEqual([]);
    expect(result.ambiguousChanges).toHaveLength(1);
  });
  test("enum changes carry complete order and dependent columns", async () => {
    const before = {
      ...table("users"),
      columns: [{ name: "id", type: "status", nullable: true }],
    };
    const current = {
      ...snapshot(before),
      enums: [{ name: "status", values: ["a", "c"] }],
    };
    const desired = {
      ...current,
      enums: [{ name: "status", values: ["a", "b", "c"] }],
    };
    expect((await diff(current, desired)).operations).toContainEqual(
      expect.objectContaining({
        type: "alterEnum",
        newValues: ["a", "b", "c"],
        dependentColumns: [{ tableName: "users", columnName: "id" }],
      })
    );
  });
  test("required dropped columns have an explicit irreversible rollback", () => {
    const current = snapshot(table("users"));
    const result = compileGeneratedTransition(
      [{ type: "dropColumn", tableName: "users", columnName: "id" }],
      getMigrationDriver(pgEstateDriver("public")),
      "artifact",
      current,
      { tables: [{ ...table("users"), columns: [] }] },
      new SqlAssembly()
    );
    expect(result.rollback).toMatchObject({
      kind: "irreversible",
      reason: expect.stringContaining("explicit backfill"),
    });
  });
  test("derived names retain uniqueness within PostgreSQL byte limit", () => {
    const prefix = "é".repeat(50);
    const left = derivedMigrationName(`${prefix}_left_key`);
    const right = derivedMigrationName(`${prefix}_right_key`);
    expect(Buffer.byteLength(left)).toBeLessThanOrEqual(63);
    expect(left).not.toBe(right);
  });
  test("managed scope is detached and authenticated", () => {
    const input = ["users", "posts"];
    const tables = normalizeManagedTables(input)!;
    input.push("foreign");
    expect(tables).toEqual(["posts", "users"]);
    const target = { dialect: "sqlite" as const, tables };
    expect(
      parseEstateDescriptor(encodeEstateDescriptor(target).bytes).descriptor
        .target
    ).toEqual(target);
    expect(() =>
      assertEstateTargetMatches(target, { dialect: "sqlite" })
    ).toThrow(SCOPE_PATTERN);
    expect(
      selectManagedSnapshot(
        { tables: [table("users"), table("foreign")] },
        target
      ).tables.map((item) => item.name)
    ).toEqual(["users"]);
  });
  test("managed scope refuses foreign key crossings before effects", () => {
    const foreign = {
      ...table("foreign"),
      foreignKeys: [
        {
          name: "foreign_user",
          columns: ["id"],
          referencedTable: "users",
          referencedColumns: ["id"],
        },
      ],
    };
    expect(() =>
      selectManagedSnapshot(
        { tables: [table("users"), foreign] },
        { dialect: "sqlite", tables: ["users"] }
      )
    ).toThrow(BOUNDARY_PATTERN);
  });
  test("default-only alterations are safe and enum removals are destructive", () => {
    const from = { name: "x", type: "integer", nullable: false, default: "1" };
    expect(
      isDestructiveOperation({
        type: "alterColumn",
        tableName: "users",
        columnName: "x",
        from,
        to: { ...from, default: "2" },
      })
    ).toBe(false);
    expect(
      isDestructiveOperation({
        type: "alterEnum",
        enumName: "state",
        removeValues: ["x"],
      })
    ).toBe(true);
  });
  test("same-name unique replacement drops its occupied index first", () => {
    expect(
      sortOperations([
        { type: "dropIndex", tableName: "users", indexName: "same" },
        {
          type: "addUniqueConstraint",
          tableName: "users",
          constraint: { name: "same", columns: ["id"] },
        },
      ]).map((item) => item.type)
    ).toEqual(["dropIndex", "addUniqueConstraint"]);
  });
  test("PG casts drop a default before changing type and restore it", () => {
    const driver = getMigrationDriver(pgEstateDriver("public"));
    const sql = driver.compileStatements(
      {
        type: "alterColumn",
        tableName: "users",
        columnName: "id",
        from: { name: "id", type: "text", nullable: false, default: "'1'" },
        to: { name: "id", type: "integer", nullable: false, default: "1" },
      },
      ddlContext("artifact")
    );
    expect(sql[0]).toContain("DROP DEFAULT");
    expect(sql[1]).toContain("TYPE integer");
    expect(sql.at(-1)).toContain("SET DEFAULT 1");
  });
  test("a branch merge refuses an unchosen column rename before publication", async () => {
    const storage = new MemoryEstateStorage();
    const driver = new PlanningDriver("sqlite");
    const model = (renamed: boolean, flag: boolean) =>
      s.model({
        id: s.string().id(),
        ...(renamed
          ? { handle: s.string().nullable() }
          : { email: s.string().nullable() }),
        ...(flag ? { flag: s.boolean().nullable() } : {}),
      });
    const initial = await generateV1(
      createClient({ schema: { user: model(false, false) }, driver }),
      storage,
      { name: "base" }
    );
    const resolve = (change: import("@migrations/types").ResolveChange) =>
      change.type === "ambiguous" ? change.rename() : change.reject();
    await generateV1(
      createClient({ schema: { user: model(true, false) }, driver }),
      storage,
      { from: initial.stateId, name: "rename", resolve }
    );
    await generateV1(
      createClient({ schema: { user: model(false, true) }, driver }),
      storage,
      { from: initial.stateId, name: "add" }
    );
    const desired = createClient({
      schema: { user: model(true, true) },
      driver,
    });
    await expect(
      generateV1(desired, storage, { name: "merge" })
    ).rejects.toMatchObject({ code: "V11010" });
    expect(await storage.listStates()).toHaveLength(3);
    const result = await generateV1(desired, storage, {
      name: "merge",
      resolve,
    });
    expect(result.operationsByParent).toHaveLength(2);
    for (const parent of result.operationsByParent)
      expect(result.reviewSql).toContain(
        `-- Parent ${parent.fromState ?? "empty"}`
      );
    expect(result.reviewSql).toContain("FORWARD execute");
    expect(result.reviewSql).toContain("ROLLBACK execute");
    expect(result.sql).not.toContain("-- Parent");
    expect(result.operations).toContainEqual(
      expect.objectContaining({
        type: "renameColumn",
        from: "email",
        to: "handle",
      })
    );
  });
  test("live scope needs no storage and exposes no history operations", () => {
    const client = createClient({
      schema: { user: s.model({ id: s.string().id() }) },
      driver: new PlanningDriver("sqlite"),
    });
    const migrations = createMigrationClient(client, { tables: ["user"] });
    expect(Object.keys(migrations).sort()).toEqual(["log", "push"]);
  });
  test("text defaults preserve the case of quoted boolean-looking strings", () => {
    expect(normalizeDefault("'T'", "text")).not.toBe(
      normalizeDefault("'t'", "text")
    );
  });
  test("inline MySQL enum alterations consume logical escaped values once", () => {
    const members = [
      "plain",
      "a\\b",
      "line1\nline2",
      "it's",
      "café ☕",
      "end\\",
    ];
    const type = mysqlMigrationDriver.getEnumColumnType(
      "kinds",
      "kind",
      members
    );
    expect(inlineEnumValues(type)).toEqual(members);
    expect(
      inlineEnumValues(`TEXT CHECK("kind" IN ('a\\b', 'line1\nline2'))`)
    ).toEqual(["a\\b", "line1\nline2"]);
  });
  test("inline enum comparison preserves quoted values and column names", () => {
    expect(normalizeType(`TEXT CHECK("Status" IN ('ACTIVE'))`)).not.toBe(
      normalizeType(`TEXT CHECK("Status" IN ('active'))`)
    );
    expect(normalizeType(`TEXT CHECK("Status" IN ('character'))`)).toContain(
      "'character'"
    );
  });
});
