/**
 * Snowflake's catalog into a schema document, against a local server that
 * answers the catalog queries as Snowflake's SQL API does. Never run against a
 * real warehouse: the `SHOW … KEYS` columns and the `INFORMATION_SCHEMA`
 * spellings are the documented ones.
 *
 * What it proves: a foreign key the catalog DECLARES — Snowflake enforces none
 * — becomes the document's relation; each Snowflake type becomes the scalar
 * that reads it exactly; a view and a type with no scalar are said, not
 * dropped silently; and a push is refused before it sends anything.
 */

import { createClient, SnowflakeDriver } from "@drivers/snowflake";
import { MigrationError, VibORMErrorCode } from "@errors";
import { createMigrationClient } from "@migrations";
import { admitLiveMigrationCapability } from "@migrations/admission";
import { getMigrationDriver } from "@migrations/drivers";
import { introspectSchema } from "@migrations/introspect";
import { s } from "@schema";
import {
  type FakeColumn,
  type FakeSnowflake,
  type FakeStatement,
  rows,
  startFakeSnowflake,
} from "@tests/fixtures/snowflake-server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const READ_STATEMENT = /^(SELECT|SHOW) /;

const text = (name: string): FakeColumn => ({ name, type: "text" });
const fixed = (name: string): FakeColumn => ({ name, type: "fixed", scale: 0 });

const COLUMNS = [
  "TABLE_NAME",
  "COLUMN_NAME",
  "DATA_TYPE",
  "IS_NULLABLE",
  "COLUMN_DEFAULT",
  "NUMERIC_PRECISION",
  "NUMERIC_SCALE",
  "CHARACTER_MAXIMUM_LENGTH",
  "DATETIME_PRECISION",
  "IS_IDENTITY",
];
const NUMERIC = new Set([
  "NUMERIC_PRECISION",
  "NUMERIC_SCALE",
  "CHARACTER_MAXIMUM_LENGTH",
  "DATETIME_PRECISION",
]);

type Row = (string | null)[];
const column = (
  table: string,
  name: string,
  type: string,
  nullable: boolean,
  facts: {
    precision?: number;
    scale?: number;
    length?: number;
    datetime?: number;
    default?: string;
  } = {}
): Row => [
  table,
  name,
  type,
  nullable ? "YES" : "NO",
  facts.default ?? null,
  facts.precision === undefined ? null : String(facts.precision),
  facts.scale === undefined ? null : String(facts.scale),
  facts.length === undefined ? null : String(facts.length),
  facts.datetime === undefined ? null : String(facts.datetime),
  "NO",
];

const CATALOG: Row[] = [
  column("CUSTOMERS", "ID", "NUMBER", false, { precision: 38, scale: 0 }),
  column("CUSTOMERS", "EMAIL", "TEXT", false, { length: 16_777_216 }),
  column("CUSTOMERS", "SEGMENT", "TEXT", true, {
    length: 32,
    default: "'retail'",
  }),
  column("CUSTOMERS", "CREATED_AT", "TIMESTAMP_NTZ", false, {
    datetime: 9,
    default: "CURRENT_TIMESTAMP()",
  }),
  column("CUSTOMERS", "PROFILE", "VARIANT", true),
  column("CUSTOMERS", "HOME", "GEOGRAPHY", true),
  column("ORDERS", "ID", "NUMBER", false, { precision: 9, scale: 0 }),
  column("ORDERS", "CUSTOMER_ID", "NUMBER", false, {
    precision: 38,
    scale: 0,
  }),
  column("ORDERS", "TOTAL", "NUMBER", false, { precision: 12, scale: 2 }),
  column("ORDERS", "PLACED_AT", "TIMESTAMP_TZ", false, { datetime: 9 }),
  column("ORDERS", "PAID", "BOOLEAN", false),
];

let server: FakeSnowflake;
/** A schema with no table yet: what a push would start from. */
let empty = false;

function answer({ statement }: FakeStatement) {
  if (empty && !statement.includes("CURRENT_DATABASE()")) return rows([], []);
  if (statement.includes("CURRENT_DATABASE()"))
    return rows([text("database"), text("schema")], [["SALES", "PUBLIC"]]);
  if (statement.includes("INFORMATION_SCHEMA.TABLES"))
    return rows([text("TABLE_NAME")], [["CUSTOMERS"], ["ORDERS"]]);
  if (statement.includes("INFORMATION_SCHEMA.COLUMNS"))
    return rows(
      COLUMNS.map((name) => (NUMERIC.has(name) ? fixed(name) : text(name))),
      CATALOG
    );
  if (statement.includes("INFORMATION_SCHEMA.VIEWS"))
    return rows([text("name")], [["CUSTOMER_TOTALS"]]);
  if (statement.startsWith("SHOW PRIMARY KEYS"))
    return rows(
      [
        text("schema_name"),
        text("table_name"),
        text("column_name"),
        fixed("key_sequence"),
        text("constraint_name"),
      ],
      [
        ["PUBLIC", "CUSTOMERS", "ID", "1", "PK_CUSTOMERS"],
        ["PUBLIC", "ORDERS", "ID", "1", "PK_ORDERS"],
      ]
    );
  if (statement.startsWith("SHOW UNIQUE KEYS"))
    return rows(
      [
        text("schema_name"),
        text("table_name"),
        text("column_name"),
        fixed("key_sequence"),
        text("constraint_name"),
      ],
      [["PUBLIC", "CUSTOMERS", "EMAIL", "1", "UQ_CUSTOMERS_EMAIL"]]
    );
  if (statement.startsWith("SHOW IMPORTED KEYS"))
    return rows(
      [
        text("pk_schema_name"),
        text("pk_table_name"),
        text("pk_column_name"),
        text("fk_schema_name"),
        text("fk_table_name"),
        text("fk_column_name"),
        fixed("key_sequence"),
        text("fk_name"),
        text("update_rule"),
        text("delete_rule"),
      ],
      [
        [
          "PUBLIC",
          "CUSTOMERS",
          "ID",
          "PUBLIC",
          "ORDERS",
          "CUSTOMER_ID",
          "1",
          "FK_ORDERS_CUSTOMER",
          "NO ACTION",
          "NO ACTION",
        ],
      ]
    );
  return rows([], []);
}

