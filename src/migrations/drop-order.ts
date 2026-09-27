/**
 * The order in which tables are dropped: children before parents.
 *
 * Two callers need it, with different premises. A generated program
 * (`orderTableDrops`, reached through `prepareSchemaProgram`) still has live
 * foreign keys when it drops a table, so an order that violates one fails,
 * and a cycle is broken only where a key's delete action allows it. A
 * namespace reset (`live-reset.ts`) has already dropped every key it can see,
 * so its order is defence and a cycle falls back to inventory order.
 * `childrenBeforeParents` is the one rule they share; what a cycle means stays
 * with each caller.
 */

import { MigrationError, VibORMErrorCode } from "../errors";
import type { DiffOperation, ReferentialAction, SchemaSnapshot } from "./types";

/** `from` holds a foreign key that references `to`. */
export interface TableReference {
  readonly from: string;
  readonly to: string;
}

/**
 * Orders `items` so that no item comes after a table it is referenced by.
 *
 * Each round takes every item no remaining item references, in input order, so
 * independent tables keep their given order. What a cycle leaves unordered is
 * returned as `blocked`, in input order; a reference from an item to itself
 * blocks that item.
 */
export function childrenBeforeParents<T>(
  items: readonly T[],
  nameOf: (item: T) => string,
  references: readonly TableReference[]
): { ordered: T[]; blocked: T[] } {
  const referencedBy = new Map<string, string[]>();
  for (const { from, to } of references) {
    const children = referencedBy.get(to);
    if (children) {
      children.push(from);
    } else {
      referencedBy.set(to, [from]);
    }
  }

  let remaining = [...items];
  const ordered: T[] = [];
  for (;;) {
    const names = new Set(remaining.map(nameOf));
    const isFree = (item: T) =>
      !referencedBy.get(nameOf(item))?.some((child) => names.has(child));
    const free = remaining.filter(isFree);
    if (free.length === 0) {
      return { ordered, blocked: remaining };
    }
    ordered.push(...free);
    remaining = remaining.filter((item) => !isFree(item));
  }
}

type DropTable = Extract<DiffOperation, { type: "dropTable" }>;

const tableOf = (drop: DropTable) => drop.tableName;

/** A key still active when its tables are dropped. */
interface ActiveKey extends TableReference {
  readonly columns: readonly string[];
  readonly onDelete: ReferentialAction | undefined;
}

/**
 * Orders a prepared program's `dropTable` operations from the foreign keys
 * the CURRENT snapshot says exist, children first wherever the keys allow.
 *
 * A key matters while it is still active when its tables are dropped: both of
 * its tables are dropped, and the program does not remove it with an explicit
 * `dropForeignKey`. PostgreSQL and MySQL remove every such key first
 * (`materializeDroppedTableForeignKeys`), so their drops keep the order they
 * were given. A retained table never references a dropped one: the desired
 * schema cannot, so the differ removes that key, and `sortOperations` runs
 * every `dropForeignKey` before every `dropTable`.
 *
 * SQLite holds keys inline and drops with enforcement on. `DROP TABLE` first
 * deletes every row, applying each key's delete action (`refusalOf`), so a
 * cycle is broken at a table whose drop no key can refuse, and refused before
 * any statement exists when no such table remains. The drops replace the band
 * of drops `sortOperations` emitted, where that band begins.
 */
