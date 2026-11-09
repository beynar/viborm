/**
 * `introspectSchema`'s translation, provider-free: a snapshot as each dialect's
 * migration introspection writes it → a schema document, its skipped objects
 * and its warnings. Every document a case produces must also parse and
 * validate, because the document is the product.
 */

import { postgresMigrationDriver } from "@migrations/drivers/postgres";
import { sqlite3MigrationDriver } from "@migrations/drivers/sqlite";
import { relationNameFromColumn } from "@migrations/introspect/names";
import { translateSnapshot } from "@migrations/introspect/translate";
import type {
  ColumnDef,
  EnumDef,
  ForeignKeyDef,
  IndexDef,
  TableDef,
  UniqueConstraintDef,
} from "@migrations/types";
import { parseSchema } from "@schema/json";
import { describe, expect, it } from "vitest";

const column = (
  name: string,
  type: string,
  extra: Partial<ColumnDef> = {}
): ColumnDef => ({ name, type, nullable: false, ...extra });

function table(
  name: string,
  columns: ColumnDef[],
  extra: {
    pk?: string[] | null;
    fks?: ForeignKeyDef[];
    uniques?: UniqueConstraintDef[];
    indexes?: IndexDef[];
  } = {}
): TableDef {
  const pk = extra.pk === undefined ? [columns[0]!.name] : extra.pk;
  return {
    name,
    columns,
    primaryKey: pk === null ? undefined : { columns: pk, name: `${name}_pkey` },
    indexes: extra.indexes ?? [],
    foreignKeys: extra.fks ?? [],
    uniqueConstraints: extra.uniques ?? [],
  };
}

const fk = (
  tableName: string,
  columns: string[],
  referencedTable: string,
  referencedColumns: string[] = ["id"],
  extra: Partial<ForeignKeyDef> = {}
): ForeignKeyDef => ({
  name: `${tableName}_${columns.join("_")}_fkey`,
  columns,
  referencedTable,
  referencedColumns,
  onDelete: "noAction",
  onUpdate: "noAction",
  ...extra,
});

function translate(
  tables: TableDef[],
  options: {
    dialect?: "postgresql" | "sqlite";
    enums?: EnumDef[];
    identity?: string[];
    junctionModels?: string[];
  } = {}
) {
  const dialect = options.dialect ?? "postgresql";
  const result = translateSnapshot({
    snapshot: { tables, enums: options.enums },
    dialect,
    migrationDriver:
      dialect === "postgresql"
        ? postgresMigrationDriver
        : sqlite3MigrationDriver,
    identityColumns: new Set(options.identity ?? []),
    junctionModels: new Set(options.junctionModels ?? []),
  });
  parseSchema(result.document, { validate: true });
  return result;
}

/** One column of a one-table PostgreSQL database, as a field. */
function pgField(def: ColumnDef, enums?: EnumDef[]) {
  const result = translate([table("t", [column("id", "integer"), def])], {
    enums,
  });
  return {
    field: result.document.models.t?.fields[def.name],
    skipped: result.skipped,
    warnings: result.warnings,
    document: result.document,
  };
}

