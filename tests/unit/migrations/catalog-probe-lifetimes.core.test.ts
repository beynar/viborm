import {
  boundNamespace,
  columnExistsProbe,
  indexExistsProbe,
  probeForGeneratedStatement,
  tableExistsProbe,
} from "@src/migrations/catalog-probes";
import { getMigrationDriver } from "@src/migrations/drivers";
import type { DiffOperation } from "@src/migrations/types";
import { describe, expect, test } from "vitest";
import {
  mysqlEstateDriver,
  pgEstateDriver,
  sqliteEstateDriver,
} from "./_estate";

const INDEX_STATEMENT = /INDEX/i;

const emailIndex = {
  name: "account_email_idx",
  columns: ["email"],
  unique: false,
};

function postgresCommand() {
  return getMigrationDriver(pgEstateDriver("reporting"));
}

function mysqlCommand() {
  return getMigrationDriver(mysqlEstateDriver({ namespace: "app" }));
}

function sqliteCommand() {
  return getMigrationDriver(sqliteEstateDriver());
}

const addColumn: DiffOperation = {
  type: "addColumn",
  tableName: "account",
  column: { name: "email", type: "TEXT", nullable: true },
};

const dropColumn: DiffOperation = {
  type: "dropColumn",
  tableName: "account",
  columnName: "email",
};

const createIndex: DiffOperation = {
  type: "createIndex",
  tableName: "account",
  index: emailIndex,
};

const dropIndex: DiffOperation = {
  type: "dropIndex",
  tableName: "account",
  indexName: emailIndex.name,
};

