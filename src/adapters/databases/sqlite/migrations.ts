/**
 * SQLite Migration Adapter (Stub)
 *
 * Migration support for SQLite is not yet implemented.
 */

import type { MigrationAdapter } from "../../database-adapter";
import type { SchemaSnapshot, DiffOperation } from "../../../migrations/types";

const notImplemented = (): never => {
  throw new Error("SQLite migrations are not yet implemented. Please use PostgreSQL.");
};

export const sqliteMigrations: MigrationAdapter = {
  introspect: async (): Promise<SchemaSnapshot> => notImplemented(),
  generateDDL: (_operation: DiffOperation): string => notImplemented(),
  mapFieldType: (_fieldType: string): string => notImplemented(),
};