describe("PostgreSQL types", () => {
  it.each([
    ["text", { type: "string" }],
    [
      "character varying(80)",
      { type: "string", native: { db: "pg", type: "varchar(80)" } },
    ],
    ["character(2)", { type: "string", native: { db: "pg", type: "char(2)" } }],
    ["citext", { type: "string", native: { db: "pg", type: "citext" } }],
    ["inet", { type: "string", native: { db: "pg", type: "inet" } }],
    ["uuid", { type: "string", generate: { kind: "uuid", generate: false } }],
    [
      "uuid[]",
      { type: "string", native: { db: "pg", type: "uuid" }, array: true },
    ],
    ["integer", { type: "int" }],
    ["smallint", { type: "int", native: { db: "pg", type: "smallint" } }],
    ["bigint", { type: "bigint" }],
    ["real", { type: "number", native: { db: "pg", type: "real" } }],
    ["double precision", { type: "number" }],
    ["boolean", { type: "boolean" }],
    ["date", { type: "date" }],
    ["bytea", { type: "blob" }],
    ["jsonb", { type: "json" }],
    ["json", { type: "json", native: { db: "pg", type: "json" } }],
    ["timestamp(3) with time zone", { type: "datetime" }],
    [
      "timestamp with time zone",
      { type: "datetime", native: { db: "pg", type: "timestamptz" } },
    ],
    [
      "timestamp(3) without time zone",
      { type: "datetime", withoutTimezone: true },
    ],
    [
      "timestamp(6) without time zone",
      {
        type: "datetime",
        withoutTimezone: true,
        native: { db: "pg", type: "timestamp(6)" },
      },
    ],
    [
      "time without time zone",
      { type: "time", native: { db: "pg", type: "time" } },
    ],
    [
      "time(3) with time zone",
      { type: "time", native: { db: "pg", type: "timetz(3)" } },
    ],
    ["integer[]", { type: "int", array: true }],
  ])("%s", (type, expected) => {
    expect(pgField(column("c", type)).field).toMatchObject(expected);
  });

  it("reads a decimal from the column's own descriptor", () => {
    expect(
      pgField(
        column("c", "numeric(12,4)", {
          decimal: { precision: 12, scale: 4 } as never,
        })
      ).field
    ).toMatchObject({ type: "decimal", precision: 12, scale: 4 });
  });

  it.each([
    ["interval", "has no VibORM scalar"],
    ["money", "has no VibORM scalar"],
    ["numeric", "unconstrained `numeric`"],
    ["character varying", "without a length"],
    ["jsonb[]", "a list of json"],
  ])("skips a %s column, with the reason", (type, reason) => {
    const { field, skipped } = pgField(column("c", type));
    expect(field).toBeUndefined();
    expect(skipped).toEqual([
      expect.objectContaining({
        kind: "column",
        table: "t",
        name: "c",
        reason: expect.stringContaining(reason),
      }),
    ]);
  });

  it("keeps a nullable column nullable", () => {
    expect(pgField(column("c", "text", { nullable: true })).field).toEqual({
      type: "string",
      nullable: true,
    });
  });
});

describe("PostgreSQL defaults", () => {
  it.each([
    [column("c", "text", { default: "'it''s'" }), { default: "it's" }],
    [column("c", "integer", { default: "42" }), { default: 42 }],
    [column("c", "double precision", { default: "2.5" }), { default: 2.5 }],
    [
      column("c", "bigint", { default: "'9007199254740993'" }),
      { default: { $bigint: "9007199254740993" } },
    ],
    [column("c", "boolean", { default: "false" }), { default: false }],
    [column("c", "jsonb", { default: `'{"a": 1}'` }), { default: { a: 1 } }],
    [
      column("c", "jsonb", { default: `'{"$date": "x"}'` }),
      { default: { $raw: { $date: "x" } } },
    ],
    [column("c", "text[]", { default: "'{a,b}'" }), { default: ["a", "b"] }],
    [
      column("c", "timestamp(3) with time zone", {
        default: "CURRENT_TIMESTAMP",
      }),
      { generate: { kind: "now" } },
    ],
    [
      column("c", "timestamp(3) with time zone", {
        default: "'2020-01-02 03:04:05+00'",
      }),
      { default: "2020-01-02T03:04:05.000Z" },
    ],
    [
      column("c", "uuid", { default: "gen_random_uuid()" }),
      { generate: { kind: "uuid" } },
    ],
    [
      column("c", "integer", { autoIncrement: true }),
      { generate: { kind: "increment" } },
    ],
  ])("%o", (def, expected) => {
    const { field, skipped } = pgField(def);
    expect(field).toMatchObject(expected);
    expect(skipped).toEqual([]);
  });

  it("reads an identity column as an increment", () => {
    const result = translate(
      [table("t", [column("id", "bigint"), column("n", "integer")])],
      {
        identity: ["t\0id"],
      }
    );
    expect(result.document.models.t?.fields.id).toEqual({
      type: "bigint",
      id: true,
      generate: { kind: "increment" },
    });
  });

  it("skips a default it cannot read, and keeps the column", () => {
    const { field, skipped } = pgField(
      column("c", "text", { default: "lower('X'::text)" })
    );
    expect(field).toEqual({ type: "string" });
    expect(skipped).toEqual([
      expect.objectContaining({ kind: "default", table: "t", name: "c" }),
    ]);
  });

  it("skips an enum default that is not a member", () => {
    const enums = [{ name: "mood", values: ["sad", "ok"] }];
    const { skipped } = pgField(
      column("c", "mood", { default: "'happy'" }),
      enums
    );
    expect(skipped.map((item) => item.kind)).toEqual(["default"]);
  });
});

