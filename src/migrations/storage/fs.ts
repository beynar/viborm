/**
 * Filesystem Storage Driver
 *
 * Re-exports the filesystem storage driver for direct import.
 *
 * @example
 * ```typescript
 * import { createFsStorageDriver } from "viborm/migrations/storage/fs";
 *
 * const migrations = createMigrationClient(client, {
 *   storageDriver: createFsStorageDriver("./migrations"),
 * });
 * ```
 */

export { createFsStorageDriver, FsStorageDriver } from "./drivers/fs";
