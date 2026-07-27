export interface DiagnosticBudget {
  entries: number;
  characters: number;
}

export const MAX_DIAGNOSTIC_ENTRIES = 256;
export const MAX_DIAGNOSTIC_ARRAY_LENGTH = 128;
export const TRUNCATED_DIAGNOSTIC_VALUE = "[Truncated]";
export const UNREADABLE_DIAGNOSTIC_VALUE = "[Unreadable]";
export const SAFE_ERROR_KEYS = [
  "code",
  "errno",
  "sqlState",
  "sqlstate",
  "status",
  "statusCode",
] as const;

const MAX_STRING_LENGTH = 4096;
const MAX_TOTAL_CHARACTERS = 32_768;
const PROVIDER_STATUS_PATTERN = /^\d{3}$/;
const SQL_STATE_PATTERN = /^[0-9A-Z]{5}$/;
const TRUSTED_CODE_PATTERN = /^V\d{4,5}$/;
const PRISMA_CODE_PATTERN = /^P\d{4}$/;
const SQL_STATE_CLASSES = new Set([
  "00",
  "01",
  "02",
  "03",
  "08",
  "09",
  "0A",
  "0B",
  "0F",
  "0L",
  "0P",
  "0Z",
  "20",
  "21",
  "22",
  "23",
  "24",
  "25",
  "26",
  "27",
  "28",
  "2B",
  "2D",
  "2F",
  "34",
  "38",
  "39",
  "3B",
  "3D",
  "3F",
  "40",
  "42",
  "44",
  "53",
  "54",
  "55",
  "57",
  "58",
  "72",
  "F0",
  "HV",
  "HY",
  "IM",
  "P0",
  "S0",
  "XA",
  "XX",
]);
const STABLE_PROVIDER_CODES = new Set([
  "ABORTED",
  "ALREADY_EXISTS",
  "CANCELLED",
  "DATA_LOSS",
  "DEADLINE_EXCEEDED",
  "EACCES",
  "EADDRINUSE",
  "EADDRNOTAVAIL",
  "EAFNOSUPPORT",
  "EAI_AGAIN",
  "EALREADY",
  "EBADF",
  "EBUSY",
  "ECONNABORTED",
  "ECONNREFUSED",
  "ECONNRESET",
  "EEXIST",
  "EHOSTUNREACH",
  "EINTR",
  "EINVAL",
  "EISCONN",
  "EMFILE",
  "ENETUNREACH",
  "ENFILE",
  "ENOENT",
  "ENOSPC",
  "ENOTCONN",
  "ENOTFOUND",
  "EPERM",
  "EPIPE",
  "ER_BAD_NULL_ERROR",
  "ER_CHECK_CONSTRAINT_VIOLATED",
  "ER_DUP_ENTRY",
  "ER_INVALID_JSON_TEXT_IN_PARAM",
  "ER_LOCK_DEADLOCK",
  "ER_LOCK_WAIT_TIMEOUT",
  "ER_NO_REFERENCED_ROW_2",
  "ER_ROW_IS_REFERENCED_2",
  "EROFS",
  "ETIMEDOUT",
  "FAILED_PRECONDITION",
  "INTERNAL",
  "INVALID_ARGUMENT",
  "NOT_FOUND",
  "OUT_OF_RANGE",
  "PERMISSION_DENIED",
  "RESOURCE_EXHAUSTED",
  "SQLITE_BUSY",
  "SQLITE_CONSTRAINT",
  "SQLITE_CONSTRAINT_CHECK",
  "SQLITE_CONSTRAINT_FOREIGNKEY",
  "SQLITE_CONSTRAINT_NOTNULL",
  "SQLITE_CONSTRAINT_UNIQUE",
  "SQLITE_LOCKED",
  "UNAUTHENTICATED",
  "UNAVAILABLE",
  "UNIMPLEMENTED",
  "UNKNOWN",
]);

export function sanitizeBytes(
  value: Uint8Array,
  budget: DiagnosticBudget
): unknown {
  const length = Math.min(
    value.byteLength,
    MAX_DIAGNOSTIC_ARRAY_LENGTH,
    Math.max(0, MAX_DIAGNOSTIC_ENTRIES - budget.entries)
  );
  const bytes: number[] = [];
  for (let index = 0; index < length; index += 1) {
    bytes.push(value[index]!);
  }
  const result = createSafeRecord();
  defineSafe(result, "type", "binary");
  defineSafe(result, "byteLength", value.byteLength);
  defineSafe(result, "bytes", bytes);
  if (value.byteLength > length) defineSafe(result, "truncated", true);
  budget.entries += length;
  return result;
}

export function sanitizeString(
  value: string,
  budget: DiagnosticBudget
): string {
  const available = Math.max(0, MAX_TOTAL_CHARACTERS - budget.characters);
  const length = Math.min(value.length, MAX_STRING_LENGTH, available);
  budget.characters += length;
  return length === value.length
    ? value
    : `${value.slice(0, length)}${TRUNCATED_DIAGNOSTIC_VALUE}`;
}

