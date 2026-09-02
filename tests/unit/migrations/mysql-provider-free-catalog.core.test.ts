import { VibORMErrorCode } from "@src/errors";
import { getMigrationDriver } from "@src/migrations/drivers";
import { describe, expect, test } from "vitest";
import { mysqlEstateDriver } from "./_estate";

function column(
  name: string,
  dataType: string,
  columnType = dataType
): Record<string, unknown> {
  return {
    TABLE_NAME: "order$lines",
    COLUMN_NAME: name,
    DATA_TYPE: dataType,
    COLUMN_TYPE: columnType,
    IS_NULLABLE: "NO",
    COLUMN_DEFAULT: null,
    CHARACTER_MAXIMUM_LENGTH: null,
    NUMERIC_PRECISION: null,
    NUMERIC_SCALE: null,
    SRS_ID: null,
    EXTRA: "",
    COLUMN_COMMENT: "",
  };
}

function foreignKey(
  name: string,
  columnName: string,
  deleteRule: string,
  updateRule: string
): Record<string, unknown> {
  return {
    TABLE_SCHEMA: "billing",
    TABLE_NAME: "order$lines",
    CONSTRAINT_NAME: name,
    COLUMN_NAME: columnName,
    REFERENCED_TABLE_SCHEMA: "billing",
    REFERENCED_TABLE_NAME: "parents",
    REFERENCED_COLUMN_NAME: "id",
    DELETE_RULE: deleteRule,
    UPDATE_RULE: updateRule,
    ORDINAL_POSITION: 1,
  };
}

function catalogDriver(rows: {
  readonly columns?: readonly Record<string, unknown>[];
  readonly primaryKeys?: readonly Record<string, unknown>[];
  readonly indexes?: readonly Record<string, unknown>[];
  readonly foreignKeys?: readonly Record<string, unknown>[];
}) {
  const execution = mysqlEstateDriver({
    namespace: "billing",
    attested: true,
  });
  execution.respond = (sql) => {
    if (sql.includes("information_schema.SCHEMATA")) {
      return [{ SCHEMA_NAME: "billing" }];
    }
    if (sql.includes("information_schema.COLUMNS")) {
      return [...(rows.columns ?? [])];
    }
    if (sql.includes("CONSTRAINT_TYPE = 'PRIMARY KEY'")) {
      return [...(rows.primaryKeys ?? [])];
    }
    if (sql.includes("information_schema.STATISTICS")) {
      return [...(rows.indexes ?? [])];
    }
    if (sql.includes("CONSTRAINT_TYPE = 'FOREIGN KEY'")) {
      return [...(rows.foreignKeys ?? [])];
    }
    if (sql.includes("information_schema.TABLES")) {
      return [{ TABLE_NAME: "order$lines" }];
    }
    return [];
  };
  return execution;
}

