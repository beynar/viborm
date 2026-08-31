import { SQLiteAdapter } from "@src/adapters/databases/sqlite/sqlite-adapter";
import { VibORMErrorCode } from "@src/errors";
import { postgresMigrationDriver } from "@src/migrations/drivers/postgres";
import { sqlite3MigrationDriver } from "@src/migrations/drivers/sqlite";
import { createFsStorageWriter as createFsStorageWriterEntry } from "@src/migrations/storage/fs";
import {
  createFsStorageWriter,
  isMigrationStorageWriter,
  MemoryConditionalObjectStore,
  MemoryEstateStorage,
  ObjectStoreEstateStorage,
  refuseWorkersKvWritable,
} from "@src/migrations/storage/index";
import type {
  ColumnDef,
  DiffOperation,
  ForeignKeyDef,
  IndexDef,
  TableDef,
} from "@src/migrations/types";
import {
  createEnumValueRemovalChange,
  readEnumResolutionDecision,
} from "@src/migrations/types";
import {
  createQueryExecutor,
  generateMigrationName,
  materializeDroppedTableForeignKeys,
  normalizeDialect,
  sortOperations,
} from "@src/migrations/utils";
import { describe, expect, test } from "vitest";
import { RecordingDriver } from "./_estate";

const idColumn: ColumnDef = {
  name: "id",
  type: "TEXT",
  nullable: false,
};

const table: TableDef = {
  name: "user",
  columns: [idColumn],
  indexes: [],
  foreignKeys: [],
  uniqueConstraints: [],
};

const index: IndexDef = {
  name: "user_id_idx",
  columns: ["id"],
  unique: false,
};

const foreignKey: ForeignKeyDef = {
  name: "user_parent_fk",
  columns: ["id"],
  referencedTable: "user",
  referencedColumns: ["id"],
};

