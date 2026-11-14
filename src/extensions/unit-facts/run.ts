import { QueryError } from "@errors";
import type { Sql } from "@sql";
import { sourceOf, type Unit } from "../unit-source";

/**
 * For a `transaction` unit: runs `sql` in the transaction and gives its
 * rows. Called before `next()`, it opens the transaction and runs before
 * anything else does; the transaction's body waits for the innermost
 * `next()`. A savepoint is no transaction.
 */
export function run(
  unit: Unit,
  sql: Sql
): Promise<readonly Record<string, unknown>[]> {
  const send = sourceOf(unit)?.run;
  return send === undefined
    ? Promise.reject(
        new QueryError("run() needs the transaction unit a handler received.")
      )
    : send(sql);
}
