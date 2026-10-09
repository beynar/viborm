import {
  compileGeneratedTransition,
  rebindDispatches,
} from "@migrations/compile";
import { mysqlMigrationDriver } from "@migrations/drivers/mysql";
import { postgresMigrationDriver as pg } from "@migrations/drivers/postgres";
import { sqlite3MigrationDriver } from "@migrations/drivers/sqlite";
import { invertOperations } from "@migrations/invert";
import { SqlAssembly } from "@migrations/sql-assembly";
import { sliceDispatch } from "@migrations/sql-blob";
import type {
  DiffOperation,
  SchemaSnapshot,
  TableDef,
} from "@migrations/types";
import type { MigrationOperationV1 } from "@migrations/v1-types";
import { expect, test } from "vitest";
import { ddlContext } from "./_estate";

const rename = { type: "renameTable", from: "old", to: "new" } as const;
const EMITTED_PRIMARY_KEY = /CONSTRAINT ("[^"]+") PRIMARY KEY/;

function table(name: string, primaryKey?: TableDef["primaryKey"]): TableDef {
  return {
    name,
    columns: [
      { name: "id", type: "varchar(17)", nullable: false },
      { name: "code", type: "text", nullable: false },
    ],
    primaryKey,
    indexes: [{ name: "literal_index", columns: ["code"], unique: true }],
    foreignKeys: [],
    uniqueConstraints: [],
  };
}

function snapshot(): SchemaSnapshot {
  return {
    tables: [
      table("old", { name: "old_pkey", columns: ["id"] }),
      {
        ...table("child", { name: "child_pkey", columns: ["id"] }),
        foreignKeys: [
          {
            name: "child_parent",
            columns: ["code"],
            referencedTable: "old",
            referencedColumns: ["id"],
          },
        ],
      },
    ],
  };
}

function compile(
  operations: DiffOperation[],
  current: SchemaSnapshot,
  desired: SchemaSnapshot
) {
  const assembly = new SqlAssembly();
  const result = compileGeneratedTransition(
    operations,
    pg,
    "artifact",
    current,
    desired,
    assembly
  );
  if (result.rollback.kind !== "schema")
    throw new Error("Expected an exact schema inverse");
  const { bytes, dispatches } = assembly.seal();
  const statements = (items: readonly MigrationOperationV1[]) =>
    rebindDispatches(items, dispatches).flatMap((operation) =>
      operation.steps.map((step) => sliceDispatch(bytes, step.execute))
    );
  return {
    forward: statements(result.operations),
    rollback: statements(result.rollback.operations),
  };
}

test("PostgreSQL projection matches its default-PK DDL while preserving the caller and FK identity", () => {
  const current = snapshot();
  const before = structuredClone(current);
  const projected = pg.projectNativeRename(current, rename);
  expect(projected.tables[0]?.primaryKey).toEqual({
    name: "new_pkey",
    columns: ["id"],
  });
  expect(projected.tables[0]?.columns).toEqual(current.tables[0]?.columns);
  expect(projected.tables[0]?.indexes).toEqual(current.tables[0]?.indexes);
  expect(projected.tables[1]?.foreignKeys[0]?.referencedTable).toBe("new");
  expect(projected.tables[1]?.primaryKey?.name).toBe("child_pkey");
  expect(current).toEqual(before);
  expect(
    pg.compileRenameTable(
      rename,
      ddlContext("artifact", { currentSchema: current })
    )
  ).toEqual([
    'ALTER TABLE "old" RENAME TO "new"',
    'ALTER TABLE "new" RENAME CONSTRAINT "old_pkey" TO "new_pkey"',
  ]);
});

test.each([
  { name: "custom", key: { name: "old_pkey_custom", columns: ["id"] } },
  { name: "unnamed", key: { columns: ["id"] } },
  { name: "absent", key: undefined },
])("PostgreSQL preserves a $name PK instead of adopting a derived constraint name", ({
  key,
}) => {
  const current = { tables: [table("old", key)] };
  expect(pg.projectNativeRename(current, rename).tables[0]?.primaryKey).toEqual(
    key
  );
  expect(
    pg.compileRenameTable(
      rename,
      ddlContext("artifact", { currentSchema: current })
    )
  ).toEqual(['ALTER TABLE "old" RENAME TO "new"']);
});

test("a partial snapshot cannot invent the absent source table or its PK", () => {
  const current = {
    tables: [table("unrelated", { name: "old_pkey", columns: ["id"] })],
  };
  expect(pg.projectNativeRename(current, rename)).toEqual(current);
  expect(
    pg.compileRenameTable(
      rename,
      ddlContext("artifact", { currentSchema: current })
    )
  ).toEqual(['ALTER TABLE "old" RENAME TO "new"']);
});

