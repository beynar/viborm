/**
 * Snowflake's migration driver: its catalog, read; nothing written.
 *
 * VibORM only reads Snowflake, so this driver answers `introspect()` and the
 * table inventory, and every member that would state DDL, take a lock or
 * probe rows for a push refuses (live commands are refused earlier, by
 * `admitLiveMigrationCapability`, before they send anything).
 *
 * The catalog is read from `INFORMATION_SCHEMA` (tables, columns) and from
 * `SHOW PRIMARY KEYS` / `SHOW UNIQUE KEYS` / `SHOW IMPORTED KEYS`, which list
 * the keys a table DECLARES. Snowflake enforces none of them, and they are
 * still what a warehouse's designer said the relations are: each declared
 * foreign key becomes the snapshot's foreign key, so a schema built from it
 * has the relation.
 *
 * Names are the catalog's own spelling (`ORDERS`, or `orders` where it was
 * created quoted): the runtime quotes every identifier, so a model mapped to
 * the name introspection reports reads that table.
 */

import type { AnyDriver } from "../../../drivers/driver";
import { MigrationError, VibORMErrorCode } from "../../../errors";
import type { Scalar } from "../../../schema/scalars/base";
import type { ScalarState } from "../../../schema/scalars/common";
import type {
  ColumnDef,
  ForeignKeyDef,
  ReferentialAction,
  SchemaSnapshot,
  TableDef,
} from "../../types";
import { MigrationDriver } from "../base";
import type { MigrationCapabilities } from "../types";

type ExecuteRaw = <T>(
  sql: string,
  params?: unknown[]
) => Promise<{ rows: T[] }>;

interface ColumnRow {
  TABLE_NAME: string;
  COLUMN_NAME: string;
  DATA_TYPE: string;
  IS_NULLABLE: string;
  COLUMN_DEFAULT: string | null;
  NUMERIC_PRECISION: number | null;
  NUMERIC_SCALE: number | null;
  CHARACTER_MAXIMUM_LENGTH: number | null;
  DATETIME_PRECISION: number | null;
  IS_IDENTITY: string | null;
}

interface KeyRow {
  schema_name: string;
  table_name: string;
  column_name: string;
  key_sequence: number;
  constraint_name: string;
}

interface ImportedKeyRow {
  pk_schema_name: string;
  pk_table_name: string;
  pk_column_name: string;
  fk_schema_name: string;
  fk_table_name: string;
  fk_column_name: string;
  key_sequence: number;
  fk_name: string;
  update_rule: string | null;
  delete_rule: string | null;
}

const quote = (name: string): string => `"${name.replaceAll('"', '""')}"`;

function refusal(what: string): MigrationError {
  return new MigrationError(
    `Snowflake cannot ${what} here: VibORM only reads a Snowflake warehouse.`,
    VibORMErrorCode.FEATURE_NOT_SUPPORTED,
    { meta: { dialect: "snowflake", operation: what } }
  );
}

const RULES: Readonly<Record<string, ReferentialAction>> = {
  CASCADE: "cascade",
  "SET NULL": "setNull",
  RESTRICT: "restrict",
  "NO ACTION": "noAction",
  "SET DEFAULT": "setDefault",
};

/** A column's type as the snapshot spells it: lower case, with its parameters. */
export function snowflakeColumnType(row: ColumnRow): string {
  const type = row.DATA_TYPE.toLowerCase();
  switch (type) {
    case "number":
      return `number(${row.NUMERIC_PRECISION ?? 38},${row.NUMERIC_SCALE ?? 0})`;
    case "text":
      return row.CHARACTER_MAXIMUM_LENGTH === null
        ? "varchar"
        : `varchar(${row.CHARACTER_MAXIMUM_LENGTH})`;
    case "binary":
      return row.CHARACTER_MAXIMUM_LENGTH === null
        ? "binary"
        : `binary(${row.CHARACTER_MAXIMUM_LENGTH})`;
    case "time":
    case "timestamp_ntz":
    case "timestamp_ltz":
    case "timestamp_tz":
      return row.DATETIME_PRECISION === null
        ? type
        : `${type}(${row.DATETIME_PRECISION})`;
    default:
      return type;
  }
}

/** Groups key rows by constraint, its columns in key order. */
function byConstraint<R extends { key_sequence: number }>(
  rows: readonly R[],
  key: (row: R) => string
): Map<string, R[]> {
  const groups = new Map<string, R[]>();
  for (const row of rows) {
    const name = key(row);
    const group = groups.get(name);
    if (group) group.push(row);
    else groups.set(name, [row]);
  }
  for (const group of groups.values())
    group.sort((a, b) => Number(a.key_sequence) - Number(b.key_sequence));
  return groups;
}