export function safeErrorString(
  error: Error,
  key: "name" | "message",
  budget: DiagnosticBudget
): string {
  const value = safeRead(error, key);
  return sanitizeString(typeof value === "string" ? value : "Error", budget);
}

export function getNestedCause(error: Error): Error | undefined {
  const originalCause = safeRead(error, "originalCause");
  if (isError(originalCause)) return originalCause;
  const cause = safeRead(error, "cause");
  return isError(cause) ? cause : undefined;
}

export function safeRead(value: object, key: PropertyKey): unknown {
  try {
    return Reflect.get(value, key);
  } catch {
    return UNREADABLE_DIAGNOSTIC_VALUE;
  }
}

export function safeHasOwn(value: object, key: PropertyKey): boolean {
  try {
    return Object.hasOwn(value, key);
  } catch {
    return false;
  }
}

export function safeOwnPropertyDescriptor(
  value: object,
  key: PropertyKey
): PropertyDescriptor | undefined {
  try {
    return Reflect.getOwnPropertyDescriptor(value, key);
  } catch {
    return undefined;
  }
}

export function safeArrayLength(value: readonly unknown[]): number {
  const length = safeRead(value, "length");
  return typeof length === "number" &&
    Number.isSafeInteger(length) &&
    length >= 0
    ? length
    : 0;
}

export function createSafeRecord(): Record<string, unknown> {
  return Object.create(null);
}

export function defineSafe(target: object, key: string, value: unknown): void {
  try {
    Object.defineProperty(target, key, {
      configurable: true,
      enumerable: true,
      value,
      writable: true,
    });
  } catch {
    // The sanitizer owns every target, but remain total if the runtime rejects.
  }
}

export function defineHidden(
  target: object,
  key: symbol,
  value: unknown
): void {
  try {
    Object.defineProperty(target, key, {
      configurable: false,
      enumerable: false,
      value,
      writable: false,
    });
  } catch {
    // Registration is hardening; boundary sanitization still fails closed.
  }
}

export function filterSafeErrorProperty(
  key: (typeof SAFE_ERROR_KEYS)[number],
  value: unknown
): string | number | undefined {
  if (key === "errno") return sanitizeProviderErrno(value);
  if (key === "sqlState" || key === "sqlstate") {
    return sanitizeSqlState(value);
  }
  if (key === "status" || key === "statusCode") {
    return sanitizeProviderStatus(value);
  }
  return sanitizeProviderCode(value);
}

export function sanitizeProviderCode(
  value: unknown
): string | number | undefined {
  if (typeof value === "number") return sanitizeProviderErrno(value);
  if (typeof value !== "string" || value.length > 64) return undefined;
  return TRUSTED_CODE_PATTERN.test(value) ||
    sanitizeSqlState(value) !== undefined ||
    STABLE_PROVIDER_CODES.has(value)
    ? value
    : undefined;
}

export function sanitizeProviderErrno(value: unknown): number | undefined {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= 2_147_483_647
    ? value
    : undefined;
}

export function sanitizeSqlState(value: unknown): string | undefined {
  return typeof value === "string" &&
    SQL_STATE_PATTERN.test(value) &&
    SQL_STATE_CLASSES.has(value.slice(0, 2))
    ? value
    : undefined;
}

export function sanitizeProviderStatus(
  value: unknown
): string | number | undefined {
  if (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 100 &&
    value <= 999
  ) {
    return value;
  }
  return typeof value === "string" && PROVIDER_STATUS_PATTERN.test(value)
    ? value
    : undefined;
}

export function sanitizeTrustedCode(value: string): string {
  return TRUSTED_CODE_PATTERN.test(value) ? value : "V9001";
}

/**
 * Prisma compatibility codes are `P` + four digits (P1001, P2002, …). Anything else is
 * dropped rather than echoed, so a hostile `prismaCode` cannot ride into diagnostics.
 */
export function sanitizeTrustedPrismaCode(value: unknown): string | undefined {
  return typeof value === "string" && PRISMA_CODE_PATTERN.test(value)
    ? value
    : undefined;
}

export function boundTrustedString(value: string): string {
  return value.length <= MAX_STRING_LENGTH
    ? value
    : `${value.slice(0, MAX_STRING_LENGTH)}${TRUNCATED_DIAGNOSTIC_VALUE}`;
}

export function safeDateString(value: Date): string {
  try {
    const milliseconds = Date.prototype.getTime.call(value);
    return Number.isFinite(milliseconds)
      ? Date.prototype.toISOString.call(value)
      : "Invalid Date";
  } catch {
    return "Invalid Date";
  }
}

export function freezeDiagnosticValue<T>(value: T): T {
  if (typeof value !== "object" || value === null) return value;
  try {
    for (const key of Reflect.ownKeys(value)) {
      const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
      if (descriptor && "value" in descriptor) {
        freezeDiagnosticValue(descriptor.value);
      }
    }
    return Object.freeze(value);
  } catch {
    return value;
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  try {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  } catch {
    return false;
  }
}

export function isError(value: unknown): value is Error {
  try {
    return value instanceof Error;
  } catch {
    return false;
  }
}
