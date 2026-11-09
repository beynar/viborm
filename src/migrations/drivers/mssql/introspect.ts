/**
 * SQL Server catalog introspection: the `sys.*` views of ONE schema, read
 * into the snapshot shape every other dialect produces.
 *
 * Every read binds the schema as `@p1`, so the bound namespace — never the
 * login's default schema — decides what is read. The snapshot spells each
 * type, default and action the way `MssqlMigrationDriver` spells the desired
 * side, so a schema created from a snapshot introspects back to it.
 */

import { readStoredDecimalDescriptor } from "@validation/primitives/decimal-codec";
import { MigrationError, VibORMErrorCode } from "../../../errors";
import { CONTROL_TABLES } from "../../control";
import type {
  ColumnDef,
  ForeignKeyDef,
  IndexDef,
  SchemaSnapshot,
  TableDef,
  UniqueConstraintDef,
} from "../../types";
import { groupBy, groupByNested, mapReferentialAction } from "../utils";

export type CatalogReader = <T>(
  sql: string,
  params?: unknown[]
) => Promise<{ rows: T[] }>;

interface ColumnRow {
  table_name: string;
  column_name: string;
  type_name: string;
  max_length: number;
  precision: number;
  scale: number;
  is_nullable: boolean;
  is_identity: boolean;
  is_computed: boolean;
  default_definition: string | null;
}

interface KeyRow {
  table_name: string;
  constraint_name: string;
  kind: "PK" | "UQ";
  column_name: string;
}

interface IndexRow {
  table_name: string;
  index_name: string;
  index_type: number;
  is_unique: boolean;
  filter_definition: string | null;
  column_name: string;
  is_descending_key: boolean;
  is_included_column: boolean;
}

interface ForeignKeyRow {
  constraint_name: string;
  table_schema: string;
  table_name: string;
  referenced_schema: string;
  referenced_table: string;
  column_name: string;
  referenced_column: string;
  delete_action: string;
  update_action: string;
}

/**
 * The user tables of `@p1`. VibORM's two control tables are left out: no
 * migration client writes them on SQL Server, so one there is not VibORM's.
 */
export const MSSQL_TABLES_QUERY =
  "SELECT t.name AS name FROM sys.tables AS t WHERE t.schema_id = SCHEMA_ID(@p1) AND t.is_ms_shipped = 0 AND t.name NOT IN (@p2, @p3) ORDER BY t.name";

/** The bound parameters of every read below. */
export const catalogParams = (schema: string): unknown[] => [
  schema,
  CONTROL_TABLES.state,
  CONTROL_TABLES.log,
];

const TABLE_SCOPE =
  "t.schema_id = SCHEMA_ID(@p1) AND t.is_ms_shipped = 0 AND t.name NOT IN (@p2, @p3)";

const COLUMNS_QUERY = `SELECT t.name AS table_name, c.name AS column_name, ty.name AS type_name, c.max_length, c.precision, c.scale, c.is_nullable, CAST(CASE WHEN ic.column_id IS NULL THEN 0 ELSE 1 END AS BIT) AS is_identity, c.is_computed, dc.definition AS default_definition
FROM sys.columns AS c
JOIN sys.tables AS t ON t.object_id = c.object_id
JOIN sys.types AS ty ON ty.user_type_id = c.user_type_id
LEFT JOIN sys.identity_columns AS ic ON ic.object_id = c.object_id AND ic.column_id = c.column_id
LEFT JOIN sys.default_constraints AS dc ON dc.object_id = c.default_object_id
WHERE ${TABLE_SCOPE}
ORDER BY t.name, c.column_id`;

const KEYS_QUERY = `SELECT t.name AS table_name, kc.name AS constraint_name, kc.type AS kind, c.name AS column_name
FROM sys.key_constraints AS kc
JOIN sys.tables AS t ON t.object_id = kc.parent_object_id
JOIN sys.index_columns AS ic ON ic.object_id = kc.parent_object_id AND ic.index_id = kc.unique_index_id
JOIN sys.columns AS c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
WHERE ${TABLE_SCOPE}
ORDER BY t.name, kc.name, ic.key_ordinal`;

// The indexes that back no key constraint (those are read above). A heap
// (`type` 0) is no index; included columns sort after the key columns.
const INDEXES_QUERY = `SELECT t.name AS table_name, i.name AS index_name, i.type AS index_type, i.is_unique, i.filter_definition, c.name AS column_name, ic.is_descending_key, ic.is_included_column
FROM sys.indexes AS i
JOIN sys.tables AS t ON t.object_id = i.object_id
JOIN sys.index_columns AS ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
JOIN sys.columns AS c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
WHERE ${TABLE_SCOPE} AND i.type > 0 AND i.is_hypothetical = 0 AND i.is_primary_key = 0 AND i.is_unique_constraint = 0
ORDER BY t.name, i.name, ic.is_included_column, ic.key_ordinal`;