export class SnowflakeMigrationDriver extends MigrationDriver {
  readonly dialect = "snowflake";
  readonly driverName = "snowflake";
  readonly capabilities: MigrationCapabilities = {
    supportsNativeEnums: false,
    supportsAddEnumValueInTransaction: false,
    supportsIndexTypes: [],
    supportsNativeArrays: false,
    supportsAddForeignKeyViaAlter: true,
    // Snowflake reads its constraint names back, but they are whatever its
    // DDL said: VibORM never wrote them, so a key is recognized by its shape.
    introspectionReadsConstraintNames: false,
  };

  /** The database and schema read: the bound namespace, else the session's. */
  private async location(
    executeRaw: ExecuteRaw
  ): Promise<{ database: string; schema: string }> {
    const { rows } = await executeRaw<{
      database: string | null;
      schema: string | null;
    }>(
      'SELECT CURRENT_DATABASE() AS "database", CURRENT_SCHEMA() AS "schema"'
    );
    const database = rows[0]?.database;
    const schema = this.namespace ?? rows[0]?.schema;
    if (!(database && schema))
      throw new MigrationError(
        "Snowflake has no current database and schema to introspect: set database and schema on the driver.",
        VibORMErrorCode.MIGRATION_INVALID_STATE,
        { meta: { dialect: "snowflake" } }
      );
    return { database, schema };
  }

  async introspect(executeRaw: ExecuteRaw): Promise<SchemaSnapshot> {
    const { database, schema } = await this.location(executeRaw);
    const scope = `${quote(database)}.${quote(schema)}`;
    const tables = await executeRaw<{ TABLE_NAME: string }>(
      "SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE' ORDER BY TABLE_NAME",
      [schema]
    );
    const columns = await executeRaw<ColumnRow>(
      "SELECT TABLE_NAME, COLUMN_NAME, DATA_TYPE, IS_NULLABLE, COLUMN_DEFAULT, NUMERIC_PRECISION, NUMERIC_SCALE, CHARACTER_MAXIMUM_LENGTH, DATETIME_PRECISION, IS_IDENTITY FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME, ORDINAL_POSITION",
      [schema]
    );
    const primary = await executeRaw<KeyRow>(
      `SHOW PRIMARY KEYS IN SCHEMA ${scope}`
    );
    const unique = await executeRaw<KeyRow>(
      `SHOW UNIQUE KEYS IN SCHEMA ${scope}`
    );
    const imported = await executeRaw<ImportedKeyRow>(
      `SHOW IMPORTED KEYS IN SCHEMA ${scope}`
    );

    const byTable = new Map<string, TableDef>();
    for (const { TABLE_NAME } of tables.rows)
      byTable.set(TABLE_NAME, {
        name: TABLE_NAME,
        columns: [],
        indexes: [],
        foreignKeys: [],
        uniqueConstraints: [],
      });
    for (const row of columns.rows) {
      const table = byTable.get(row.TABLE_NAME);
      if (!table) continue;
      const column: ColumnDef = {
        name: row.COLUMN_NAME,
        type: snowflakeColumnType(row),
        nullable: row.IS_NULLABLE === "YES",
      };
      if (row.COLUMN_DEFAULT !== null) column.default = row.COLUMN_DEFAULT;
      if (
        row.IS_IDENTITY === "YES" ||
        /\.NEXTVAL$|^IDENTITY|^AUTOINCREMENT/i.test(row.COLUMN_DEFAULT ?? "")
      )
        column.autoIncrement = true;
      // A NUMBER with a scale is a fixed decimal; NUMBER(p,0) is an integer.
      if (
        row.DATA_TYPE === "NUMBER" &&
        row.NUMERIC_PRECISION !== null &&
        (row.NUMERIC_SCALE ?? 0) > 0
      )
        column.decimal = {
          precision: Number(row.NUMERIC_PRECISION),
          scale: Number(row.NUMERIC_SCALE),
        };
      table.columns.push(column);
    }
    const here = (row: { schema_name: string }) => row.schema_name === schema;
    for (const [name, keys] of byConstraint(primary.rows.filter(here), (row) =>
      `${row.table_name}\0${row.constraint_name}`
    )) {
      const table = byTable.get(keys[0]!.table_name);
      if (table)
        table.primaryKey = {
          columns: keys.map((key) => key.column_name),
          name: name.split("\0")[1],
        };
    }
    for (const [name, keys] of byConstraint(unique.rows.filter(here), (row) =>
      `${row.table_name}\0${row.constraint_name}`
    ))
      byTable.get(keys[0]!.table_name)?.uniqueConstraints.push({
        name: name.split("\0")[1]!,
        columns: keys.map((key) => key.column_name),
      });
    // A key into another schema names a table this snapshot does not hold.
    const local = imported.rows.filter(
      (row) => row.fk_schema_name === schema && row.pk_schema_name === schema
    );
    for (const [name, keys] of byConstraint(local, (row) =>
      `${row.fk_table_name}\0${row.fk_name}`
    )) {
      const first = keys[0]!;
      const foreignKey: ForeignKeyDef = {
        name: name.split("\0")[1]!,
        columns: keys.map((key) => key.fk_column_name),
        referencedTable: first.pk_table_name,
        referencedColumns: keys.map((key) => key.pk_column_name),
      };
      const onDelete = RULES[first.delete_rule ?? ""];
      const onUpdate = RULES[first.update_rule ?? ""];
      if (onDelete) foreignKey.onDelete = onDelete;
      if (onUpdate) foreignKey.onUpdate = onUpdate;
      byTable.get(first.fk_table_name)?.foreignKeys.push(foreignKey);
    }
    return { tables: [...byTable.values()] };
  }