describe("keys and names", () => {
  it("keeps database names, maps a reserved one, and skips one `.map()` cannot take", () => {
    const result = translate([
      table("sales", [
        column("id", "integer"),
        column("first name", "text"),
        column("_count", "integer"),
      ]),
      table("2024 sales", [column("id", "integer")]),
    ]);
    expect(result.document.models).toEqual({
      sales: {
        fields: {
          id: { type: "int", id: true },
          _count_2: { type: "int", column: "_count" },
        },
      },
    });
    expect(result.skipped.map((item) => [item.kind, item.name])).toEqual([
      ["column", "first name"],
      ["table", "2024 sales"],
    ]);
  });

  it("claims no generator for a text key: the database cannot prove one", () => {
    const result = translate([table("t", [column("id", "text")])]);
    expect(result.document.models.t?.fields.id).toEqual({
      type: "string",
      id: true,
      generate: { kind: "ulid", generate: false, implicit: true },
    });
  });

  it("states a compound primary key as `ids`", () => {
    const result = translate([
      table("t", [column("a", "integer"), column("b", "integer")], {
        pk: ["a", "b"],
      }),
    ]);
    expect(result.document.models.t?.ids).toEqual([{ fields: ["a", "b"] }]);
  });

  it("names a relation from its foreign-key column", () => {
    expect(relationNameFromColumn("author_id")).toBe("author");
    expect(relationNameFromColumn("authorId")).toBe("author");
    expect(relationNameFromColumn("AUTHOR_ID")).toBe("AUTHOR");
    expect(relationNameFromColumn("paid")).toBeUndefined();
    expect(relationNameFromColumn("id")).toBeUndefined();
  });

  it("skips a table without a primary key, and one whose key cannot be read", () => {
    const result = translate([
      table("log", [column("at", "text")], { pk: null }),
      table("odd", [column("id", "interval")]),
      table("ok", [column("id", "integer")]),
    ]);
    expect(Object.keys(result.document.models)).toEqual(["ok"]);
    expect(result.skipped.map((item) => [item.kind, item.name])).toEqual([
      ["table", "log"],
      ["table", "odd"],
    ]);
  });
});

describe("unique constraints and indexes", () => {
  const users = (uniques: UniqueConstraintDef[], indexes: IndexDef[] = []) =>
    translate([
      table(
        "users",
        [
          column("id", "integer"),
          column("email", "text"),
          column("org", "integer"),
        ],
        {
          uniques,
          indexes,
        }
      ),
    ]);

  it("reads PostgreSQL's default names as `.unique()` and compound uniques", () => {
    const result = users([
      { name: "users_email_key", columns: ["email"] },
      { name: "users_org_email_key", columns: ["org", "email"] },
      { name: "users_by_org_key", columns: ["org", "id"] },
    ]);
    const model = result.document.models.users!;
    expect(model.fields.email).toMatchObject({ unique: true });
    expect(model.uniques).toEqual([
      { fields: ["org", "email"] },
      { fields: ["org", "id"], name: "by_org" },
    ]);
    expect(result.warnings).toEqual([]);
  });

  it("keeps any other constraint name as a unique index, and says so", () => {
    const result = users([{ name: "uq_email", columns: ["email"] }]);
    expect(result.document.models.users!.indexes).toEqual([
      { fields: ["email"], name: "uq_email", unique: true },
    ]);
    expect(result.warnings).toEqual([
      expect.objectContaining({ kind: "approximated", name: "uq_email" }),
    ]);
  });

  it("keeps indexes by name and type, and skips partial and raw ones", () => {
    const result = users(
      [],
      [
        {
          name: "users_org_idx",
          columns: ["org"],
          unique: false,
          type: "btree",
        },
        {
          name: "users_email_hash",
          columns: ["email"],
          unique: false,
          type: "hash",
        },
        {
          name: "users_live",
          columns: ["email"],
          unique: false,
          where: "org > 0",
        },
        {
          name: "users_raw",
          columns: ["email"],
          unique: false,
          raw: { hash: "x" },
        },
      ]
    );
    expect(result.document.models.users!.indexes).toEqual([
      { fields: ["org"], name: "users_org_idx" },
      { fields: ["email"], name: "users_email_hash", type: "hash" },
    ]);
    expect(result.skipped.map((item) => [item.kind, item.name])).toEqual([
      ["index", "users_live"],
      ["index", "users_raw"],
    ]);
  });
});

