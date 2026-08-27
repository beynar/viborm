/**
 * Migration Driver Registry
 *
 * Central registry for migration drivers. Drivers are registered by their
 * driver name and can be looked up by driver name or dialect.
 */

import type { AnyDriver } from "../../drivers/driver";
import { MigrationError, VibORMErrorCode } from "../../errors";
import { resolveMigrationEstate } from "../target";
import type { MigrationTarget } from "../types";
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
 * A migration driver bound to one estate.
 *
 * Binding narrows two of the base class's optional facts — the durable target
 * and the execution driver — to present ones, so an admitted live boundary
 * never has to ask whether its driver knows which estate it serves. The live
 * `namespace` stays optional: an unbound MySQL adapter binds to a real estate,
 * and refusing it for effectful work belongs to the admission owner.
 */
export interface BoundMigrationDriver extends MigrationDriver {
  readonly target: MigrationTarget;
  readonly executionDriver: AnyDriver;
}

/**
 * Looks up the dialect implementation and returns it BOUND to this driver's
 * estate.
 *
 * The registry stays the dialect implementation registry and its entries stay
 * stateless: binding never mutates a registered singleton and never parks an
 * active namespace in module-level state. The bound value is a frozen view
 * whose prototype is the registered instance, so two clients on two schemas
 * hold two immutable targets over one implementation.
 *
 * This is the ONE place a driver becomes a migration estate. Resolving the
 * estate here is what makes an unproven PostgreSQL adapter fail at lookup
 * rather than at some later statement.
 *
 * The durable target and the live namespace are BOTH taken from one
 * `resolveMigrationEstate` call, which reads `adapter.namespace` exactly once.
 * Binding must never read that fact a second time: an accessor-backed custom
 * adapter could answer differently, and the frozen view would then name one
 * estate in its target and render another in its DDL.
 *
 * @throws MigrationError if no implementation is registered, or if the estate
 *   target cannot be proven
 */
export function getMigrationDriver(driver: AnyDriver): BoundMigrationDriver {
  const { target, namespace } = resolveMigrationEstate(driver);
  const implementation = findMigrationDriver(driver.driverName, target.dialect);

  const bound: BoundMigrationDriver = Object.create(implementation);
  Object.defineProperties(bound, {
    target: { value: target, enumerable: true },
    executionDriver: { value: driver, enumerable: true },
    namespace: { value: namespace, enumerable: true },
  });
  Object.freeze(bound);
  return bound;
}

/**
 * Resolves the registered implementation.
 *
 * Lookup order:
 * 1. Exact match by driver name
 * 2. Fallback to dialect default
 */
function findMigrationDriver(
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
