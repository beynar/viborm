/**
 * Migration Storage
 *
 * Abstracts file storage for migrations.
 *
 * For tree-shaking, import storage drivers directly:
 * ```typescript
 * import { createFsStorageDriver } from "viborm/migrations/storage/fs";
 * ```
 */

// Driver base class and helpers (no node:fs dependency)
export {
  MigrationStorageDriver,
  addJournalEntry,
  calculateChecksum,
  createEmptyJournal,
  createEmptySnapshot,
  createMigrationEntry,
  formatMigrationFilename,
  formatMigrationPath,
  generateVersion,
  getNextMigrationIndex,
  toKebabCase,
  validateJournalDialect,
} from "./driver";

// NOTE: Concrete drivers are NOT re-exported here to allow tree-shaking.
// Import them directly:
//   import { createFsStorageDriver } from "viborm/migrations/storage/fs";
