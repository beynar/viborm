import {
  boundTrustedString,
  createSafeRecord,
  defineHidden,
  defineSafe,
  filterSafeErrorProperty,
  freezeDiagnosticValue,
  getNestedCause,
  isError,
  isRecord,
  MAX_DIAGNOSTIC_ARRAY_LENGTH,
  MAX_DIAGNOSTIC_ENTRIES,
  SAFE_ERROR_KEYS,
  safeArrayLength,
  safeDateString,
  safeErrorString,
  safeHasOwn,
  safeOwnPropertyDescriptor,
  safeRead,
  sanitizeBytes,
  sanitizeProviderCode,
  sanitizeProviderErrno,
  sanitizeProviderStatus,
  sanitizeSqlState,
  sanitizeString,
  sanitizeTrustedCode,
  TRUNCATED_DIAGNOSTIC_VALUE,
  UNREADABLE_DIAGNOSTIC_VALUE,
} from "./diagnostic-safety";

export interface DiagnosticDisclosure {
  includeSql?: boolean | undefined;
  includeParams?: boolean | undefined;
}

export interface ResolvedDiagnosticDisclosure {
  includeSql: boolean;
  includeParams: boolean;
}

interface SanitizeState {
  readonly disclosure: ResolvedDiagnosticDisclosure;
  readonly seen: WeakSet<object>;
  entries: number;
  characters: number;
}

interface TrustedErrorSnapshot {
  readonly cause?: Error | undefined;
  readonly code: string;
  readonly disclosure: ResolvedDiagnosticDisclosure;
  readonly message: string;
  readonly meta: Record<string, unknown>;
  readonly name: string;
  readonly timestamp: string;
}

const MAX_DEPTH = 8;
const SQL_KEYS = new Set(["query", "querytext", "sql", "statement"]);
const PARAMETER_KEYS = new Set([
  "arguments",
  "bindings",
  "parameters",
  "params",
  "values",
]);
const CAUSE_KEYS = new Set(["cause", "originalcause"]);
const ERROR_META_KEYS = new Set([
  "actualChecksum",
  "actualResultCount",
  "actualRowCount",
  "autoIncrement",
  "column",
  "columns",
  "conflictsWith",
  "constraint",
  "context",
  "correlationId",
  "dialect",
  "driver",
  "expectedChecksum",
  "expectedResultCount",
  "expectedRowCount",
  "expectedStatementCount",
  "feature",
  "field",
  "hint",
  "indexName",
  "indexType",
  "method",
  "migrationIndex",
  "migrationName",
  "migrationsDir",
  "model",
  "operation",
  "params",
  "providerCode",
  "providerErrno",
  "providerSqlState",
  "providerStatus",
  "query",
  "relation",
  "relations",
  "representation",
  "resultIndex",
  "scalarType",
  "statementIndex",
  "step",
  "strategy",
  "table",
  "timeout",
  "type",
]);
const LOG_META_KEYS = new Set(["event", "status"]);
const STRING_META_KEYS = new Set([
  "actualChecksum",
  "column",
  "conflictsWith",
  "constraint",
  "context",
  "correlationId",
  "dialect",
  "driver",
  "expectedChecksum",
  "feature",
  "field",
  "hint",
  "indexName",
  "indexType",
  "method",
  "migrationName",
  "migrationsDir",
  "model",
  "operation",
  "relation",
  "representation",
  "scalarType",
  "step",
  "strategy",
  "table",
  "type",
]);
const STRING_ARRAY_META_KEYS = new Set(["columns", "relations"]);
const NUMBER_META_KEYS = new Set([
  "actualResultCount",
  "actualRowCount",
  "expectedResultCount",
  "expectedRowCount",
  "expectedStatementCount",
  "migrationIndex",
  "resultIndex",
  "statementIndex",
  "timeout",
]);
const REDACTED_CAUSE_MESSAGE = "Underlying error details redacted";
const REDACTED_ERROR_MESSAGE = "Error details redacted";
const CIRCULAR_VALUE = "[Circular]";
const TRUNCATED_VALUE = TRUNCATED_DIAGNOSTIC_VALUE;
const UNREADABLE_VALUE = UNREADABLE_DIAGNOSTIC_VALUE;
const TRUSTED_ERROR_SNAPSHOT = Symbol("viborm.trustedErrorSnapshot");

