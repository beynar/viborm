/**
 * The ONE live-namespace reset owner (§6.2).
 *
 * Three programs used to invent reset SQL: the CLI's own dynamic loop, the
 * dialect drivers' `generateResetSQL()`, and `push({ forceReset: true })`. They
 * disagreed — MySQL's dialect answer dropped nothing at all, and PostgreSQL's
 * enumerated `public` regardless of the estate — so this module replaces all
 * three. Migration `reset()` and force-reset push own different truths about
 * the tracking table, and that difference is a PARAMETER, never an inference
 * from whether a storage driver happens to exist.
 *
 * Containment is the point: the inventory is a bound catalog read scoped to the
 * configured namespace, foreign keys inside it are dropped explicitly rather
 * than cascaded away, and nothing here issues `DROP SCHEMA`, `DROP DATABASE`,
 * or `FOREIGN_KEY_CHECKS = 0`.
 *
 * The owner is TWO calls, and the seam between them is the first effect:
 * {@link planLiveNamespaceReset} decides and renders the whole clear from
 * catalog reads, and {@link executeLiveNamespaceReset} runs it. Every refusal
 * lives in the first, so no caller's commit-model reporter can restate a
 * containment refusal as a failure part-way through a program that never began.
 */

import type { AnyDriver } from "../drivers/driver";
import { errorCause } from "../drivers/shared/driver-options";
import { MigrationError, VibORMErrorCode } from "../errors";
import type { BoundMigrationDriver } from "./drivers";
import { introspectSchema } from "./push/planner";
import type { ForeignKeyDef, SchemaSnapshot } from "./types";
import { createQueryExecutor } from "./utils";

/**
 * What this reset does with the declared tracking table.
 *
 * - `preserve` — migration `reset()`: the table's STRUCTURE survives and only
 *   its rows are cleared, because the same command is about to replay the
 *   estate and restore them.
 * - `drop` — force-reset push: the table is an ordinary managed object of the
 *   selected namespace and goes with the rest. Push never reads or writes
 *   estate history, so it makes no history claim about the rows it removes.
 */
export type TrackingTablePolicy = "preserve" | "drop";

export interface LiveNamespaceResetPolicy {
  readonly trackingTable: TrackingTablePolicy;
  /**
   * The already-normalized tracking-table name.
   *
   * A primitive, deliberately: the routine must not have to guess which
   * inventoried table is special, and it must not be handed migration storage
   * to find out. A custom-named table this command did not declare is an
   * ordinary table here and receives no tracking-history claim.
   */
  readonly trackingTableName: string;
  /** Additional tables whose structure must survive the clear. */
  readonly preserveTables?: readonly string[];
}

export interface LiveNamespaceResetResult {
  /** Table names dropped, in the order they were dropped. */
  readonly dropped: string[];
}

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
   * Every table in the configured namespace, as the inventory read them.
   *
   * The MEMBERSHIP answer, which is not the same as {@link dropTables}: a
   * `preserve` policy keeps the tracking table, and the dry-run preview reports
   * the estate it inspected.
   */
  readonly tables: string[];
  /** The tracking-row clear, or `null` when this estate holds no such table. */
  readonly clearTracking: string | null;
  /** Every foreign key the estate owns, as an explicit drop. */
  readonly dropForeignKeys: string[];
  /** The tables this policy drops, in the order they will be dropped. */
  readonly dropTables: readonly PlannedTableDrop[];
  /** Managed enum drops, which run after the tables that use them. */
  readonly dropEnums: string[];
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
  );

  const enumInventory = migrationDriver.generateInventoryEnums();
  const enums = enumInventory
    ? readNames(
        await executor(enumInventory.sql, enumInventory.params),
        "managed enum"
      )
    : [];

  return { snapshot, tables, enums };
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
 * @param policy - the tracking-table truth this caller owns
 */
