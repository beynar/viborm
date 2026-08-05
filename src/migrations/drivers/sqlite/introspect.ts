/**
 * SQLite Schema Introspection
 *
 * Reads the current database schema from SQLite's PRAGMA statements
 * and sqlite_master, returning a normalized SchemaSnapshot.
 */

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
    const char = sql[cursor];

    if (char === "'" || char === '"' || char === "`") {
      cursor++;
      while (cursor < sql.length) {
        if (sql[cursor] === char) {
          // A doubled quote is an escaped one, not the end of the token.
          if (sql[cursor + 1] === char) {
            cursor += 2;
            continue;
          }
          break;
        }
        cursor++;
      }
      cursor++;
      continue;
    }

    if (char === "[") {
      while (cursor < sql.length && sql[cursor] !== "]") cursor++;
      cursor++;
      continue;
    }

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
    case "NO ACTION":
    default:
      return "noAction";
  }
}

// =============================================================================
// INTROSPECTION
// =============================================================================

export async function introspect(
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
      columns.push({
        name: col.name,
        type: col.type || "TEXT",
        nullable: int(col.notnull) === 0,
        default: col.dflt_value ?? undefined,
        autoIncrement:
          pk === 1 && col.type.toUpperCase() === "INTEGER" ? true : false,
      });

      if (pk > 0) {
        pkColumns.push({ name: col.name, position: pk });
      }
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
      // Skip auto-created indexes for primary keys
      if (idx.origin === "pk") continue;

      // Get index columns
      const indexColsResult = await executeRaw<SqliteIndexColumn>(
        `PRAGMA index_info(${escapeIdentifier(idx.name)})`
      );

      const indexColumns = indexColsResult.rows
        .sort((a, b) => int(a.seqno) - int(b.seqno))
        .map((c) => c.name);

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
