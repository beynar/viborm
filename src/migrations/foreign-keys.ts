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
 * inside one — `push/executor.ts`, `apply/index.ts` and `apply/down.ts`.
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

/**
 * `PRAGMA foreign_keys = OFF` / `= ON`, the only statement any migration driver
 * emits whose effect a transaction discards. Written by
 * `generateTableRecreation`; no other dialect emits it.
 */
const MATCH_FOREIGN_KEYS_PRAGMA =
  /^PRAGMA\s+foreign_keys\s*=\s*(ON|OFF)\s*;?$/i;

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
 * Takes the foreign-key pragmas out of a DDL batch so the caller can run them
 * around its transaction instead of inside it.
 *
 * Returns `bracket: null` — and the statements unchanged — when there is
 * nothing to lift or nothing to lift them out of, so every caller can run the
 * result unconditionally.
 */
/**
 * Whether this driver has no OUTSIDE to lift the pragmas to.
 *
 * A native batch is one round trip, so the pragma would have to travel inside
 * it — the very thing that does not work. Lifting it would mean a separate
 * statement on a connection the batch does not share, which is not something
 * this repo can measure: D1 is the only batch-only SQLite driver and nothing in
 * the estate exercises it. So that batch goes through untouched, exactly as it
 * did before, and the hole stays open there and named.
 *
 * Exported because the hole is also a REFUSAL condition, not only a lifting
 * one: a table recreation that has to preserve foreign keys cannot be admitted
 * on a substrate where the disable is a no-op, so the SQLite driver asks this
 * same question before it plans one (plan §7.4's D1 prerequisite).
 */
export function foreignKeyPragmasCannotBeLifted(driver: AnyDriver): boolean {
  return driver.supportsBatch;
}

export function liftForeignKeyPragmas(
  driver: AnyDriver,
  statements: string[]
): LiftedStatements {
  if (foreignKeyPragmasCannotBeLifted(driver)) {
    return { bracket: null, statements };
  }

  let disable: string | null = null;
  let enable: string | null = null;
  const rest: string[] = [];

  for (const statement of statements) {
    const match = statement.trim().match(MATCH_FOREIGN_KEYS_PRAGMA);
    if (!match) {
      rest.push(statement);
      continue;
    }
    if (match[1]?.toUpperCase() === "OFF") {
      disable ??= statement.trim();
    } else {
      enable ??= statement.trim();
    }
  }

  // Half a bracket would leave enforcement off past the batch. Leave the batch
  // exactly as it came instead, so it fails the way it failed before rather
  // than succeeding with the database unguarded.
  if (!(disable && enable)) {
    return { bracket: null, statements };
  }

  return { bracket: { disable, enable }, statements: rest };
}

interface ForeignKeyCheckRow {
  table?: unknown;
  parent?: unknown;
}

/**
 * Runs `work` with enforcement really off, restoring it however `work` ends.
 * Call it OUTSIDE the transaction `work` opens — that placement is the whole
 * point. A no-op when there is no bracket.
 */
export async function withForeignKeysLifted<T>(
  driver: AnyDriver,
  bracket: ForeignKeyBracket | null,
  work: () => Promise<T>
): Promise<T> {
  if (!bracket) {
    return await work();
  }

  await driver._executeRaw(terminate(bracket.disable));
  try {
    return await work();
  } finally {
    await driver._executeRaw(terminate(bracket.enable));
  }
}

function terminate(statement: string): string {
  const trimmed = statement.trim();
  return trimmed.endsWith(";") ? trimmed : `${trimmed};`;
}

/**
 * Refuses a lifted batch that would commit against a broken reference. Call it
 * from INSIDE the transaction, last, so the throw takes the batch back.
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
  driver: AnyDriver,
  bracket: ForeignKeyBracket | null
): Promise<void> {
  if (!bracket) {
    return;
  }

  const result = await driver._executeRaw<ForeignKeyCheckRow>(
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
