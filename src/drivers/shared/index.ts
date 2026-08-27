/**
 * Shared Driver Utilities
 *
 * Re-exports common utilities for driver implementations.
 */

export { readCleanupFailures, withCleanupFailure } from "./cleanup-failure";
export {
  defineImmutableDriverFact,
  type MigrationNamespaceAttestation,
  resolveMigrationNamespaceAttestationOption,
  resolveNamespaceOption,
} from "./driver-options";
export {
  type MySQLConnectionOptions,
  parseMySQLUrl,
} from "./mysql-utils";
export {
  condemnedSessionError,
  type PinnedSessionControl,
  type PinnedSessionReservation,
  releaseReservedPostgresSession,
  unprovenLockStateError,
} from "./pinned-session";
export { normalizePostgresRowCount } from "./postgres-result";
export {
  classifySQLiteStatementResult,
  isSQLiteInsertStatement,
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
  acquireWithMaxWait,
  type BatchTransactionOptions,
  type DriverTransactionOptions,
  type IsolationLevelPlacement,
  isolationLevelStatement,
  type MaxWaitSupport,
  parseTransactionOptions,
  resolveTransactionPlan,
  runWithTransactionTimeout,
  TRANSACTION_ISOLATION_LEVELS,
  type TransactionForm,
  type TransactionIsolationLevel,
  type TransactionOptionContext,
  type TransactionOptionSupport,
  type TransactionOptions,
  type TransactionPlan,
  transactionMaxWaitError,
  transactionTimeoutError,
} from "./transaction-options";
export {
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
