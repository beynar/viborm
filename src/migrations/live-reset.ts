/**
 * The ONE live-namespace reset owner (§6.2).
 *
 * Three programs used to invent reset SQL: the CLI's own dynamic loop, the
 * dialect drivers' `generateResetSQL()`, and `push({ forceReset: true })`. They
 * disagreed — MySQL's dialect answer dropped nothing at all, and PostgreSQL's
 * enumerated `public` regardless of the estate — so this module replaces all
 * three. Migration `reset()` and force-reset push both keep the migration
 * control pair: a clear drops neither table.
 *
 * Containment is the point: the inventory is a bound catalog read scoped to the
 * configured namespace, foreign keys inside it are dropped explicitly rather
 * than cascaded away, and nothing here issues `DROP SCHEMA`, `DROP DATABASE`,
 * or `FOREIGN_KEY_CHECKS = 0`.
 *
 * {@link planLiveNamespaceReset} decides and renders the whole clear from
 * catalog reads, before the first effect. Every refusal lives there, so no
 * caller's commit-model reporter can restate a containment refusal as a failure
 * part-way through a program that never began.
 */

import type { AnyDriver } from "../drivers/driver";
import { MigrationError, VibORMErrorCode } from "../errors";
import { errorCause } from "../errors/diagnostic-safety";
import { CONTROL_TABLES } from "./control";
import type { BoundMigrationDriver } from "./drivers";
import { childrenBeforeParents, type TableReference } from "./drop-order";
import { introspectSchema } from "./push/planner";
import type { ForeignKeyDef, SchemaSnapshot } from "./types";
import { createQueryExecutor } from "./utils";

/** One table this reset drops, and the statement that drops it. */
interface PlannedTableDrop {
  readonly name: string;
  readonly sql: string;
}

/**
 * The COMPLETE clear, decided and rendered — and nothing executed.
 *
 * The split is the point (§6.2). Everything that can REFUSE the clear —
 * proving the namespace, reading the inventory, both containment refusals, the
 * drop order — is answered from catalog reads, so it belongs before the caller
 * enters a commit model at all. A refusal that has already been wrapped in
 * MySQL's partial-commit reporter tells the caller a database nothing touched
 * "failed partway through", and loses the metadata naming the constraint that
 * made it refuse.
 */
export interface LiveNamespaceResetPlan {
  /**
   * Every foreign key the estate owns, as an explicit drop, or SQLite's one
   * deferral of them all ({@link clearForeignKeys}).
   */
  readonly dropForeignKeys: string[];
  /** The tables this reset drops, in the order they will be dropped. */
  readonly dropTables: readonly PlannedTableDrop[];
  /** Managed enum drops, which run after the tables that use them. */
  readonly dropEnums: string[];
  /** The whole clear, in the order it runs: keys, then tables, then enums. */
  readonly clear: readonly string[];
}

export interface LiveNamespaceInventory {
  /** The estate's dependency graph, as the catalog describes it. */
  readonly snapshot: SchemaSnapshot;
  /** Every table in the configured namespace. */
  readonly tables: string[];
  /** Every managed enum type, on dialects that have them. */
  readonly enums: string[];
}

/**
 * Proves the configured namespace and reads what a reset would touch.
 *
 * ONE owner for both consumers — the effectful reset and the dry run that
 * previews it — because a preview computed a different way is not a preview.
 * `introspect` is what proves the namespace exists before anything is
 * published, and it refuses a foreign key with exactly one side inside the
 * estate, so a cross-namespace dependency is refused BEFORE the first DDL
 * rather than discovered after half the estate is gone.
 *
 * The snapshot describes the GRAPH; the bound catalog read decides MEMBERSHIP,
 * because a table the snapshot cannot model is still a table in this namespace
 * and a reset that skipped it would leave the estate half-cleared. For the same
 * reason the membership read is the one provider result this owner refuses to
 * treat as advisory: see {@link readNames}.
 */
export async function inventoryLiveNamespace(
  driver: AnyDriver,
  migrationDriver: BoundMigrationDriver
): Promise<LiveNamespaceInventory> {
  const snapshot = await introspectSchema(driver, migrationDriver);

  const executor = createQueryExecutor(driver);
  const inventory = migrationDriver.generateInventoryTables();
  const tables = readNames(
    await executor(inventory.sql, inventory.params),
    "table"
  ).filter(
    (name) =>
      migrationDriver.target.tables === undefined ||
      migrationDriver.target.tables.includes(name)
  );

  const enumInventory = migrationDriver.generateInventoryEnums();
  const enums = enumInventory
    ? readNames(
        await executor(enumInventory.sql, enumInventory.params),
        "managed enum"
      )
    : [];

  return {
    snapshot,
    tables,
    enums:
      migrationDriver.target.tables === undefined
        ? enums
        : enums.filter((name) =>
            snapshot.enums?.some((item) => item.name === name)
          ),
  };
}

