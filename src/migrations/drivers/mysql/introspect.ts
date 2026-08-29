/**
 * MySQL Schema Introspection
 *
 * Reads the current database schema from MySQL's information_schema,
 * returning a normalized SchemaSnapshot.
 */

import {
  type DecimalDescriptor,
  decimalListDefaultText,
  decodePhysicalDecimalList,
} from "@validation/primitives/decimal-codec";
import { MigrationError, VibORMErrorCode } from "../../../errors";
import {
  readMysqlDecimalListMarker,
  readStoredDecimalDescriptor,
} from "../../decimal";
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
import { type CatalogReader, resolveCatalogNamespace } from "./catalog";
import type {
  MySQLColumn,
  MySQLForeignKey,
  MySQLIndex,
  MySQLPrimaryKey,
  MySQLTable,
} from "./types";

// =============================================================================
// SQL QUERIES
// =============================================================================

// Every filter below binds the resolved database as DATA (§5.2). The name is
// never spliced into the statement, and `DATABASE()` — the connection's ambient
// default, which the ORM never configured — appears nowhere.
const TABLES_QUERY = `
SELECT TABLE_NAME
FROM information_schema.TABLES
WHERE TABLE_SCHEMA = ?
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
  EXTRA,
  COLUMN_COMMENT
FROM information_schema.COLUMNS
WHERE TABLE_SCHEMA = ?
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
WHERE tc.TABLE_SCHEMA = ?
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
WHERE TABLE_SCHEMA = ?
  AND INDEX_NAME != 'PRIMARY'
ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX
`;

// Both endpoints are projected and BOTH are admitted as filter candidates
// (§5.2): a constraint that leaves the estate in either direction has to be
// visible here before it can be refused, and an inbound one is not reachable
// through the referencing side's schema at all.
const FOREIGN_KEYS_QUERY = `
SELECT
  tc.TABLE_SCHEMA,
  tc.TABLE_NAME,
  tc.CONSTRAINT_NAME,
  kcu.COLUMN_NAME,
  kcu.REFERENCED_TABLE_SCHEMA,
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
WHERE tc.CONSTRAINT_TYPE = 'FOREIGN KEY'
  AND (tc.TABLE_SCHEMA = ? OR kcu.REFERENCED_TABLE_SCHEMA = ?)
ORDER BY tc.TABLE_NAME, tc.CONSTRAINT_NAME, kcu.ORDINAL_POSITION
`;

// =============================================================================
// CONSTANTS
// =============================================================================

const ENUM_VALUES_REGEX = /enum\((.+)\)/i;

/**
 * Parse enum values from MySQL COLUMN_TYPE string.
 * Handles values containing commas, doubled single quotes (''), and backslash escapes (\').
 * Example: "enum('a,b','it''s','c')" -> ['a,b', "it's", 'c']
 * Example: "enum('it\\'s')" -> ["it's"]
 */
function parseEnumValues(columnType: string): string[] | null {
  const match = columnType.match(ENUM_VALUES_REGEX);
  if (!match?.[1]) return null;

  const content = match[1];
  const values: string[] = [];
  let i = 0;

  while (i < content.length) {
    // Skip whitespace and commas
    while (i < content.length && (content[i] === " " || content[i] === ",")) {
      i++;
    }
    if (i >= content.length) break;

    // Expect opening quote
    if (content[i] !== "'") {
      i++;
      continue;
    }
    i++; // Skip opening quote

    // Collect value until closing quote (handle escaped quotes '' and \')
    let value = "";
    while (i < content.length) {
      if (content[i] === "\\" && i + 1 < content.length) {
        // Backslash escape - append next char and skip both
        value += content[i + 1];
        i += 2;
      } else if (content[i] === "'" && content[i + 1] === "'") {
        // Doubled quote escape - add single quote and skip both
        value += "'";
        i += 2;
      } else if (content[i] === "'") {
        // Closing quote
        i++;
        break;
      } else {
        value += content[i];
        i++;
      }
    }
    values.push(value);
  }

  return values.length > 0 ? values : null;
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
    default:
      return "noAction";
  }
}

