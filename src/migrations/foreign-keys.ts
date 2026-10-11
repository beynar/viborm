/**
 * The one DDL statement a transaction silently swallows.
 *
 * SQLite cannot alter a table in place, so `alterColumn`, `addForeignKey` and
 * both halves of a unique-constraint change go through
 * `SQLite3MigrationDriver.generateTableRecreation`: create `__new_<t>`, copy
 * the rows, `DROP TABLE <t>`, rename. `DROP TABLE` is the step that needs
 * foreign keys really disabled — with enforcement on, SQLite performs an
 * implicit `DELETE FROM` before removing the table, which either raises the
 * constraint or fires the referential action on every child row.
 *
 * `PRAGMA foreign_keys` is documented by SQLite as a NO-OP inside a
 * transaction, and all three places that execute generated DDL run the batch
 * inside one — `execute-dispatch.ts` and the SQLite recreation path.
 * MEASURED on better-sqlite3 at `5e5bc60`, recreating a populated table a
 * single child row pointed at:
 *
 *   - `onDelete: noAction` -> `DROP TABLE` threw `FOREIGN KEY constraint
 *     failed` and the push applied nothing;
 *   - `onDelete: cascade`  -> no error, and every child row was gone;
 *   - `onDelete: setNull`  -> no error, and every child's key was NULL.
 *
 * `PRAGMA defer_foreign_keys=ON` — the spelling SQLite does honor inside a
 * transaction — does not close it: it defers the violation counter the
 * implicit delete already incremented, so `noAction` merely moves its failure
 * from `DROP TABLE` to `COMMIT`, and the two silent halves stay silent.
 *
 * So the pragma is lifted out to bracket the transaction, which is SQLite's own
 * documented procedure — its step 1 (`PRAGMA foreign_keys=OFF`) precedes its
 * step 2 (`BEGIN`). Lifting it is what makes the disable real for the first
 * time, and a real disable is fail-open for the rest of the batch: a
 * `dropTable` sharing the batch would now orphan its children instead of
 * refusing. `assertForeignKeysIntact` is that hole closed — step 10 of the same
 * procedure — and it runs inside the transaction so a violation rolls the whole
 * batch back.
 */

import type { AnyDriver } from "../drivers/driver";
import { MigrationError, VibORMErrorCode } from "../errors";
import { createIdentifierQuoter } from "../sql/identifiers";

/**
 * `PRAGMA foreign_keys = OFF` / `= ON`, the only statement any migration driver
 * emits whose effect a transaction discards. Written by
 * `generateTableRecreation`; no other dialect emits it.
 */
const MATCH_FOREIGN_KEYS_PRAGMA =
  /^PRAGMA\s+foreign_keys\s*=\s*(ON|OFF)\s*;?$/i;

/** A statement's leading whitespace and SQL comments. */
const LEADING_TRIVIA = /^(?:\s+|--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)*/;

const DROPS_TABLE = /^DROP\s+TABLE\b/i;

/**
 * The `DROP TABLE` a recreation or a `dropTable` renders (`"name"`), and the
 * plain spelling a hand-written transition may use, optionally in `main`.
 */
const MATCH_DROP_TABLE =
  /^DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:(?:main|"main")\s*\.\s*)?(?:"((?:[^"]|"")+)"|([A-Za-z_][\w$]*))\s*;?\s*$/i;

const quote = createIdentifierQuoter('"');

export interface ForeignKeyBracket {
  /** Runs before the transaction opens. */
  readonly disable: string;
  /** Runs after it closes, however it closes. */
  readonly enable: string;
}

export interface LiftedStatements {
  /** `null` when nothing was lifted; the statements are then untouched. */
  readonly bracket: ForeignKeyBracket | null;
  readonly statements: string[];
}