/**
 * Decides and renders the COMPLETE clear, without executing any of it.
 *
 * Namespace proof, inventory, both containment refusals, foreign-key
 * materialization and drop order all happen here, so every way this clear can
 * refuse is answered from catalog reads alone — before the caller enters a
 * transaction or a sequential program, and therefore before anything can
 * describe a refusal as a partial commit (§6.2). It is also what lets a dry run
 * preview the effectful path rather than a second computation of it.
 *
 * @param driver - the producer to read the catalog on; the caller has already
 *   pinned and locked it where its dialect has a lock to take
 * @param migrationDriver - the estate-bound migration driver
 */
export async function planLiveNamespaceReset(
  driver: AnyDriver,
  migrationDriver: BoundMigrationDriver
): Promise<LiveNamespaceResetPlan> {
  const { snapshot, tables, enums } = await inventoryLiveNamespace(
    driver,
    migrationDriver
  );

  // MySQL is the one dialect whose DDL commits as it runs, and it cannot make
  // the tracking clear and the destructive DDL one transaction — so an inbound
  // foreign key to the declared tracking table has no safe order: dropping that
  // key first opens a window where the history rows are still there and their
  // schema is going away, and clearing or dropping the referenced table first
  // can simply be blocked.
  if (migrationDriver.target.dialect === "mysql") {
    assertNoInboundTrackingReference(snapshot, CONTROL_TABLES.state);
  }

  // Drop every foreign key the estate owns, explicitly, before any table
  // drop. This is what replaces `CASCADE` and `FOREIGN_KEY_CHECKS = 0`:
  // cycles and mutually-dropped tables are handled, and a dependency this
  // inventory does NOT represent aborts the operation instead of being
  // deleted with it.
  const dropForeignKeys = clearForeignKeys(
    migrationDriver,
    ownedForeignKeys(snapshot, tables)
  );

  // The control pair survives every clear: its structure is the history.
  const droppable = tables.filter(
    (name) => name !== CONTROL_TABLES.state && name !== CONTROL_TABLES.log
  );

  const dropTables: PlannedTableDrop[] = [];
  for (const table of dependencySafeOrder(droppable, snapshot)) {
    dropTables.push({
      name: table,
      sql: migrationDriver.generateDropTableSQL(table),
    });
  }

  // Managed enums go after their tables: a type still used by a column is
  // a dependency, and `RESTRICT` is the point.
  const dropEnums: string[] = [];
  for (const enumName of enums) {
    const statement = migrationDriver.generateDropEnumSQL(enumName);
    if (statement) {
      dropEnums.push(statement);
    }
  }

  return {
    dropForeignKeys,
    dropTables,
    dropEnums,
    clear: [
      ...dropForeignKeys,
      ...dropTables.map((table) => table.sql),
      ...dropEnums,
    ],
  };
}

/**
 * The statements that take the owned keys out of the way of the table drops.
 *
 * A dialect that keeps keys inline in `CREATE TABLE` (SQLite) cannot drop one
 * short of rebuilding its table, and its `DROP TABLE` checks the keys of every
 * row it removes, which a cycle or a self-referencing `RESTRICT` fails in any
 * order. There one statement defers every key to the COMMIT, by which point
 * each table holding one is gone.
 */
function clearForeignKeys(
  migrationDriver: BoundMigrationDriver,
  owned: Iterable<{ table: string; foreignKey: ForeignKeyDef }>
): string[] {
  const statements: string[] = [];
  for (const { table, foreignKey } of owned) {
    if (!migrationDriver.capabilities.supportsAddForeignKeyViaAlter) {
      return ["PRAGMA defer_foreign_keys = ON"];
    }
    statements.push(
      migrationDriver.generateDDL(
        { type: "dropForeignKey", tableName: table, fkName: foreignKey.name },
        { destination: "live" }
      )
    );
  }
  return statements;
}

/** Every foreign key owned by a table this reset is about to drop. */
function* ownedForeignKeys(
  snapshot: SchemaSnapshot,
  tables: readonly string[]
): Generator<{ table: string; foreignKey: ForeignKeyDef }> {
  const inventoried = new Set(tables);
  for (const table of snapshot.tables) {
    if (!inventoried.has(table.name)) {
      continue;
    }
    for (const foreignKey of table.foreignKeys) {
      yield { table: table.name, foreignKey };
    }
  }
}

/**
 * Children before parents, with a stable fallback for cycles.
 *
 * Every foreign key inside the estate has already been dropped by the time
 * these run, so the order is defence rather than necessity: it keeps a
 * constraint the inventory could not see from turning a reset into a failure
 * that has already dropped half the estate. A cycle's keys are already
 * dropped too, so its tables go in inventory order rather than deadlocking.
 */
function dependencySafeOrder(
  tables: readonly string[],
  snapshot: SchemaSnapshot
): string[] {
  const references: TableReference[] = [];
  for (const table of snapshot.tables) {
    for (const foreignKey of table.foreignKeys) {
      if (foreignKey.referencedTable !== table.name) {
        references.push({ from: table.name, to: foreignKey.referencedTable });
      }
    }
  }
  const { ordered, blocked } = childrenBeforeParents(
    tables,
    (name) => name,
    references
  );
  return [...ordered, ...blocked];
}

