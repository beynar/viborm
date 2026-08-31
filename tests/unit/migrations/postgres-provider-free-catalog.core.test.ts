import { VibORMErrorCode } from "@src/errors";
import { getMigrationDriver } from "@src/migrations/drivers";
import { describe, expect, test } from "vitest";
import { pgEstateDriver } from "./_estate";

type CatalogRows = Partial<
  Record<
    | "tables"
    | "columns"
    | "primaryKeys"
    | "indexes"
    | "foreignKeys"
    | "crossingForeignKeys"
    | "uniques"
    | "enums",
    readonly Record<string, unknown>[]
  >
>;

function classify(sql: string): keyof CatalogRows | "proof" | "unknown" {
  if (sql.includes("SELECT 1 AS present")) return "proof";
  if (sql.includes("format_type")) return "columns";
  if (sql.includes("(owner_ns.nspname = $1) <>")) {
    return "crossingForeignKeys";
  }
  if (sql.includes("FROM pg_index ix")) return "indexes";
  if (sql.includes("JOIN pg_enum e")) return "enums";
  if (sql.includes("constraint_type = 'PRIMARY KEY'")) return "primaryKeys";
  if (sql.includes("con.contype = 'f'")) return "foreignKeys";
  if (sql.includes("constraint_type = 'UNIQUE'")) return "uniques";
  if (sql.includes("information_schema.tables")) return "tables";
  return "unknown";
}

function catalogDriver(answers: CatalogRows) {
  const execution = pgEstateDriver("billing");
  execution.respond = (sql) => {
    const query = classify(sql);
    if (query === "proof") return [{ present: 1 }];
    if (query === "unknown") return [];
    return [...(answers[query] ?? [])];
  };
  return execution;
}

function column(
  name: string,
  dataType: string,
  udtName: string,
  formattedType = udtName
): Record<string, unknown> {
  return {
    table_name: "account",
    column_name: name,
    data_type: dataType,
    udt_schema: "pg_catalog",
    udt_name: udtName,
    is_nullable: "NO",
    column_default: null,
    character_maximum_length: null,
    numeric_precision: null,
    numeric_scale: null,
    formatted_type: formattedType,
    type_extension: null,
    type_extension_schema: null,
  };
}

function foreignKey(
  name: string,
  columnName: string,
  deleteRule: string,
  updateRule: string
): Record<string, unknown> {
  return {
    table_name: "account",
    constraint_name: name,
    column_name: columnName,
    foreign_table_name: "parent",
    foreign_column_name: "id",
    delete_rule: deleteRule,
    update_rule: updateRule,
    ordinal_position: 1,
  };
}

