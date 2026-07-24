/**
 * Migration Driver Types
 *
 * Types for the migration driver system.
 */

import type { Dialect } from "../../drivers/types";

/**
 * Capabilities that differ between migration drivers.
 * Used to determine behavior in push() and serializer.
 */
export interface MigrationCapabilities {
  /**
   * Whether this database supports native enum types.
   * - PostgreSQL: true (CREATE TYPE ... AS ENUM)
   * - SQLite: false (uses TEXT)
   */
  supportsNativeEnums: boolean;

  /**
   * Whether ALTER TYPE ... ADD VALUE can run inside a transaction.
   * - PostgreSQL: false (must run outside transaction)
   * - SQLite: N/A (no native enums)
   */
  supportsAddEnumValueInTransaction: boolean;

  /**
   * Supported index types.
   * - PostgreSQL: ["btree", "hash", "gin", "gist"]
   * - SQLite: ["btree"]
   */
  supportsIndexTypes: string[];

  /**
   * Whether this database supports native array types.
   * - PostgreSQL: true (native arrays with operators)
   * - SQLite: false (uses JSON)
   */
  supportsNativeArrays: boolean;

  /**
   * Whether a foreign key can be added to an existing table with a standalone
   * `ALTER TABLE ... ADD ... FOREIGN KEY` statement that does not require table
   * recreation or knowledge of the introspected current schema.
   *
   * - PostgreSQL: true (`ALTER TABLE ... ADD CONSTRAINT ... FOREIGN KEY`)
   * - MySQL: true (`ALTER TABLE ... ADD CONSTRAINT ... FOREIGN KEY`)
   * - SQLite: false (no `ALTER TABLE ADD FOREIGN KEY`; needs table recreation)
   * - LibSQL: false (rewrites the column via `ALTER COLUMN ... TO`, which needs
   *   the current column definition — not a standalone add)
   *
   * When true, a newly created table's foreign keys that point *forward* to a
   * table created later in the same batch are lifted out of `CREATE TABLE` into
   * separate `addForeignKey` operations, so every table exists before any FK is
   * added (see `extractForwardReferenceForeignKeys`). When false, the driver
   * keeps foreign keys inline in `CREATE TABLE` and relies on the database
   * resolving references lazily (SQLite/LibSQL).
   */
  supportsAddForeignKeyViaAlter: boolean;
}

export type { Dialect };