describe("migration utility surface", () => {
  test.each<[input: string, expected: "postgresql" | "sqlite" | "mysql"]>([
    ["postgresql", "postgresql"],
    ["postgres", "postgresql"],
    ["sqlite", "sqlite"],
    ["mysql", "mysql"],
  ])("normalizes %s to %s", (input, expected) => {
    expect(normalizeDialect(input)).toBe(expected);
  });

  test("rejects an unsupported migration dialect", () => {
    expect(() => normalizeDialect("oracle")).toThrow(
      expect.objectContaining({
        code: VibORMErrorCode.MIGRATION_DIALECT_MISMATCH,
      })
    );
  });

  test("adapts raw driver results to migration rows", async () => {
    const driver = new RecordingDriver(
      "sqlite",
      "utility-recording",
      new SQLiteAdapter()
    );
    driver.respond = () => [{ id: "u1" }];

    await expect(
      createQueryExecutor(driver)("SELECT id", [1])
    ).resolves.toEqual([{ id: "u1" }]);
    expect(driver.statements).toContain("SELECT id");
    expect(driver.parameters).toContainEqual([1]);
  });

  test.each<{ operations: DiffOperation[]; expected: string }>([
    { operations: [], expected: "empty" },
    {
      operations: [{ type: "createTable", table }],
      expected: "create-user",
    },
    {
      operations: [
        { type: "createTable", table },
        { type: "dropTable", tableName: "old_user" },
      ],
      expected: "initial",
    },
    {
      operations: [{ type: "dropTable", tableName: "user" }],
      expected: "drop-user",
    },
    {
      operations: [{ type: "addColumn", tableName: "user", column: idColumn }],
      expected: "add-id-to-user",
    },
    {
      operations: [
        { type: "dropColumn", tableName: "user", columnName: "legacy" },
      ],
      expected: "drop-legacy-from-user",
    },
    {
      operations: [{ type: "renameTable", from: "user", to: "account" }],
      expected: "rename-user-to-account",
    },
    {
      operations: [
        {
          type: "renameColumn",
          tableName: "user",
          from: "name",
          to: "label",
        },
      ],
      expected: "rename-name-to-label",
    },
    {
      operations: [{ type: "createIndex", tableName: "user", index }],
      expected: "add-index-user_id_idx",
    },
    {
      operations: [
        { type: "dropIndex", tableName: "user", indexName: "user_id_idx" },
      ],
      expected: "drop-index-user_id_idx",
    },
    {
      operations: [
        { type: "addForeignKey", tableName: "user", fk: foreignKey },
      ],
      expected: "add-fk-user_parent_fk",
    },
    {
      operations: [
        {
          type: "dropForeignKey",
          tableName: "user",
          fkName: "user_parent_fk",
        },
      ],
      expected: "drop-fk-user_parent_fk",
    },
    {
      operations: [
        { type: "createEnum", enumDef: { name: "role", values: ["user"] } },
      ],
      expected: "create-enum-role",
    },
    {
      operations: [{ type: "dropEnum", enumName: "role" }],
      expected: "drop-enum-role",
    },
    {
      operations: [{ type: "alterEnum", enumName: "role" }],
      expected: "alter-enum-role",
    },
    {
      operations: [
        {
          type: "addPrimaryKey",
          tableName: "user",
          primaryKey: { columns: ["id"] },
        },
      ],
      expected: "migration",
    },
  ])("names $expected migrations", ({ operations, expected }) => {
    expect(generateMigrationName(operations)).toBe(expected);
  });

  test("executes the intentional storage entry modules", () => {
    expect(createFsStorageWriterEntry).toBe(createFsStorageWriter);
    expect(isMigrationStorageWriter(new MemoryEstateStorage())).toBe(true);
    expect(MemoryConditionalObjectStore).toBeTypeOf("function");
    expect(ObjectStoreEstateStorage).toBeTypeOf("function");
    expect(refuseWorkersKvWritable).toBeTypeOf("function");
  });

  test("orders table renames before operations using the new identity", () => {
    const rename: DiffOperation = {
      type: "renameTable",
      from: "legacy_user",
      to: "user",
    };
    const create: DiffOperation = {
      type: "createTable",
      table: { ...table, name: "user" },
    };
    const add: DiffOperation = {
      type: "addColumn",
      tableName: "user",
      column: { name: "label", type: "TEXT", nullable: true },
    };

    expect(sortOperations([add, create, rename])).toEqual([
      rename,
      create,
      add,
    ]);
  });

  test("materializes each unplanned foreign-key drop implicated by a table drop", () => {
    const parentForeignKey: ForeignKeyDef = {
      ...foreignKey,
      name: "child_parent_fk",
      columns: ["parent_id"],
      referencedTable: "parent",
    };
    const current = {
      tables: [
        {
          ...table,
          name: "child",
          columns: [
            idColumn,
            { name: "parent_id", type: "TEXT", nullable: false },
          ],
          foreignKeys: [parentForeignKey],
        },
        { ...table, name: "parent" },
      ],
    };
    const dropParent: DiffOperation = {
      type: "dropTable",
      tableName: "parent",
    };

    expect(
      materializeDroppedTableForeignKeys(
        [dropParent],
        current,
        postgresMigrationDriver
      )
    ).toEqual([
      {
        type: "dropForeignKey",
        tableName: "child",
        fkName: parentForeignKey.name,
      },
      dropParent,
    ]);
  });

  test("does not duplicate planned drops or materialize on SQLite", () => {
    const planned: DiffOperation = {
      type: "dropForeignKey",
      tableName: "user",
      fkName: foreignKey.name,
    };
    const drop: DiffOperation = { type: "dropTable", tableName: "user" };
    const current = {
      tables: [{ ...table, foreignKeys: [foreignKey] }],
    };
    const operations = [planned, drop];

    expect(
      materializeDroppedTableForeignKeys(
        operations,
        current,
        postgresMigrationDriver
      )
    ).toBe(operations);
    expect(
      materializeDroppedTableForeignKeys(
        operations,
        current,
        sqlite3MigrationDriver
      )
    ).toBe(operations);
    expect(
      materializeDroppedTableForeignKeys(
        [planned],
        current,
        postgresMigrationDriver
      )
    ).toEqual([planned]);
  });

  test("records mixed enum-resolution decisions from the same change owner", () => {
    const change = createEnumValueRemovalChange({
      enumName: "role",
      tableName: "user",
      columnName: "role",
      isNullable: true,
      removedValues: ["legacy"],
      availableValues: ["active"],
      description: "remove legacy role",
    });

    change.mapValues({ legacy: "active" });
    change.useNull();
    expect(readEnumResolutionDecision(change)).toEqual({ kind: "mixed" });
  });
});

describe("coverage low value", () => {
  test("keeps the defensive sparse-operation fallback stable", () => {
    const sparse: DiffOperation[] = [];
    sparse.length = 1;
    expect(generateMigrationName(sparse)).toBe("migration");
  });
});
