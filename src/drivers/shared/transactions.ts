import { TransactionError, VibORMErrorCode } from "@errors";
import type { IsolationLevel, TransactionOptions } from "../types";

const sqlIsolationLevels: Record<IsolationLevel, string> = {
  read_uncommitted: "READ UNCOMMITTED",
  read_committed: "READ COMMITTED",
  repeatable_read: "REPEATABLE READ",
  serializable: "SERIALIZABLE",
};

const postgresJsIsolationLevels: Record<IsolationLevel, string> = {
  read_uncommitted: "read uncommitted",
  read_committed: "read committed",
  repeatable_read: "repeatable read",
  serializable: "serializable",
};

export const getSqlIsolationLevel = (level: IsolationLevel): string => {
  const sqlLevel = sqlIsolationLevels[level];
  if (!sqlLevel) {
    throw new Error(`Unknown isolation level: ${level}`);
  }
  return sqlLevel;
};

export const getPostgresJsIsolationLevel = (level: IsolationLevel): string => {
  const sqlLevel = postgresJsIsolationLevels[level];
  if (!sqlLevel) {
    throw new Error(`Unknown isolation level: ${level}`);
  }
  return sqlLevel;
};

/**
 * SQLite transactions are always serializable. Reject weaker levels loudly
 * instead of silently ignoring them; "serializable" is honored as-is.
 */
export const assertSQLiteIsolationLevel = (
  driverName: string,
  options?: TransactionOptions
): void => {
  const level = options?.isolationLevel;
  if (level && level !== "serializable") {
    throw new TransactionError(
      `Driver "${driverName}" (SQLite) only supports serializable transactions; got "${level}".`,
      {
        code: VibORMErrorCode.INVALID_TRANSACTION_INPUT,
        meta: { driver: driverName, isolationLevel: level },
      }
    );
  }
};

export const runSavepoint = async <T>(
  executeStatement: (statement: string) => unknown | Promise<unknown>,
  fn: () => Promise<T>
): Promise<T> => {
  const savepointName = `sp_${crypto.randomUUID().replace(/-/g, "")}`;
  await executeStatement(`SAVEPOINT ${savepointName}`);

  try {
    const result = await fn();
    await executeStatement(`RELEASE SAVEPOINT ${savepointName}`);
    return result;
  } catch (error) {
    await executeStatement(`ROLLBACK TO SAVEPOINT ${savepointName}`);
    throw error;
  }
};
