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
}

export type { Dialect };
