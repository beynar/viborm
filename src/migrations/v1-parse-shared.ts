/**
 * Shared hostile-parse primitives for Migration V1.
 *
 * Exact-key admission and primitive field readers. Artifact parsers own
 * their shapes; this file owns only the reusable refuse/key helpers.
 */

import { MigrationError, VibORMErrorCode } from "../errors";
import { isNumber, isRecord, isString } from "../validation/value-guards";

export function refuse(message: string): never {
  throw new MigrationError(message, VibORMErrorCode.MIGRATION_INVALID_ESTATE);
}

export function exactObject(
  value: unknown,
  allowed: readonly string[],
  required: readonly string[],
  label: string
): Record<string, unknown> {
  if (!isRecord(value)) refuse(`${label} must be an object`);
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) refuse(`${label} has unknown key ${key}`);
  }
  for (const key of required) {
    if (!(key in value)) refuse(`${label} is missing ${key}`);
  }
  return value;
}

export function parseFormat(value: unknown, label: string): "1" {
  if (value !== "1") refuse(`${label} format must be "1"`);
  return "1";
}

export function parseFiniteInteger(value: unknown, label: string): number {
  if (
    !(isNumber(value) && Number.isInteger(value) && Number.isSafeInteger(value))
  ) {
    refuse(`${label} must be a safe integer`);
  }
  return value;
}

export function parseRequiredString(value: unknown, label: string): string {
  if (!isString(value) || value.length === 0)
    refuse(`${label} must be a non-empty string`);
  return value;
}

export function parseStringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) refuse(`${label} must be an array`);
  return value.map((entry, index) => {
    if (!isString(entry)) refuse(`${label}[${index}] must be a string`);
    return entry;
  });
}

export function parseIdentifierArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) refuse(`${label} must be an array`);
  return value.map((entry, index) =>
    parseRequiredString(entry, `${label}[${index}]`)
  );
}