function formatColumnType(col: MySQLColumn): string {
  // For ENUM types, return the full COLUMN_TYPE which includes values
  if (col.DATA_TYPE === "enum") {
    return col.COLUMN_TYPE; // e.g., "enum('active','inactive')"
  }

  // For types with modifiers (unsigned, zerofill) or size info in COLUMN_TYPE,
  // prefer COLUMN_TYPE to preserve full type specification
  // Examples: "int unsigned", "bigint unsigned zerofill", "varbinary(255)", "bit(8)", "timestamp(6)"
  const columnType = col.COLUMN_TYPE.toLowerCase();
  const hasModifiers =
    columnType.includes("unsigned") ||
    columnType.includes("zerofill") ||
    // Has parentheses with size/precision info (but not enum which is handled above)
    (columnType.includes("(") && col.DATA_TYPE !== "enum");

  if (hasModifiers) {
    return col.COLUMN_TYPE;
  }

  // Fallback: construct from DATA_TYPE with precision info
  if (col.DATA_TYPE === "varchar" && col.CHARACTER_MAXIMUM_LENGTH) {
    return `VARCHAR(${col.CHARACTER_MAXIMUM_LENGTH})`;
  }
  if (col.DATA_TYPE === "char" && col.CHARACTER_MAXIMUM_LENGTH) {
    return `CHAR(${col.CHARACTER_MAXIMUM_LENGTH})`;
  }
  if (col.DATA_TYPE === "decimal" && col.NUMERIC_PRECISION) {
    if (col.NUMERIC_SCALE !== null && col.NUMERIC_SCALE !== undefined) {
      return `DECIMAL(${col.NUMERIC_PRECISION},${col.NUMERIC_SCALE})`;
    }
    return `DECIMAL(${col.NUMERIC_PRECISION})`;
  }

  return col.DATA_TYPE.toUpperCase();
}

function isAutoIncrement(extra: string): boolean {
  return extra.toLowerCase().includes("auto_increment");
}

/**
 * The declared decimal domain of a MySQL column, or `undefined`.
 *
 * Two carriers, because MySQL stores the two shapes differently. A scalar is
 * `DECIMAL(p,s)` and the catalog reports the pair directly. A list is `JSON`,
 * which carries nothing, so its domain lives in the deterministic column
 * comment — matched EXACTLY (§6.2): a comment that merely mentions a decimal is
 * a comment, not a descriptor, and reading one as a descriptor would attach a
 * domain to a column VibORM never declared one on.
 */
function readDecimalDomain(col: MySQLColumn): DecimalDescriptor | undefined {
  if (col.DATA_TYPE === "decimal" && col.NUMERIC_PRECISION !== null) {
    const descriptor = readStoredDecimalDescriptor(
      col.NUMERIC_PRECISION,
      col.NUMERIC_SCALE ?? 0,
      "mysql"
    );
    if (descriptor !== undefined) return descriptor;
    throw new MigrationError(
      `MySQL reported column "${col.TABLE_NAME}"."${col.COLUMN_NAME}" as DECIMAL(${String(col.NUMERIC_PRECISION)},${String(col.NUMERIC_SCALE ?? 0)}), outside VibORM's complete exact-decimal domain for this provider. Migration introspection is refused rather than publishing an invalid descriptor.`,
      VibORMErrorCode.MIGRATION_INVALID_STATE,
      {
        meta: {
          dialect: "mysql",
          table: col.TABLE_NAME,
          column: col.COLUMN_NAME,
          type: "invalid-catalog-decimal-domain",
        },
      }
    );
  }
  if (col.DATA_TYPE !== "json") return undefined;
  return readMysqlDecimalListMarker(col.COLUMN_COMMENT);
}

/**
 * MySQL deparses an expression-backed string default as
 * `_charset\\'value\\'` in `information_schema.COLUMNS`. Normalize only the
 * exact decimal-list value this driver emits: the column must carry the exact
 * marker, the container must decode through its descriptor, and re-encoding it
 * must reproduce every byte. A generic JSON default or a manually respelled
 * container remains catalog text and therefore remains different.
 */
