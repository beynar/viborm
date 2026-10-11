import { isSqliteStateControlDefinition } from "../../control";
/**
 * SQLite Schema Introspection
 *
 * Reads the current database schema from SQLite's PRAGMA statements
 * and sqlite_master, returning a normalized SchemaSnapshot.
 */

import { BATCH_REFS_TABLE } from "@adapters/shared/batch-refs";
import {
  sqliteDefinitionKeywords,
  sqliteTableDefinitions,
} from "../../../adapters/databases/sqlite/storage/column-constraints";
import { readSqliteDecimalConstraint } from "../../../adapters/databases/sqlite/storage/decimal";
import {
  readSqliteGeoPointColumn,
  SQLITE_GEO_POINT_TYPE,
} from "../../../adapters/databases/sqlite/storage/geo-point";
import { skipSqlNonStructuralRegion } from "../../../adapters/databases/sqlite/storage/sql-lexing";
import { MigrationError, VibORMErrorCode } from "../../../errors";
import type {
  ColumnDef,
  ForeignKeyDef,
  IndexDef,
  PrimaryKeyDef,
  ReferentialAction,
  SchemaSnapshot,
  TableDef,
  UniqueConstraintDef,
} from "../../types";
import type {
  SqliteColumn,
  SqliteForeignKey,
  SqliteIndex,
  SqliteIndexColumn,
  SqliteInt,
  SqliteTable,
} from "./types";

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

function escapeIdentifier(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/**
 * A pragma's integer column, as a number.
 *
 * SQLite reports integers, but the driver decides how they arrive: the LibSQL
 * driver runs with `intMode: "bigint"` (`src/drivers/libsql/index.ts`), so every
 * pragma integer reaches this file as BigInt. Read raw, each one is wrong in a
 * different way — `1n === 1` is false, so a unique index reads as non-unique
 * and a NOT NULL column reads as nullable; and `a.seqno - b.seqno` yields a
 * BigInt that `Array#sort` refuses outright, which crashes the introspection of
 * any index over two or more columns. Normalizing here, once, is what lets the
 * rest of this file compare plain numbers.
 */
function int(value: SqliteInt): number {
  return Number(value);
}

/** The predicate half of a stored `CREATE INDEX … WHERE …`, if there is one. */
const TRAILING_WHERE = /^WHERE\s+([\s\S]+)$/i;
/** The defaults SQLite's column grammar takes without parentheses. */
// Identifiers include NULL, TRUE, FALSE and CURRENT_*, and SQLite reads a
// bare or double-quoted one in a default as a string literal.
const LITERAL_DEFAULT =
  /^(?:[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?|0x[\da-f]+|'(?:[^']|'')*'|x'[\da-f]*'|"(?:[^"]|"")*"|[a-z_][\w$]*)$/i;

/**
 * A column's default as DDL. `PRAGMA table_info` reports `DEFAULT (expr)`
 * without its parentheses, and an expression is a legal default only inside
 * them: a table recreation that wrote `strftime(...)` back verbatim (an
 * `s.dateTime().now()` column) was a `CREATE TABLE` SQLite refused.
 */
function columnDefault(value: string | null): string | undefined {
  if (value === null) return;
  return LITERAL_DEFAULT.test(value) ? value : `(${value})`;
}
const AUTOINCREMENT = /\bAUTOINCREMENT\b/i;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The CHECK the SQLite driver embeds in an enum column type.
 *
 * `PRAGMA table_info` reports only `TEXT`. The values live in
 * `sqlite_master.sql` as `CHECK("col" IN ('a', 'b'))`, which is the same
 * spelling `getEnumColumnType` writes into the desired snapshot. Reconstruct
 * that suffix so fingerprint and differ see one type.
 */
function sqliteEnumCheckSuffix(
  tableSql: string | null,
  columnName: string
): string | undefined {
  if (!tableSql) return;
  const quoted = escapeIdentifier(columnName);
  const match = tableSql.match(
    new RegExp(
      `CHECK\\(\\s*${escapeRegExp(quoted)}\\s+IN\\s*\\((\\s*(?:'(?:[^']|'')*'\\s*,\\s*)*'(?:[^']|'')*'\\s*)\\)\\s*\\)`,
      "i"
    )
  );
  const list = match?.[1];
  if (!list) return;
  const values: string[] = [];
  const literals = /'((?:[^']|'')*)'/g;
  let literal = literals.exec(list);
  while (literal) {
    const value = literal[1];
    if (value !== undefined) values.push(value.replace(/''/g, "'"));
    literal = literals.exec(list);
  }
  if (values.length === 0) return;
  const escaped = values
    .map((value) => `'${value.replace(/'/g, "''")}'`)
    .join(", ");
  return ` CHECK(${quoted} IN (${escaped}))`;
}

