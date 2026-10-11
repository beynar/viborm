/**
 * Migration Driver Registry
 *
 * Central registry for migration drivers. Drivers are registered by their
 * driver name and can be looked up by driver name or dialect.
 */

import type {
  AnyDriver,
  SqliteMigrationCapability,
} from "../../drivers/driver";
import {
  DEFAULT_MIGRATION_TIME_LIMITS,
  type ResolvedMigrationTimeLimits,
} from "../../drivers/shared/pinned-session";
import { MigrationError, VibORMErrorCode } from "../../errors";
import { resolveMigrationEstate, selectManagedSnapshot } from "../target";
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
 * The implementation each stock SQLite driver binds to, by name.
 *
 * SQLite is the one dialect with two implementations, so a SQLite driver never
 * binds by dialect: a driver declaring `sqliteMigrationCapability` binds to
 * `sqlite3` whatever its name (so a declaring libSQL subclass never reaches the
 * libsql implementation's unvalidated native ALTER COLUMN), an undeclared stock
 * driver binds here, and an undeclared custom one has no binding at all.
 * Binding is not admission: effectful work still needs the declaration
 * (`admission.ts`). PostgreSQL and MySQL have one implementation each,
 * registered under the dialect's name.
 */
const STOCK_SQLITE_BINDINGS: ReadonlyMap<string, string> = new Map([
  ["sqlite3", "sqlite3"],
  ["bun-sqlite", "sqlite3"],
  ["d1", "sqlite3"],
  ["libsql", "libsql"],
]);

/**
 * The one admitted declaration, as bound. Its type admits no other value, so
 * it cannot drift from the `SQLITE_MIGRATION_CAPABILITY` drivers declare; it is
 * spelled here so the migration bundle does not import the driver module.
 */
const SQLITE_MIGRATION_CAPABILITY: SqliteMigrationCapability = Object.freeze({
  foreignKeys: "pragma",
  reservedTablePrefixes: "none",
  exclusion: "database-write-lock",
});

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
  /** The SQLite capability read once at binding; admission decides from it. */
  readonly sqliteMigrationCapability: SqliteMigrationCapability | undefined;
  /** The command's time limits: the client's own, or the defaults. */
  readonly timeLimits: ResolvedMigrationTimeLimits;
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
export function getMigrationDriver(
  driver: AnyDriver,
  tables?: readonly string[],
  timeLimits: ResolvedMigrationTimeLimits = DEFAULT_MIGRATION_TIME_LIMITS
): BoundMigrationDriver {
  const { target: baseTarget, namespace } = resolveMigrationEstate(driver);
  const target =
    tables === undefined
      ? baseTarget
      : Object.freeze({ ...baseTarget, tables });
  const capability =
    target.dialect === "sqlite"
      ? readSqliteMigrationCapability(driver)
      : undefined;
  const implementation = findMigrationDriver(
    driver.driverName,
    target.dialect,
    capability
  );

  const bound: BoundMigrationDriver = Object.create(implementation);
  Object.defineProperties(bound, {
    target: { value: target, enumerable: true },
    executionDriver: { value: driver, enumerable: true },
    namespace: { value: namespace, enumerable: true },
    sqliteMigrationCapability: { value: capability, enumerable: true },
    timeLimits: { value: timeLimits, enumerable: true },
    introspect: {
      async value(
        this: MigrationDriver,
        executeRaw: Parameters<MigrationDriver["introspect"]>[0]
      ) {
        return selectManagedSnapshot(
          await implementation.introspect.call(this, executeRaw),
          target
        );
      },
    },
  });
  Object.freeze(bound);
  return bound;
}

/**
 * The driver's SQLite migration capability, read ONCE, or undefined when it
 * declares none. Only the exact values count: each is a safety claim, and a
 * mistyped claim must not read as an approximate one.
 */
function readSqliteMigrationCapability(
  driver: AnyDriver
): SqliteMigrationCapability | undefined {
  const declared: unknown = driver.sqliteMigrationCapability;
  if (typeof declared !== "object" || declared === null) return;
  for (const [key, value] of Object.entries(SQLITE_MIGRATION_CAPABILITY)) {
    if (Reflect.get(declared, key) !== value) return;
  }
  return SQLITE_MIGRATION_CAPABILITY;
}

/** Resolves the registered implementation this driver binds to. */
function findMigrationDriver(
  driverName: string,
  dialect: Dialect,
  capability: SqliteMigrationCapability | undefined
): MigrationDriver {
  let name: string | undefined = dialect;
  if (dialect === "sqlite") {
    name = capability ? "sqlite3" : STOCK_SQLITE_BINDINGS.get(driverName);
  }
  const driver = name === undefined ? undefined : driverRegistry.get(name);
  if (driver) return driver;
  throw new MigrationError(
    name === undefined
      ? `The SQLite driver "${driverName}" declares no \`sqliteMigrationCapability\`, so no migration implementation binds to it.`
      : `No migration driver registered for "${driverName}" (dialect: ${dialect}).`,
    VibORMErrorCode.DRIVER_NOT_SUPPORTED,
    { meta: { driver: driverName, dialect } }
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
