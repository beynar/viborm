/**
 * PostgreSQL Schema Introspection
 *
 * Reads the current database schema from PostgreSQL's information_schema
 * and system catalogs, returning a normalized SchemaSnapshot.
 */

import type {
  EnumDef,
  ForeignKeyDef,
  IndexDef,
  PrimaryKeyDef,
  ReferentialAction,
  SchemaSnapshot,
  TableDef,
  UniqueConstraintDef,
} from "../../types";
import type {
  PgColumn,
  PgEnum,
  PgForeignKey,
  PgIndex,
  PgPrimaryKey,
  PgTable,
  PgUniqueConstraint,
} from "./types";

// Regex for cleaning up PostgreSQL type casting (e.g., 'value'::text -> 'value')
const TYPE_CAST_REGEX = /::\w+(\[\])?$/;

// =============================================================================
// SQL QUERIES
// =============================================================================

const TABLES_QUERY = `
SELECT table_name
FROM information_schema.tables
WHERE table_schema = 'public'
  AND table_type = 'BASE TABLE'
ORDER BY table_name;
`;

const COLUMNS_QUERY = `
SELECT
  c.table_name,
  c.column_name,
  c.data_type,
  c.udt_name,
  c.is_nullable,
  c.column_default,
  c.character_maximum_length,
  c.numeric_precision,
  c.numeric_scale
FROM information_schema.columns c
JOIN information_schema.tables t
  ON c.table_name = t.table_name
  AND c.table_schema = t.table_schema
WHERE c.table_schema = 'public'
  AND t.table_type = 'BASE TABLE'
ORDER BY c.table_name, c.ordinal_position;
`;

const PRIMARY_KEYS_QUERY = `
SELECT
  tc.table_name,
  tc.constraint_name,
  kcu.column_name,
  kcu.ordinal_position
FROM information_schema.table_constraints tc
JOIN information_schema.key_column_usage kcu
  ON tc.constraint_name = kcu.constraint_name
  AND tc.table_schema = kcu.table_schema
WHERE tc.table_schema = 'public'
  AND tc.constraint_type = 'PRIMARY KEY'
ORDER BY tc.table_name, kcu.ordinal_position;
`;

const INDEXES_QUERY = `
SELECT
  t.relname AS table_name,
  i.relname AS index_name,
  a.attname AS column_name,
  ix.indisunique AS is_unique,
  am.amname AS index_type,
  pg_get_expr(ix.indpred, ix.indrelid) AS filter_condition,
  array_position(ix.indkey, a.attnum) AS ordinal_position
FROM pg_index ix
JOIN pg_class t ON t.oid = ix.indrelid
JOIN pg_class i ON i.oid = ix.indexrelid
JOIN pg_am am ON am.oid = i.relam
JOIN pg_namespace n ON n.oid = t.relnamespace
JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY(ix.indkey)
WHERE n.nspname = 'public'
  AND NOT ix.indisprimary
  AND t.relkind = 'r'
ORDER BY t.relname, i.relname, array_position(ix.indkey, a.attnum);
`;

const FOREIGN_KEYS_QUERY = `
SELECT
  tc.table_name,
  tc.constraint_name,
  kcu.column_name,
  ccu.table_name AS foreign_table_name,
  ccu.column_name AS foreign_column_name,
  rc.delete_rule,
  rc.update_rule,
  kcu.ordinal_position
FROM information_schema.table_constraints tc
JOIN information_schema.key_column_usage kcu
  ON tc.constraint_name = kcu.constraint_name
  AND tc.table_schema = kcu.table_schema
JOIN information_schema.constraint_column_usage ccu
  ON ccu.constraint_name = tc.constraint_name
  AND ccu.table_schema = tc.table_schema
JOIN information_schema.referential_constraints rc
  ON rc.constraint_name = tc.constraint_name
  AND rc.constraint_schema = tc.table_schema
WHERE tc.table_schema = 'public'
  AND tc.constraint_type = 'FOREIGN KEY'
ORDER BY tc.table_name, tc.constraint_name, kcu.ordinal_position;
`;