/**
 * Reads the predicate of a partial index back out of the text SQLite stored.
 *
 * SQLite keeps `sqlite_master.sql` as the statement was written and re-spells
 * nothing (measured on 3.51: the predicate, its inner spacing and its padding
 * all come back byte-identical; only the statement terminator is dropped), so
 * the predicate the differ compares is the one the serializer emitted. This
 * reads it out and does not normalize it — `indexesEqual` is the one place the
 * two snapshot producers' spellings are reconciled.
 *
 * The predicate is whatever follows the column list, not whatever follows the
 * first `WHERE` in the text: a column may be named `a WHERE b`. So walk the
 * statement to the parenthesis that closes the column list, skipping quoted
 * identifiers and string literals, and read the tail from there.
 */
function partialIndexPredicate(sql: string | null): string | undefined {
  if (!sql) return undefined;

  let depth = 0;
  let cursor = 0;
  let columnListEnd = -1;

  while (cursor < sql.length) {
    // Quoted tokens and comments are skipped through the ONE owner of where a
    // non-structural SQLite region ends, shared with the reserved decimal-
    // constraint reader: both read text SQLite stored verbatim, and both are
    // wrong the same way if its contents are read as syntax.
    const skipped = skipSqlNonStructuralRegion(sql, cursor);
    if (skipped !== cursor) {
      cursor = skipped;
      continue;
    }

    const char = sql[cursor];

    if (char === "(") {
      depth++;
    } else if (char === ")") {
      depth--;
      if (depth === 0) {
        columnListEnd = cursor;
        break;
      }
    }
    cursor++;
  }

  if (columnListEnd === -1) return undefined;

  const match = TRAILING_WHERE.exec(sql.slice(columnListEnd + 1).trimStart());
  return match?.[1];
}

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

// =============================================================================
// INTROSPECTION
// =============================================================================

