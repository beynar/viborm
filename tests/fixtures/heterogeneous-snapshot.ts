/**
 * Snapshot tables that differ from each other: column counts, types,
 * nullability, defaults and constraint names all vary with the table's name.
 * A benchmark of identical tables hides positional delta costs, because a
 * shifted table then differs from its neighbour only by name.
 */
import type { SchemaSnapshot, TableDef } from "@src/migrations/types";

export const TYPES = ["TEXT", "INTEGER", "BOOLEAN", "REAL", "BLOB"];

/** Tables that differ from each other, unlike a benchmark of identical ones. */
export function heterogeneousTable(
  name: string,
  columns: readonly string[]
): TableDef {
  return {
    name,
    columns: [
      { name: "id", type: "TEXT", nullable: false },
      { name: "parent_id", type: "TEXT", nullable: true },
      ...columns.map((column, index) => ({
        name: column,
        type: TYPES[(name.length + index) % TYPES.length]!,
        nullable: index % 2 === 0,
        ...(index % 3 === 0 ? { default: `'${name}_${column}'` } : {}),
      })),
    ],
    primaryKey: { columns: ["id"], name: `${name}_pkey` },
    indexes: [
      { name: `${name}_parent_idx`, columns: ["parent_id"], unique: false },
    ],
    foreignKeys: [
      {
        name: `${name}_parent_fkey`,
        columns: ["parent_id"],
        referencedTable: name,
        referencedColumns: ["id"],
        onDelete: "cascade",
      },
    ],
    uniqueConstraints: [],
  };
}

export function columnsOf(name: string): string[] {
  return Array.from(
    { length: 4 + (name.length % 5) },
    (_, index) => `${name}_field_${index}`
  );
}

export function heterogeneousSchema(names: readonly string[]): SchemaSnapshot {
  return {
    enums: [{ name: "access_level", values: ["view", "edit", "full"] }],
    tables: names.map((name) => heterogeneousTable(name, columnsOf(name))),
  };
}