export async function planLiveNamespaceReset(
  driver: AnyDriver,
  migrationDriver: BoundMigrationDriver,
  policy: LiveNamespaceResetPolicy
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
    assertNoInboundTrackingReference(snapshot, policy.trackingTableName);
  }

  // Drop every foreign key the estate owns, explicitly, before any table
  // drop. This is what replaces `CASCADE` and `FOREIGN_KEY_CHECKS = 0`:
  // cycles and mutually-dropped tables are handled, and a dependency this
  // inventory does NOT represent aborts the operation instead of being
  // deleted with it.
  const dropForeignKeys: string[] = [];
  for (const { table, foreignKey } of ownedForeignKeys(snapshot, tables)) {
    dropForeignKeys.push(
      migrationDriver.generateDDL(
        { type: "dropForeignKey", tableName: table, fkName: foreignKey.name },
        { destination: "live" }
      )
    );
  }

  const preserved = new Set<string>(policy.preserveTables ?? []);
  if (policy.trackingTable === "preserve") {
    preserved.add(policy.trackingTableName);
  }
  const droppable = tables.filter((name) => !preserved.has(name));

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
    tables,
    clearTracking: tables.includes(policy.trackingTableName)
      ? migrationDriver.generateClearMigrations(policy.trackingTableName)
      : null,
    dropForeignKeys,
    dropTables,
    dropEnums,
  };
}

/**
 * Executes a planned clear. Every statement here CHANGES the estate.
 *
 * On PostgreSQL the caller wraps this in one transaction, so a failure rolls
 * every drop back. On MySQL DDL commits implicitly, which is why the tracking
 * rows are cleared FIRST — that clear commits immediately, so a later failure
 * can never leave rows claiming that now-missing objects are applied.
 *
 * The partial-commit REPORT is the caller's, not this owner's, and that is not
 * delegation for its own sake: the clear is only part of the program on both of
 * its MySQL callers — `reset()` replays the history after it and force-reset
 * rebuilds after it — so a boundary recorded here would fall silent at exactly
 * the point the caller keeps going. Both wrap this in `runSequentialProgram`
 * (`pinned-session.ts`), which records the boundary on the producer itself and
 * therefore spans the whole program. What that reporter must NOT span is the
 * planning above, which is why it is a separate call rather than this one's
 * first act.
 *
 * @param driver - the producer to execute on; the caller decides whether it is
 *   inside a transaction, and whether it is inside a sequential program
 * @param plan - the rendered clear, from {@link planLiveNamespaceReset}
 */
export async function executeLiveNamespaceReset(
  driver: AnyDriver,
  plan: LiveNamespaceResetPlan
): Promise<LiveNamespaceResetResult> {
  if (plan.clearTracking !== null) {
    await driver._executeRaw(plan.clearTracking);
  }

  for (const statement of plan.dropForeignKeys) {
    await driver._executeRaw(statement);
  }

  const dropped: string[] = [];
  for (const { name, sql } of plan.dropTables) {
    await driver._executeRaw(sql);
    dropped.push(name);
  }

  for (const statement of plan.dropEnums) {
    await driver._executeRaw(statement);
  }

  return { dropped };
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
 * that has already dropped half the estate.
 */
function dependencySafeOrder(
  tables: readonly string[],
  snapshot: SchemaSnapshot
): string[] {
  const remaining = new Set(tables);
  const referencedBy = new Map<string, Set<string>>();
  for (const table of snapshot.tables) {
    for (const foreignKey of table.foreignKeys) {
      if (foreignKey.referencedTable === table.name) {
        continue;
      }
      const dependants =
        referencedBy.get(foreignKey.referencedTable) ?? new Set<string>();
      dependants.add(table.name);
      referencedBy.set(foreignKey.referencedTable, dependants);
    }
  }

  const ordered: string[] = [];
  while (remaining.size > 0) {
    const free = [...remaining].filter((name) => {
      const dependants = referencedBy.get(name);
      if (!dependants) {
        return true;
      }
      for (const dependant of dependants) {
        if (remaining.has(dependant)) {
          return false;
        }
      }
      return true;
    });
    // A cycle leaves nothing free. Its keys are already dropped, so the
    // remaining names go in inventory order rather than deadlocking here.
    const batch = free.length > 0 ? free : [...remaining];
    for (const name of batch) {
      ordered.push(name);
      remaining.delete(name);
    }
  }
  return ordered;
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