/** Refuses an inbound foreign key to the declared tracking table. */
function assertNoInboundTrackingReference(
  snapshot: SchemaSnapshot,
  trackingTableName: string
): void {
  for (const table of snapshot.tables) {
    for (const foreignKey of table.foreignKeys) {
      if (foreignKey.referencedTable !== trackingTableName) {
        continue;
      }
      throw new MigrationError(
        `Table "${table.name}" holds a foreign key "${foreignKey.name}" referencing the migration tracking table "${trackingTableName}", so this reset has no safe order and is refused before any statement runs. ` +
          "MySQL commits DDL implicitly, so the tracking rows cannot be cleared and the schema torn down as one operation; drop the constraint yourself and re-run.",
        VibORMErrorCode.MIGRATION_INVALID_STATE,
        {
          meta: {
            table: table.name,
            constraint: foreignKey.name,
            referencedTable: trackingTableName,
          },
        }
      );
    }
  }
}

/**
 * Why an inventory this read cannot trust refuses the WHOLE clear.
 *
 * One sentence for both refusals below, because they have one reason: the
 * alternative to refusing is a reset that clears part of a namespace and
 * reports success.
 */
const UNTRUSTED_INVENTORY =
  "A reset drops exactly what its inventory names and leaves everything else, so an inventory this read cannot trust would clear part of the namespace and report that it cleared all of it. The whole clear is refused before any statement runs.";

/**
 * Reads the `name` column off provider-shaped inventory rows, or REFUSES.
 *
 * The inventory is not a report; it is the DROP LIST. Everything it names is
 * destroyed and everything it does not name survives, so a row this read
 * SKIPPED took a real object off the list — the clear then reported success
 * over a namespace it had half cleared, and the rebuild that followed collided
 * with what was left. A repeated name is the same defect written differently:
 * one object planned twice while another was never planned at all.
 *
 * So the read fails closed, and it fails HERE — among
 * {@link planLiveNamespaceReset}'s catalog reads, before a destructive
 * statement exists to have run.
 */
function readNames(rows: readonly unknown[], inventory: string): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  for (const [index, row] of rows.entries()) {
    const name = readName(row, index, inventory);
    if (seen.has(name)) {
      throw new MigrationError(
        `The ${inventory} inventory for this reset named "${name}" twice, at position ${index}. ${UNTRUSTED_INVENTORY}`,
        VibORMErrorCode.MIGRATION_INVALID_STATE,
        {
          meta: { type: "duplicate-reset-inventory-name", resultIndex: index },
        }
      );
    }
    seen.add(name);
    names.push(name);
  }
  return names;
}

/** The one object an inventory row names, or the refusal it earns. */
function readName(row: unknown, index: number, inventory: string): string {
  // The cause is already an `Error` here: the one caller that has a thrown value
  // normalizes it through {@link errorCause} first. Deciding it here instead
  // meant a bare `thrown instanceof Error`, which BOTH dropped every non-`Error`
  // a provider row threw and, against a Proxy whose `getPrototypeOf` trap
  // throws, replaced this typed refusal with the trap's own error.
  const refuse = (reason: string, cause?: Error): MigrationError =>
    new MigrationError(
      `The ${inventory} inventory for this reset returned a row at position ${index} that does not name one object: ${reason}. ${UNTRUSTED_INVENTORY}`,
      VibORMErrorCode.MIGRATION_INVALID_STATE,
      {
        cause,
        meta: { type: "unreadable-reset-inventory", resultIndex: index },
      }
    );

  // The executor's contract is `unknown[]`, so this is where a provider row
  // becomes an object at all. A driver's own result contract already refuses a
  // non-object row (`drivers/normalized-result.ts`), which is why no falsifier
  // reaches this line through a driver; what it decides is that the answer for
  // a row from anywhere else is a refusal rather than a shorter drop list.
  if (typeof row !== "object" || row === null) {
    throw refuse(`the row is ${row === null ? "null" : `a ${typeof row}`}`);
  }

  let name: unknown;
  try {
    // Reading a column off a provider's row runs the provider's code, and its
    // failure is still this inventory refusing to be read.
    //
    // OWN properties only, because this inventory names objects a CATALOG
    // reported and a catalog reports columns: a `name` reached through the
    // prototype chain is a carrier's property or `Object.prototype` pollution,
    // and honouring one puts an object on the DROP LIST that no catalog ever
    // named. Asking whether the row owns the column runs the provider's code
    // too — a proxy answers that with a trap — so the ownership test shares
    // this `try` and refuses identically. It is not a second read of the value:
    // it consults the descriptor, not the getter.
    name = Object.hasOwn(row, "name") ? Reflect.get(row, "name") : undefined;
  } catch (failure) {
    throw refuse("reading its `name` threw", errorCause(failure));
  }

  if (typeof name !== "string") {
    throw refuse(
      `its \`name\` is ${name === undefined ? "not a column of the row" : `a ${typeof name}`}`
    );
  }
  // An empty name renders as a quoted nothing, so the statement it would
  // produce does not drop the object the provider meant to report.
  if (name.length === 0) {
    throw refuse("its `name` is the empty string");
  }
  return name;
}