// Both directions: a key INTO the schema from another one is read to be refused.
const FOREIGN_KEYS_QUERY = `SELECT fk.name AS constraint_name, SCHEMA_NAME(t.schema_id) AS table_schema, t.name AS table_name, SCHEMA_NAME(r.schema_id) AS referenced_schema, r.name AS referenced_table, c.name AS column_name, rc.name AS referenced_column, fk.delete_referential_action_desc AS delete_action, fk.update_referential_action_desc AS update_action
FROM sys.foreign_keys AS fk
JOIN sys.foreign_key_columns AS fkc ON fkc.constraint_object_id = fk.object_id
JOIN sys.tables AS t ON t.object_id = fk.parent_object_id
JOIN sys.tables AS r ON r.object_id = fk.referenced_object_id
JOIN sys.columns AS c ON c.object_id = fkc.parent_object_id AND c.column_id = fkc.parent_column_id
JOIN sys.columns AS rc ON rc.object_id = fkc.referenced_object_id AND rc.column_id = fkc.referenced_column_id
WHERE (t.schema_id = SCHEMA_ID(@p1) OR r.schema_id = SCHEMA_ID(@p1)) AND t.name NOT IN (@p2, @p3)
ORDER BY t.name, fk.name, fkc.constraint_column_id`;

const LENGTH_TYPES = new Set(["varchar", "char", "varbinary", "binary"]);
const WIDE_TYPES = new Set(["nvarchar", "nchar"]);
const SCALED_TYPES = new Set(["datetime2", "time", "datetimeoffset"]);
const INTEGER_TYPES = new Set(["tinyint", "smallint", "int", "bigint"]);
/** A literal past INT's range parses as NUMERIC, and the catalog prints `5.`. */
const TRAILING_POINT = /^-?\d+\.$/;

/** The catalog type, spelled the way the desired side spells it. */
function spellType(row: ColumnRow): string {
  const name = row.type_name.toUpperCase();
  const length = row.max_length === -1 ? "MAX" : undefined;
  if (WIDE_TYPES.has(row.type_name))
    return `${name}(${length ?? row.max_length / 2})`;
  if (LENGTH_TYPES.has(row.type_name))
    return `${name}(${length ?? row.max_length})`;
  if (row.type_name === "decimal" || row.type_name === "numeric")
    return `${name}(${row.precision},${row.scale})`;
  if (SCALED_TYPES.has(row.type_name)) return `${name}(${row.scale})`;
  return name;
}

/**
 * Whether the first `(` of `text` closes on its last character. Quotes are
 * skipped, so `('(a)')` is one literal and `(1)+(2)` is not wrapped.
 */
function wrapped(text: string): boolean {
  if (!(text.startsWith("(") && text.endsWith(")"))) return false;
  let depth = 0;
  let quoted = false;
  for (const [index, character] of [...text].entries()) {
    if (character === "'") quoted = !quoted;
    else if (!quoted && character === "(") depth++;
    else if (!quoted && character === ")") {
      depth--;
      if (depth === 0) return index === text.length - 1;
    }
  }
  return false;
}

/**
 * The default as the DDL wrote it. The catalog stores `DEFAULT 1` as `((1))`
 * and `DEFAULT N'a'` as `(N'a')`, so the outer parentheses are its own.
 */
function readDefault(row: ColumnRow): string | undefined {
  let text = row.default_definition;
  if (text === null) return;
  while (wrapped(text)) text = text.slice(1, -1);
  return INTEGER_TYPES.has(row.type_name) && TRAILING_POINT.test(text)
    ? text.slice(0, -1)
    : text;
}

function readColumn(row: ColumnRow, managed: boolean): ColumnDef {
  if (managed && row.is_computed)
    throw new MigrationError(
      `SQL Server column "${row.table_name}"."${row.column_name}" is computed; a snapshot cannot represent its expression.`,
      VibORMErrorCode.MIGRATION_INVALID_STATE,
      {
        meta: {
          table: row.table_name,
          column: row.column_name,
          feature: "computed column",
        },
      }
    );
  const decimal =
    row.type_name === "decimal" || row.type_name === "numeric"
      ? readStoredDecimalDescriptor(row.precision, row.scale, "mssql")
      : undefined;
  return {
    name: row.column_name,
    type: spellType(row),
    nullable: row.is_nullable,
    default: readDefault(row),
    autoIncrement: row.is_identity,
    decimal,
  };
}

/**
 * One index, or a refusal where the snapshot has no word for it: included
 * columns, a descending key, or anything but a B-tree (columnstore, XML,
 * spatial).
 */
