/**
 * MySQL Schema Introspection
 *
 * Reads the current database schema from MySQL's information_schema,
 * returning a normalized SchemaSnapshot.
 */

import type {
  ColumnDef,
  EnumDef,
  ForeignKeyDef,
  IndexDef,
  PrimaryKeyDef,
  ReferentialAction,
  SchemaSnapshot,
  TableDef,
  UniqueConstraintDef,
} from "../../types";
import { groupBy, groupByNested } from "../utils";
import type {
  MySQLColumn,
  MySQLForeignKey,
  MySQLIndex,
  MySQLPrimaryKey,
  MySQLTable,
  MySQLUniqueConstraint,
} from "./types";

// =============================================================================
// SQL QUERIES
// =============================================================================

// Note: DATABASE() returns current database name in MySQL
const TABLES_QUERY = `
SELECT TABLE_NAME
FROM information_schema.TABLES
WHERE TABLE_SCHEMA = DATABASE()
  AND TABLE_TYPE = 'BASE TABLE'
ORDER BY TABLE_NAME
`;

const COLUMNS_QUERY = `
SELECT
  TABLE_NAME,
  COLUMN_NAME,
  DATA_TYPE,
  COLUMN_TYPE,
  IS_NULLABLE,
  COLUMN_DEFAULT,
  CHARACTER_MAXIMUM_LENGTH,
  NUMERIC_PRECISION,
  NUMERIC_SCALE,
  EXTRA
FROM information_schema.COLUMNS
WHERE TABLE_SCHEMA = DATABASE()
ORDER BY TABLE_NAME, ORDINAL_POSITION
`;

const PRIMARY_KEYS_QUERY = `
SELECT
  tc.TABLE_NAME,
  tc.CONSTRAINT_NAME,
  kcu.COLUMN_NAME,
  kcu.ORDINAL_POSITION
FROM information_schema.TABLE_CONSTRAINTS tc
JOIN information_schema.KEY_COLUMN_USAGE kcu
  ON tc.CONSTRAINT_NAME = kcu.CONSTRAINT_NAME
  AND tc.TABLE_SCHEMA = kcu.TABLE_SCHEMA
  AND tc.TABLE_NAME = kcu.TABLE_NAME
WHERE tc.TABLE_SCHEMA = DATABASE()
  AND tc.CONSTRAINT_TYPE = 'PRIMARY KEY'
ORDER BY tc.TABLE_NAME, kcu.ORDINAL_POSITION
`;

const INDEXES_QUERY = `
SELECT
  TABLE_NAME,
  INDEX_NAME,
  COLUMN_NAME,
  NON_UNIQUE,
  INDEX_TYPE,
  SEQ_IN_INDEX
FROM information_schema.STATISTICS
WHERE TABLE_SCHEMA = DATABASE()
  AND INDEX_NAME != 'PRIMARY'
ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX
`;

const FOREIGN_KEYS_QUERY = `
SELECT
  tc.TABLE_NAME,
  tc.CONSTRAINT_NAME,
  kcu.COLUMN_NAME,
  kcu.REFERENCED_TABLE_NAME,
  kcu.REFERENCED_COLUMN_NAME,
  rc.DELETE_RULE,
  rc.UPDATE_RULE,
  kcu.ORDINAL_POSITION
FROM information_schema.TABLE_CONSTRAINTS tc
JOIN information_schema.KEY_COLUMN_USAGE kcu
  ON tc.CONSTRAINT_NAME = kcu.CONSTRAINT_NAME
  AND tc.TABLE_SCHEMA = kcu.TABLE_SCHEMA
  AND tc.TABLE_NAME = kcu.TABLE_NAME
JOIN information_schema.REFERENTIAL_CONSTRAINTS rc
  ON rc.CONSTRAINT_NAME = tc.CONSTRAINT_NAME
  AND rc.CONSTRAINT_SCHEMA = tc.TABLE_SCHEMA
WHERE tc.TABLE_SCHEMA = DATABASE()
  AND tc.CONSTRAINT_TYPE = 'FOREIGN KEY'
ORDER BY tc.TABLE_NAME, tc.CONSTRAINT_NAME, kcu.ORDINAL_POSITION
`;