/**
 * Whether this driver has no transaction to lift the pragmas out of — and so
 * nothing to prove the lift in.
 *
 * What the pragma does is the driver's declared claim: effectful SQLite work is
 * admitted only on a driver declaring `sqliteMigrationCapability`, whose
 * `foreignKeys: "pragma"` says `PRAGMA foreign_keys` between transactions takes
 * effect and reads back (`admission.ts` is that claim's one reader). The claim
 * is then verified on every lift. What is left is the transaction: without one,
 * a recreation that went wrong can neither be checked before it commits nor
 * rolled back, so it is refused (D1 is the stock case: one native batch, no
 * transaction).
 *
 * Exported because the SQLite driver asks the same question before it plans a
 * relation-bearing domain conversion (plan §7.4's D1 prerequisite).
 */
export function foreignKeyPragmasCannotBeLifted(driver: AnyDriver): boolean {
  return !driver.supportsTransactions;
}

/**
 * Takes the foreign-key pragmas out of a DDL batch so the caller can run them
 * around its transaction instead of inside it.
 *
 * Returns `bracket: null` — and the statements unchanged — when there is
 * nothing to lift, so every caller can run the result unconditionally. A batch
 * that needs the lift on a driver that cannot prove one is refused here,
 * before any of it runs.
 */
export function liftForeignKeyPragmas(
  driver: AnyDriver,
  statements: string[]
): LiftedStatements {
  let disable: string | null = null;
  let enable: string | null = null;
  const rest: string[] = [];

  for (const statement of statements) {
    const trimmed = statement.trim();
    const match = trimmed.match(MATCH_FOREIGN_KEYS_PRAGMA);
    if (!match) {
      rest.push(statement);
      continue;
    }
    if (match[1]?.toUpperCase() === "OFF") {
      disable ??= trimmed;
    } else {
      enable ??= trimmed;
    }
  }

  // Half a bracket would leave enforcement off past the batch. Leave the batch
  // exactly as it came instead, so it fails the way it failed before rather
  // than succeeding with the database unguarded.
  if (!(disable && enable)) {
    return { bracket: null, statements };
  }
  if (foreignKeyPragmasCannotBeLifted(driver)) {
    throw new MigrationError(
      `The driver "${driver.driverName}" runs migrations without a transaction, so a SQLite table recreation cannot be proven to keep the rows that reference it: if \`PRAGMA foreign_keys=OFF\` did not take, \`DROP TABLE\` would delete or null every child row and nothing could roll it back. ` +
        "The change is refused before any statement runs. Run it through a driver with transactions.",
      VibORMErrorCode.MIGRATION_UNSUPPORTED_PROVIDER,
      {
        meta: { driver: driver.driverName, feature: "SQLite table recreation" },
      }
    );
  }

  return { bracket: { disable, enable }, statements: rest };
}

interface ForeignKeyCheckRow {
  table?: unknown;
  parent?: unknown;
}

/**
 * Runs one body inside the lifted transaction: on `transaction`, with every
 * `DROP TABLE` counted around, then `PRAGMA foreign_key_check`.
 */
export type InsideLift = <R>(
  transaction: AnyDriver,
  body: (producer: AnyDriver) => Promise<R>
) => Promise<R>;

const unlifted: InsideLift = (transaction, body) => body(transaction);

/**
 * Runs `work` with enforcement really off, restoring it however `work` ends.
 * Call it OUTSIDE the transaction `work` opens — that placement is the whole
 * point — and run that transaction's statements through the `inside` it is
 * handed. Without a bracket nothing is lifted and `inside` adds nothing.
 *
 * The lift is verified, not assumed. The driver's `beforeForeignKeysOff` hook
 * runs first, and `PRAGMA foreign_keys` must read 0 after the disable — or the
 * change is refused before any of it runs — and 1 after the re-enable. Inside,
 * every table referencing a dropped table must keep its rows and its keys
 * across that `DROP TABLE`, which still catches a driver whose read-back lies,
 * and `PRAGMA foreign_key_check` must find nothing before the commit.
 */
