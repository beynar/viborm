/**
 * PostgreSQL Migration Adapter
 *
 * Implements database introspection and DDL generation for PostgreSQL.
 */

import type {
  ColumnDef,
  DiffOperation,
  EnumDef,
  ForeignKeyDef,
  IndexDef,
  PrimaryKeyDef,
  ReferentialAction,
  SchemaSnapshot,
  TableDef,
  UniqueConstraintDef,
} from "../../../migrations/types";
import type { MigrationAdapter } from "../../database-adapter";

// =============================================================================
// INTROSPECTION QUERY TYPES
// =============================================================================

interface PgTable {
  table_name: string;
}

interface PgColumn {
  table_name: string;
  column_name: string;
  data_type: string;
  udt_name: string;
  is_nullable: string;
  column_default: string | null;
  character_maximum_length: number | null;
  numeric_precision: number | null;
  numeric_scale: number | null;
}

interface PgPrimaryKey {
  table_name: string;
  constraint_name: string;
  column_name: string;
  ordinal_position: number;
}

interface PgIndex {
  table_name: string;
  index_name: string;
  column_name: string;
  is_unique: boolean;
  index_type: string;
  filter_condition: string | null;
  ordinal_position: number;
}

interface PgForeignKey {
  table_name: string;
  constraint_name: string;
  column_name: string;
  foreign_table_name: string;
  foreign_column_name: string;
  delete_rule: string;
  update_rule: string;
  ordinal_position: number;
}

interface PgUniqueConstraint {
  table_name: string;
  constraint_name: string;
  column_name: string;
  ordinal_position: number;
}

interface PgEnum {
  enum_name: string;
  enum_value: string;
  sort_order: number;
}

// =============================================================================
// INTROSPECTION QUERIES
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
    case "NO ACTION":
    default:
      return "noAction";
  }
}

function formatColumnType(col: PgColumn): string {
  const baseType = col.udt_name.startsWith("_")
    ? col.udt_name.slice(1) + "[]"
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
  const cleaned = columnDefault.replace(/::\w+(\[\])?$/, "").trim();
  return cleaned;
}

// =============================================================================
// INTROSPECTION
// =============================================================================

