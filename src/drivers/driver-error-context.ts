import {
  CacheConfigurationError,
  CacheInvalidKeyError,
  CacheInvalidTTLError,
  CacheOperationNotCacheableError,
  CheckConstraintError,
  ConnectionError,
  type DiagnosticDisclosure,
  FeatureNotSupportedError,
  ForeignKeyError,
  getTrustedErrorCause,
  InvalidTransactionInputError,
  MigrationError,
  NestedWriteAssertionError,
  NestedWriteError,
  NotFoundError,
  NotNullConstraintError,
  PendingOperationError,
  QueryEngineError,
  QueryError,
  resolveDiagnosticDisclosure,
  sanitizeErrorMetadata,
  TransactionError,
  UniqueConstraintError,
  ValidationError,
  VibORMError,
  VibORMErrorCode,
  type VibORMErrorMeta,
} from "@errors";
import type { Operation } from "@query-engine/types";

export interface DriverErrorShape {
  code?: string | number;
  bodyCode?: string | number;
  errno?: number;
  constraint?: string;
  table?: string;
  column?: string;
  constraint_name?: string;
  table_name?: string;
  column_name?: string;
  sqlState?: string;
  sqlstate?: string;
  status?: string | number;
  statusCode?: string | number;
}

export interface DriverErrorContext {
  driverName: string;
  model?: string;
  operation?: Operation | string;
  correlationId?: string;
  statementIndex?: number;
  query?: string;
  params?: unknown[];
  diagnostics?: DiagnosticDisclosure;
  forceContext?: boolean;
}

const EXECUTION_META_KEYS = [
  "driver",
  "model",
  "operation",
  "correlationId",
  "query",
  "params",
] as const;
const MYSQL_SQLSTATE_IN_MESSAGE_PATTERN = /\(sqlstate ([^)]+)\)/i;
const MYSQL_KEY_IN_MESSAGE_PATTERN = /for key '([^']+)'/;

function readProperty(value: object, key: string): unknown {
  try {
    return Reflect.get(value, key);
  } catch {
    return undefined;
  }
}

export function attachExecutionContext(
  error: VibORMError,
  context: DriverErrorContext
): VibORMError {
  const snapshot = VibORMError.prototype.toJSON.call(error);
  const snapshotMeta = readProperty(snapshot, "meta");
  const mergedMeta = sanitizeErrorMetadata(
    isRecordValue(snapshotMeta) ? snapshotMeta : {},
    context.diagnostics
  );
  const forceContext = context.forceContext !== false;
  if (!forceContext) {
    return cloneVibORMError(error, mergedMeta, snapshot, context.diagnostics);
  }
  const additions = sanitizeErrorMetadata(
    buildMeta({}, context, ""),
    context.diagnostics
  );
  for (const key of EXECUTION_META_KEYS) {
    Reflect.deleteProperty(mergedMeta, key);
  }
  for (const key of Reflect.ownKeys(additions)) {
    if (typeof key !== "string") continue;
    Object.defineProperty(mergedMeta, key, {
      configurable: true,
      enumerable: true,
      value: additions[key],
      writable: true,
    });
  }
  return cloneVibORMError(error, mergedMeta, snapshot, context.diagnostics);
}

function cloneVibORMError(
  error: VibORMError,
  meta: VibORMErrorMeta,
  snapshot: Record<string, unknown>,
  diagnostics: DiagnosticDisclosure | undefined
): VibORMError {
  if (error instanceof ValidationError) {
    const validationClone = cloneValidationError(error, meta, diagnostics);
    if (validationClone) return validationClone;
  }
  const message =
    typeof snapshot.message === "string"
      ? snapshot.message
      : "VibORM operation failed";
  const code = isVibORMErrorCode(snapshot.code)
    ? snapshot.code
    : VibORMErrorCode.INTERNAL_ERROR;
  const cause = getTrustedErrorCause(error);
  const options = {
    ...(isErrorValue(cause) ? { cause } : {}),
    diagnostics,
    meta,
  };
  const cloneConstructor = getCloneConstructor(error);
  const newTarget =
    typeof cloneConstructor === "function" ? cloneConstructor : VibORMError;
  let candidate: unknown;
  try {
    candidate = Reflect.construct(
      VibORMError,
      [message, code, options],
      newTarget
    );
  } catch {
    candidate = new VibORMError(message, code, options);
  }
  const clonedError =
    candidate instanceof VibORMError
      ? candidate
      : new VibORMError(message, code, options);
  return clonedError;
}

function cloneValidationError(
  error: ValidationError,
  meta: VibORMErrorMeta,
  diagnostics: DiagnosticDisclosure | undefined
): ValidationError | undefined {
  const operation = readProperty(error, "operation");
  const issues = readProperty(error, "issues");
  if (!(isOperation(operation) && isArrayValue(issues))) return undefined;
  const issueSnapshot = snapshotValidationIssues(issues);
  return new ValidationError(operation, issueSnapshot, { diagnostics, meta });
}