const MYSQL_STRING_EXPRESSION_DEFAULT = /^_[A-Za-z0-9_]+\\'([\s\S]*)\\'$/;

function cleanDefault(
  col: MySQLColumn,
  descriptor: DecimalDescriptor | undefined
): string | undefined {
  const columnDefault = col.COLUMN_DEFAULT;
  if (
    columnDefault === null ||
    descriptor === undefined ||
    col.DATA_TYPE !== "json"
  ) {
    return columnDefault ?? undefined;
  }
  const match = MYSQL_STRING_EXPRESSION_DEFAULT.exec(columnDefault);
  const container = match?.[1];
  if (container === undefined) return columnDefault;
  const canonicals = decodePhysicalDecimalList(
    container,
    descriptor,
    "coefficient"
  );
  if (canonicals === undefined) return columnDefault;
  const rendered = decimalListDefaultText("mysql", canonicals, descriptor);
  return rendered === container ? `('${rendered}')` : columnDefault;
}

/**
 * Refuses every foreign key with one endpoint outside the selected database
 * (§5.2), before the snapshot exists.
 *
 * Both directions are refused for the same reason: the estate's own DDL cannot
 * express, drop or recreate a constraint whose other half lives in a database
 * this client does not manage, so a reset, a push, or a generated down would
 * plan work that is either impossible or destructive to a stranger's schema.
 *
 * This runs BEFORE the rows are grouped, because the grouped set is also what
 * hides MySQL's auto-created FK indexes from the snapshot: admitting a foreign
 * row here would silently change which indexes the differ sees.
 */
function admitContainedForeignKeys(
  rows: readonly MySQLForeignKey[],
  namespace: string
): void {
  for (const row of rows) {
    if (
      row.TABLE_SCHEMA === namespace &&
      row.REFERENCED_TABLE_SCHEMA === namespace
    ) {
      continue;
    }
    throw new MigrationError(
      `Foreign key "${row.CONSTRAINT_NAME}" crosses a database boundary: \`${row.TABLE_SCHEMA}\`.\`${row.TABLE_NAME}\` references \`${row.REFERENCED_TABLE_SCHEMA}\`.\`${row.REFERENCED_TABLE_NAME}\`, and this client manages only "${namespace}". ` +
        "Migration work is refused before any snapshot, plan or DDL: VibORM cannot recreate or drop a constraint whose other half lives in a database it does not own.",
      VibORMErrorCode.MIGRATION_INVALID_STATE,
      {
        // BOTH endpoints are reported (§5.2), each on its own allowlisted
        // channel: the referencing one on `table`, the referenced one on
        // `referencedTable`, beside the database this client manages.
        meta: {
          dialect: "mysql",
          type: "cross-database-foreign-key",
          constraint: row.CONSTRAINT_NAME,
          namespace,
          table: `${row.TABLE_SCHEMA}.${row.TABLE_NAME}`,
          referencedTable: `${row.REFERENCED_TABLE_SCHEMA}.${row.REFERENCED_TABLE_NAME}`,
        },
      }
    );
  }
}

// =============================================================================
// INTROSPECTION
// =============================================================================