export function resolveDiagnosticDisclosure(
  disclosure?: DiagnosticDisclosure
): ResolvedDiagnosticDisclosure {
  try {
    return {
      includeSql: disclosure?.includeSql === true,
      includeParams: disclosure?.includeParams === true,
    };
  } catch {
    return { includeSql: false, includeParams: false };
  }
}

export function sanitizeErrorMetadata(
  value: Record<string, unknown>,
  disclosure?: DiagnosticDisclosure
): Record<string, unknown> {
  return sanitizeAllowedRecord(value, ERROR_META_KEYS, disclosure, false);
}

export function sanitizeLogMetadata(
  value: Record<string, unknown>,
  disclosure?: DiagnosticDisclosure
): Record<string, unknown> {
  return sanitizeAllowedRecord(value, LOG_META_KEYS, disclosure, true);
}

export function sanitizeDiagnosticParameters(
  value: unknown,
  disclosure?: DiagnosticDisclosure
): unknown {
  return sanitizeUnknown(value, createState(disclosure), 0, false, true);
}

export function sanitizeErrorForLogging(
  error: Error,
  disclosure?: DiagnosticDisclosure
): Error {
  try {
    return sanitizeError(error, createState(disclosure), 0, false);
  } catch {
    return new Error(UNREADABLE_VALUE);
  }
}

export function sanitizeErrorCause(error: Error): Error {
  try {
    return sanitizeError(error, createState(), 0, true);
  } catch {
    return new Error(REDACTED_CAUSE_MESSAGE);
  }
}

export function serializeSanitizedError(
  error: Error | undefined
): Record<string, unknown> | undefined {
  if (!error) return undefined;
  try {
    return serializeError(error, createState(), 0);
  } catch {
    const fallback = createSafeRecord();
    defineSafe(fallback, "name", "Error");
    defineSafe(fallback, "message", UNREADABLE_VALUE);
    return fallback;
  }
}

export function registerTrustedError(
  error: Error,
  snapshot: {
    cause?: Error | undefined;
    code: string;
    disclosure?: DiagnosticDisclosure | undefined;
    message: string;
    meta: Record<string, unknown>;
    name: string;
    timestamp: Date;
  }
): void {
  const disclosure = resolveDiagnosticDisclosure(snapshot.disclosure);
  const trusted: TrustedErrorSnapshot = Object.freeze({
    cause: snapshot.cause
      ? freezeDiagnosticValue(
          sanitizeError(snapshot.cause, createState(), 0, true)
        )
      : undefined,
    code: sanitizeTrustedCode(snapshot.code),
    disclosure,
    message: boundTrustedString(snapshot.message),
    meta: freezeDiagnosticValue(
      sanitizeErrorMetadata(snapshot.meta, disclosure)
    ),
    name: boundTrustedString(snapshot.name),
    timestamp: safeDateString(snapshot.timestamp),
  });
  defineHidden(error, TRUSTED_ERROR_SNAPSHOT, trusted);
}

export function serializeTrustedError(
  error: Error
): Record<string, unknown> | undefined {
  const snapshot = getTrustedErrorSnapshot(error);
  if (!snapshot) return undefined;
  const serialized = createSafeRecord();
  defineSafe(serialized, "name", snapshot.name);
  defineSafe(serialized, "message", snapshot.message);
  defineSafe(serialized, "code", snapshot.code);
  defineSafe(
    serialized,
    "meta",
    sanitizeErrorMetadata(snapshot.meta, snapshot.disclosure)
  );
  defineSafe(serialized, "timestamp", snapshot.timestamp);
  defineSafe(serialized, "cause", serializeSanitizedError(snapshot.cause));
  return serialized;
}

export function getTrustedErrorCause(error: Error): Error | undefined {
  return getTrustedErrorSnapshot(error)?.cause;
}