  generateInventoryTables(): { sql: string; params: unknown[] } {
    return this.namespace === undefined
      ? {
          sql: "SELECT TABLE_NAME AS \"name\" FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = CURRENT_SCHEMA() AND TABLE_TYPE = 'BASE TABLE' ORDER BY TABLE_NAME",
          params: [],
        }
      : {
          sql: "SELECT TABLE_NAME AS \"name\" FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE' ORDER BY TABLE_NAME",
          params: [this.namespace],
        };
  }

  generateInventoryEnums(): null {
    return null;
  }

  escapeIdentifier(name: string): string {
    return quote(name);
  }

  /** The column a scalar reads from, as introspection would report it. */
  mapScalarType(_scalar: Scalar, state: ScalarState): string {
    if (state.array === true) return "array";
    switch (state.type) {
      case "string":
      case "enum":
        return "varchar";
      case "int":
      case "bigint":
        return "number(38,0)";
      case "number":
        return "float";
      case "decimal":
        return state.decimal
          ? `number(${state.decimal.precision},${state.decimal.scale})`
          : "number(38,0)";
      case "boolean":
        return "boolean";
      case "datetime":
        return "timestamp_ntz(9)";
      case "date":
        return "date";
      case "time":
        return "time(9)";
      case "json":
        return "variant";
      case "blob":
        return "binary";
      default:
        return "variant";
    }
  }

  getDefaultExpression(): undefined {
    return undefined;
  }

  getEnumColumnType(): string {
    return "varchar";
  }

  tableHoldsRows(_producer: AnyDriver, _table: string): Promise<boolean> {
    return Promise.reject(refusal("push"));
  }

  undeclaredValue(): Promise<undefined> {
    return Promise.reject(refusal("push"));
  }

  generateAcquireLock(): never {
    throw refusal("take a migration lock");
  }

  generateReleaseLock(): never {
    throw refusal("take a migration lock");
  }

  generateDropTableSQL(): never {
    throw refusal("drop a table");
  }

  generateDropEnumSQL(): never {
    throw refusal("drop an enum");
  }

  generateCreateTable(): never {
    throw refusal("create a table");
  }
  generateDropTable(): never {
    throw refusal("drop a table");
  }
  generateRenameTable(): never {
    throw refusal("rename a table");
  }
  generateAddColumn(): never {
    throw refusal("add a column");
  }
  generateDropColumn(): never {
    throw refusal("drop a column");
  }
  generateRenameColumn(): never {
    throw refusal("rename a column");
  }
  generateAlterColumn(): never {
    throw refusal("alter a column");
  }
  generateCreateIndex(): never {
    throw refusal("create an index");
  }
  generateDropIndex(): never {
    throw refusal("drop an index");
  }
  generateAddForeignKey(): never {
    throw refusal("add a foreign key");
  }
  generateDropForeignKey(): never {
    throw refusal("drop a foreign key");
  }
  generateAddUniqueConstraint(): never {
    throw refusal("add a unique constraint");
  }
  generateDropUniqueConstraint(): never {
    throw refusal("drop a unique constraint");
  }
  generateAddPrimaryKey(): never {
    throw refusal("add a primary key");
  }
  generateDropPrimaryKey(): never {
    throw refusal("drop a primary key");
  }
  generateCreateEnum(): never {
    throw refusal("create an enum");
  }
  generateDropEnum(): never {
    throw refusal("drop an enum");
  }
  generateAlterEnum(): never {
    throw refusal("alter an enum");
  }
}

export const snowflakeMigrationDriver = new SnowflakeMigrationDriver();