export function orderTableDrops(
  operations: DiffOperation[],
  current: SchemaSnapshot
): DiffOperation[] {
  const drops = operations.filter(
    (operation): operation is DropTable => operation.type === "dropTable"
  );
  if (drops.length === 0) {
    return operations;
  }

  const dropped = new Set(drops.map(tableOf));
  const removedKeys = new Set<string>();
  for (const operation of operations) {
    if (operation.type === "dropForeignKey") {
      removedKeys.add(`${operation.tableName} ${operation.fkName}`);
    }
  }
  const keys: ActiveKey[] = [];
  for (const table of current.tables) {
    for (const fk of table.foreignKeys) {
      const active =
        dropped.has(table.name) &&
        dropped.has(fk.referencedTable) &&
        !removedKeys.has(`${table.name} ${fk.name}`);
      if (active) {
        keys.push({
          from: table.name,
          to: fk.referencedTable,
          columns: fk.columns,
          onDelete: fk.onDelete,
        });
      }
    }
  }
  // Children first: every key between two tables, and a self-reference that
  // refuses even its own table's delete.
  const childFirst = keys.filter(
    (key) => key.from !== key.to || key.onDelete === "restrict"
  );

  const ordered: DropTable[] = [];
  let remaining = drops;
  for (;;) {
    const step = childrenBeforeParents(remaining, tableOf, childFirst);
    ordered.push(...step.ordered);
    if (step.blocked.length === 0) {
      break;
    }
    const left = new Set(step.blocked.map(tableOf));
    const next = step.blocked.find(
      (drop) => !refusalOf(drop.tableName, keys, left)
    );
    if (!next) {
      throw cyclicDropRefusal(step.blocked.map(tableOf), keys);
    }
    ordered.push(next);
    remaining = step.blocked.filter((drop) => drop !== next);
  }

  const first = operations.findIndex(
    (operation) => operation.type === "dropTable"
  );
  const rest = operations.filter((operation) => operation.type !== "dropTable");
  return [...rest.slice(0, first), ...ordered, ...rest.slice(first)];
}

/**
 * The key that may refuse dropping `table` while the `existing` tables,
 * `table` among them, remain, if any.
 *
 * The implicit delete removes every row of `table`, and CASCADE extends it to
 * the rows of each remaining table that cascades from a deleted one. A
 * remaining key into a deleted table then decides: CASCADE deleted its rows
 * too and SET NULL clears them; RESTRICT refuses at once; NO ACTION and SET
 * DEFAULT are settled when the statement ends, by when a key held by `table`
 * has lost every row, while one held by another table may still point at
 * nothing. Measured on better-sqlite3 over random populated rows, for every
 * pair of actions on a two-table cycle in both orders and for each action on
 * a self-reference.
 */
function refusalOf(
  table: string,
  keys: readonly ActiveKey[],
  existing: ReadonlySet<string>
): ActiveKey | undefined {
  const deleted = new Set([table]);
  for (const name of deleted) {
    for (const key of keys) {
      if (
        key.to === name &&
        key.onDelete === "cascade" &&
        existing.has(key.from)
      ) {
        deleted.add(key.from);
      }
    }
  }
  return keys.find(
    (key) =>
      deleted.has(key.to) &&
      existing.has(key.from) &&
      key.onDelete !== "cascade" &&
      key.onDelete !== "setNull" &&
      (key.onDelete === "restrict" || key.from !== table)
  );
}

const ACTION_SQL: Record<ReferentialAction, string> = {
  cascade: "CASCADE",
  setNull: "SET NULL",
  restrict: "RESTRICT",
  noAction: "NO ACTION",
  setDefault: "SET DEFAULT",
};

/**
 * Names every blocked table and a key that refuses its drop, by columns:
 * SQLite introspection cannot read a key's name back.
 */
function cyclicDropRefusal(
  blocked: readonly string[],
  keys: readonly ActiveKey[]
): MigrationError {
  const left = new Set(blocked);
  const reasons = blocked.flatMap((table) => {
    const key = refusalOf(table, keys, left);
    return key
      ? [
          `dropping "${table}" is refused by ${key.from}(${key.columns.join(", ")}) -> ${key.to} ON DELETE ${ACTION_SQL[key.onDelete ?? "noAction"]}`,
        ]
      : [];
  });
  return new MigrationError(
    `Tables ${blocked.map((name) => `"${name}"`).join(", ")} cannot be dropped in an order that satisfies their foreign keys: ${reasons.join("; ")}. This database enforces those keys while it drops a table and cannot drop a key without rebuilding its table, so the whole plan is refused before any statement runs. ` +
      "Remove one of these relations, or change its delete action to SET NULL, in a separate change first; then drop the tables.",
    VibORMErrorCode.MIGRATION_INVALID_STATE,
    { meta: { type: "cyclic-table-drop" } }
  );
}
