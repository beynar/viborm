/**
 * Snowflake's catalog into a schema document, against a local server that
 * answers the catalog queries as Snowflake's SQL API does. Never run against a
 * real warehouse: the `SHOW … KEYS` columns and the `INFORMATION_SCHEMA`
 * spellings are the documented ones.
 *
 * What it proves: a foreign key the catalog DECLARES — Snowflake enforces none
 * — becomes the document's relation; each Snowflake type becomes the scalar
 * that reads it exactly; a view and a type with no scalar are said, not
 * dropped silently; a key out of the schema is said, not read as a local
 * relation; and every migration command is refused before it sends anything.
 */

import { createClient, SnowflakeDriver } from "@drivers/snowflake";
import { MigrationError, VibORMErrorCode } from "@errors";
import { createMigrationClient } from "@migrations";
import { introspectSchema } from "@migrations/introspect";
import { MemoryEstateStorage } from "@migrations/storage/memory";
import { s } from "@schema";
import {
  type FakeColumn,
  type FakeSnowflake,
  type FakeStatement,
  rows,
  startFakeSnowflake,
} from "@tests/fixtures/snowflake-server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

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
  column("ORDERS", "DELIVERED_TO", "GEOGRAPHY", true),
  column("ORDERS", "EMBEDDING", "VECTOR", true),
  column("ORDERS", "SIGNATURE", "VECTOR", true),
  column("ORDERS", "FLOOR_PLAN", "GEOMETRY", true),
  column("ORDERS", "CRM_CUSTOMER_ID", "NUMBER", true, {
    precision: 38,
    scale: 0,
  }),
  column("ORDERS", "ARCHIVED_ID", "NUMBER", true, { precision: 38, scale: 0 }),
];

/** One `SHOW IMPORTED KEYS` row: ORDERS's key into `[database, schema]`. */
const importedKey = (
  [database, schema]: [string, string],
  column: string,
  name: string
) => [
  database,
  schema,
  "CUSTOMERS",
  "ID",
  "SALES",
  "PUBLIC",
  "ORDERS",
  column,
  "1",
  name,
  "NO ACTION",
  "NO ACTION",
];

let server: FakeSnowflake;

function answer({ statement }: FakeStatement) {
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
  if (statement.startsWith("SHOW COLUMNS"))
    return rows(
      [text("table_name"), text("column_name"), text("data_type")],
      [
        [
          "ORDERS",
          "EMBEDDING",
          '{"type":"VECTOR","nullable":true,"vectorElementType":{"type":"REAL","nullable":false},"dimension":3}',
        ],
        [
          "ORDERS",
          "SIGNATURE",
          '{"type":"VECTOR","nullable":true,"vectorElementType":{"type":"FIXED","precision":38,"scale":0,"nullable":false},"dimension":2}',
        ],
      ]
    );
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
        text("pk_database_name"),
        text("pk_schema_name"),
        text("pk_table_name"),
        text("pk_column_name"),
        text("fk_database_name"),
        text("fk_schema_name"),
        text("fk_table_name"),
        text("fk_column_name"),
        fixed("key_sequence"),
        text("fk_name"),
        text("update_rule"),
        text("delete_rule"),
      ],
      [
        importedKey(["SALES", "PUBLIC"], "CUSTOMER_ID", "FK_ORDERS_CUSTOMER"),
        // Every database has a PUBLIC schema, and a CUSTOMERS table may be in
        // both: this key is not into SALES.PUBLIC.CUSTOMERS.
        importedKey(["CRM", "PUBLIC"], "CRM_CUSTOMER_ID", "FK_ORDERS_CRM"),
        importedKey(["SALES", "ARCHIVE"], "ARCHIVED_ID", "FK_ORDERS_ARCHIVE"),
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
    expect(customers!.fields).toMatchObject({
      HOME: { type: "point", nullable: true },
    });
    expect(orders!.fields).toMatchObject({
      ID: { type: "int", id: true },
      CUSTOMER_ID: { type: "bigint" },
      TOTAL: { type: "decimal", precision: 12, scale: 2 },
      PLACED_AT: { type: "datetime" },
      PAID: { type: "boolean" },
      DELIVERED_TO: { type: "point", nullable: true },
      EMBEDDING: { type: "vector", dimension: 3, nullable: true },
    });
    expect(orders!.fields).not.toHaveProperty("SIGNATURE");
    expect(orders!.fields).not.toHaveProperty("FLOOR_PLAN");
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
          table: "ORDERS",
          name: "SIGNATURE",
          reason: expect.stringContaining("VECTOR(INT)"),
        }),
        expect.objectContaining({
          kind: "column",
          table: "ORDERS",
          name: "FLOOR_PLAN",
          reason: expect.stringContaining("planar"),
        }),
        // A key out of the schema is said, never read as a local relation.
        expect.objectContaining({
          kind: "foreignKey",
          table: "ORDERS",
          reason: expect.stringContaining("CRM.PUBLIC.CUSTOMERS"),
        }),
        expect.objectContaining({
          kind: "foreignKey",
          table: "ORDERS",
          reason: expect.stringContaining("SALES.ARCHIVE.CUSTOMERS"),
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
        expect.objectContaining({
          kind: "approximated",
          table: "ORDERS",
          name: "DELIVERED_TO",
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
      // One table holds vectors: SHOW COLUMNS caps a whole schema at 10,000.
      'SHOW COLUMNS IN TABLE "SALES"."PUBLIC"."ORDERS"',
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

  it("refuses the migration client, so every command, before it reads storage or sends anything", () => {
    const client = createClient({ schema, databaseUrl: url(), token: "t" });
    const storage = new MemoryEstateStorage();
    for (const options of [
      undefined,
      { storage },
      { tables: ["ITEMS"] },
    ] as const) {
      const failure = (() => {
        try {
          createMigrationClient(client, options as never);
        } catch (error) {
          return error;
        }
      })();
      expect(failure).toBeInstanceOf(MigrationError);
      expect(failure).toMatchObject({
        code: VibORMErrorCode.FEATURE_NOT_SUPPORTED,
        message: expect.stringContaining(
          "Snowflake has no migrations: VibORM only reads a Snowflake warehouse."
        ),
      });
    }
    expect(server.requests).toEqual([]);
  });
});