function driver() {
  return new SnowflakeDriver({
    databaseUrl: `snowflake://READER@myorg-acct/SALES/PUBLIC?warehouse=WH&host=${encodeURIComponent(server.url)}`,
    token: "t",
  });
}

beforeEach(async () => {
  empty = false;
  server = await startFakeSnowflake(answer);
});

afterEach(async () => {
  await server.close();
});

describe("introspectSchema on Snowflake", () => {
  it("reads declared keys as keys and relations, each type as its exact scalar, and says what it leaves out", async () => {
    const result = await introspectSchema({ driver: driver() });
    expect(result.dialect).toBe("snowflake");
    const { CUSTOMERS: customers, ORDERS: orders } = result.document.models;
    expect(customers!.fields).toMatchObject({
      ID: { type: "bigint", id: true },
      EMAIL: { type: "string", unique: true },
      SEGMENT: { type: "string", nullable: true, default: "retail" },
      CREATED_AT: { type: "datetime", generate: { kind: "now" } },
      PROFILE: { type: "json", nullable: true },
    });
    expect(customers!.fields).not.toHaveProperty("HOME");
    expect(orders!.fields).toMatchObject({
      ID: { type: "int", id: true },
      CUSTOMER_ID: { type: "bigint" },
      TOTAL: { type: "decimal", precision: 12, scale: 2 },
      PLACED_AT: { type: "datetime" },
      PAID: { type: "boolean" },
    });
    // The declared, unenforced foreign key is the relation, both ways.
    const relations = (model: object) =>
      Object.values(model).filter(
        (field: { type: string }) =>
          field.type === "toOne" || field.type === "toMany"
      );
    expect(relations(orders!.fields)).toEqual([
      expect.objectContaining({
        type: "toOne",
        target: "CUSTOMERS",
        fields: ["CUSTOMER_ID"],
        references: ["ID"],
      }),
    ]);
    expect(relations(customers!.fields)).toEqual([
      expect.objectContaining({ type: "toMany", target: "ORDERS" }),
    ]);

    expect(result.skipped).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "view", name: "CUSTOMER_TOTALS" }),
        expect.objectContaining({
          kind: "column",
          table: "CUSTOMERS",
          name: "HOME",
        }),
      ])
    );
    expect(result.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "approximated",
          message: expect.stringContaining("Snowflake enforces no primary"),
        }),
        expect.objectContaining({
          kind: "approximated",
          table: "CUSTOMERS",
          name: "CREATED_AT",
        }),
      ])
    );
    // A push of the document has no meaning here: no drift is reported.
    expect(result.warnings.some((warning) => warning.kind === "drift")).toBe(
      false
    );
    // Every catalog statement qualifies the schema it reads.
    const shows = server
      .statements()
      .map((sent) => sent.statement)
      .filter((statement) => statement.startsWith("SHOW"));
    expect(shows).toEqual([
      'SHOW PRIMARY KEYS IN SCHEMA "SALES"."PUBLIC"',
      'SHOW UNIQUE KEYS IN SCHEMA "SALES"."PUBLIC"',
      'SHOW IMPORTED KEYS IN SCHEMA "SALES"."PUBLIC"',
    ]);
  });

  it("writes the light document a client reads", async () => {
    const result = await introspectSchema({ driver: driver(), light: true });
    expect(result.document.light).toBe(true);
    expect(result.warnings.every((w) => w.kind === "approximated")).toBe(true);
  });

  it("refuses a snowflake:// URL, which carries no credential", async () => {
    await expect(
      introspectSchema({ url: "snowflake://READER@myorg-acct/SALES/PUBLIC" })
    ).rejects.toThrow("Pass the driver instead");
  });
});

describe("migrations on Snowflake", () => {
  const schema = { item: s.model({ id: s.int().id() }).map("ITEMS") };
  const url = () =>
    `snowflake://READER@myorg-acct/SALES/PUBLIC?host=${encodeURIComponent(server.url)}`;

  it("refuses every command that could write, before it sends anything", () => {
    const migrationDriver = getMigrationDriver(
      new SnowflakeDriver({ databaseUrl: url(), token: "t" })
    );
    for (const requirement of ["effectful", "batch"] as const) {
      const failure = (() => {
        try {
          admitLiveMigrationCapability(migrationDriver, requirement, "push");
        } catch (error) {
          return error;
        }
      })();
      expect(failure).toBeInstanceOf(MigrationError);
      expect((failure as MigrationError).code).toBe(
        VibORMErrorCode.FEATURE_NOT_SUPPORTED
      );
    }
    // A read-only command reads.
    admitLiveMigrationCapability(migrationDriver, "read-only", "status");
    expect(server.requests).toEqual([]);
  });

  it("refuses a push preview at its first DDL statement, having only read", async () => {
    empty = true;
    const client = createClient({ schema, databaseUrl: url(), token: "t" });
    const failure = await createMigrationClient(client)
      .push({ dryRun: true })
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(MigrationError);
    expect((failure as MigrationError).message).toBe(
      "Snowflake cannot create a table here: VibORM only reads a Snowflake warehouse."
    );
    for (const sent of server.statements())
      expect(sent.statement).toMatch(READ_STATEMENT);
  });
});