describe("provider-free MySQL catalog reconstruction", () => {
  test("reconstructs catalog-only type, enum, key, and action vocabulary", async () => {
    const execution = catalogDriver({
      columns: [
        {
          ...column("id", "int", "int unsigned"),
          EXTRA: "DEFAULT_GENERATED auto_increment",
        },
        {
          ...column("label", "varchar"),
          CHARACTER_MAXIMUM_LENGTH: 63,
          IS_NULLABLE: "YES",
        },
        {
          ...column("code", "char"),
          CHARACTER_MAXIMUM_LENGTH: 3,
        },
        {
          ...column("amount", "decimal"),
          NUMERIC_PRECISION: 10,
          NUMERIC_SCALE: 2,
        },
        {
          ...column("units", "decimal"),
          NUMERIC_PRECISION: 8,
          NUMERIC_SCALE: null,
        },
        column(
          "sta$tus",
          "enum",
          String.raw`enum('a,b', 'it''s', 'back\\slash')`
        ),
        column("unparsed", "enum", "enum(not-quoted)"),
        { ...column("location", "point"), SRS_ID: undefined },
        { ...column("target", "point"), SRS_ID: "4326" },
      ],
      primaryKeys: [
        {
          TABLE_NAME: "order$lines",
          CONSTRAINT_NAME: "PRIMARY",
          COLUMN_NAME: "code",
          ORDINAL_POSITION: 2,
        },
        {
          TABLE_NAME: "order$lines",
          CONSTRAINT_NAME: "PRIMARY",
          COLUMN_NAME: "id",
          ORDINAL_POSITION: 1,
        },
      ],
      indexes: [
        {
          TABLE_NAME: "order$lines",
          INDEX_NAME: "geo_idx",
          COLUMN_NAME: "target",
          NON_UNIQUE: 1,
          INDEX_TYPE: "RTREE",
          SEQ_IN_INDEX: 1,
        },
        {
          TABLE_NAME: "order$lines",
          INDEX_NAME: "odd_idx",
          COLUMN_NAME: "code",
          NON_UNIQUE: 0,
          INDEX_TYPE: "ODD",
          SEQ_IN_INDEX: 2,
        },
        {
          TABLE_NAME: "order$lines",
          INDEX_NAME: "odd_idx",
          COLUMN_NAME: "id",
          NON_UNIQUE: 0,
          INDEX_TYPE: "ODD",
          SEQ_IN_INDEX: 1,
        },
        {
          TABLE_NAME: "order$lines",
          INDEX_NAME: "set_null_fk",
          COLUMN_NAME: "label",
          NON_UNIQUE: 1,
          INDEX_TYPE: "BTREE",
          SEQ_IN_INDEX: 1,
        },
      ],
      foreignKeys: [
        foreignKey("set_null_fk", "label", "SET NULL", "RESTRICT"),
        foreignKey("set_default_fk", "code", "SET DEFAULT", "CASCADE"),
        foreignKey("fallback_fk", "id", "NO ACTION", "NO ACTION"),
      ],
    });
    const driver = getMigrationDriver(execution);

    const snapshot = await driver.introspect((sql, params) =>
      execution._executeRaw(sql, params)
    );

    expect(snapshot.enums).toEqual([
      {
        name: "order$lines$sta$tus$enum",
        values: ["a,b", "it's", "back\\slash"],
      },
    ]);
    expect(snapshot.tables[0]?.columns).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "id",
          type: "int unsigned",
          autoIncrement: true,
        }),
        expect.objectContaining({ name: "label", type: "VARCHAR(63)" }),
        expect.objectContaining({ name: "code", type: "CHAR(3)" }),
        expect.objectContaining({
          name: "amount",
          type: "DECIMAL(10,2)",
          decimal: { precision: 10, scale: 2 },
        }),
        expect.objectContaining({
          name: "units",
          type: "DECIMAL(8)",
          decimal: { precision: 8, scale: 0 },
        }),
        expect.objectContaining({ name: "location", type: "POINT" }),
        expect.objectContaining({ name: "target", type: "POINT SRID 4326" }),
      ])
    );
    expect(snapshot.tables[0]?.primaryKey).toEqual({
      columns: ["id", "code"],
      name: "PRIMARY",
    });
    expect(snapshot.tables[0]?.indexes).toEqual([
      {
        name: "geo_idx",
        columns: ["target"],
        unique: false,
        type: "spatial",
      },
      {
        name: "odd_idx",
        columns: ["id", "code"],
        unique: true,
        type: undefined,
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
  });
});

describe("coverage low value", () => {
  test.each([
    [-1],
    [4_294_967_296],
    ["not-a-number"],
  ])("refuses the structurally impossible catalog SRID %s", async (srid) => {
    const execution = catalogDriver({
      columns: [{ ...column("location", "point"), SRS_ID: srid }],
    });
    const driver = getMigrationDriver(execution);

    await expect(
      driver.introspect((sql, params) => execution._executeRaw(sql, params))
    ).rejects.toMatchObject({
      code: VibORMErrorCode.MIGRATION_INVALID_STATE,
      meta: { type: "invalid-catalog-srid" },
    });
  });
});