function createState(disclosure?: DiagnosticDisclosure): SanitizeState {
  return {
    disclosure: resolveDiagnosticDisclosure(disclosure),
    seen: new WeakSet<object>(),
    entries: 0,
    characters: 0,
  };
}

function sanitizeUnknown(
  value: unknown,
  state: SanitizeState,
  depth: number,
  insideCause: boolean,
  insideParameters: boolean
): unknown {
  try {
    if (depth > MAX_DEPTH || state.entries >= MAX_DIAGNOSTIC_ENTRIES) {
      return TRUNCATED_VALUE;
    }
    if (typeof value === "string") {
      return insideCause
        ? REDACTED_CAUSE_MESSAGE
        : sanitizeString(value, state);
    }
    if (
      value === null ||
      typeof value === "number" ||
      typeof value === "boolean"
    ) {
      return value;
    }
    if (typeof value === "bigint") {
      return sanitizeString(value.toString(), state);
    }
    if (typeof value === "undefined") return "[Undefined]";
    if (typeof value === "symbol") return sanitizeString(String(value), state);
    if (typeof value === "function") return "[Function]";
    if (value instanceof Error) {
      return sanitizeError(value, state, depth, true);
    }
    if (value instanceof Date) {
      const timestamp = Date.prototype.getTime.call(value);
      return Number.isFinite(timestamp)
        ? sanitizeString(Date.prototype.toISOString.call(value), state)
        : "[Invalid Date]";
    }
    if (value instanceof ArrayBuffer) {
      return sanitizeBytes(new Uint8Array(value), state);
    }
    if (ArrayBuffer.isView(value)) {
      return sanitizeBytes(
        new Uint8Array(value.buffer, value.byteOffset, value.byteLength),
        state
      );
    }
    if (state.seen.has(value)) return CIRCULAR_VALUE;
    state.seen.add(value);
    if (isArrayValue(value)) {
      return sanitizeArray(value, state, depth, insideCause, insideParameters);
    }
    return sanitizeObject(value, state, depth, insideCause, insideParameters);
  } catch {
    return UNREADABLE_VALUE;
  }
}

function sanitizeArray(
  value: readonly unknown[],
  state: SanitizeState,
  depth: number,
  insideCause: boolean,
  insideParameters: boolean
): unknown[] {
  const length = Math.min(safeArrayLength(value), MAX_DIAGNOSTIC_ARRAY_LENGTH);
  const result: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    if (state.entries >= MAX_DIAGNOSTIC_ENTRIES) {
      result.push(TRUNCATED_VALUE);
      break;
    }
    state.entries += 1;
    const descriptor = safeOwnPropertyDescriptor(value, String(index));
    const entry =
      descriptor && "value" in descriptor ? descriptor.value : UNREADABLE_VALUE;
    result.push(
      sanitizeUnknown(entry, state, depth + 1, insideCause, insideParameters)
    );
  }
  if (safeArrayLength(value) > length) result.push(TRUNCATED_VALUE);
  return result;
}

function sanitizeObject(
  value: object,
  state: SanitizeState,
  depth: number,
  insideCause: boolean,
  insideParameters: boolean
): Record<string, unknown> {
  const result = createSafeRecord();
  try {
    for (const key in value) {
      if (!safeHasOwn(value, key)) continue;
      if (state.entries >= MAX_DIAGNOSTIC_ENTRIES) {
        defineSafe(result, "truncated", TRUNCATED_VALUE);
        break;
      }
      const normalizedKey = key.length <= 64 ? key.toLowerCase() : "";
      if (
        !insideParameters &&
        SQL_KEYS.has(normalizedKey) &&
        !state.disclosure.includeSql
      ) {
        continue;
      }
      if (
        !insideParameters &&
        PARAMETER_KEYS.has(normalizedKey) &&
        !state.disclosure.includeParams
      ) {
        continue;
      }
      if (
        insideCause &&
        (normalizedKey === "message" ||
          normalizedKey === "detail" ||
          normalizedKey === "hint" ||
          normalizedKey === "stack")
      ) {
        continue;
      }
      state.entries += 1;
      const descriptor = safeOwnPropertyDescriptor(value, key);
      const entry =
        descriptor && "value" in descriptor
          ? descriptor.value
          : UNREADABLE_VALUE;
      defineSafe(
        result,
        sanitizeString(key, state),
        sanitizeUnknown(
          entry,
          state,
          depth + 1,
          insideCause || (!insideParameters && CAUSE_KEYS.has(normalizedKey)),
          insideParameters || PARAMETER_KEYS.has(normalizedKey)
        )
      );
    }
  } catch {
    defineSafe(result, "unreadable", UNREADABLE_VALUE);
  }
  return result;
}

