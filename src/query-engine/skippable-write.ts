import type { AnyDriver, QueryExecutionContext } from "@drivers";
import type { QueryResult } from "@drivers/types";
import { isVibORMError, VibORMErrorCode } from "@errors";
import type { Sql } from "@sql";

/**
 * Execute one duplicate-skippable write behind a savepoint (P6 pure-leaf
 * extraction, consumed by V2): a unique-constraint violation is swallowed to a
 * zero-row result — the `INSERT … skipDuplicates` semantics — while any other
 * error propagates. The savepoint isolates the rollback so the surrounding atomic
 * scope survives the swallowed conflict.
 */
export async function executeSkippableWrite(
  driver: AnyDriver,
  statement: Sql,
  context: QueryExecutionContext
): Promise<QueryResult<unknown>> {
  try {
    return await driver.withTransaction(
      (savepointDriver) => savepointDriver._execute(statement, context),
      undefined,
      context
    );
  } catch (error) {
    if (
      isVibORMError(error) &&
      error.code === VibORMErrorCode.UNIQUE_CONSTRAINT
    ) {
      return { rows: [], rowCount: 0 };
    }
    throw error;
  }
}
