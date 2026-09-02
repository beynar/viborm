import { VibORMErrorCode } from "@src/errors";
import { sqlite3MigrationDriver } from "@src/migrations/drivers/sqlite";
import { serializeResolvedModels } from "@src/migrations/serializer";
import type {
  ColumnDef,
  DiffOperation,
  SchemaSnapshot,
  TableDef,
} from "@src/migrations/types";
import { s } from "@src/schema";
import { hydrateSchemaNames } from "@src/schema/hydration";
import { resolveSchemaOrThrow } from "@src/schema/validation/validator";
import { describe, expect, test } from "vitest";
import { ddlContext } from "./_estate";

const STATUS_CHECK = `TEXT CHECK("status" IN ('active', 'retired'))`;

const accountTable: TableDef = {
  name: "account",
  columns: [
    { name: "id", type: "INTEGER", nullable: false },
    { name: "status", type: STATUS_CHECK, nullable: true },
  ],
  indexes: [],
  foreignKeys: [],
  uniqueConstraints: [],
};

const accountSchema: SchemaSnapshot = { tables: [accountTable] };

const statusDependency = [{ tableName: "account", columnName: "status" }];

function compile(
  operation: DiffOperation,
  currentSchema: SchemaSnapshot = accountSchema
): readonly string[] {
  return sqlite3MigrationDriver.compileStatements(
    operation,
    ddlContext("live", { currentSchema })
  );
}

function refusalFrom(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error("the operation compiled but a refusal was expected");
}

interface EnumReplacementCase {
  readonly name: string;
  readonly operation: DiffOperation;
  readonly update?: string;
}

/** Every replacement precedence the shared enum-migration renderer answers. */
const enumReplacementCases: readonly EnumReplacementCase[] = [
  {
    name: "no removed values",
    operation: {
      type: "alterEnum",
      enumName: "resolution_status",
      newValues: ["active", "retired"],
      dependentColumns: statusDependency,
    },
  },
  {
    name: "a removed value with no configured replacement",
    operation: {
      type: "alterEnum",
      enumName: "resolution_status",
      newValues: ["active"],
      removeValues: ["retired"],
      dependentColumns: statusDependency,
    },
  },
  {
    name: "a removed value mapped to NULL",
    operation: {
      type: "alterEnum",
      enumName: "resolution_status",
      newValues: ["active"],
      removeValues: ["retired"],
      dependentColumns: statusDependency,
      defaultReplacement: null,
    },
    update: `UPDATE "account" SET "status" = NULL WHERE "status" = 'retired'`,
  },
  {
    name: "a removed value mapped per column to a surviving value",
    operation: {
      type: "alterEnum",
      enumName: "resolution_status",
      newValues: ["active"],
      removeValues: ["retired"],
      dependentColumns: statusDependency,
      columnValueReplacements: { "account.status": { retired: "active" } },
    },
    update: `UPDATE "account" SET "status" = 'active' WHERE "status" = 'retired'`,
  },
];

describe("SQLite enum compilation edges", () => {
  test("dropping an enum rewrites its dependent CHECK column to plain TEXT", () => {
    const statements = compile({
      type: "dropEnum",
      enumName: "resolution_status",
      dependentColumns: statusDependency,
    });
    const create = statements.find((statement) =>
      statement.startsWith('CREATE TABLE "__new_account"')
    );

    expect(create).toContain('"status" TEXT');
    expect(create).not.toContain("CHECK");
    expect(statements).toContain('DROP TABLE "account"');
  });

  test("dropping an enum whose dependent table is unknown is an internal failure", () => {
    expect(
      refusalFrom(() =>
        compile({
          type: "dropEnum",
          enumName: "resolution_status",
          dependentColumns: [{ tableName: "ghost", columnName: "status" }],
        })
      )
    ).toMatchObject({
      code: VibORMErrorCode.INTERNAL_ERROR,
      message: expect.stringContaining('Table "ghost" not found'),
    });
  });

  test("altering an enum nothing depends on states that and rebuilds nothing", () => {
    expect(
      compile({
        type: "alterEnum",
        enumName: "resolution_status",
        newValues: ["active"],
      })
    ).toEqual([
      '-- SQLite: no dependent columns found for enum "resolution_status"',
    ]);
  });

  test("altering an enum whose dependent table is unknown records it and rebuilds nothing", () => {
    expect(
      compile({
        type: "alterEnum",
        enumName: "resolution_status",
        newValues: ["active"],
        dependentColumns: [{ tableName: "ghost", columnName: "status" }],
      })
    ).toEqual(['-- SQLite: table "ghost" not found']);
  });

  test.each(
    enumReplacementCases
  )("altering an enum with $name migrates rows exactly once", ({
    operation,
    update,
  }) => {
    const statements = compile(operation);
    const updates = statements.filter((statement) =>
      statement.startsWith("UPDATE ")
    );

    expect(updates).toEqual(update === undefined ? [] : [update]);
    expect(statements).toContain('DROP TABLE "account"');
  });
});

