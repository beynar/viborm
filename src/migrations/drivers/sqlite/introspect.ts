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
  SqliteTable,
} from "./types";

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

function escapeIdentifier(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
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

    // Get foreign keys
    const fksResult = await executeRaw<SqliteForeignKey>(
      `PRAGMA foreign_key_list(${escapeIdentifier(tableName)})`
    );

    // Build columns
    const columns: ColumnDef[] = [];
    const pkColumns: { name: string; position: number }[] = [];

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
        pkColumns.push({ name: col.name, position: col.pk });
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
