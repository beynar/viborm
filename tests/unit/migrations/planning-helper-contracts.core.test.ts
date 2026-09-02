import { MigrationError, VibORMErrorCode } from "@src/errors";
import {
  boundNamespace,
  columnExistsProbe,
  indexExistsProbe,
  probeForGeneratedStatement,
  tableExistsProbe,
} from "@src/migrations/catalog-probes";
import { getMigrationDriver } from "@src/migrations/drivers";
import {
  bindingId,
  canonicalizeSnapshotPredicates,
  canonicalValue,
  fingerprintSnapshot,
  freezeDeep,
  normalizeDefault,
  normalizeType,
  pushTargetIdentity,
} from "@src/migrations/push-fingerprint";
import type {
  DiffOperation,
  SchemaSnapshot,
  TableDef,
} from "@src/migrations/types";
import { describe, expect, test } from "vitest";
import {
  mysqlEstateDriver,
  pgEstateDriver,
  sqliteEstateDriver,
} from "./_estate";

const table: TableDef = {
  name: "account",
  columns: [{ name: "id", type: "TEXT", nullable: false }],
  indexes: [
    {
      name: "account_id_idx",
      columns: ["id"],
      unique: false,
      where: " id IS NOT NULL ",
    },
  ],
  foreignKeys: [],
  uniqueConstraints: [],
};