function snapshotValidationIssues(value: unknown[]): Array<{
  path: string;
  message: string;
}> {
  const issues: Array<{ path: string; message: string }> = [];
  const rawLength = readProperty(value, "length");
  const length =
    typeof rawLength === "number" && Number.isSafeInteger(rawLength)
      ? Math.min(rawLength, 128)
      : 0;
  for (let index = 0; index < length; index += 1) {
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Reflect.getOwnPropertyDescriptor(value, String(index));
    } catch {
      continue;
    }
    if (
      !(descriptor && "value" in descriptor && isRecordValue(descriptor.value))
    ) {
      continue;
    }
    const path = readProperty(descriptor.value, "path");
    const message = readProperty(descriptor.value, "message");
    if (typeof path !== "string" || typeof message !== "string") continue;
    issues.push({ path, message });
  }
  return issues;
}

function isOperation(value: unknown): value is Operation {
  return (
    typeof value === "string" &&
    [
      "aggregate",
      "count",
      "create",
      "createMany",
      "createManyAndReturn",
      "delete",
      "deleteMany",
      "exist",
      "findFirst",
      "findMany",
      "findUnique",
      "groupBy",
      "update",
      "updateMany",
      "updateManyAndReturn",
      "upsert",
    ].includes(value)
  );
}

function getCloneConstructor(error: VibORMError): unknown {
  try {
    const prototype = Object.getPrototypeOf(error);
    if (prototype === CacheConfigurationError.prototype) {
      return CacheConfigurationError;
    }
    if (prototype === CacheInvalidKeyError.prototype) {
      return CacheInvalidKeyError;
    }
    if (prototype === CacheInvalidTTLError.prototype) {
      return CacheInvalidTTLError;
    }
    if (prototype === CacheOperationNotCacheableError.prototype) {
      return CacheOperationNotCacheableError;
    }
    if (prototype === CheckConstraintError.prototype) {
      return CheckConstraintError;
    }
    if (prototype === ConnectionError.prototype) return ConnectionError;
    if (prototype === FeatureNotSupportedError.prototype) {
      return FeatureNotSupportedError;
    }
    if (prototype === ForeignKeyError.prototype) return ForeignKeyError;
    if (prototype === InvalidTransactionInputError.prototype) {
      return InvalidTransactionInputError;
    }
    if (prototype === MigrationError.prototype) return MigrationError;
    if (prototype === NestedWriteAssertionError.prototype) {
      return NestedWriteAssertionError;
    }
    if (prototype === NestedWriteError.prototype) return NestedWriteError;
    if (prototype === NotFoundError.prototype) return NotFoundError;
    if (prototype === NotNullConstraintError.prototype) {
      return NotNullConstraintError;
    }
    if (prototype === PendingOperationError.prototype) {
      return PendingOperationError;
    }
    if (prototype === QueryEngineError.prototype) return QueryEngineError;
    if (prototype === QueryError.prototype) return QueryError;
    if (prototype === TransactionError.prototype) return TransactionError;
    if (prototype === UniqueConstraintError.prototype) {
      return UniqueConstraintError;
    }
    return VibORMError;
  } catch {
    return VibORMError;
  }
}

function isVibORMErrorCode(value: unknown): value is VibORMErrorCode {
  return Object.values(VibORMErrorCode).some((code) => code === value);
}

function isRecordValue(value: unknown): value is Record<string, unknown> {
  try {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  } catch {
    return false;
  }
}

function isArrayValue(value: unknown): value is unknown[] {
  try {
    return Array.isArray(value);
  } catch {
    return false;
  }
}

function isErrorValue(value: unknown): value is Error {
  try {
    return value instanceof Error;
  } catch {
    return false;
  }
}

export function buildMeta(
  error: DriverErrorShape,
  context: DriverErrorContext,
  message: string
): VibORMErrorMeta {
  const meta: VibORMErrorMeta = { driver: context.driverName };
  const disclosure = resolveDiagnosticDisclosure(context.diagnostics);

  if (context.model) meta.model = context.model;
  if (context.operation) meta.operation = context.operation;
  if (context.correlationId) meta.correlationId = context.correlationId;
  if (context.statementIndex !== undefined) {
    meta.statementIndex = context.statementIndex;
  }
  if (disclosure.includeSql && context.query !== undefined) {
    meta.query = context.query;
  }
  if (disclosure.includeParams && context.params !== undefined) {
    meta.params = context.params;
  }

  const providerCode = error.code ?? error.bodyCode;
  if (typeof providerCode === "string" || typeof providerCode === "number") {
    meta.providerCode = providerCode;
  }
  if (typeof error.errno === "number") meta.providerErrno = error.errno;
  const sqlState =
    error.sqlState ??
    error.sqlstate ??
    MYSQL_SQLSTATE_IN_MESSAGE_PATTERN.exec(message)?.[1];
  if (typeof sqlState === "string") meta.providerSqlState = sqlState;
  const status = error.status ?? error.statusCode;
  if (typeof status === "string" || typeof status === "number") {
    meta.providerStatus = status;
  }

  const constraint = error.constraint ?? error.constraint_name;
  const table = error.table ?? error.table_name;
  const column = error.column ?? error.column_name;
  if (constraint) meta.constraint = constraint;
  if (table) meta.table = table;
  if (column) meta.columns = [column];

  if (!meta.constraint) {
    const key = MYSQL_KEY_IN_MESSAGE_PATTERN.exec(message)?.[1];
    if (key) {
      const dotIndex = key.indexOf(".");
      if (dotIndex === -1) {
        meta.constraint = key;
      } else {
        meta.constraint = key.slice(dotIndex + 1);
        if (!meta.table) meta.table = key.slice(0, dotIndex);
      }
    }
  }
  return meta;
}