function sanitizeError(
  error: Error,
  state: SanitizeState,
  depth: number,
  redactMessage: boolean
): Error {
  if (depth > MAX_DEPTH) return new Error(TRUNCATED_VALUE);
  if (state.seen.has(error)) return new Error(CIRCULAR_VALUE);
  state.seen.add(error);

  const trusted = redactMessage ? undefined : getTrustedErrorSnapshot(error);
  const sanitized = new Error(
    redactMessage
      ? REDACTED_CAUSE_MESSAGE
      : trusted
        ? sanitizeString(trusted.message, state)
        : REDACTED_ERROR_MESSAGE
  );
  sanitized.name = trusted ? sanitizeString(trusted.name, state) : "Error";
  sanitized.stack = undefined;

  if (trusted) {
    defineSafe(sanitized, "code", trusted.code);
  } else {
    for (const key of SAFE_ERROR_KEYS) {
      const value = safeRead(error, key);
      const filtered = filterSafeErrorProperty(key, value);
      if (filtered !== undefined) defineSafe(sanitized, key, filtered);
    }
  }
  const meta = trusted?.meta;
  if (!redactMessage && meta) {
    defineSafe(
      sanitized,
      "meta",
      sanitizeErrorMetadata(meta, state.disclosure)
    );
  }
  if (trusted) {
    defineSafe(sanitized, "timestamp", trusted.timestamp);
    registerTrustedError(sanitized, {
      cause: trusted.cause,
      code: trusted.code,
      disclosure: state.disclosure,
      message: trusted.message,
      meta: trusted.meta,
      name: trusted.name,
      timestamp: new Date(trusted.timestamp),
    });
  }

  const nested = trusted?.cause ?? getNestedCause(error);
  if (nested) {
    const safeCause = sanitizeError(nested, state, depth + 1, true);
    defineSafe(sanitized, "cause", safeCause);
    defineSafe(sanitized, "originalCause", safeCause);
  }
  return sanitized;
}

function sanitizeAllowedRecord(
  value: Record<string, unknown>,
  allowedKeys: ReadonlySet<string>,
  disclosure: DiagnosticDisclosure | undefined,
  validateLogMetadata: boolean
): Record<string, unknown> {
  const selected = createSafeRecord();
  const state = createState(disclosure);
  for (const key of allowedKeys) {
    const descriptor = safeOwnPropertyDescriptor(value, key);
    if (!(descriptor && "value" in descriptor)) continue;
    const raw = descriptor.value;
    let filtered: unknown;
    try {
      filtered = filterAllowedDiagnosticValue(key, raw, validateLogMetadata);
    } catch {
      continue;
    }
    if (filtered === undefined) continue;
    defineSafe(selected, key, filtered);
  }
  const sanitized = sanitizeUnknown(selected, state, 0, false, false);
  return isRecord(sanitized) ? sanitized : createSafeRecord();
}