describe("migration planning helper contracts", () => {
  test("catalog probes bind each dialect and stored MySQL artifacts defer their namespace", () => {
    const postgres = getMigrationDriver(pgEstateDriver("tenant"));
    const mysql = getMigrationDriver(
      mysqlEstateDriver({ namespace: "tenant", attested: true })
    );
    const sqlite = getMigrationDriver(sqliteEstateDriver());

    expect(tableExistsProbe(postgres, "account", true)).toMatchObject({
      id: "table:exists:account",
      parameters: [
        { kind: "string", value: "tenant" },
        { kind: "string", value: "account" },
      ],
      equals: true,
    });
    expect(columnExistsProbe(mysql, "account", "id", false)).toMatchObject({
      id: "column:absent:account.id",
      parameters: [
        { kind: "string", value: "tenant" },
        { kind: "string", value: "account" },
        { kind: "string", value: "id" },
      ],
      equals: false,
    });
    expect(indexExistsProbe(sqlite, "account", "idx", true)).toMatchObject({
      id: "index:exists:idx",
      parameters: [{ kind: "string", value: "idx" }],
    });

    const generated = probeForGeneratedStatement(
      mysql,
      { type: "createIndex", tableName: "account", index: table.indexes[0]! },
      "CREATE INDEX account_id_idx ON account(id)"
    );
    expect(generated?.pre.parameters[0]).toEqual({
      kind: "target-namespace",
    });
    expect(boundNamespace(mysql)).toBe("tenant");
  });

  test("generated-statement probes distinguish effects from non-DDL and unknown create-table statements", () => {
    const sqlite = getMigrationDriver(sqliteEstateDriver());
    const cases: Array<{
      operation: DiffOperation;
      sql: string;
      expected: string | null;
    }> = [
      {
        operation: { type: "createTable", table },
        sql: "CREATE TABLE account(id TEXT)",
        expected: "table:absent:account",
      },
      {
        operation: { type: "createTable", table },
        sql: "CREATE INDEX account_id_idx ON account(id)",
        expected: "index:absent:account_id_idx",
      },
      {
        operation: { type: "dropTable", tableName: "account" },
        sql: "DROP TABLE account",
        expected: "table:exists:account",
      },
      {
        operation: {
          type: "addColumn",
          tableName: "account",
          column: { name: "name", type: "TEXT", nullable: true },
        },
        sql: "ALTER TABLE account ADD name TEXT",
        expected: "column:absent:account.name",
      },
      {
        operation: {
          type: "dropColumn",
          tableName: "account",
          columnName: "name",
        },
        sql: "ALTER TABLE account DROP name",
        expected: "column:exists:account.name",
      },
      {
        operation: {
          type: "dropIndex",
          tableName: "account",
          indexName: "account_id_idx",
        },
        sql: "DROP INDEX account_id_idx",
        expected: "index:exists:account_id_idx",
      },
      {
        operation: { type: "createTable", table },
        sql: "PRAGMA foreign_keys = OFF",
        expected: null,
      },
      {
        operation: { type: "createTable", table },
        sql: "CREATE VIEW account_view AS SELECT 1",
        expected: null,
      },
      {
        operation: { type: "createTable", table },
        sql: "CREATE INDEX absent_idx ON account(id)",
        expected: null,
      },
    ];

    for (const { operation, sql, expected } of cases) {
      expect(
        probeForGeneratedStatement(sqlite, operation, sql)?.pre.id ?? null
      ).toBe(expected);
    }
  });

  test("live fingerprints normalize aliases, defaults, ordering, and unreadable names", () => {
    const sqlite = getMigrationDriver(sqliteEstateDriver());
    const first: SchemaSnapshot = {
      tables: [
        {
          ...table,
          columns: [
            {
              name: "enabled",
              type: " BOOL ",
              nullable: false,
              default: "'t'",
            },
            { name: "id", type: "INT4[]", nullable: false, default: "NULL" },
          ],
          foreignKeys: [
            {
              name: "account_parent_a",
              columns: ["id"],
              referencedTable: "account",
              referencedColumns: ["id"],
            },
          ],
          uniqueConstraints: [{ name: "account_id_a", columns: ["id"] }],
        },
      ],
    };
    const second: SchemaSnapshot = {
      tables: [
        {
          ...first.tables[0]!,
          columns: [
            { name: "id", type: "integer[]", nullable: false },
            {
              name: "enabled",
              type: "boolean",
              nullable: false,
              default: "1",
            },
          ],
          foreignKeys: [
            { ...first.tables[0]!.foreignKeys[0]!, name: "account_parent_b" },
          ],
          uniqueConstraints: [
            { ...first.tables[0]!.uniqueConstraints[0]!, name: "account_id_b" },
          ],
        },
      ],
    };

    expect(fingerprintSnapshot(first, sqlite)).toBe(
      fingerprintSnapshot(second, sqlite)
    );
    expect(normalizeType(" TIMESTAMPTZ [] ")).toBe(
      "timestamp with time zone[]"
    );
    expect(normalizeDefault(" FALSE ")).toBe("false");
    expect(normalizeDefault("now() ")).toBe("now()");
    expect(normalizeDefault("CURRENT_TIMESTAMP")).toBe("CURRENT_TIMESTAMP");
  });

  test("predicate canonicalization preserves unhandled indexes and fails closed", async () => {
    const snapshot: SchemaSnapshot = {
      tables: [
        table,
        {
          ...table,
          name: "plain",
          indexes: [{ name: "plain_idx", columns: ["id"], unique: false }],
        },
      ],
    };
    const canonical = await canonicalizeSnapshotPredicates(
      snapshot,
      async () => ["id IS NOT NULL"]
    );
    expect(canonical.tables[0]?.indexes[0]?.where).toBe("id IS NOT NULL");
    expect(canonical.tables[1]).toBe(snapshot.tables[1]);
    expect(
      await canonicalizeSnapshotPredicates(snapshot, async () => [undefined])
    ).toEqual(snapshot);
    expect(await canonicalizeSnapshotPredicates(snapshot, undefined)).toBe(
      snapshot
    );
  });

  test("push target identity is stable per binding and provider-specific", async () => {
    const postgres = pgEstateDriver("tenant");
    postgres.respond = () => [{ database: "app" }];
    const pgClient = { $driver: postgres, $schema: {} };
    expect(bindingId(pgClient)).toBe(bindingId(pgClient));
    await expect(
      pushTargetIdentity(pgClient, postgres, getMigrationDriver(postgres))
    ).resolves.toMatchObject({
      dialect: "postgresql",
      database: "app",
      namespace: "tenant",
    });

    const mysql = mysqlEstateDriver({ namespace: "tenant", attested: true });
    await expect(
      pushTargetIdentity(
        { $driver: mysql, $schema: {} },
        mysql,
        getMigrationDriver(mysql)
      )
    ).resolves.toMatchObject({ dialect: "mysql", database: "tenant" });

    const sqlite = sqliteEstateDriver();
    await expect(
      pushTargetIdentity(
        { $driver: sqlite, $schema: {} },
        sqlite,
        getMigrationDriver(sqlite)
      )
    ).resolves.toMatchObject({ dialect: "sqlite", location: null });
  });

  test("canonical projection drops undefined recursively and deep freeze preserves views", () => {
    const bytes = Uint8Array.of(1, 2);
    const projected = canonicalValue({
      kept: [{ nested: true, omitted: undefined }],
      omitted: undefined,
    });
    expect(projected).toEqual({ kept: [{ nested: true }] });
    expect(freezeDeep({ projected, bytes })).toMatchObject({
      projected,
      bytes,
    });
    expect(Object.isFrozen(projected)).toBe(true);
    expect(Object.isFrozen(bytes)).toBe(false);
  });
});

describe("coverage low value", () => {
  test("provider identity refusals do not admit ambient defaults", async () => {
    const postgres = pgEstateDriver("tenant");
    postgres.respond = () => [{ database: "" }];
    await expect(
      pushTargetIdentity(
        { $driver: postgres, $schema: {} },
        postgres,
        getMigrationDriver(postgres)
      )
    ).rejects.toMatchObject({
      code: VibORMErrorCode.MIGRATION_INVALID_STATE,
    });

    const mysql = mysqlEstateDriver({ attested: true });
    await expect(
      pushTargetIdentity(
        { $driver: mysql, $schema: {} },
        mysql,
        getMigrationDriver(mysql)
      )
    ).rejects.toBeInstanceOf(MigrationError);
  });

  test("unbound live catalog probes reject instead of inventing a namespace", () => {
    const mysql = getMigrationDriver(mysqlEstateDriver({ attested: true }));
    expect(() => tableExistsProbe(mysql, "account", true)).toThrowError(
      expect.objectContaining({
        code: VibORMErrorCode.MIGRATION_INVALID_STATE,
      })
    );
    expect(
      probeForGeneratedStatement(
        mysql,
        { type: "dropTable", tableName: "account" },
        "DROP TABLE account"
      )
    ).toBeNull();
  });
});