const referencingTable: TableDef = {
  name: "post",
  columns: [
    { name: "id", type: "INTEGER", nullable: false },
    { name: "account_id", type: "INTEGER", nullable: true },
  ],
  indexes: [],
  foreignKeys: [
    {
      name: "post_account_fk",
      columns: ["account_id"],
      referencedTable: "account",
      referencedColumns: ["id"],
      onDelete: "setDefault",
      onUpdate: "setDefault",
    },
  ],
  uniqueConstraints: [],
};

const defaultsSchema = {
  row: s.model({
    id: s.string().id(),
    label: s.string().default("O'Brien"),
    active: s.boolean().default(true),
  }),
};
hydrateSchemaNames(defaultsSchema);

const nonFiniteSchema = {
  reading: s.model({
    id: s.string().id(),
    score: s.number().default(Number.POSITIVE_INFINITY),
  }),
};
hydrateSchemaNames(nonFiniteSchema);

function columnOf(snapshot: SchemaSnapshot, name: string): ColumnDef {
  const column = snapshot.tables[0]?.columns.find(
    (candidate) => candidate.name === name
  );
  if (!column) throw new Error(`the snapshot has no column named ${name}`);
  return column;
}

describe("SQLite driver base rendering", () => {
  test("a SET DEFAULT referential action renders on both edges", () => {
    const statements = compile(
      { type: "createTable", table: referencingTable },
      { tables: [accountTable, referencingTable] }
    );

    expect(statements[0]).toContain("ON DELETE SET DEFAULT");
    expect(statements[0]).toContain("ON UPDATE SET DEFAULT");
  });

  test("string and boolean defaults reach DDL through the base renderer", () => {
    const snapshot = serializeResolvedModels(
      defaultsSchema,
      sqlite3MigrationDriver,
      resolveSchemaOrThrow(defaultsSchema)
    );

    expect(columnOf(snapshot, "label").default).toBe("'O''Brien'");
    expect(columnOf(snapshot, "active").default).toBe("1");
  });

  test("a non-finite numeric default is refused before any DDL exists", () => {
    expect(
      refusalFrom(() =>
        serializeResolvedModels(
          nonFiniteSchema,
          sqlite3MigrationDriver,
          resolveSchemaOrThrow(nonFiniteSchema)
        )
      )
    ).toMatchObject({
      code: VibORMErrorCode.INVALID_INPUT,
      message: expect.stringContaining("not a finite number"),
    });
  });

  test("a null or absent value escapes to the SQL NULL literal", () => {
    expect(sqlite3MigrationDriver.escapeValue(null)).toBe("NULL");
    expect(sqlite3MigrationDriver.escapeValue(undefined)).toBe("NULL");
    expect(sqlite3MigrationDriver.escapeValue("O'Brien")).toBe("'O''Brien'");
  });
});

describe("coverage low value", () => {
  test("an identifier that bypassed the string type is refused, not quoted", () => {
    expect(
      refusalFrom(() =>
        // @ts-expect-error - hostile JavaScript can bypass the identifier type
        sqlite3MigrationDriver.escapeIdentifier(null)
      )
    ).toMatchObject({
      code: VibORMErrorCode.INVALID_INPUT,
      message: expect.stringContaining("null or undefined identifier"),
    });
  });
});