describe("provider-free PostgreSQL catalog reconstruction", () => {
  test("reconstructs ordered keys, indexes, enums, types, and referential actions", async () => {
    const execution = catalogDriver({
      tables: [{ table_name: "account" }],
      columns: [
        {
          ...column("id", "integer", "int4", "integer"),
          column_default: "nextval('billing.account_id_seq'::regclass)",
        },
        {
          ...column("label", "character varying", "varchar"),
          character_maximum_length: 40,
          is_nullable: "YES",
        },
        {
          ...column("code", "character", "bpchar"),
          character_maximum_length: 3,
        },
        {
          ...column("amount", "numeric", "numeric"),
          numeric_precision: 10,
          numeric_scale: 2,
          column_default: "'-1.2'::numeric",
        },
        {
          ...column("sequence", "numeric", "numeric"),
          numeric_precision: 8,
          numeric_scale: null,
          column_default: "next_value()",
        },
        {
          ...column("amounts", "ARRAY", "_numeric", "numeric(7,2)[]"),
          column_default: "'{1.20}'::numeric[]",
        },
        column("labels", "ARRAY", "_text", "text[]"),
        {
          ...column("state", "USER-DEFINED", "state", "billing.state"),
          udt_schema: "billing",
          column_default: "'active'::unrelated",
        },
      ],
      primaryKeys: [
        {
          table_name: "account",
          constraint_name: "account_pkey",
          column_name: "code",
          ordinal_position: 2,
        },
        {
          table_name: "account",
          constraint_name: "account_pkey",
          column_name: "id",
          ordinal_position: 1,
        },
      ],
      indexes: [
        {
          table_name: "account",
          index_name: "account_search_idx",
          column_name: "label",
          is_unique: false,
          index_type: "gin",
          filter_condition: "(label IS NOT NULL)",
          ordinal_position: 2,
        },
        {
          table_name: "account",
          index_name: "account_search_idx",
          column_name: "code",
          is_unique: false,
          index_type: "gin",
          filter_condition: "(label IS NOT NULL)",
          ordinal_position: 1,
        },
      ],
      foreignKeys: [
        foreignKey("set_null_fk", "label", "SET NULL", "RESTRICT"),
        foreignKey("set_default_fk", "code", "SET DEFAULT", "CASCADE"),
        foreignKey("fallback_fk", "id", "NO ACTION", "NO ACTION"),
      ],
      uniques: [
        {
          table_name: "account",
          constraint_name: "account_identity_key",
          column_name: "code",
          ordinal_position: 2,
        },
        {
          table_name: "account",
          constraint_name: "account_identity_key",
          column_name: "label",
          ordinal_position: 1,
        },
      ],
      enums: [
        { enum_name: "state", enum_value: "archived", sort_order: 2 },
        { enum_name: "state", enum_value: "active", sort_order: 1 },
      ],
    });
    const driver = getMigrationDriver(execution);

    const snapshot = await driver.introspect((sql, params) =>
      execution._executeRaw(sql, params)
    );

    expect(snapshot.tables[0]?.columns).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "id",
          type: "int4",
          default: undefined,
          autoIncrement: true,
        }),
        expect.objectContaining({ name: "label", type: "varchar(40)" }),
        expect.objectContaining({ name: "code", type: "char(3)" }),
        expect.objectContaining({
          name: "amount",
          type: "numeric(10,2)",
          default: "-1.20",
          decimal: { precision: 10, scale: 2 },
        }),
        expect.objectContaining({
          name: "sequence",
          type: "numeric(8)",
          default: "next_value()",
          decimal: { precision: 8, scale: 0 },
        }),
        expect.objectContaining({
          name: "amounts",
          type: "numeric(7,2)[]",
          decimal: { precision: 7, scale: 2 },
        }),
        expect.objectContaining({ name: "labels", type: "text[]" }),
        expect.objectContaining({ name: "state", default: "'active'" }),
      ])
    );
    expect(snapshot.tables[0]?.primaryKey).toEqual({
      columns: ["id", "code"],
      name: "account_pkey",
    });
    expect(snapshot.tables[0]?.indexes).toEqual([
      {
        name: "account_search_idx",
        columns: ["code", "label"],
        unique: false,
        type: "gin",
        where: "(label IS NOT NULL)",
      },
    ]);
    expect(snapshot.tables[0]?.foreignKeys).toEqual([
      expect.objectContaining({
        name: "set_null_fk",
        onDelete: "setNull",
        onUpdate: "restrict",
      }),
      expect.objectContaining({
        name: "set_default_fk",
        onDelete: "setDefault",
        onUpdate: "cascade",
      }),
      expect.objectContaining({
        name: "fallback_fk",
        onDelete: "noAction",
        onUpdate: "noAction",
      }),
    ]);
    expect(snapshot.tables[0]?.uniqueConstraints).toEqual([
      {
        name: "account_identity_key",
        columns: ["label", "code"],
      },
    ]);
    expect(snapshot.enums).toEqual([
      { name: "state", values: ["active", "archived"] },
    ]);
  });

  test("refuses PostGIS type erasure when the adapter has no GeoPoint protocol", async () => {
    const execution = catalogDriver({
      tables: [{ table_name: "account" }],
      columns: [
        {
          ...column(
            "location",
            "USER-DEFINED",
            "geography",
            "geography(Point,4326)"
          ),
          udt_schema: "public",
          type_extension: "postgis",
          type_extension_schema: "public",
        },
      ],
    });
    const driver = getMigrationDriver(execution);

    await expect(
      driver.introspect((sql, params) => execution._executeRaw(sql, params))
    ).rejects.toMatchObject({
      code: VibORMErrorCode.DRIVER_NOT_SUPPORTED,
      meta: { feature: "GeoPoint", type: "geography" },
    });
  });
});

describe("coverage low value", () => {
  test("reports the count when several cross-schema constraints are present", async () => {
    const crossing = {
      constraint_name: "external_fk",
      owning_schema: "billing",
      owning_table: "account",
      referenced_schema: "external",
      referenced_table: "parent",
    };
    const execution = catalogDriver({
      crossingForeignKeys: [
        crossing,
        { ...crossing, constraint_name: "second_external_fk" },
      ],
    });
    const driver = getMigrationDriver(execution);

    await expect(
      driver.introspect((sql, params) => execution._executeRaw(sql, params))
    ).rejects.toMatchObject({
      code: VibORMErrorCode.FEATURE_NOT_SUPPORTED,
      message: expect.stringContaining("2 such constraints"),
    });
  });
});