describe("catalog probes for column and index statements", () => {
  test("a PostgreSQL column statement is proven against the bound schema", () => {
    const probes = probeForGeneratedStatement(
      postgresCommand(),
      addColumn,
      'ALTER TABLE "reporting"."account" ADD COLUMN "email" TEXT'
    );

    expect(probes?.pre).toMatchObject({
      id: "column:absent:account.email",
      equals: false,
      parameters: [
        { kind: "string", value: "reporting" },
        { kind: "string", value: "account" },
        { kind: "string", value: "email" },
      ],
    });
    expect(probes?.pre.sql).toContain("pg_catalog.pg_attribute");
    expect(probes?.pre.sql).toContain("NOT a.attisdropped");
    expect(probes?.post).toMatchObject({
      id: "column:exists:account.email",
      equals: true,
    });
    expect(probes?.post.parameters).toEqual(probes?.pre.parameters);
  });

  test("a PostgreSQL index statement is proven against the bound schema", () => {
    const probes = probeForGeneratedStatement(
      postgresCommand(),
      createIndex,
      'CREATE INDEX "account_email_idx" ON "reporting"."account" ("email")'
    );

    expect(probes?.pre).toMatchObject({
      id: "index:absent:account_email_idx",
      equals: false,
      parameters: [
        { kind: "string", value: "reporting" },
        { kind: "string", value: "account_email_idx" },
      ],
    });
    expect(probes?.pre.sql).toContain("c.relkind = 'i'");
    expect(probes?.post).toMatchObject({
      id: "index:exists:account_email_idx",
      equals: true,
    });
  });

  test.each([
    {
      name: "drop column",
      operation: dropColumn,
      statement: 'ALTER TABLE "reporting"."account" DROP COLUMN "email"',
      before: true,
      after: false,
    },
    {
      name: "drop index",
      operation: dropIndex,
      statement: 'DROP INDEX "reporting"."account_email_idx"',
      before: true,
      after: false,
    },
  ])("a PostgreSQL $name proves presence before and absence after", ({
    operation,
    statement,
    before,
    after,
  }) => {
    const probes = probeForGeneratedStatement(
      postgresCommand(),
      operation,
      statement
    );

    expect(probes?.pre.equals).toBe(before);
    expect(probes?.post.equals).toBe(after);
    expect(probes?.pre.parameters[0]).toEqual({
      kind: "string",
      value: "reporting",
    });
  });

  test("a stored MySQL column probe carries the symbolic namespace, not a literal", () => {
    const probes = probeForGeneratedStatement(
      mysqlCommand(),
      dropColumn,
      "ALTER TABLE `account` DROP COLUMN `email`"
    );

    expect(probes?.pre).toMatchObject({
      id: "column:exists:account.email",
      equals: true,
      parameters: [
        { kind: "target-namespace" },
        { kind: "string", value: "account" },
        { kind: "string", value: "email" },
      ],
    });
    expect(probes?.pre.sql).toContain("information_schema.columns");
    expect(probes?.post).toMatchObject({
      id: "column:absent:account.email",
      equals: false,
      parameters: [
        { kind: "target-namespace" },
        { kind: "string", value: "account" },
        { kind: "string", value: "email" },
      ],
    });
  });

  test("a stored MySQL index probe carries the symbolic namespace, not a literal", () => {
    const probes = probeForGeneratedStatement(
      mysqlCommand(),
      createIndex,
      "CREATE INDEX `account_email_idx` ON `account` (`email`)"
    );

    expect(probes?.pre.parameters).toEqual([
      { kind: "target-namespace" },
      { kind: "string", value: "account" },
      { kind: "string", value: "account_email_idx" },
    ]);
    expect(probes?.pre.sql).toContain("information_schema.statistics");
  });

  test("a live MySQL probe binds the resolved database name", () => {
    const command = mysqlCommand();

    expect(
      columnExistsProbe(command, "account", "email", true).parameters
    ).toEqual([
      { kind: "string", value: "app" },
      { kind: "string", value: "account" },
      { kind: "string", value: "email" },
    ]);
    expect(
      indexExistsProbe(command, "account", "account_email_idx", true).parameters
    ).toEqual([
      { kind: "string", value: "app" },
      { kind: "string", value: "account" },
      { kind: "string", value: "account_email_idx" },
    ]);
    expect(boundNamespace(command)).toBe("app");
  });

  test("SQLite column and index probes are namespace-free pragma and master reads", () => {
    const command = sqliteCommand();
    const column = columnExistsProbe(command, "account", "email", true);
    const index = indexExistsProbe(
      command,
      "account",
      "account_email_idx",
      false
    );

    expect(column.sql).toContain("pragma_table_info(?)");
    expect(column.parameters).toEqual([
      { kind: "string", value: "account" },
      { kind: "string", value: "email" },
    ]);
    expect(index.sql).toContain("type = 'index'");
    expect(index.parameters).toEqual([
      { kind: "string", value: "account_email_idx" },
    ]);
    expect(index.id).toBe("index:absent:account_email_idx");
    expect(boundNamespace(command)).toBeUndefined();
  });

  test("a table probe still answers for every dialect", () => {
    expect(
      tableExistsProbe(postgresCommand(), "account", true).parameters
    ).toEqual([
      { kind: "string", value: "reporting" },
      { kind: "string", value: "account" },
    ]);
    expect(tableExistsProbe(sqliteCommand(), "account", false).sql).toContain(
      "sqlite_master"
    );
  });

  test.each([
    ["PostgreSQL", postgresCommand],
    ["MySQL", mysqlCommand],
    ["SQLite", sqliteCommand],
  ])("a created table's %s index statement is proven against its own index, not one whose name it extends or a column it indexes", (_label, command) => {
    // Matched by substring, `by_email_b`'s statement named `by_email`: its
    // postcheck then held once `by_email` existed, and a stepwise run (every
    // run on Neki) skipped creating it.
    const driver = command();
    const createTable: DiffOperation = {
      type: "createTable",
      table: {
        name: "account",
        columns: [
          { name: "id", type: "TEXT", nullable: false },
          { name: "email", type: "TEXT", nullable: true },
          { name: "backup", type: "TEXT", nullable: true },
        ],
        primaryKey: { columns: ["id"] },
        indexes: [
          { name: "by_email", columns: ["email"], unique: false },
          { name: "by_email_b", columns: ["backup"], unique: false },
          // An index named like a column another one indexes (Devin, #119).
          { name: "email", columns: ["id"], unique: false },
          { name: "by_backup", columns: ["email"], unique: false },
        ],
        foreignKeys: [],
        uniqueConstraints: [],
      },
    };
    const statements = driver.compileStatements(createTable, {
      currentSchema: { tables: [] },
      precedingOperations: [],
      followingOperations: [],
    } as never);
    const probed = statements
      .filter((statement) => INDEX_STATEMENT.test(statement))
      .map((statement) => {
        const probes = probeForGeneratedStatement(
          driver,
          createTable,
          statement
        );
        return probes?.post.parameters.at(-1);
      });
    expect(probed).toEqual([
      { kind: "string", value: "by_email" },
      { kind: "string", value: "by_email_b" },
      { kind: "string", value: "email" },
      { kind: "string", value: "by_backup" },
    ]);
  });

  test("a created table's MySQL FULLTEXT and SPATIAL index statements keep their probes", () => {
    const driver = mysqlCommand();
    const createTable: DiffOperation = {
      type: "createTable",
      table: {
        name: "place",
        columns: [
          { name: "id", type: "varchar(191)", nullable: false },
          { name: "body", type: "text", nullable: false },
          { name: "location", type: "point", nullable: false },
        ],
        primaryKey: { columns: ["id"] },
        indexes: [
          {
            name: "place_body",
            columns: ["body"],
            unique: false,
            type: "fulltext",
          },
          {
            name: "place_location",
            columns: ["location"],
            unique: false,
            type: "spatial",
          },
        ],
        foreignKeys: [],
        uniqueConstraints: [],
      },
    };
    const statements = driver
      .compileStatements(createTable, {
        currentSchema: { tables: [] },
        precedingOperations: [],
        followingOperations: [],
      } as never)
      .filter((statement) => INDEX_STATEMENT.test(statement));
    expect(
      statements.map((statement) => statement.split(" ").slice(0, 3).join(" "))
    ).toEqual(["CREATE FULLTEXT INDEX", "CREATE SPATIAL INDEX"]);
    expect(
      statements.map((statement) =>
        probeForGeneratedStatement(
          driver,
          createTable,
          statement
        )?.post.parameters.at(-1)
      )
    ).toEqual([
      { kind: "string", value: "place_body" },
      { kind: "string", value: "place_location" },
    ]);
  });
});