export async function introspect(
  executeRaw: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>,
  managedTables?: readonly string[],
  excludeD1SystemTables = false
): Promise<SchemaSnapshot> {
  // Get all tables. `sql` rides along on the query that was already being made
  // — the reserved decimal constraints are read out of it, and a second live
  // read for them would be a raw-execution call site the architecture census
  // pins per file. The engine's batch reference scratch is not part of the
  // user's schema: it is TEMP where the transport admits temporary objects and
  // never appears here, but on D1 it is an ordinary table in `main`, and a
  // snapshot that carried it would have push and diff plan its drop.
  // D1 also exposes provider-owned `_cf_` tables but forbids their PRAGMAs.
  // Filter that exact reserved prefix only for D1; GLOB treats `_` literally,
  // and an ordinary SQLite application's similarly named tables stay visible.
  const tablesResult = await executeRaw<SqliteTable>(
    `
    SELECT name, sql
    FROM sqlite_master
    WHERE type = 'table'
      AND name NOT LIKE 'sqlite_%'
      AND name <> ?
      ${excludeD1SystemTables ? "AND name NOT GLOB '_cf_*'" : ""}
    ORDER BY name
  `,
    [BATCH_REFS_TABLE]
  );

  const tables: TableDef[] = [];

  for (const tableRow of tablesResult.rows) {
    const tableName = tableRow.name;

    const selected =
      managedTables === undefined || managedTables.includes(tableName);
    const definitions = sqliteTableDefinitions(tableRow.sql ?? "");
    if (
      selected &&
      definitions.some((definition) =>
        sqliteDefinitionKeywords(definition.text).includes("AS")
      )
    )
      throw new MigrationError(
        `SQLite table "${tableName}" has generated columns that this schema cannot represent. Synchronization refuses before effects and preserves them.`,
        VibORMErrorCode.MIGRATION_INVALID_STATE,
        { meta: { table: tableName, feature: "generated columns" } }
      );
    if (
      selected &&
      sqliteDefinitionKeywords(
        (tableRow.sql ?? "").split("(")[0] ?? ""
      ).includes("VIRTUAL")
    )
      throw new MigrationError(
        `SQLite virtual table "${tableName}" cannot be faithfully reconstructed. Synchronization refuses before effects.`,
        VibORMErrorCode.MIGRATION_INVALID_STATE,
        { meta: { table: tableName, feature: "virtual table" } }
      );

    // Get columns using PRAGMA
    const columnsResult = await executeRaw<SqliteColumn>(
      `PRAGMA table_info(${escapeIdentifier(tableName)})`
    );
    const tableSql = tableRow.sql;
    const hasAutoincrement = AUTOINCREMENT.test(tableSql ?? "");

    // Get indexes
    const indexesResult = await executeRaw<SqliteIndex>(
      `PRAGMA index_list(${escapeIdentifier(tableName)})`
    );

    // The pragma reports that an index is partial but not what its predicate
    // is; only the stored statement carries that.
    const indexSqlResult = await executeRaw<{
      name: string;
      sql: string | null;
    }>(
      "SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = ?",
      [tableName]
    );
    const indexSql = new Map(
      indexSqlResult.rows.map((row) => [row.name, row.sql])
    );

    // Get foreign keys
    const fksResult = await executeRaw<SqliteForeignKey>(
      `PRAGMA foreign_key_list(${escapeIdentifier(tableName)})`
    );

    // Build columns
    const columns: ColumnDef[] = [];
    const pkColumns: { name: string; position: number }[] = [];

    for (const col of columnsResult.rows) {
      const pk = int(col.pk);
      const type = col.type || "TEXT";
      const nullable = int(col.notnull) === 0 && pk === 0;
      const geoPointEncoding = readSqliteGeoPointColumn(
        tableSql,
        { name: col.name, type, nullable },
        escapeIdentifier
      );
      columns.push({
        name: col.name,
        geoPointEncoding,
        type: geoPointEncoding
          ? SQLITE_GEO_POINT_TYPE
          : `${type}${sqliteEnumCheckSuffix(tableSql, col.name) ?? ""}`,
        nullable,
        default: columnDefault(col.dflt_value),
        autoIncrement: pk === 1 && hasAutoincrement,
        // The declared domain, recovered from the reserved CHECK constraint
        // the driver wrote. Nothing else on this dialect carries it: the type
        // is `INTEGER` (or `TEXT`) at every precision and scale, and the
        // pragma reports no constraints at all — so a side that could not
        // recover it would read as a change on every push, forever.
        decimal: readSqliteDecimalConstraint(
          tableSql,
          // The descriptor proof consumes the exact declared type PRAGMA
          // reported. The generic snapshot fallback above may call an untyped
          // column TEXT, but that normalization cannot turn BLOB affinity into
          // the writer-owned TEXT decimal-list carrier.
          { name: col.name, type: col.type, nullable },
          escapeIdentifier
        ),
      });

      if (pk > 0) {
        pkColumns.push({ name: col.name, position: pk });
      }
    }

    if (selected) {
      const checks = definitions.reduce(
        (count, definition) =>
          count +
          sqliteDefinitionKeywords(definition.text).filter(
            (word) => word === "CHECK"
          ).length,
        0
      );
      const represented = columns.reduce(
        (count, column) =>
          count +
          Number(column.decimal !== undefined) +
          Number(column.geoPointEncoding !== undefined) +
          Number(sqliteEnumCheckSuffix(tableSql, column.name) !== undefined),
        0
      );
      if (
        checks !== represented &&
        !isSqliteStateControlDefinition(tableName, tableSql)
      )
        throw new MigrationError(
          `SQLite table "${tableName}" has CHECK constraints that this schema cannot faithfully represent. Synchronization refuses before effects and preserves them.`,
          VibORMErrorCode.MIGRATION_INVALID_STATE,
          { meta: { table: tableName, feature: "CHECK constraints" } }
        );
    }

    // Build primary key (sort by pk position)
    let primaryKey: PrimaryKeyDef | undefined;
    if (pkColumns.length > 0) {
      pkColumns.sort((a, b) => a.position - b.position);
      primaryKey = {
        name: `${tableName}_pkey`,
        columns: pkColumns.map((p) => p.name),
      };
    }

    // Build indexes and unique constraints
    const indexes: IndexDef[] = [];
    const uniqueConstraints: UniqueConstraintDef[] = [];

    for (const idx of indexesResult.rows) {
      // xinfo exposes the physical key semantics that index_info erases.
      // Auxiliary rowid columns are not key members; user expressions, DESC
      // and collations cannot be faithfully recreated by this declaration DSL.
      const indexColsResult = await executeRaw<SqliteIndexColumn>(
        `PRAGMA index_xinfo(${escapeIdentifier(idx.name)})`
      );
      const keys = indexColsResult.rows.filter(
        (column) => int(column.key) === 1
      );
      const unsupported =
        keys.length === 0 ||
        keys.some(
          (column) =>
            int(column.cid) < 0 ||
            column.name === null ||
            int(column.desc) !== 0 ||
            column.coll !== "BINARY"
        );
      if (unsupported) {
        if (managedTables === undefined || managedTables.includes(tableName)) {
          throw new MigrationError(
            `SQLite index "${tableName}.${idx.name}" has expression/order/collation semantics that this index declaration cannot represent. Synchronization refuses before effects and preserves it. Manage its table outside this synchronization scope until a faithful declaration is available.`,
            VibORMErrorCode.FEATURE_NOT_SUPPORTED,
            { meta: { table: tableName, indexName: idx.name } }
          );
        }
        continue;
      }
      // PK membership is already represented by the table's primary key.
      if (idx.origin === "pk") continue;
      const indexColumns = keys
        .sort((a, b) => int(a.seqno) - int(b.seqno))
        .flatMap((column) => (column.name === null ? [] : [column.name]));

      const unique = int(idx.unique) === 1;
      if (unique && idx.origin === "u") {
        // This is a unique constraint
        uniqueConstraints.push({
          name: idx.name,
          columns: indexColumns,
        });
      } else {
        indexes.push({
          name: idx.name,
          columns: indexColumns,
          unique,
          where: partialIndexPredicate(indexSql.get(idx.name) ?? null),
        });
      }
    }

    // Build foreign keys - group by id (constraint)
    const fkMap = new Map<number, SqliteForeignKey[]>();
    for (const fk of fksResult.rows) {
      const id = int(fk.id);
      const existing = fkMap.get(id) || [];
      existing.push(fk);
      fkMap.set(id, existing);
    }

    const foreignKeys: ForeignKeyDef[] = [];
    for (const [id, fkCols] of fkMap) {
      const sorted = fkCols.sort((a, b) => int(a.seq) - int(b.seq));
      const first = sorted[0];
      if (first) {
        foreignKeys.push({
          name: `${tableName}_fk_${id}`,
          columns: sorted.map((f) => f.from),
          referencedTable: first.table,
          referencedColumns: sorted.map((f) => f.to),
          onDelete: mapReferentialAction(first.on_delete),
          onUpdate: mapReferentialAction(first.on_update),
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

  // SQLite doesn't have native enum types
  return { tables, enums: [] };
}
