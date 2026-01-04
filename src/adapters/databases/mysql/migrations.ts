/**
 * MySQL Migration Adapter (Stub)
 *
 * Migration support for MySQL is not yet implemented.
 */

import type { DiffOperation, SchemaSnapshot } from "../../../migrations/types";
import type { MigrationAdapter } from "../../database-adapter";

const notImplemented = (): never => {
  throw new Error(
    "MySQL migrations are not yet implemented. Please use PostgreSQL."
  );
};

export const mysqlMigrations: MigrationAdapter = {
  introspect: async (): Promise<SchemaSnapshot> => notImplemented(),
  generateDDL: (_operation: DiffOperation): string => notImplemented(),
  mapFieldType: (_fieldType: string): string => notImplemented(),
};