async function introspect(
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

  // Group columns by table
  const columnsByTable = new Map<string, PgColumn[]>();
  for (const col of columnsResult.rows) {
    const cols = columnsByTable.get(col.table_name) || [];
    cols.push(col);
    columnsByTable.set(col.table_name, cols);
  }

  // Group primary keys by table
  const pkByTable = new Map<string, PgPrimaryKey[]>();
  for (const pk of primaryKeysResult.rows) {
    const pks = pkByTable.get(pk.table_name) || [];
    pks.push(pk);
    pkByTable.set(pk.table_name, pks);
  }

  // Group indexes by table and index name
  const indexesByTable = new Map<string, Map<string, PgIndex[]>>();
  for (const idx of indexesResult.rows) {
    if (!indexesByTable.has(idx.table_name)) {
      indexesByTable.set(idx.table_name, new Map());
    }
    const tableIndexes = indexesByTable.get(idx.table_name)!;
    const indexCols = tableIndexes.get(idx.index_name) || [];
    indexCols.push(idx);
    tableIndexes.set(idx.index_name, indexCols);
  }

  // Group foreign keys by table and constraint name
  const fkByTable = new Map<string, Map<string, PgForeignKey[]>>();
  for (const fk of foreignKeysResult.rows) {
    if (!fkByTable.has(fk.table_name)) {
      fkByTable.set(fk.table_name, new Map());
    }
    const tableFks = fkByTable.get(fk.table_name)!;
    const fkCols = tableFks.get(fk.constraint_name) || [];
    fkCols.push(fk);
    tableFks.set(fk.constraint_name, fkCols);
  }

  // Group unique constraints by table and constraint name
  const uniqueByTable = new Map<string, Map<string, PgUniqueConstraint[]>>();
  for (const uq of uniqueConstraintsResult.rows) {
    if (!uniqueByTable.has(uq.table_name)) {
      uniqueByTable.set(uq.table_name, new Map());
    }
    const tableUniques = uniqueByTable.get(uq.table_name)!;
    const uqCols = tableUniques.get(uq.constraint_name) || [];
    uqCols.push(uq);
    tableUniques.set(uq.constraint_name, uqCols);
  }

  // Group enum values by enum name
  const enumsByName = new Map<string, PgEnum[]>();
  for (const e of enumsResult.rows) {
    const vals = enumsByName.get(e.enum_name) || [];
    vals.push(e);
    enumsByName.set(e.enum_name, vals);
  }

  // Build tables
  const tables: TableDef[] = [];

  for (const table of tablesResult.rows) {
    const tableName = table.table_name;

    // Build columns
    const columns: ColumnDef[] = (columnsByTable.get(tableName) || []).map(
      (col) => ({
        name: col.column_name,
        type: formatColumnType(col),
        nullable: col.is_nullable === "YES",
        default: cleanDefault(col.column_default),
        autoIncrement: isAutoIncrement(col.column_default),
      })
    );

    // Build primary key
    let primaryKey: PrimaryKeyDef | undefined;
    const pkCols = pkByTable.get(tableName);
    if (pkCols && pkCols.length > 0) {
      pkCols.sort((a, b) => a.ordinal_position - b.ordinal_position);
      primaryKey = {
        columns: pkCols.map((pk) => pk.column_name),
        name: pkCols[0]!.constraint_name,
      };
    }

    // Build indexes
    const indexes: IndexDef[] = [];
    const tableIndexes = indexesByTable.get(tableName);
    if (tableIndexes) {
      for (const [indexName, indexCols] of tableIndexes) {
        indexCols.sort((a, b) => a.ordinal_position - b.ordinal_position);
        const firstCol = indexCols[0]!;
        indexes.push({
          name: indexName,
          columns: indexCols.map((idx) => idx.column_name),
          unique: firstCol.is_unique,
          type: firstCol.index_type as "btree" | "hash" | "gin" | "gist",
          where: firstCol.filter_condition || undefined,
        });
      }
    }

    // Build foreign keys
    const foreignKeys: ForeignKeyDef[] = [];
    const tableFks = fkByTable.get(tableName);
    if (tableFks) {
      for (const [constraintName, fkCols] of tableFks) {
        fkCols.sort((a, b) => a.ordinal_position - b.ordinal_position);
        const firstFk = fkCols[0]!;
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

// =============================================================================
// DDL GENERATION
// =============================================================================

function escapeIdentifier(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function escapeValue(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function formatReferentialAction(action: ReferentialAction): string {
  switch (action) {
    case "cascade":
      return "CASCADE";
    case "setNull":
      return "SET NULL";
    case "restrict":
      return "RESTRICT";
    case "setDefault":
      return "SET DEFAULT";
    case "noAction":
    default:
      return "NO ACTION";
  }
}

function generateColumnDef(column: ColumnDef): string {
  const parts: string[] = [escapeIdentifier(column.name)];

  // Handle serial types for auto-increment
  if (column.autoIncrement) {
    if (column.type === "integer" || column.type === "int4") {
      parts.push("SERIAL");
    } else if (column.type === "bigint" || column.type === "int8") {
      parts.push("BIGSERIAL");
    } else if (column.type === "smallint" || column.type === "int2") {
      parts.push("SMALLSERIAL");
    } else {
      parts.push(column.type);
    }
  } else {
    parts.push(column.type);
  }

  if (!column.nullable) {
    parts.push("NOT NULL");
  }

  if (column.default !== undefined && !column.autoIncrement) {
    parts.push(`DEFAULT ${column.default}`);
  }

  return parts.join(" ");
}

function generateDDL(operation: DiffOperation): string {
  switch (operation.type) {
    case "createTable": {
      const { table } = operation;
      const columnDefs = table.columns.map(generateColumnDef);

      // Add primary key constraint
      if (table.primaryKey) {
        const pkCols = table.primaryKey.columns
          .map(escapeIdentifier)
          .join(", ");
        const pkName = table.primaryKey.name
          ? `CONSTRAINT ${escapeIdentifier(table.primaryKey.name)} `
          : "";
        columnDefs.push(`${pkName}PRIMARY KEY (${pkCols})`);
      }

      // Add unique constraints
      for (const uq of table.uniqueConstraints) {
        const uqCols = uq.columns.map(escapeIdentifier).join(", ");
        columnDefs.push(
          `CONSTRAINT ${escapeIdentifier(uq.name)} UNIQUE (${uqCols})`
        );
      }

      const sql = `CREATE TABLE ${escapeIdentifier(table.name)} (\n  ${columnDefs.join(",\n  ")}\n)`;

      // Add indexes and foreign keys as separate statements
      const statements = [sql];

      for (const idx of table.indexes) {
        statements.push(
          generateDDL({
            type: "createIndex",
            tableName: table.name,
            index: idx,
          })
        );
      }

      for (const fk of table.foreignKeys) {
        statements.push(
          generateDDL({ type: "addForeignKey", tableName: table.name, fk })
        );
      }

      return statements.join(";\n");
    }

    case "dropTable":
      return `DROP TABLE ${escapeIdentifier(operation.tableName)} CASCADE`;

    case "renameTable":
      return `ALTER TABLE ${escapeIdentifier(operation.from)} RENAME TO ${escapeIdentifier(operation.to)}`;

    case "addColumn": {
      const colDef = generateColumnDef(operation.column);
      return `ALTER TABLE ${escapeIdentifier(operation.tableName)} ADD COLUMN ${colDef}`;
    }

    case "dropColumn":
      return `ALTER TABLE ${escapeIdentifier(operation.tableName)} DROP COLUMN ${escapeIdentifier(operation.columnName)}`;

    case "renameColumn":
      return `ALTER TABLE ${escapeIdentifier(operation.tableName)} RENAME COLUMN ${escapeIdentifier(operation.from)} TO ${escapeIdentifier(operation.to)}`;

    case "alterColumn": {
      const { tableName, columnName, from, to } = operation;
      const statements: string[] = [];
      const table = escapeIdentifier(tableName);
      const col = escapeIdentifier(columnName);

      // Type change
      if (from.type !== to.type) {
        statements.push(
          `ALTER TABLE ${table} ALTER COLUMN ${col} TYPE ${to.type} USING ${col}::${to.type}`
        );
      }

      // Nullable change
      if (from.nullable !== to.nullable) {
        if (to.nullable) {
          statements.push(
            `ALTER TABLE ${table} ALTER COLUMN ${col} DROP NOT NULL`
          );
        } else {
          statements.push(
            `ALTER TABLE ${table} ALTER COLUMN ${col} SET NOT NULL`
          );
        }
      }

      // Default change
      if (from.default !== to.default) {
        if (to.default === undefined) {
          statements.push(
            `ALTER TABLE ${table} ALTER COLUMN ${col} DROP DEFAULT`
          );
        } else {
          statements.push(
            `ALTER TABLE ${table} ALTER COLUMN ${col} SET DEFAULT ${to.default}`
          );
        }
      }

      return statements.join(";\n");
    }

    case "createIndex": {
      const { tableName, index } = operation;
      const unique = index.unique ? "UNIQUE " : "";
      const indexType = index.type ? `USING ${index.type} ` : "";
      const cols = index.columns.map(escapeIdentifier).join(", ");
      const where = index.where ? ` WHERE ${index.where}` : "";
      return `CREATE ${unique}INDEX ${escapeIdentifier(index.name)} ON ${escapeIdentifier(tableName)} ${indexType}(${cols})${where}`;
    }

    case "dropIndex":
      return `DROP INDEX ${escapeIdentifier(operation.indexName)}`;

    case "addForeignKey": {
      const { tableName, fk } = operation;
      const cols = fk.columns.map(escapeIdentifier).join(", ");
      const refCols = fk.referencedColumns.map(escapeIdentifier).join(", ");
      const onDelete = fk.onDelete
        ? ` ON DELETE ${formatReferentialAction(fk.onDelete)}`
        : "";
      const onUpdate = fk.onUpdate
        ? ` ON UPDATE ${formatReferentialAction(fk.onUpdate)}`
        : "";
      return `ALTER TABLE ${escapeIdentifier(tableName)} ADD CONSTRAINT ${escapeIdentifier(fk.name)} FOREIGN KEY (${cols}) REFERENCES ${escapeIdentifier(fk.referencedTable)} (${refCols})${onDelete}${onUpdate}`;
    }

    case "dropForeignKey":
      return `ALTER TABLE ${escapeIdentifier(operation.tableName)} DROP CONSTRAINT ${escapeIdentifier(operation.fkName)}`;

    case "addUniqueConstraint": {
      const { tableName, constraint } = operation;
      const cols = constraint.columns.map(escapeIdentifier).join(", ");
      return `ALTER TABLE ${escapeIdentifier(tableName)} ADD CONSTRAINT ${escapeIdentifier(constraint.name)} UNIQUE (${cols})`;
    }

    case "dropUniqueConstraint":
      return `ALTER TABLE ${escapeIdentifier(operation.tableName)} DROP CONSTRAINT ${escapeIdentifier(operation.constraintName)}`;

    case "addPrimaryKey": {
      const { tableName, primaryKey } = operation;
      const cols = primaryKey.columns.map(escapeIdentifier).join(", ");
      const name = primaryKey.name
        ? escapeIdentifier(primaryKey.name)
        : escapeIdentifier(`${tableName}_pkey`);
      return `ALTER TABLE ${escapeIdentifier(tableName)} ADD CONSTRAINT ${name} PRIMARY KEY (${cols})`;
    }

    case "dropPrimaryKey":
      return `ALTER TABLE ${escapeIdentifier(operation.tableName)} DROP CONSTRAINT ${escapeIdentifier(operation.constraintName)}`;

    case "createEnum": {
      const { enumDef } = operation;
      const values = enumDef.values.map(escapeValue).join(", ");
      return `CREATE TYPE ${escapeIdentifier(enumDef.name)} AS ENUM (${values})`;
    }

    case "dropEnum":
      return `DROP TYPE ${escapeIdentifier(operation.enumName)}`;

    case "alterEnum": {
      const { enumName, addValues, removeValues } = operation;
      const statements: string[] = [];

      // PostgreSQL can add values but not remove them easily
      if (addValues) {
        for (const value of addValues) {
          statements.push(
            `ALTER TYPE ${escapeIdentifier(enumName)} ADD VALUE ${escapeValue(value)}`
          );
        }
      }

      // Note: Removing enum values in PostgreSQL requires recreating the type
      if (removeValues && removeValues.length > 0) {
        statements.push(
          `-- WARNING: Removing enum values requires recreating the type. Values to remove: ${removeValues.join(", ")}`
        );
      }

      return statements.join(";\n");
    }

    default:
      throw new Error(`Unknown operation type: ${(operation as any).type}`);
  }
}

// =============================================================================
// TYPE MAPPING
// =============================================================================

function mapFieldType(
  fieldType: string,
  options?: { array?: boolean; autoIncrement?: boolean }
): string {
  let baseType: string;

  switch (fieldType) {
    case "string":
      baseType = "text";
      break;
    case "int":
      baseType = options?.autoIncrement ? "serial" : "integer";
      break;
    case "float":
      baseType = "double precision";
      break;
    case "decimal":
      baseType = "numeric";
      break;
    case "boolean":
      baseType = "boolean";
      break;
    case "datetime":
      baseType = "timestamptz";
      break;
    case "date":
      baseType = "date";
      break;
    case "time":
      baseType = "time";
      break;
    case "bigint":
      baseType = options?.autoIncrement ? "bigserial" : "bigint";
      break;
    case "json":
      baseType = "jsonb";
      break;
    case "blob":
      baseType = "bytea";
      break;
    case "vector":
      baseType = "vector";
      break;
    case "point":
      baseType = "point";
      break;
    default:
      baseType = fieldType;
  }

  return options?.array ? `${baseType}[]` : baseType;
}

// =============================================================================
// EXPORT
// =============================================================================

export const postgresMigrations: MigrationAdapter = {
  introspect,
  generateDDL,
  mapFieldType,
};
