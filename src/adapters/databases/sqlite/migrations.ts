/**
 * SQLite Migration Adapter
 *
 * Implements database introspection and DDL generation for SQLite.
 */

import type {
  ColumnDef,
  DiffOperation,
  ForeignKeyDef,
  IndexDef,
  PrimaryKeyDef,
  ReferentialAction,
  SchemaSnapshot,
  TableDef,
  UniqueConstraintDef,
} from "../../../migrations/types";
import type { Field } from "../../../schema/fields/base";
import type { FieldState } from "../../../schema/fields/common";
import type { MigrationAdapter } from "../../database-adapter";

// =============================================================================
// INTROSPECTION QUERY TYPES
// =============================================================================

interface SqliteTable {
  name: string;
}

interface SqliteColumn {
  cid: number;
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
}

interface SqliteIndex {
  name: string;
  unique: number;
  origin: string;
  partial: number;
}

interface SqliteIndexColumn {
  seqno: number;
  cid: number;
  name: string;
}

interface SqliteForeignKey {
  id: number;
  seq: number;
  table: string;
  from: string;
  to: string;
  on_update: string;
  on_delete: string;
  match: string;
}

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

function mapReferentialAction(rule: string): ReferentialAction {
  switch (rule.toUpperCase()) {
    case "CASCADE":
      return "cascade";
    case "SET NULL":
      return "setNull";
    case "RESTRICT":
      return "restrict";
    case "SET DEFAULT":
      return "setDefault";
    case "NO ACTION":
    default:
      return "noAction";
  }
}

