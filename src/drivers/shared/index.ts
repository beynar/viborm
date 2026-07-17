/**
 * Shared Driver Utilities
 *
 * Re-exports common utilities for driver implementations.
 */

export {
  type MySQLConnectionOptions,
  mysqlResultParser,
  parseMySQLUrl,
} from "./mysql-utils";
export { normalizePostgresRowCount } from "./postgres-result";
export {
  classifySQLiteStatementResult,
  type SQLiteStatementResultKind,
} from "./sqlite-statement-classifier";
export {
  convertValuesForSQLite,
  isSQLiteBinaryValue,
  type SQLiteBinaryValue,
  sqliteBinaryToUint8Array,
  sqliteResultParser,
} from "./sqlite-utils";
export {
  assertNoTransactionOptions,
  createTransactionCleanupError,
  nestedTransactionDispatchError,
  type ProviderManagedTransaction,
  readTransactionCleanupFailures,
  runProviderManagedTransaction,
  runSavepoint,
  runTransactionLifecycle,
  type TransactionLifecycle,
  unsupportedCallbackTransactionError,
} from "./transactions";