const UNIQUE_CONSTRAINTS_QUERY = `
SELECT
  tc.table_name,
  tc.constraint_name,
  kcu.column_name,
  kcu.ordinal_position
FROM information_schema.table_constraints tc
JOIN information_schema.key_column_usage kcu
  ON tc.constraint_name = kcu.constraint_name
  AND tc.table_schema = kcu.table_schema
WHERE tc.table_schema = 'public'
  AND tc.constraint_type = 'UNIQUE'
ORDER BY tc.table_name, tc.constraint_name, kcu.ordinal_position;
`;

const ENUMS_QUERY = `
SELECT
  t.typname AS enum_name,
  e.enumlabel AS enum_value,
  e.enumsortorder AS sort_order
FROM pg_type t
JOIN pg_enum e ON t.oid = e.enumtypid
JOIN pg_namespace n ON n.oid = t.typnamespace
WHERE n.nspname = 'public'
ORDER BY t.typname, e.enumsortorder;
`;

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

/**
 * Groups an array of items by a key extracted via keyFn.
 */
function groupBy<T>(items: T[], keyFn: (item: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const item of items) {
    const key = keyFn(item);
    const existing = map.get(key);
    if (existing) {
      existing.push(item);
    } else {
      map.set(key, [item]);
    }
  }
  return map;
}

/**
 * Groups items by primary key, then by secondary key.
 * Used for indexes, foreign keys, and unique constraints that have
 * multiple rows per constraint (one per column).
 */
function groupByNested<T>(
  items: T[],
  primaryKeyFn: (item: T) => string,
  secondaryKeyFn: (item: T) => string
): Map<string, Map<string, T[]>> {
  const map = new Map<string, Map<string, T[]>>();
  for (const item of items) {
    const pk = primaryKeyFn(item);
    const sk = secondaryKeyFn(item);

    let secondary = map.get(pk);
    if (!secondary) {
      secondary = new Map();
      map.set(pk, secondary);
    }

    const existing = secondary.get(sk);
    if (existing) {
      existing.push(item);
    } else {
      secondary.set(sk, [item]);
    }
  }
  return map;
}