export async function withForeignKeysLifted<T>(
  driver: AnyDriver,
  bracket: ForeignKeyBracket | null,
  work: (inside: InsideLift) => Promise<T>
): Promise<T> {
  if (!bracket) {
    return await work(unlifted);
  }

  await driver["beforeForeignKeysOff"]?.();
  await driver._executeRaw(terminate(bracket.disable));
  let completed = false;
  try {
    await assertEnforcement(driver, 0);
    const result = await work(async (transaction, body) => {
      const value = await body(keepingChildren(transaction));
      await assertForeignKeysIntact(transaction, bracket);
      return value;
    });
    completed = true;
    return result;
  } finally {
    await driver._executeRaw(terminate(bracket.enable));
    if (completed) await assertEnforcement(driver, 1);
  }
}

function terminate(statement: string): string {
  const trimmed = statement.trim();
  return trimmed.endsWith(";") ? trimmed : `${trimmed};`;
}

async function assertEnforcement(
  driver: AnyDriver,
  expected: 0 | 1
): Promise<void> {
  const { rows } = await driver._executeRaw<{ foreign_keys?: unknown }>(
    "PRAGMA foreign_keys;"
  );
  const read = rows[0]?.foreign_keys;
  if (Number(read) === expected) return;
  throw new MigrationError(
    expected === 0
      ? `PRAGMA foreign_keys reads ${String(read)} after PRAGMA foreign_keys=OFF on the driver "${driver.driverName}", so a SQLite table recreation would delete or null the rows that reference it. The change is refused before any statement runs; foreign keys were re-enabled.`
      : `The change committed, but PRAGMA foreign_keys reads ${String(read)} after PRAGMA foreign_keys=ON on the driver "${driver.driverName}": foreign keys may not be enforced on this connection. Disconnect the client before running other queries on it.`,
    VibORMErrorCode.MIGRATION_UNSUPPORTED_PROVIDER,
    { meta: { driver: driver.driverName, pragma: "foreign_keys", expected } }
  );
}

/**
 * `transaction`, with every `DROP TABLE` run between two counts of each table
 * that references the dropped one (built the way every execution view in this
 * layer is: an `Object.create` restating one member).
 *
 * With enforcement really off, `DROP TABLE` touches no other table. With it on
 * — a driver whose `PRAGMA foreign_keys` read-back lies — it deletes or nulls
 * every child row, which `foreign_key_check` cannot see afterwards. Counting
 * right around the statement, rather than around the whole batch, leaves the
 * batch free to write those rows itself.
 */
function keepingChildren(transaction: AnyDriver): AnyDriver {
  const view: AnyDriver = Object.create(transaction);
  Object.defineProperty(view, "_executeRaw", {
    value: async (sql: string, params?: unknown[]) => {
      const parent = droppedTable(sql);
      if (parent === undefined) {
        return await transaction._executeRaw(sql, params);
      }
      const children = await referencingColumns(transaction, parent);
      const before = await countChildren(transaction, children);
      const result = await transaction._executeRaw(sql, params);
      const after = await countChildren(transaction, children);
      const changed = [...children].flatMap(([child, columns], i) =>
        [`"${child}" rows`, ...columns.map((c) => `"${child}"."${c}" non-null`)]
          .map((label, k) => `${label} ${before[i]?.[k]} -> ${after[i]?.[k]}`)
          .filter((_, k) => before[i]?.[k] !== after[i]?.[k])
      );
      if (changed.length > 0) {
        throw new MigrationError(
          `Rows referencing "${parent}" changed when it was dropped with foreign keys lifted (${changed.join(", ")}), so the batch was rolled back. ` +
            "The driver did not really disable foreign keys, and DROP TABLE fired the referential actions.",
          VibORMErrorCode.MIGRATION_FAILED,
          { meta: { driver: transaction.driverName, table: parent } }
        );
      }
      return result;
    },
  });
  return view;
}

/**
 * The table a `DROP TABLE` statement drops, or `undefined` for any other
 * statement. A drop whose name it cannot read is refused: its children could
 * not be counted, and the census must not be skipped silently.
 */
