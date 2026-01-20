/**
 * Migration Driver Registry
 *
 * Central registry for migration drivers. Drivers are registered by their
 * driver name and can be looked up by driver name or dialect.
 */

import { MigrationError, VibORMErrorCode } from "../../errors";
import type { MigrationDriver } from "./base";
import type { Dialect } from "./types";

export type {
  AddColumnOperation,
  AddForeignKeyOperation,
  AddPrimaryKeyOperation,
  AddUniqueConstraintOperation,
  AlterColumnOperation,
  AlterEnumOperation,
  CreateEnumOperation,
  CreateIndexOperation,
  CreateTableOperation,
  DDLContext,
  DropColumnOperation,
  DropEnumOperation,
  DropForeignKeyOperation,
  DropIndexOperation,
  DropPrimaryKeyOperation,
  DropTableOperation,
  DropUniqueConstraintOperation,
  RenameColumnOperation,
  RenameTableOperation,
} from "./base";
// Export base class and types
export { MigrationDriver } from "./base";
export type { Dialect, MigrationCapabilities } from "./types";

// =============================================================================
// REGISTRY
// =============================================================================

/**
 * Registry of migration drivers by driver name.
 */
const driverRegistry = new Map<string, MigrationDriver>();

/**
 * Map of dialects to their default driver names.
 */
const dialectDefaults = new Map<Dialect, string>([
  ["postgresql", "postgresql"],
  ["sqlite", "sqlite3"],
  ["mysql", "mysql"],
]);

/**
 * Registers a migration driver.
 *
 * @param driver - The migration driver to register
 */
export function registerMigrationDriver(driver: MigrationDriver): void {
  driverRegistry.set(driver.driverName, driver);
}

/**
 * Gets a migration driver by driver name or dialect.
 *
 * Lookup order:
 * 1. Exact match by driver name
 * 2. Fallback to dialect default
 *
 * @param driverName - The driver name (e.g., "pg", "pglite", "sqlite3", "libsql")
 * @param dialect - The dialect to use as fallback
 * @returns The migration driver
 * @throws MigrationError if no driver found
 */
export function getMigrationDriver(
  driverName: string,
  dialect: Dialect
): MigrationDriver {
  // Try exact driver name match
  let driver = driverRegistry.get(driverName);
  if (driver) return driver;

  // Try dialect default
  const defaultDriverName = dialectDefaults.get(dialect);
  if (defaultDriverName) {
    driver = driverRegistry.get(defaultDriverName);
    if (driver) return driver;
  }

  throw new MigrationError(
    `No migration driver registered for "${driverName}" (dialect: ${dialect}). ` +
      `Available drivers: ${[...driverRegistry.keys()].join(", ") || "none"}`,
    VibORMErrorCode.DRIVER_NOT_SUPPORTED
  );
}

/**
 * Lists all registered migration drivers.
 */
export function listMigrationDrivers(): MigrationDriver[] {
  return [...driverRegistry.values()];
}

/**
 * Checks if a migration driver is registered.
 */
export function hasMigrationDriver(driverName: string): boolean {
  return driverRegistry.has(driverName);
}

// =============================================================================
// AUTO-REGISTRATION
// =============================================================================

// Import and register built-in drivers
import { libsqlMigrationDriver } from "./libsql";
import { mysqlMigrationDriver } from "./mysql";
import { postgresMigrationDriver } from "./postgres";
import { sqlite3MigrationDriver } from "./sqlite";

registerMigrationDriver(postgresMigrationDriver);
registerMigrationDriver(sqlite3MigrationDriver);
registerMigrationDriver(libsqlMigrationDriver);
registerMigrationDriver(mysqlMigrationDriver);