function filterAllowedDiagnosticValue(
  key: string,
  value: unknown,
  validateLogMetadata: boolean
): unknown {
  if (key === "event" && validateLogMetadata) {
    return typeof value === "string" &&
      ["bypass", "hit", "miss", "revalidate"].includes(value)
      ? value
      : undefined;
  }
  if (key === "status" && validateLogMetadata) {
    return typeof value === "string" &&
      [
        "cache-set-failed",
        "error",
        "fresh",
        "stale",
        "start",
        "success",
      ].includes(value)
      ? value
      : undefined;
  }
  if (key === "providerCode") return sanitizeProviderCode(value);
  if (key === "providerErrno") return sanitizeProviderErrno(value);
  if (key === "providerSqlState") return sanitizeSqlState(value);
  if (key === "providerStatus") return sanitizeProviderStatus(value);
  if (STRING_META_KEYS.has(key)) {
    return typeof value === "string" ? value : undefined;
  }
  if (STRING_ARRAY_META_KEYS.has(key)) return sanitizeStringArray(value);
  if (NUMBER_META_KEYS.has(key)) {
    return typeof value === "number" &&
      Number.isFinite(value) &&
      value >= 0 &&
      value <= Number.MAX_SAFE_INTEGER
      ? value
      : undefined;
  }
  if (key === "autoIncrement") {
    return typeof value === "boolean" ? value : undefined;
  }
  if (key === "query") return typeof value === "string" ? value : undefined;
  if (key === "params") return isArrayValue(value) ? value : undefined;
  return undefined;
}

function sanitizeStringArray(value: unknown): string[] | undefined {
  if (!isArrayValue(value)) return undefined;
  const length = Math.min(safeArrayLength(value), MAX_DIAGNOSTIC_ARRAY_LENGTH);
  const strings: string[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = safeOwnPropertyDescriptor(value, String(index));
    if (!(descriptor && "value" in descriptor)) return undefined;
    if (typeof descriptor.value !== "string") return undefined;
    strings.push(descriptor.value);
  }
  return strings;
}

function isArrayValue(value: unknown): value is unknown[] {
  try {
    return Array.isArray(value);
  } catch {
    return false;
  }
}

function getTrustedErrorSnapshot(
  error: Error
): TrustedErrorSnapshot | undefined {
  const snapshot = safeRead(error, TRUSTED_ERROR_SNAPSHOT);
  if (!isRecord(snapshot)) return undefined;
  const cause = safeRead(snapshot, "cause");
  const code = safeRead(snapshot, "code");
  const disclosure = safeRead(snapshot, "disclosure");
  const message = safeRead(snapshot, "message");
  const meta = safeRead(snapshot, "meta");
  const name = safeRead(snapshot, "name");
  const timestamp = safeRead(snapshot, "timestamp");
  if (
    (cause !== undefined && !isError(cause)) ||
    typeof code !== "string" ||
    !isResolvedDisclosure(disclosure) ||
    typeof message !== "string" ||
    !isRecord(meta) ||
    typeof name !== "string" ||
    typeof timestamp !== "string"
  ) {
    return undefined;
  }
  return { cause, code, disclosure, message, meta, name, timestamp };
}

function isResolvedDisclosure(
  value: unknown
): value is ResolvedDiagnosticDisclosure {
  return (
    isRecord(value) &&
    typeof value.includeSql === "boolean" &&
    typeof value.includeParams === "boolean"
  );
}

function serializeError(
  error: Error,
  state: SanitizeState,
  depth: number
): Record<string, unknown> {
  const serialized = createSafeRecord();
  if (state.seen.has(error)) {
    defineSafe(serialized, "name", "Error");
    defineSafe(serialized, "message", CIRCULAR_VALUE);
    return serialized;
  }
  state.seen.add(error);
  defineSafe(serialized, "name", safeErrorString(error, "name", state));
  defineSafe(serialized, "message", safeErrorString(error, "message", state));
  for (const key of SAFE_ERROR_KEYS) {
    const value = safeRead(error, key);
    const filtered = filterSafeErrorProperty(key, value);
    if (filtered !== undefined) defineSafe(serialized, key, filtered);
  }
  const meta = safeRead(error, "meta");
  if (isRecord(meta)) {
    defineSafe(
      serialized,
      "meta",
      sanitizeUnknown(meta, state, depth + 1, true, false)
    );
  }
  const nested = getNestedCause(error);
  if (nested && depth < MAX_DEPTH) {
    defineSafe(serialized, "cause", serializeError(nested, state, depth + 1));
  }
  return serialized;
}