function droppedTable(sql: string): string | undefined {
  const statement = sql.replace(LEADING_TRIVIA, "");
  if (!DROPS_TABLE.test(statement)) return;
  const match = statement.match(MATCH_DROP_TABLE);
  const name = match?.[1]?.replaceAll('""', '"') ?? match?.[2];
  if (name !== undefined) return name;
  throw new MigrationError(
    "A SQLite migration that recreates a table also runs a DROP TABLE whose table name cannot be read, so the rows referencing that table cannot be counted around the drop. " +
      'The batch was rolled back. Spell the drop as DROP TABLE "name" (or a plain identifier) in its own statement.',
    VibORMErrorCode.MIGRATION_FAILED
  );
}

/** Every other table with a foreign key to `parent`, and its referencing columns. */
async function referencingColumns(
  transaction: AnyDriver,
  parent: string
): Promise<Map<string, string[]>> {
  const { rows } = await transaction._executeRaw<{
    child: unknown;
    column: unknown;
  }>(
    `SELECT DISTINCT m."name" AS "child", f."from" AS "column" FROM sqlite_master AS m, pragma_foreign_key_list(m."name") AS f WHERE m."type" = 'table' AND f."table" = ? COLLATE NOCASE AND m."name" <> ? COLLATE NOCASE`,
    [parent, parent]
  );
  const children = new Map<string, string[]>();
  for (const row of rows) {
    const child = String(row.child);
    const columns = children.get(child) ?? [];
    columns.push(String(row.column));
    children.set(child, columns);
  }
  return children;
}

/** Per child: its row count, then the non-null count of each referencing column. */
async function countChildren(
  transaction: AnyDriver,
  children: ReadonlyMap<string, readonly string[]>
): Promise<number[][]> {
  const counts: number[][] = [];
  for (const [child, columns] of children) {
    const keys = columns.map(
      (column, k) => `, count(${quote(column)}) AS "k${k}"`
    );
    const { rows } = await transaction._executeRaw<Record<string, unknown>>(
      `SELECT count(*) AS "rows"${keys.join("")} FROM ${quote(child)}`
    );
    const row = rows[0] ?? {};
    counts.push([row.rows, ...columns.map((_, k) => row[`k${k}`])].map(Number));
  }
  return counts;
}

/**
 * Refuses a lifted batch that would commit against a broken reference: the
 * last statement `inside` runs, in the transaction, so the throw takes the
 * batch back. A no-op without a bracket.
 *
 * This is why the lift is not a fail-open trade. Lifting the pragma disables
 * enforcement for the whole batch, not just the recreation, so a `dropTable`
 * or a rebuild that sheds a referenced column could commit orphans the
 * un-lifted — and therefore never actually disabled — batch would have refused.
 * `PRAGMA foreign_key_check` is step 10 of SQLite's own recreation procedure.
 *
 * It cannot tell a reference the batch broke from one it merely found, and
 * refuses either way: SQLite's procedure says a reported violation means the
 * schema change is to be abandoned.
 */
export async function assertForeignKeysIntact(
  transaction: AnyDriver,
  bracket: ForeignKeyBracket | null
): Promise<void> {
  if (!bracket) {
    return;
  }

  const result = await transaction._executeRaw<ForeignKeyCheckRow>(
    "PRAGMA foreign_key_check;"
  );
  if (result.rows.length === 0) {
    return;
  }

  const offenders = [
    ...new Set(
      result.rows.map(
        (row) => `${String(row.table)} -> ${String(row.parent ?? "?")}`
      )
    ),
  ];
  throw new MigrationError(
    `Migration left ${result.rows.length} row(s) violating a foreign key (${offenders.join(", ")}). ` +
      "A SQLite table recreation runs with foreign keys disabled, so the batch was rolled back rather than committed against a broken reference.",
    VibORMErrorCode.MIGRATION_FAILED
  );
}