function escapeIdentifier(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function escapeValue(value: unknown): string {
  if (value === null) return "NULL";
  if (typeof value === "number") return String(value);
  if (typeof value === "boolean") return value ? "1" : "0";
  if (typeof value === "string") return `'${value.replace(/'/g, "''")}'`;
  return String(value);
}

// =============================================================================
// INTROSPECTION
// =============================================================================

async function introspect(
  executeRaw: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>
): Promise<SchemaSnapshot> {
  // Get all tables
  const tablesResult = await executeRaw<SqliteTable>(`
    SELECT name
    FROM sqlite_master
    WHERE type = 'table'
      AND name NOT LIKE 'sqlite_%'
    ORDER BY name
  `);

  const tables: TableDef[] = [];

  for (const tableRow of tablesResult.rows) {
    const tableName = tableRow.name;

    // Get columns using PRAGMA
    const columnsResult = await executeRaw<SqliteColumn>(
      `PRAGMA table_info(${escapeIdentifier(tableName)})`
    );

    // Get indexes
    const indexesResult = await executeRaw<SqliteIndex>(
      `PRAGMA index_list(${escapeIdentifier(tableName)})`
    );

    // Get foreign keys
    const fksResult = await executeRaw<SqliteForeignKey>(
      `PRAGMA foreign_key_list(${escapeIdentifier(tableName)})`
    );

    // Build columns
    const columns: ColumnDef[] = [];
    const pkColumns: string[] = [];

    for (const col of columnsResult.rows) {
      columns.push({
        name: col.name,
        type: col.type || "TEXT",
        nullable: col.notnull === 0,
        default: col.dflt_value ?? undefined,
        autoIncrement:
          col.pk === 1 && col.type.toUpperCase() === "INTEGER" ? true : false,
      });

      if (col.pk > 0) {
        pkColumns.push(col.name);
      }
    }

    // Build primary key
    let primaryKey: PrimaryKeyDef | undefined;
    if (pkColumns.length > 0) {
      primaryKey = {
        name: `${tableName}_pkey`,
        columns: pkColumns,
      };
    }

    // Build indexes
    const indexes: IndexDef[] = [];
    const uniqueConstraints: UniqueConstraintDef[] = [];

    for (const idx of indexesResult.rows) {
      // Skip auto-created indexes for primary keys and unique constraints
      if (idx.origin === "pk") continue;

      // Get index columns
      const indexColsResult = await executeRaw<SqliteIndexColumn>(
        `PRAGMA index_info(${escapeIdentifier(idx.name)})`
      );

      const indexColumns = indexColsResult.rows
        .sort((a, b) => a.seqno - b.seqno)
        .map((c) => c.name);

      if (idx.unique && idx.origin === "u") {
        // This is a unique constraint
        uniqueConstraints.push({
          name: idx.name,
          columns: indexColumns,
        });
      } else {
        indexes.push({
          name: idx.name,
          columns: indexColumns,
          unique: idx.unique === 1,
        });
      }
    }

    // Build foreign keys - group by id (constraint)
    const fkMap = new Map<number, SqliteForeignKey[]>();
    for (const fk of fksResult.rows) {
      const existing = fkMap.get(fk.id) || [];
      existing.push(fk);
      fkMap.set(fk.id, existing);
    }

    const foreignKeys: ForeignKeyDef[] = [];
    for (const [id, fkCols] of fkMap) {
      const sorted = fkCols.sort((a, b) => a.seq - b.seq);
      const first = sorted[0]!;

      foreignKeys.push({
        name: `${tableName}_fk_${id}`,
        columns: sorted.map((f) => f.from),
        referencedTable: first.table,
        referencedColumns: sorted.map((f) => f.to),
        onDelete: mapReferentialAction(first.on_delete),
        onUpdate: mapReferentialAction(first.on_update),
      });
    }

    tables.push({
      name: tableName,
      columns,
      primaryKey,
      indexes,
      foreignKeys,
      uniqueConstraints,
    });
  }

  // SQLite doesn't have native enum types
  return { tables, enums: [] };
}

// =============================================================================
// DDL GENERATION
// =============================================================================

function generateDDL(operation: DiffOperation): string {
  switch (operation.type) {
    case "createTable":
      return generateCreateTable(operation.table);
    case "dropTable":
      return `DROP TABLE ${escapeIdentifier(operation.tableName)}`;
    case "renameTable":
      return `ALTER TABLE ${escapeIdentifier(operation.from)} RENAME TO ${escapeIdentifier(operation.to)}`;
    case "addColumn":
      return generateAddColumn(operation.tableName, operation.column);
    case "dropColumn":
      return `ALTER TABLE ${escapeIdentifier(operation.tableName)} DROP COLUMN ${escapeIdentifier(operation.columnName)}`;
    case "renameColumn":
      return `ALTER TABLE ${escapeIdentifier(operation.tableName)} RENAME COLUMN ${escapeIdentifier(operation.from)} TO ${escapeIdentifier(operation.to)}`;
    case "alterColumn":
      // SQLite has limited ALTER COLUMN support - often requires table recreation
      throw new Error(
        `SQLite does not support ALTER COLUMN directly. Table recreation required for: ${operation.tableName}.${operation.columnName}`
      );
    case "createIndex":
      return generateCreateIndex(operation.tableName, operation.index);
    case "dropIndex":
      return `DROP INDEX ${escapeIdentifier(operation.indexName)}`;
    case "addForeignKey":
      // SQLite doesn't support adding foreign keys after table creation
      throw new Error(
        "SQLite does not support adding foreign keys to existing tables. Table recreation required."
      );
    case "dropForeignKey":
      // SQLite doesn't support dropping foreign keys
      throw new Error(
        "SQLite does not support dropping foreign keys. Table recreation required."
      );
    case "addUniqueConstraint":
      return `CREATE UNIQUE INDEX ${escapeIdentifier(operation.constraint.name)} ON ${escapeIdentifier(operation.tableName)} (${operation.constraint.columns.map(escapeIdentifier).join(", ")})`;
    case "dropUniqueConstraint":
      return `DROP INDEX ${escapeIdentifier(operation.constraintName)}`;
    case "addPrimaryKey":
      // SQLite doesn't support adding primary keys after table creation
      throw new Error(
        "SQLite does not support adding primary keys to existing tables. Table recreation required."
      );
    case "dropPrimaryKey":
      // SQLite doesn't support dropping primary keys
      throw new Error(
        "SQLite does not support dropping primary keys. Table recreation required."
      );
    case "createEnum":
    case "dropEnum":
    case "alterEnum":
      // SQLite doesn't have native enums - use CHECK constraints instead
      return "-- SQLite does not support native enums";
    default:
      throw new Error(`Unknown operation type: ${(operation as any).type}`);
  }
}

function generateCreateTable(table: TableDef): string {
  const parts: string[] = [];

  // Columns
  for (const col of table.columns) {
    const colDef = [escapeIdentifier(col.name), col.type];

    if (!col.nullable) colDef.push("NOT NULL");
    if (col.default !== undefined) {
      colDef.push(`DEFAULT ${col.default}`);
    }

    parts.push(colDef.join(" "));
  }

  // Primary key
  if (table.primaryKey) {
    // Check if it's a single INTEGER PRIMARY KEY (SQLite autoincrement)
    if (
      table.primaryKey.columns.length === 1 &&
      table.columns.find(
        (c) =>
          c.name === table.primaryKey!.columns[0] &&
          c.type.toUpperCase() === "INTEGER" &&
          c.autoIncrement
      )
    ) {
      // Already handled in column definition
    } else {
      parts.push(
        `PRIMARY KEY (${table.primaryKey.columns.map(escapeIdentifier).join(", ")})`
      );
    }
  }

  // Unique constraints (inline)
  for (const uq of table.uniqueConstraints || []) {
    parts.push(
      `CONSTRAINT ${escapeIdentifier(uq.name)} UNIQUE (${uq.columns.map(escapeIdentifier).join(", ")})`
    );
  }

  // Foreign keys
  for (const fk of table.foreignKeys) {
    const fkDef = [
      `CONSTRAINT ${escapeIdentifier(fk.name)}`,
      `FOREIGN KEY (${fk.columns.map(escapeIdentifier).join(", ")})`,
      `REFERENCES ${escapeIdentifier(fk.referencedTable)} (${fk.referencedColumns.map(escapeIdentifier).join(", ")})`,
    ];

    if (fk.onDelete && fk.onDelete !== "noAction") {
      fkDef.push(
        `ON DELETE ${fk.onDelete.toUpperCase().replace("SETNULL", "SET NULL").replace("SETDEFAULT", "SET DEFAULT")}`
      );
    }
    if (fk.onUpdate && fk.onUpdate !== "noAction") {
      fkDef.push(
        `ON UPDATE ${fk.onUpdate.toUpperCase().replace("SETNULL", "SET NULL").replace("SETDEFAULT", "SET DEFAULT")}`
      );
    }

    parts.push(fkDef.join(" "));
  }

  let ddl = `CREATE TABLE ${escapeIdentifier(table.name)} (\n  ${parts.join(",\n  ")}\n)`;

  // Create indexes separately
  const indexDDLs: string[] = [];
  for (const idx of table.indexes) {
    indexDDLs.push(generateCreateIndex(table.name, idx));
  }

  if (indexDDLs.length > 0) {
    ddl += ";\n" + indexDDLs.join(";\n");
  }

  return ddl;
}

function generateAddColumn(tableName: string, column: ColumnDef): string {
  const parts = [escapeIdentifier(column.name), column.type];

  if (!column.nullable) parts.push("NOT NULL");
  if (column.default !== undefined) {
    parts.push(`DEFAULT ${column.default}`);
  }

  return `ALTER TABLE ${escapeIdentifier(tableName)} ADD COLUMN ${parts.join(" ")}`;
}

function generateCreateIndex(tableName: string, index: IndexDef): string {
  const unique = index.unique ? "UNIQUE " : "";
  return `CREATE ${unique}INDEX ${escapeIdentifier(index.name)} ON ${escapeIdentifier(tableName)} (${index.columns.map(escapeIdentifier).join(", ")})`;
}

// =============================================================================
// FIELD TYPE MAPPING
// =============================================================================

/**
 * Maps VibORM field types to SQLite column types.
 * SQLite has dynamic typing with only 5 storage classes: NULL, INTEGER, REAL, TEXT, BLOB.
 * Date/time values are stored as TEXT (ISO 8601) or INTEGER (Unix timestamp).
 * Arrays, vectors, and points are stored as JSON.
 */
function mapFieldType(field: Field, fieldState: FieldState): string {
  const nativeType = field["~"].nativeType;

  // If a native type is specified and it's for SQLite, use it
  if (nativeType && nativeType.db === "sqlite") {
    return nativeType.type;
  }

  // SQLite doesn't support native arrays - use JSON for array types
  if (fieldState.array) {
    return "JSON";
  }

  switch (fieldState.type) {
    case "string":
    case "enum": // Enum values are text, CHECK constraint handles validation
      return "TEXT";
    case "json":
    case "vector": // Store vectors as JSON arrays
    case "point": // Store points as JSON {x, y}
      return "JSON";
    case "int":
    case "bigint":
    case "boolean":
      return "INTEGER";
    case "float":
    case "decimal":
      return "REAL";
    case "datetime":
    case "date":
    case "time":
      // SQLite stores dates as TEXT (ISO 8601 format)
      // withTimezone doesn't affect storage, but affects how we format/parse
      return "TEXT";
    case "blob":
      return "BLOB";
    default:
      return "TEXT";
  }
}

/**
 * Converts a VibORM default value to a SQLite default expression.
 * Note: uuid, now, ulid, nanoid, cuid are always generated at the ORM level.
 */
function getDefaultExpression(fieldState: FieldState): string | undefined {
  // Handle auto-generate types - all generated at ORM level for consistency
  if (fieldState.autoGenerate) {
    switch (fieldState.autoGenerate) {
      case "increment":
        // SQLite uses INTEGER PRIMARY KEY for auto-increment
        return undefined;
      case "uuid":
      case "now":
      case "updatedAt":
      case "ulid":
      case "nanoid":
      case "cuid":
        // All generated at ORM level for cross-database consistency
        return undefined;
      default:
        return undefined;
    }
  }

  // Handle explicit default value
  if (fieldState.hasDefault && fieldState.default !== undefined) {
    const defaultVal = fieldState.default;

    // Skip function defaults (generated at runtime)
    if (typeof defaultVal === "function") {
      return undefined;
    }

    // Handle null default
    if (defaultVal === null) {
      return "NULL";
    }

    // Handle primitive defaults
    if (typeof defaultVal === "string") {
      return `'${defaultVal.replace(/'/g, "''")}'`;
    }
    if (typeof defaultVal === "number") {
      return String(defaultVal);
    }
    if (typeof defaultVal === "boolean") {
      // SQLite uses 1/0 for booleans
      return defaultVal ? "1" : "0";
    }
  }

  return undefined;
}

/**
 * SQLite doesn't support native enum types.
 * We use TEXT with CHECK constraint for validation.
 * The CHECK constraint is generated separately in DDL.
 */
function getEnumColumnType(
  _tableName: string,
  _columnName: string,
  _values: string[]
): string {
  // Returns TEXT - the CHECK constraint is added during DDL generation
  // e.g., CHECK (status IN ('active', 'inactive', 'pending'))
  return "TEXT";
}

// =============================================================================
// EXPORT
// =============================================================================

export const sqliteMigrations: MigrationAdapter = {
  introspect,
  generateDDL,
  mapFieldType,
  getDefaultExpression,
  supportsNativeEnums: false,
  getEnumColumnType,
};