test("dropping and recreating the source without a PK cannot resurrect its previous constraint", () => {
  const current = {
    tables: [
      table("old", { name: "old_pkey", columns: ["id"] }),
      table("other", { name: "other_pkey", columns: ["id"] }),
    ],
  };
  const before = structuredClone(current);
  const precedingOperations: DiffOperation[] = [
    { type: "dropTable", tableName: "old" },
    { type: "createTable", table: table("old") },
  ];
  const prior = structuredClone(precedingOperations);
  expect(
    pg.compileRenameTable(
      rename,
      ddlContext("artifact", { currentSchema: current, precedingOperations })
    )
  ).toEqual(['ALTER TABLE "old" RENAME TO "new"']);
  expect(
    pg.compileRenameTable(
      { type: "renameTable", from: "other", to: "retained" },
      ddlContext("artifact", { currentSchema: current, precedingOperations })
    )
  ).toEqual([
    'ALTER TABLE "other" RENAME TO "retained"',
    'ALTER TABLE "retained" RENAME CONSTRAINT "other_pkey" TO "retained_pkey"',
  ]);
  expect(current).toEqual(before);
  expect(precedingOperations).toEqual(prior);
});

test("a preceding PK replacement on another table preserves the renamed table's default key", () => {
  const current = {
    tables: [
      table("old", { name: "old_pkey", columns: ["id"] }),
      table("other", { name: "other_pkey", columns: ["id"] }),
    ],
  };
  const before = structuredClone(current);
  const precedingOperations: DiffOperation[] = [
    {
      type: "dropPrimaryKey",
      tableName: "other",
      constraintName: "other_pkey",
    },
    {
      type: "addPrimaryKey",
      tableName: "other",
      primaryKey: { name: "other_custom_key", columns: ["id"] },
    },
  ];
  const prior = structuredClone(precedingOperations);
  expect(
    pg.compileRenameTable(
      rename,
      ddlContext("artifact", { currentSchema: current, precedingOperations })
    )
  ).toEqual([
    'ALTER TABLE "old" RENAME TO "new"',
    'ALTER TABLE "new" RENAME CONSTRAINT "old_pkey" TO "new_pkey"',
  ]);
  expect(
    pg.compileRenameTable(
      { type: "renameTable", from: "other", to: "retained" },
      ddlContext("artifact", { currentSchema: current, precedingOperations })
    )
  ).toEqual(['ALTER TABLE "other" RENAME TO "retained"']);
  expect(current).toEqual(before);
  expect(precedingOperations).toEqual(prior);
});

test("a preceding generated unnamed add-PK supplies the physical default name for rename", () => {
  const current = { tables: [table("old")] };
  const add: DiffOperation = {
    type: "addPrimaryKey",
    tableName: "old",
    primaryKey: { columns: ["id"] },
  };
  expect(pg.compileStatements(add, ddlContext("artifact"))).toEqual([
    'ALTER TABLE "old" ADD CONSTRAINT "old_pkey" PRIMARY KEY ("id")',
  ]);
  expect(
    pg.compileRenameTable(
      rename,
      ddlContext("artifact", {
        currentSchema: current,
        precedingOperations: [add],
      })
    )
  ).toEqual([
    'ALTER TABLE "old" RENAME TO "new"',
    'ALTER TABLE "new" RENAME CONSTRAINT "old_pkey" TO "new_pkey"',
  ]);
  expect(current.tables[0]?.primaryKey).toBeUndefined();
});

test("a preceding generated unnamed create-table PK has a concrete emitted name before rename", () => {
  const create: DiffOperation = {
    type: "createTable",
    table: table("old", { columns: ["id"] }),
  };
  expect(pg.compileStatements(create, ddlContext("artifact"))[0]).toContain(
    'CONSTRAINT "old_pkey" PRIMARY KEY ("id")'
  );
  expect(
    pg.compileRenameTable(
      rename,
      ddlContext("artifact", {
        currentSchema: { tables: [] },
        precedingOperations: [create],
      })
    )
  ).toEqual([
    'ALTER TABLE "old" RENAME TO "new"',
    'ALTER TABLE "new" RENAME CONSTRAINT "old_pkey" TO "new_pkey"',
  ]);
  expect(create.table.primaryKey?.name).toBeUndefined();
});

test.each([
  "create",
  "add",
])("long-table %s PK projection uses the exact emitted bounded name", (kind) => {
  // Table identifiers fit PostgreSQL's limit, while adding _pkey does not.
  const from = "a".repeat(60);
  const to = "b".repeat(60);
  const operation: DiffOperation =
    kind === "create"
      ? { type: "createTable", table: table(from, { columns: ["id"] }) }
      : {
          type: "addPrimaryKey",
          tableName: from,
          primaryKey: { columns: ["id"] },
        };
  const current: SchemaSnapshot = {
    tables: kind === "create" ? [] : [table(from)],
  };
  const sourceName = pg
    .compileStatements(operation, ddlContext("artifact"))[0]
    ?.match(EMITTED_PRIMARY_KEY)?.[1];
  const targetName = pg
    .compileStatements(
      { type: "addPrimaryKey", tableName: to, primaryKey: { columns: ["id"] } },
      ddlContext("artifact")
    )[0]
    ?.match(EMITTED_PRIMARY_KEY)?.[1];
  if (!(sourceName && targetName))
    throw new Error("Generated PK must declare its physical constraint name");
  expect(Buffer.byteLength(sourceName.slice(1, -1))).toBeLessThanOrEqual(63);
  expect(Buffer.byteLength(targetName.slice(1, -1))).toBeLessThanOrEqual(63);
  expect(sourceName).not.toBe(`"${from}_pkey"`);
  expect(
    pg.compileRenameTable(
      { type: "renameTable", from, to },
      ddlContext("artifact", {
        currentSchema: current,
        precedingOperations: [operation],
      })
    )
  ).toEqual([
    `ALTER TABLE "${from}" RENAME TO "${to}"`,
    `ALTER TABLE "${to}" RENAME CONSTRAINT ${sourceName} TO ${targetName}`,
  ]);
});