describe("relations", () => {
  const account = table("account", [column("id", "integer")]);

  it("pairs a foreign key's to-one with a to-many, keeping its actions", () => {
    const result = translate([
      account,
      table("post", [column("id", "integer"), column("author_id", "integer")], {
        fks: [
          fk("post", ["author_id"], "account", ["id"], { onDelete: "cascade" }),
        ],
        indexes: [
          { name: "post_author_id_idx", columns: ["author_id"], unique: false },
        ],
      }),
    ]);
    expect(result.document.models.post!.fields.author).toEqual({
      type: "toOne",
      target: "account",
      fields: ["author_id"],
      references: ["id"],
      onDelete: "cascade",
      onUpdate: "noAction",
    });
    expect(result.document.models.account!.fields.post).toEqual({
      type: "toMany",
      target: "post",
    });
  });

  it("names several foreign keys to one table apart, with a pairing label", () => {
    const result = translate([
      account,
      table(
        "post",
        [
          column("id", "integer"),
          column("author_id", "integer"),
          column("editor_id", "integer", { nullable: true }),
        ],
        {
          fks: [
            fk("post", ["author_id"], "account"),
            fk("post", ["editor_id"], "account"),
          ],
        }
      ),
    ]);
    const { post, account: target } = result.document.models;
    expect(post!.fields.author).toMatchObject({ name: "post_author_id_fkey" });
    expect(post!.fields.editor).toMatchObject({ name: "post_editor_id_fkey" });
    expect(target!.fields.post_by_author).toEqual({
      type: "toMany",
      target: "post",
      name: "post_author_id_fkey",
    });
    expect(target!.fields.post_by_editor).toEqual({
      type: "toMany",
      target: "post",
      name: "post_editor_id_fkey",
    });
  });

  it("names a self relation, and a one-to-one inverse is a to-one", () => {
    const result = translate([
      table(
        "node",
        [
          column("id", "integer"),
          column("parent_id", "integer", { nullable: true }),
        ],
        {
          fks: [fk("node", ["parent_id"], "node")],
          uniques: [{ name: "node_parent_id_key", columns: ["parent_id"] }],
        }
      ),
    ]);
    expect(result.document.models.node!.fields).toMatchObject({
      parent: { type: "toOne", target: "node", name: "node_parent_id_fkey" },
      node_by_parent: {
        type: "toOne",
        target: "node",
        name: "node_parent_id_fkey",
      },
    });
  });

  it("does not let a relation take a column's key", () => {
    const result = translate([
      account,
      table(
        "post",
        [
          column("id", "integer"),
          column("author_id", "integer"),
          column("author", "text"),
        ],
        {
          fks: [fk("post", ["author_id"], "account")],
        }
      ),
    ]);
    expect(result.document.models.post!.fields.author).toEqual({
      type: "string",
    });
    expect(result.document.models.post!.fields.author_2).toMatchObject({
      type: "toOne",
    });
  });

  it.each([
    [fk("post", ["author_id"], "missing"), "does not declare"],
    [fk("post", ["author_id"], "account", ["code"]), "as a key"],
    [
      fk("post", ["author_id"], "account", ["id"], { onDelete: "setDefault" }),
      "SET DEFAULT",
    ],
  ])("skips a foreign key it cannot state: %o", (foreignKey, reason) => {
    const result = translate([
      table("account", [column("id", "integer"), column("code", "integer")]),
      table("post", [column("id", "integer"), column("author_id", "integer")], {
        fks: [foreignKey],
      }),
    ]);
    expect(result.document.models.post!.fields.author).toBeUndefined();
    expect(result.skipped).toEqual([
      expect.objectContaining({
        kind: "foreignKey",
        reason: expect.stringContaining(reason),
      }),
    ]);
  });

  const joinTables = () => [
    table("post", [column("id", "integer")]),
    table("tag", [column("id", "integer")]),
    table(
      "post_tag",
      [column("post_id", "integer"), column("tag_id", "integer")],
      {
        pk: ["post_id", "tag_id"],
        fks: [
          fk("post_tag", ["post_id"], "post", ["id"], { onDelete: "cascade" }),
          fk("post_tag", ["tag_id"], "tag", ["id"], { onDelete: "cascade" }),
        ],
      }
    ),
  ];

  it("writes a pure join table as the generated junction of a many-to-many", () => {
    const result = translate(joinTables());
    expect(Object.keys(result.document.models)).toEqual(["post", "tag"]);
    expect(result.document.models.post!.fields.tag).toEqual({
      type: "toMany",
      target: "tag",
      junction: {
        table: "post_tag",
        source: "post_id",
        target: "tag_id",
        onDelete: "cascade",
        onUpdate: "noAction",
      },
    });
    expect(result.document.models.tag!.fields.post).toEqual({
      type: "toMany",
      target: "post",
    });
    expect([...result.generatedJunctions]).toEqual(["post_tag"]);
  });

  it("keeps it as a junction model when the generated junction is another table", () => {
    const result = translate(joinTables(), { junctionModels: ["post_tag"] });
    const { post, post_tag: link } = result.document.models;
    expect(link!.fields).toMatchObject({
      post: { type: "toOne", target: "post", fields: ["post_id"] },
      tag: { type: "toOne", target: "tag", fields: ["tag_id"] },
    });
    expect(post!.fields.tag).toEqual({
      type: "toMany",
      target: "tag",
      junction: { model: "post_tag", source: "post", target: "tag" },
    });
    expect(post!.fields.post_tag).toEqual({
      type: "toMany",
      target: "post_tag",
    });
  });
});