function mapReferentialAction(rule: string): ReferentialAction {
  switch (rule) {
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

function formatColumnType(col: PgColumn): string {
  const baseType = col.udt_name.startsWith("_")
    ? `${col.udt_name.slice(1)}[]`
    : col.udt_name;

  // Handle special types with precision
  if (col.data_type === "character varying" && col.character_maximum_length) {
    return `varchar(${col.character_maximum_length})`;
  }
  if (col.data_type === "character" && col.character_maximum_length) {
    return `char(${col.character_maximum_length})`;
  }
  if (col.data_type === "numeric" && col.numeric_precision) {
    if (col.numeric_scale) {
      return `numeric(${col.numeric_precision},${col.numeric_scale})`;
    }
    return `numeric(${col.numeric_precision})`;
  }

  return baseType;
}

function isAutoIncrement(columnDefault: string | null): boolean {
  if (!columnDefault) return false;
  return (
    columnDefault.includes("nextval(") ||
    columnDefault.includes("_seq'::regclass)")
  );
}

function cleanDefault(columnDefault: string | null): string | undefined {
  if (!columnDefault) return undefined;

  // Skip auto-increment defaults
  if (isAutoIncrement(columnDefault)) return undefined;

  // Clean up type casting (e.g., 'value'::text -> 'value')
  const cleaned = columnDefault.replace(TYPE_CAST_REGEX, "").trim();
  return cleaned;
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
    enumsResult,
  ] = await Promise.all([
    executeRaw<PgTable>(TABLES_QUERY),
    executeRaw<PgColumn>(COLUMNS_QUERY),
    executeRaw<PgPrimaryKey>(PRIMARY_KEYS_QUERY),
    executeRaw<PgIndex>(INDEXES_QUERY),
    executeRaw<PgForeignKey>(FOREIGN_KEYS_QUERY),
    executeRaw<PgUniqueConstraint>(UNIQUE_CONSTRAINTS_QUERY),
    executeRaw<PgEnum>(ENUMS_QUERY),
  ]);

  // Group results using helper functions
  const columnsByTable = groupBy(columnsResult.rows, (col) => col.table_name);
  const pkByTable = groupBy(primaryKeysResult.rows, (pk) => pk.table_name);
  const indexesByTable = groupByNested(
    indexesResult.rows,
    (idx) => idx.table_name,
    (idx) => idx.index_name
  );
  const fkByTable = groupByNested(
    foreignKeysResult.rows,
    (fk) => fk.table_name,
    (fk) => fk.constraint_name
  );
  const uniqueByTable = groupByNested(
    uniqueConstraintsResult.rows,
    (uq) => uq.table_name,
    (uq) => uq.constraint_name
  );
  const enumsByName = groupBy(enumsResult.rows, (e) => e.enum_name);

  // Build tables
  const tables: TableDef[] = [];

  for (const table of tablesResult.rows) {
    const tableName = table.table_name;

    // Build columns
    const columns = (columnsByTable.get(tableName) || []).map((col) => ({
      name: col.column_name,
      type: formatColumnType(col),
      nullable: col.is_nullable === "YES",
      default: cleanDefault(col.column_default),
      autoIncrement: isAutoIncrement(col.column_default),
    }));

    // Build primary key
    let primaryKey: PrimaryKeyDef | undefined;
    const pkCols = pkByTable.get(tableName);
    if (pkCols && pkCols.length > 0) {
      pkCols.sort((a, b) => a.ordinal_position - b.ordinal_position);
      const firstPk = pkCols[0];
      if (firstPk) {
        primaryKey = {
          columns: pkCols.map((pk) => pk.column_name),
          name: firstPk.constraint_name,
        };
      }
    }

    // Build indexes
    const indexes: IndexDef[] = [];
    const tableIndexes = indexesByTable.get(tableName);
    if (tableIndexes) {
      for (const [indexName, indexCols] of tableIndexes) {
        indexCols.sort((a, b) => a.ordinal_position - b.ordinal_position);
        const firstCol = indexCols[0];
        if (firstCol) {
          indexes.push({
            name: indexName,
            columns: indexCols.map((idx) => idx.column_name),
            unique: firstCol.is_unique,
            type: firstCol.index_type as "btree" | "hash" | "gin" | "gist",
            where: firstCol.filter_condition || undefined,
          });
        }
      }
    }

    // Build foreign keys
    const foreignKeys: ForeignKeyDef[] = [];
    const tableFks = fkByTable.get(tableName);
    if (tableFks) {
      for (const [constraintName, fkCols] of tableFks) {
        fkCols.sort((a, b) => a.ordinal_position - b.ordinal_position);
        const firstFk = fkCols[0];
        if (firstFk) {
          foreignKeys.push({
            name: constraintName,
            columns: fkCols.map((fk) => fk.column_name),
            referencedTable: firstFk.foreign_table_name,
            referencedColumns: fkCols.map((fk) => fk.foreign_column_name),
            onDelete: mapReferentialAction(firstFk.delete_rule),
            onUpdate: mapReferentialAction(firstFk.update_rule),
          });
        }
      }
    }

    // Build unique constraints
    const uniqueConstraints: UniqueConstraintDef[] = [];
    const tableUniques = uniqueByTable.get(tableName);
    if (tableUniques) {
      for (const [constraintName, uqCols] of tableUniques) {
        uqCols.sort((a, b) => a.ordinal_position - b.ordinal_position);
        uniqueConstraints.push({
          name: constraintName,
          columns: uqCols.map((uq) => uq.column_name),
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

  // Build enums
  const enums: EnumDef[] = [];
  for (const [enumName, enumVals] of enumsByName) {
    enumVals.sort((a, b) => a.sort_order - b.sort_order);
    enums.push({
      name: enumName,
      values: enumVals.map((e) => e.enum_value),
    });
  }

  return {
    tables,
    enums: enums.length > 0 ? enums : undefined,
  };
}