function readIndex(
  tableName: string,
  name: string,
  rows: readonly IndexRow[],
  managed: boolean
): IndexDef {
  const [first] = rows;
  const representable =
    first !== undefined &&
    (first.index_type === 1 || first.index_type === 2) &&
    rows.every((row) => !(row.is_included_column || row.is_descending_key));
  if (managed && !representable)
    throw new MigrationError(
      `SQL Server index "${tableName}.${name}" has included columns, a descending key or a non-B-tree type, which an index declaration cannot represent.`,
      VibORMErrorCode.FEATURE_NOT_SUPPORTED,
      { meta: { table: tableName, indexName: name } }
    );
  return {
    name,
    columns: rows
      .filter((row) => !row.is_included_column)
      .map((row) => row.column_name),
    unique: first?.is_unique ?? false,
    type: "btree",
    where: first?.filter_definition ?? undefined,
  };
}

/** SQL Server prints `SET_NULL`; the shared reader takes `SET NULL`. */
const readAction = (action: string) =>
  mapReferentialAction(action.replace("_", " "));

function readForeignKeys(
  rows: readonly ForeignKeyRow[],
  schema: string,
  managedTables: readonly string[] | undefined
): Map<string, ForeignKeyDef[]> {
  const selected = (name: string) =>
    managedTables === undefined || managedTables.includes(name);
  const byTable = new Map<string, ForeignKeyDef[]>();
  const grouped = groupBy([...rows], (row) =>
    JSON.stringify([row.table_schema, row.table_name, row.constraint_name])
  );
  for (const columns of grouped.values()) {
    const first = columns[0]!;
    const inside = first.table_schema === schema;
    if (inside !== (first.referenced_schema === schema)) {
      if (!selected(inside ? first.table_name : first.referenced_table))
        continue;
      throw new MigrationError(
        `Foreign key "${first.constraint_name}" crosses the schema boundary: "${first.table_schema}"."${first.table_name}" references "${first.referenced_schema}"."${first.referenced_table}", and this client reads only "${schema}".`,
        VibORMErrorCode.FEATURE_NOT_SUPPORTED,
        { meta: { dialect: "mssql", constraint: first.constraint_name } }
      );
    }
    if (!inside) continue;
    const keys = byTable.get(first.table_name) ?? [];
    keys.push({
      name: first.constraint_name,
      columns: columns.map((row) => row.column_name),
      referencedTable: first.referenced_table,
      referencedColumns: columns.map((row) => row.referenced_column),
      onDelete: readAction(first.delete_action),
      onUpdate: readAction(first.update_action),
    });
    byTable.set(first.table_name, keys);
  }
  return byTable;
}

/** Reads one schema, which the caller has proven exists. */
export async function introspectMssql(
  executeRaw: CatalogReader,
  schema: string,
  managedTables?: readonly string[]
): Promise<SchemaSnapshot> {
  // One after another: a connection runs one statement at a time.
  const params = catalogParams(schema);
  const tables = await executeRaw<{ name: string }>(MSSQL_TABLES_QUERY, params);
  const columns = await executeRaw<ColumnRow>(COLUMNS_QUERY, params);
  const keys = await executeRaw<KeyRow>(KEYS_QUERY, params);
  const indexes = await executeRaw<IndexRow>(INDEXES_QUERY, params);
  const foreignKeys = await executeRaw<ForeignKeyRow>(
    FOREIGN_KEYS_QUERY,
    params
  );

  const columnsByTable = groupBy(columns.rows, (row) => row.table_name);
  const keysByTable = groupByNested(
    keys.rows,
    (row) => row.table_name,
    (row) => row.constraint_name
  );
  const indexesByTable = groupByNested(
    indexes.rows,
    (row) => row.table_name,
    (row) => row.index_name
  );
  const foreignKeysByTable = readForeignKeys(
    foreignKeys.rows,
    schema,
    managedTables
  );

  const snapshot: TableDef[] = [];
  for (const { name } of tables.rows) {
    const managed = managedTables === undefined || managedTables.includes(name);
    let primaryKey: TableDef["primaryKey"];
    const uniqueConstraints: UniqueConstraintDef[] = [];
    for (const [constraint, rows] of keysByTable.get(name) ?? []) {
      const key = {
        name: constraint,
        columns: rows.map((row) => row.column_name),
      };
      if (rows[0]?.kind === "PK") primaryKey = key;
      else uniqueConstraints.push(key);
    }
    snapshot.push({
      name,
      columns: (columnsByTable.get(name) ?? []).map((row) =>
        readColumn(row, managed)
      ),
      primaryKey,
      indexes: [...(indexesByTable.get(name) ?? [])].map(([index, rows]) =>
        readIndex(name, index, rows, managed)
      ),
      foreignKeys: foreignKeysByTable.get(name) ?? [],
      uniqueConstraints,
    });
  }
  return { tables: snapshot };
}