describe("enums", () => {
  it("inlines a column's own derived enum, names a shared one, skips an unused one", () => {
    const result = translate(
      [
        table("t", [
          column("id", "integer"),
          column("status", "t_status_enum"),
          column("role", "member_role"),
          column("roles", "member_role[]"),
        ]),
      ],
      {
        enums: [
          { name: "t_status_enum", values: ["a", "b"] },
          { name: "member_role", values: ["owner", "member"] },
          { name: "orphan", values: ["x"] },
        ],
      }
    );
    expect(result.document.enums).toEqual({
      member_role: { values: ["owner", "member"], name: "member_role" },
    });
    expect(result.document.models.t!.fields).toMatchObject({
      status: { type: "enum", enum: ["a", "b"] },
      role: { type: "enum", enum: "member_role" },
      roles: { type: "enum", enum: "member_role", array: true },
    });
    expect(result.skipped).toEqual([
      expect.objectContaining({ kind: "enum", name: "orphan" }),
    ]);
  });
});

describe("SQLite", () => {
  const sqlite = (
    columns: ColumnDef[],
    extra: Parameters<typeof table>[2] = {}
  ) =>
    translate([table("t", [column("id", "INTEGER"), ...columns], extra)], {
      dialect: "sqlite",
    });

  it("reads VibORM's own spellings exactly", () => {
    const result = sqlite([
      column("name", "TEXT"),
      column("score", "REAL", { default: "1.5" }),
      column("data", "JSON", { nullable: true }),
      column("bytes", "BLOB", { nullable: true }),
      column("at", "TEXT", {
        default: "(strftime('%Y-%m-%dT%H:%M:%fZ','now'))",
      }),
      column("role", `TEXT CHECK("role" IN ('a', 'b'))`, { default: "'a'" }),
      column("price", "INTEGER", {
        default: "150",
        decimal: { precision: 10, scale: 2 } as never,
      }),
    ]);
    expect(result.document.models.t!.fields).toMatchObject({
      name: { type: "string" },
      score: { type: "number", default: 1.5 },
      data: { type: "json", nullable: true },
      bytes: { type: "blob", nullable: true },
      at: { type: "datetime", generate: { kind: "now" } },
      role: { type: "enum", enum: ["a", "b"], default: "a" },
      price: { type: "decimal", precision: 10, scale: 2, default: "1.50" },
    });
    expect(result.warnings).toEqual([]);
  });

  it("reads any other declared type by affinity, and says so", () => {
    const result = sqlite([
      column("name", "VARCHAR(20)"),
      column("flag", "BOOLEAN", { default: "0" }),
      column("at", "DATETIME", { nullable: true }),
    ]);
    expect(result.document.models.t!.fields).toMatchObject({
      name: { type: "string" },
      flag: { type: "boolean", default: false },
      at: { type: "datetime" },
    });
    expect(result.warnings.map((warning) => warning.name)).toEqual([
      "name",
      "flag",
      "at",
    ]);
  });

  it("reads a BLOB key, and a foreign key to it, as the uuid key VibORM stores there", () => {
    const result = translate(
      [
        table("a", [column("id", "BLOB")]),
        table("b", [column("id", "INTEGER"), column("a_id", "BLOB")], {
          fks: [fk("b", ["a_id"], "a")],
          indexes: [{ name: "b_a_id_idx", columns: ["a_id"], unique: false }],
        }),
      ],
      { dialect: "sqlite" }
    );
    expect(result.document.models.a!.fields.id).toMatchObject({
      type: "string",
      generate: { kind: "uuid", generate: false },
    });
    expect(result.document.models.b!.fields.a_id).toMatchObject({
      type: "string",
    });
    expect(
      result.warnings.map((warning) => `${warning.table}.${warning.name}`)
    ).toEqual(["a.id", "b.a_id"]);
  });
});