const UNIQUE_CONSTRAINTS_QUERY = `
SELECT
  tc.TABLE_NAME,
  tc.CONSTRAINT_NAME,
  kcu.COLUMN_NAME,
  kcu.ORDINAL_POSITION
FROM information_schema.TABLE_CONSTRAINTS tc
JOIN information_schema.KEY_COLUMN_USAGE kcu
  ON tc.CONSTRAINT_NAME = kcu.CONSTRAINT_NAME
  AND tc.TABLE_SCHEMA = kcu.TABLE_SCHEMA
  AND tc.TABLE_NAME = kcu.TABLE_NAME
WHERE tc.TABLE_SCHEMA = DATABASE()
  AND tc.CONSTRAINT_TYPE = 'UNIQUE'
ORDER BY tc.TABLE_NAME, tc.CONSTRAINT_NAME, kcu.ORDINAL_POSITION
`;

// =============================================================================
// CONSTANTS
// =============================================================================

const ENUM_VALUES_REGEX = /enum\((.+)\)/i;

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
    default:
      return "noAction";
  }
}

function formatColumnType(col: MySQLColumn): string {
  // For ENUM types, return the full COLUMN_TYPE which includes values
  if (col.DATA_TYPE === "enum") {
    return col.COLUMN_TYPE; // e.g., "enum('active','inactive')"
  }

  // Handle precision types
  if (col.DATA_TYPE === "varchar" && col.CHARACTER_MAXIMUM_LENGTH) {
    return `VARCHAR(${col.CHARACTER_MAXIMUM_LENGTH})`;
  }
  if (col.DATA_TYPE === "char" && col.CHARACTER_MAXIMUM_LENGTH) {
    return `CHAR(${col.CHARACTER_MAXIMUM_LENGTH})`;
  }
  if (col.DATA_TYPE === "decimal" && col.NUMERIC_PRECISION) {
    if (col.NUMERIC_SCALE) {
      return `DECIMAL(${col.NUMERIC_PRECISION},${col.NUMERIC_SCALE})`;
    }
    return `DECIMAL(${col.NUMERIC_PRECISION})`;
  }

  return col.DATA_TYPE.toUpperCase();
}

function isAutoIncrement(extra: string): boolean {
  return extra.toLowerCase().includes("auto_increment");
}

// =============================================================================
// INTROSPECTION
// =============================================================================

