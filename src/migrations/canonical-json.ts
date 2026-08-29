/**
 * RFC 8785 JSON Canonicalization Scheme (JCS).
 *
 * Hash identity is these exact UTF-8 bytes. No locale, insertion order,
 * platform line ending, or display formatter participates.
 */

import { MigrationError, VibORMErrorCode } from "../errors";
import { isRecord } from "../validation/value-guards";

const UTF8 = new TextEncoder();

export function canonicalizeJson(value: unknown): Uint8Array {
  return UTF8.encode(serializeJcs(value));
}

export function canonicalizeJsonText(value: unknown): string {
  return serializeJcs(value);
}

function serializeJcs(value: unknown): string {
  if (value === null) return "null";
  if (value === true) return "true";
  if (value === false) return "false";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") return serializeNumber(value);
  if (Array.isArray(value)) {
    const parts = new Array<string>(value.length);
    for (let i = 0; i < value.length; i++) {
      parts[i] = serializeJcs(value[i]);
    }
    return `[${parts.join(",")}]`;
  }
  if (isRecord(value)) {
    const keys = Object.keys(value).sort(compareUtf16);
    const parts = new Array<string>(keys.length);
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i]!;
      parts[i] = `${JSON.stringify(key)}:${serializeJcs(value[key])}`;
    }
    return `{${parts.join(",")}}`;
  }
  throw new MigrationError(
    "Canonical JSON refuses undefined, bigint, function, symbol, and boxed values",
    VibORMErrorCode.MIGRATION_INVALID_ESTATE
  );
}

function serializeNumber(value: number): string {
  if (!Number.isFinite(value)) {
    throw new MigrationError(
      "Canonical JSON refuses NaN and Infinity",
      VibORMErrorCode.MIGRATION_INVALID_ESTATE
    );
  }
  if (Object.is(value, -0)) return "0";
  return JSON.stringify(value);
}

function compareUtf16(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

export function assertCanonicalBytes(
  bytes: Uint8Array,
  reconstructed: unknown,
  label: string
): void {
  const expected = canonicalizeJson(reconstructed);
  if (bytes.length !== expected.length) {
    throw new MigrationError(
      `${label} is not canonical RFC 8785 JSON`,
      VibORMErrorCode.MIGRATION_INVALID_ESTATE
    );
  }
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] !== expected[i]) {
      throw new MigrationError(
        `${label} is not canonical RFC 8785 JSON`,
        VibORMErrorCode.MIGRATION_INVALID_ESTATE
      );
    }
  }
}

export function parseJsonBytes(bytes: Uint8Array, label: string): unknown {
  if (
    bytes.length >= 3 &&
    bytes[0] === 0xef &&
    bytes[1] === 0xbb &&
    bytes[2] === 0xbf
  ) {
    throw new MigrationError(
      `${label} must be UTF-8 without a BOM`,
      VibORMErrorCode.MIGRATION_INVALID_ESTATE
    );
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (cause) {
    throw new MigrationError(
      `${label} is not valid UTF-8 JSON`,
      VibORMErrorCode.MIGRATION_INVALID_ESTATE,
      { cause: cause instanceof Error ? cause : undefined }
    );
  }
}

export function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  for (let i = 0; i < left.length; i++) {
    if (left[i] !== right[i]) return false;
  }
  return true;
}
