import {
  CacheConfigurationError,
  CacheInvalidKeyError,
  CacheInvalidTTLError,
  CacheOperationNotCacheableError,
  CheckConstraintError,
  ClientInitializationError,
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
  UnsupportedOperationError,
  ValidationError,
  type ValidationErrorSource,
  ValueTooLongError,
  VibORMError,
  VibORMErrorCode,
  type VibORMErrorMeta,
} from "@errors";
import type { Operation } from "@query-engine/types";
import {
  isArrayValue,
  isError,
  isRecord,
  safeArrayLength,
  safeOwnPropertyDescriptor,
} from "../errors/diagnostic-safety";
import { transferLoggedErrorEvidence } from "../instrumentation/logged-errors";
import type { Dialect } from "./types";

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
  /**
   * The SQL family that raised the error, when the normalizing call site knows
   * it. Only numeric provider codes need it: a symbolic name or a message
   * symbol identifies its own provider, but a bare integer does not.
   */
  dialect?: Dialect;
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
    isRecord(snapshotMeta) ? snapshotMeta : {},
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

/** Clone one trusted failure with the exact durable write state now known. */
export function attachCommitCertainty(
  error: VibORMError,
  commitCertainty: NonNullable<VibORMErrorMeta["commitCertainty"]>
): VibORMError {
  const snapshot = VibORMError.prototype.toJSON.call(error);
  const snapshotMeta = readProperty(snapshot, "meta");
  const meta = sanitizeErrorMetadata(
    isRecord(snapshotMeta) ? snapshotMeta : {}
  );
  meta.commitCertainty = commitCertainty;
  return cloneVibORMError(error, meta, snapshot, undefined);
}

function cloneVibORMError(
  error: VibORMError,
  meta: VibORMErrorMeta,
  snapshot: Record<string, unknown>,
  diagnostics: DiagnosticDisclosure | undefined
): VibORMError {
  if (error instanceof ValidationError) {
    const validationClone = cloneValidationError(error, meta, diagnostics);
    if (validationClone) {
      transferLoggedErrorEvidence(error, validationClone);
      return validationClone;
    }
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
    ...(isError(cause) ? { cause } : {}),
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
  transferLoggedErrorEvidence(error, clonedError);
  return clonedError;
}

function cloneValidationError(
  error: ValidationError,
  meta: VibORMErrorMeta,
  diagnostics: DiagnosticDisclosure | undefined
): ValidationError | undefined {
  const source = snapshotValidationSource(readProperty(error, "source"));
  const issues = readProperty(error, "issues");
  if (!(source && isArrayValue(issues))) return undefined;
  const issueSnapshot = snapshotValidationIssues(issues);
  const cause = getTrustedErrorCause(error);
  return new ValidationError(source, issueSnapshot, {
    ...(isError(cause) ? { cause } : {}),
    diagnostics,
    meta,
  });
}

function snapshotValidationSource(
  value: unknown
): ValidationErrorSource | undefined {
  if (!isRecord(value)) return undefined;
  const kind = readProperty(value, "kind");
  if (kind === "operation") {
    const operation = readProperty(value, "operation");
    const model = readProperty(value, "model");
    if (!isOperation(operation)) return undefined;
    return {
      kind,
      operation,
      ...(typeof model === "string" ? { model } : {}),
    };
  }
  if (kind === "registry") {
    const model = readProperty(value, "model");
    const property = readProperty(value, "property");
    return {
      kind,
      ...(typeof model === "string" ? { model } : {}),
      ...(typeof property === "string" ? { property } : {}),
    };
  }
  if (kind === "schema-builder") {
    const builder = readProperty(value, "builder");
    const path = readProperty(value, "path");
    if (!(typeof builder === "string" && typeof path === "string")) {
      return undefined;
    }
    return { kind, builder, path };
  }
  if (kind === "json-schema") {
    const target = readProperty(value, "target");
    const schemaType = readProperty(value, "schemaType");
    return {
      kind,
      ...(typeof target === "string" ? { target } : {}),
      ...(typeof schemaType === "string" ? { schemaType } : {}),
    };
  }
  return undefined;
}

function snapshotValidationIssues(value: unknown[]): Array<{
  path: string;
  message: string;
}> {
  const issues: Array<{ path: string; message: string }> = [];
  const length = Math.min(safeArrayLength(value), 128);
  for (let index = 0; index < length; index += 1) {
    const descriptor = safeOwnPropertyDescriptor(value, String(index));
    if (!(descriptor && "value" in descriptor && isRecord(descriptor.value))) {
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
      "deleteManyAndReturn",
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

// Every concrete VibORMError subclass whose identity must survive cloning.
// ValidationError is absent on purpose: cloneValidationError handles it.
const CLONE_CONSTRUCTORS = [
  CacheConfigurationError,
  CacheInvalidKeyError,
  CacheInvalidTTLError,
  CacheOperationNotCacheableError,
  CheckConstraintError,
  ClientInitializationError,
  ConnectionError,
  FeatureNotSupportedError,
  ForeignKeyError,
  InvalidTransactionInputError,
  MigrationError,
  NestedWriteAssertionError,
  NestedWriteError,
  NotFoundError,
  NotNullConstraintError,
  PendingOperationError,
  QueryEngineError,
  QueryError,
  TransactionError,
  UniqueConstraintError,
  UnsupportedOperationError,
  ValueTooLongError,
] as const;

function getCloneConstructor(error: VibORMError): unknown {
  try {
    const prototype = Object.getPrototypeOf(error);
    return (
      CLONE_CONSTRUCTORS.find((ctor) => ctor.prototype === prototype) ??
      VibORMError
    );
  } catch {
    return VibORMError;
  }
}

function isVibORMErrorCode(value: unknown): value is VibORMErrorCode {
  return Object.values(VibORMErrorCode).some((code) => code === value);
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