export async function introspect(
  executeRaw: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>
): Promise<SchemaSnapshot> {
  // Execute all queries in parallel
  const [
    tablesResult,
    columnsResult,
    primaryKeysResult,
    indexesResult,
    foreignKeysResult,
    uniqueConstraintsResult,
  ] = await Promise.all([
    executeRaw<MySQLTable>(TABLES_QUERY),
    executeRaw<MySQLColumn>(COLUMNS_QUERY),
    executeRaw<MySQLPrimaryKey>(PRIMARY_KEYS_QUERY),
    executeRaw<MySQLIndex>(INDEXES_QUERY),
    executeRaw<MySQLForeignKey>(FOREIGN_KEYS_QUERY),
    executeRaw<MySQLUniqueConstraint>(UNIQUE_CONSTRAINTS_QUERY),
  ]);

  // Group results
  const columnsByTable = groupBy(columnsResult.rows, (col) => col.TABLE_NAME);
  const pkByTable = groupBy(primaryKeysResult.rows, (pk) => pk.TABLE_NAME);
  const indexesByTable = groupByNested(
    indexesResult.rows,
    (idx) => idx.TABLE_NAME,
    (idx) => idx.INDEX_NAME
  );
  const fkByTable = groupByNested(
    foreignKeysResult.rows,
    (fk) => fk.TABLE_NAME,
    (fk) => fk.CONSTRAINT_NAME
  );
  const uniqueByTable = groupByNested(
    uniqueConstraintsResult.rows,
    (uq) => uq.TABLE_NAME,
    (uq) => uq.CONSTRAINT_NAME
  );

  // Track enum definitions found in columns
  const enumDefs: EnumDef[] = [];
  const seenEnums = new Set<string>();

  // Build tables
  const tables: TableDef[] = [];

  for (const table of tablesResult.rows) {
    const tableName = table.TABLE_NAME;

    // Build columns
    const columns: ColumnDef[] = [];
    for (const col of columnsByTable.get(tableName) || []) {
      // Extract enum values if this is an enum column
      if (col.DATA_TYPE === "enum") {
        const enumName = `${tableName}_${col.COLUMN_NAME}_enum`;
        if (!seenEnums.has(enumName)) {
          // Parse enum values from COLUMN_TYPE: enum('val1','val2')
          const match = col.COLUMN_TYPE.match(ENUM_VALUES_REGEX);
          if (match?.[1]) {
            const values = match[1]
              .split(",")
              .map((v) => v.trim().replace(/^'|'$/g, ""));
            enumDefs.push({ name: enumName, values });
            seenEnums.add(enumName);
          }
        }
      }

      columns.push({
        name: col.COLUMN_NAME,
        type: formatColumnType(col),
        nullable: col.IS_NULLABLE === "YES",
        default: col.COLUMN_DEFAULT ?? undefined,
        autoIncrement: isAutoIncrement(col.EXTRA),
      });
    }

    // Build primary key
    let primaryKey: PrimaryKeyDef | undefined;
    const pkCols = pkByTable.get(tableName);
    if (pkCols && pkCols.length > 0) {
      pkCols.sort((a, b) => a.ORDINAL_POSITION - b.ORDINAL_POSITION);
      const firstPkCol = pkCols[0];
      if (firstPkCol) {
        primaryKey = {
          columns: pkCols.map((pk) => pk.COLUMN_NAME),
          name: firstPkCol.CONSTRAINT_NAME,
        };
      }
    }

    // Build indexes
    const indexes: IndexDef[] = [];
    const tableIndexes = indexesByTable.get(tableName);
    if (tableIndexes) {
      for (const [indexName, indexCols] of tableIndexes) {
        indexCols.sort((a, b) => a.SEQ_IN_INDEX - b.SEQ_IN_INDEX);
        const firstCol = indexCols[0];
        if (firstCol) {
          const indexType = firstCol.INDEX_TYPE.toLowerCase();
          indexes.push({
            name: indexName,
            columns: indexCols.map((idx) => idx.COLUMN_NAME),
            unique: firstCol.NON_UNIQUE === 0,
            // MySQL uses BTREE, HASH, FULLTEXT, SPATIAL - normalize to supported types
            type:
              indexType === "btree" || indexType === "hash"
                ? indexType
                : undefined,
          });
        }
      }
    }

    // Build foreign keys
    const foreignKeys: ForeignKeyDef[] = [];
    const tableFks = fkByTable.get(tableName);
    if (tableFks) {
      for (const [constraintName, fkCols] of tableFks) {
        fkCols.sort((a, b) => a.ORDINAL_POSITION - b.ORDINAL_POSITION);
        const firstFk = fkCols[0];
        if (firstFk) {
          foreignKeys.push({
            name: constraintName,
            columns: fkCols.map((fk) => fk.COLUMN_NAME),
            referencedTable: firstFk.REFERENCED_TABLE_NAME,
            referencedColumns: fkCols.map((fk) => fk.REFERENCED_COLUMN_NAME),
            onDelete: mapReferentialAction(firstFk.DELETE_RULE),
            onUpdate: mapReferentialAction(firstFk.UPDATE_RULE),
          });
        }
      }
    }

    // Build unique constraints
    const uniqueConstraints: UniqueConstraintDef[] = [];
    const tableUniques = uniqueByTable.get(tableName);
    if (tableUniques) {
      for (const [constraintName, uqCols] of tableUniques) {
        uqCols.sort((a, b) => a.ORDINAL_POSITION - b.ORDINAL_POSITION);
        uniqueConstraints.push({
          name: constraintName,
          columns: uqCols.map((uq) => uq.COLUMN_NAME),
        });
      }
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

  // MySQL doesn't have standalone enum types, but we track them for compatibility
  return {
    tables,
    enums: enumDefs.length > 0 ? enumDefs : undefined,
  };
}