export async function introspect(
  executeRaw: CatalogReader,
  namespace: string | undefined
): Promise<SchemaSnapshot> {
  // The database is proven to exist BEFORE anything is read, so an absent one
  // can never be published as an empty inventory (§5.2). Its returned spelling
  // is what every filter below binds and what the containment comparison uses:
  // under `lower_case_table_names` the server's spelling is the identity the
  // catalog rows actually carry.
  const catalogNamespace = await resolveCatalogNamespace(executeRaw, namespace);

  // Execute all queries in parallel
  const [
    tablesResult,
    columnsResult,
    primaryKeysResult,
    indexesResult,
    foreignKeysResult,
  ] = await Promise.all([
    executeRaw<MySQLTable>(TABLES_QUERY, [catalogNamespace]),
    executeRaw<MySQLColumn>(COLUMNS_QUERY, [catalogNamespace]),
    executeRaw<MySQLPrimaryKey>(PRIMARY_KEYS_QUERY, [catalogNamespace]),
    executeRaw<MySQLIndex>(INDEXES_QUERY, [catalogNamespace]),
    executeRaw<MySQLForeignKey>(FOREIGN_KEYS_QUERY, [
      catalogNamespace,
      catalogNamespace,
    ]),
  ]);

  admitContainedForeignKeys(foreignKeysResult.rows, catalogNamespace);

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
        // Use $ as delimiter and escape any $ in names to prevent collisions
        // e.g. table "foo$bar" col "baz" -> "foo$$bar$baz$enum"
        const escapedTable = tableName.replace(/\$/g, "$$");
        const escapedCol = col.COLUMN_NAME.replace(/\$/g, "$$");
        const enumName = `${escapedTable}$${escapedCol}$enum`;
        if (!seenEnums.has(enumName)) {
          // Parse enum values from COLUMN_TYPE: enum('val1','val2')
          // Uses stateful parser to handle commas and escaped quotes in values
          const values = parseEnumValues(col.COLUMN_TYPE);
          if (values) {
            enumDefs.push({ name: enumName, values });
            seenEnums.add(enumName);
          }
        }
      }

      const decimal = readDecimalDomain(col);
      columns.push({
        name: col.COLUMN_NAME,
        type: formatColumnType(col),
        nullable: col.IS_NULLABLE === "YES",
        default: cleanDefault(col, decimal),
        autoIncrement: isAutoIncrement(col.EXTRA),
        decimal,
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
    // MySQL auto-creates an index named after each FK constraint; it isn't a
    // user index and can't be dropped while the FK exists, so hide it
    const fkNames = new Set(fkByTable.get(tableName)?.keys() ?? []);
    if (tableIndexes) {
      for (const [indexName, indexCols] of tableIndexes) {
        if (fkNames.has(indexName)) {
          continue;
        }
        indexCols.sort((a, b) => a.SEQ_IN_INDEX - b.SEQ_IN_INDEX);
        const firstCol = indexCols[0];
        if (firstCol) {
          const rawIndexType = firstCol.INDEX_TYPE.toLowerCase();
          // MySQL INFORMATION_SCHEMA reports RTREE for spatial indexes, normalize to "spatial"
          const indexType = rawIndexType === "rtree" ? "spatial" : rawIndexType;
          indexes.push({
            name: indexName,
            columns: indexCols.map((idx) => idx.COLUMN_NAME),
            unique: firstCol.NON_UNIQUE === 0,
            // MySQL uses BTREE, HASH, FULLTEXT, SPATIAL (reported as RTREE) - preserve all supported types
            type:
              indexType === "btree" ||
              indexType === "hash" ||
              indexType === "fulltext" ||
              indexType === "spatial"
                ? (indexType as "btree" | "hash" | "fulltext" | "spatial")
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

    // MySQL HAS ONE UNIQUE NAMESPACE, so a unique is reported ONCE — as an
    // index, above, from STATISTICS. TABLE_CONSTRAINTS lists the very same
    // object a second time (its `UNIQUE` constraint face), and filing that
    // second face here made every unique-bearing MySQL schema churn forever:
    // whichever bucket the desired side did not use looked like a stray object
    // and the differ planned a drop for it (measured on docker MySQL 8 — a
    // spurious `dropIndex` for a declared unique constraint, a spurious
    // `dropUniqueConstraint` for a declared unique index).
    //
    // The desired side is canonicalized to match by the driver's
    // `finalizeTable`, which rewrites every unique constraint into a unique
    // index. Both sides now speak indexes, so a unique round-trips unchanged.
    //
    // The bucket stays in the shape (every dialect's snapshot carries it) and
    // is always empty for MySQL. TABLE_CONSTRAINTS is no longer queried at all:
    // it can report nothing the STATISTICS rows above do not already carry.
    const uniqueConstraints: UniqueConstraintDef[] = [];

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