test.each([
  sqlite3MigrationDriver,
  mysqlMigrationDriver,
])("$dialect table projection retains native definitions and their physical PK name", (driver) => {
  const current = snapshot();
  const before = structuredClone(current);
  const projected = driver.projectNativeRename(current, rename);
  expect(projected.tables[0]).toEqual({ ...current.tables[0], name: "new" });
  expect(projected.tables[0]?.primaryKey?.name).toBe("old_pkey");
  expect(projected.tables[1]?.foreignKeys[0]?.referencedTable).toBe("new");
  expect(current).toEqual(before);
});

test.each([
  undefined,
  "caller_named_key",
])("long generated ADD-PK rollback uses its exact forward name (supplied=%s)", (name) => {
  const tableName = "c".repeat(60);
  const current = { tables: [table(tableName)] };
  const add: DiffOperation = {
    type: "addPrimaryKey",
    tableName,
    primaryKey: { columns: ["id"], name },
  };
  const emitted = pg.compileStatements(add, ddlContext("artifact"))[0];
  const identifier = emitted?.match(EMITTED_PRIMARY_KEY)?.[1];
  if (!(emitted && identifier))
    throw new Error("Generated PK must declare its physical name");
  if (name) expect(identifier).toBe(`"${name}"`);
  const desired = {
    tables: [
      table(tableName, { columns: ["id"], name: identifier.slice(1, -1) }),
    ],
  };
  expect(compile([add], current, desired)).toEqual({
    forward: [emitted],
    rollback: [`ALTER TABLE "${tableName}" DROP CONSTRAINT ${identifier}`],
  });
  expect(current.tables[0]?.primaryKey).toBeUndefined();
});

test("successive PG table renames compile each actual derived PK name and their inverse", () => {
  const current = {
    tables: [table("old", { name: "old_pkey", columns: ["id"] })],
  };
  const operations: DiffOperation[] = [
    rename,
    { type: "renameTable", from: "new", to: "last" },
  ];
  const desired = {
    tables: [table("last", { name: "last_pkey", columns: ["id"] })],
  };
  expect(compile(operations, current, desired)).toEqual({
    forward: [
      'ALTER TABLE "old" RENAME TO "new"',
      'ALTER TABLE "new" RENAME CONSTRAINT "old_pkey" TO "new_pkey"',
      'ALTER TABLE "new" RENAME TO "last"',
      'ALTER TABLE "last" RENAME CONSTRAINT "new_pkey" TO "last_pkey"',
    ],
    rollback: [
      'ALTER TABLE "last" RENAME TO "new"',
      'ALTER TABLE "new" RENAME CONSTRAINT "last_pkey" TO "new_pkey"',
      'ALTER TABLE "new" RENAME TO "old"',
      'ALTER TABLE "old" RENAME CONSTRAINT "new_pkey" TO "old_pkey"',
    ],
  });
});

test.each([
  false,
  true,
])("rename then drop-PK inverse follows preceding key restoration (replacement=%s)", (replacement) => {
  const current = {
    tables: [table("old", { name: "old_pkey", columns: ["id"] })],
  };
  const operations: DiffOperation[] = [
    rename,
    { type: "dropPrimaryKey", tableName: "new", constraintName: "new_pkey" },
  ];
  if (replacement)
    operations.push({
      type: "addPrimaryKey",
      tableName: "new",
      primaryKey: { name: "replacement_key", columns: ["code"] },
    });
  const desired = {
    tables: [
      table(
        "new",
        replacement ? { name: "replacement_key", columns: ["code"] } : undefined
      ),
    ],
  };
  expect(
    invertOperations(operations, current, pg.projectNativeRename.bind(pg))
      .operations
  ).toEqual([
    ...(replacement
      ? [
          {
            type: "dropPrimaryKey",
            tableName: "new",
            constraintName: "replacement_key",
          },
        ]
      : []),
    {
      type: "addPrimaryKey",
      tableName: "new",
      primaryKey: { name: "new_pkey", columns: ["id"] },
    },
    { type: "renameTable", from: "new", to: "old" },
  ]);
  expect(compile(operations, current, desired).rollback).toEqual([
    ...(replacement
      ? ['ALTER TABLE "new" DROP CONSTRAINT "replacement_key"']
      : []),
    'ALTER TABLE "new" ADD CONSTRAINT "new_pkey" PRIMARY KEY ("id")',
    'ALTER TABLE "new" RENAME TO "old"',
    'ALTER TABLE "old" RENAME CONSTRAINT "new_pkey" TO "old_pkey"',
  ]);
});
