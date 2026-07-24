import type { Sql } from "@sql";

/**
 * Logical cast types that adapters map to dialect-specific SQL types.
 *
 * Instead of hardcoding SQL type names like "TEXT" or "VARCHAR",
 * use these logical types and let each adapter map to the correct syntax.
 */
export type CastType = "text" | "integer" | "boolean" | "numeric";

/**
 * @internal Adapter-owned SQL for atomic batch reference storage.
 */
export interface BatchReferenceSqlAdapter {
  setup: (batchId: string) => Sql[];
  clear: (batchId: string) => Sql;
  cleanup: (batchId: string) => Sql;
  store: (batchId: string, key: string, valueSql: Sql) => Sql;
  read: (batchId: string, key: string) => Sql;
  storeLastInsertId: (batchId: string, key: string) => Sql;
}
