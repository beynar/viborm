import { VibORMErrorCode } from "@src/errors";
import { getMigrationDriver } from "@src/migrations/drivers";
import { introspectPostgresSchema } from "@src/migrations/drivers/postgres/introspect";
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
  test.each([
    "generated",
    "partitioned",
  ])("refuses selected %s semantics without poisoning excluded tables", async (kind) => {
    const execution = catalogDriver({
      tables: [
        {
          table_name: "account",
          relation_kind: kind === "partitioned" ? "p" : "r",
          is_partition: false,
        },
      ],
      columns: [
        {
          ...column("id", "integer", "int4"),
          generated_kind: kind === "generated" ? "s" : "",
        },
      ],
    });
    await expect(
      getMigrationDriver(execution).introspect((sql, params) =>
        execution._executeRaw(sql, params)
      )
    ).rejects.toMatchObject({
      code: VibORMErrorCode.MIGRATION_INVALID_STATE,
      message: expect.stringContaining(
        kind === "generated" ? "generated" : "partition"
      ),
    });
    await expect(
      introspectPostgresSchema(
        (sql, params) => execution._executeRaw(sql, params),
        {
          namespace: "billing",
          tables: ["external"],
          admittedExtensionTypes: new Set(),
        }
      )
    ).resolves.toMatchObject({ tables: [{ name: "account" }] });
  });

  test("view collision catalog parameters use explicit escaped PostgreSQL array text", async () => {
    const execution = catalogDriver({});
    const calls: unknown[][] = [];
    execution.respond = (sql, params) => {
      if (sql.includes("relation.relkind IN ('v','m')")) {
        calls.push(params ?? []);
        return [{ name: "mapped_view" }];
      }
      return [];
    };
    await expect(
      getMigrationDriver(execution).preflightSchemaRequirements(
        [
          {
            tables: [
              {
                name: "mapped_view",
                columns: [],
                primaryKey: undefined,
                uniqueConstraints: [],
                indexes: [],
                foreignKeys: [],
              },
            ],
          },
        ],
        (sql, params) => execution._executeRaw(sql, params)
      )
    ).rejects.toMatchObject({
      code: VibORMErrorCode.MIGRATION_INVALID_STATE,
      message: expect.stringContaining("view"),
    });
    expect(calls).toEqual([["billing", '{"mapped_view"}']]);
  });

  test.each([
    "btree",
    "hnsw",
  ])("refuses unrepresentable %s index metadata in owned scope and leaves external scope alone", async (method) => {
    const execution = catalogDriver({
      tables: [{ table_name: "account" }],
      columns: [column("id", "integer", "int4")],
      indexes: [
        {
          table_name: "account",
          index_name: "foreign_semantics",
          column_name: "id",
          is_unique: false,
          index_type: method,
          unsupported_structure: true,
          filter_condition: null,
          ordinal_position: 1,
        },
      ],
    });
    await expect(
      getMigrationDriver(execution).introspect((query, params) =>
        execution._executeRaw(query, params)
      )
    ).rejects.toMatchObject({
      code: VibORMErrorCode.FEATURE_NOT_SUPPORTED,
      message: expect.stringContaining("account.foreign_semantics"),
    });
    await expect(
      introspectPostgresSchema(
        (query, params) => execution._executeRaw(query, params),
        {
          namespace: "billing",
          tables: ["other"],
          admittedExtensionTypes: new Set(),
        }
      )
    ).resolves.toBeDefined();
    expect(
      execution.statements.every(
        (statement) =>
          statement === "<connect>" ||
          statement.startsWith("SELECT") ||
          statement.trimStart().startsWith("SELECT")
      )
    ).toBe(true);
  });

  // `push` reads the catalog on its ONE pinned session: node-postgres queues
  // overlapping queries on a connection and warns it will refuse them in
  // pg@9, so the reads go one at a time.
  test("reads the catalog one statement at a time", async () => {
    const execution = catalogDriver({
      tables: [{ table_name: "account" }],
      columns: [column("id", "integer", "int4")],
    });
    let inFlight = 0;
    let peak = 0;
    const reads: string[] = [];
    await getMigrationDriver(execution).introspect(async (sql, params) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      reads.push(sql);
      await new Promise((resolve) => setTimeout(resolve, 1));
      try {
        return await execution._executeRaw(sql, params);
      } finally {
        inFlight -= 1;
      }
    });
    expect(reads.length).toBeGreaterThan(8);
    expect(peak).toBe(1);
  });

  test("reconstructs ordered keys, indexes, enums, types, and referential actions", async () => {
    const execution = catalogDriver({
      tables: [{ table_name: "account" }],
      columns: [
        {
          ...column("id", "integer", "int4", "integer"),
          column_default: "nextval('billing.account_id_seq'::regclass)",
        },
        {
          ...column(
            "label",
            "character varying",
            "varchar",
            "character varying(40)"
          ),
          character_maximum_length: 40,
          is_nullable: "YES",
        },
        {
          ...column("code", "character", "bpchar", "character(3)"),
          character_maximum_length: 3,
        },
        {
          ...column("amount", "numeric", "numeric", "numeric(10,2)"),
          numeric_precision: 10,
          numeric_scale: 2,
          column_default: "'-1.2'::numeric",
        },
        {
          ...column("sequence", "numeric", "numeric", "numeric(8,0)"),
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
          unsupported_structure: false,
          filter_condition: "(label IS NOT NULL)",
          ordinal_position: 2,
        },
        {
          table_name: "account",
          index_name: "account_search_idx",
          column_name: "code",
          is_unique: false,
          index_type: "gin",
          unsupported_structure: false,
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
          type: "integer",
          default: undefined,
          autoIncrement: true,
        }),
        expect.objectContaining({
          name: "label",
          type: "character varying(40)",
        }),
        expect.objectContaining({ name: "code", type: "character(3)" }),
        expect.objectContaining({
          name: "amount",
          type: "numeric(10,2)",
          default: "-1.20",
          decimal: { precision: 10, scale: 2 },
        }),
        expect.objectContaining({
          name: "sequence",
          type: "numeric(8,0)",
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
