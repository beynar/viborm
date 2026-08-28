/**
 * Dispatch identity and hostile parameter admission.
 * Reset-plan and state parsers share this owner; they do not import each other.
 */

import { MigrationError, VibORMErrorCode } from "../errors";
import {
  isBoolean,
  isNumber,
  isRecord,
  isString,
} from "../validation/value-guards";
import { canonicalizeJson } from "./canonical-json";
import { domainHash, HASH_DOMAIN, parseSha256, type Sha256 } from "./identity";
import { exactObject, parseFiniteInteger, refuse } from "./v1-parse-shared";
import type { MigrationDispatchV1, MigrationParameterV1 } from "./v1-types";

const DISPATCH_KEYS = [
  "dispatchId",
  "length",
  "offset",
  "parameters",
  "sqlHash",
] as const;

export function encodeDispatchIdentity(
  sqlHash: Sha256,
  offset: number,
  length: number,
  parameters: readonly MigrationParameterV1[]
): Sha256 {
  return domainHash(
    HASH_DOMAIN.dispatch,
    canonicalizeJson({ sqlHash, offset, length, parameters })
  );
}

export function parseDispatch(
  value: unknown,
  label: string
): MigrationDispatchV1 {
  const record = exactObject(value, DISPATCH_KEYS, DISPATCH_KEYS, label);
  const offset = parseFiniteInteger(record.offset, `${label}.offset`);
  const length = parseFiniteInteger(record.length, `${label}.length`);
  if (offset < 0 || length < 0) refuse(`${label} range must be non-negative`);
  if (!Array.isArray(record.parameters))
    refuse(`${label}.parameters must be an array`);
  const parameters = record.parameters.map((parameter, index) =>
    parseParameter(parameter, `${label}.parameters[${index}]`)
  );
  const sqlHash = parseSha256(record.sqlHash, `${label}.sqlHash`);
  const dispatchId = parseSha256(record.dispatchId, `${label}.dispatchId`);
  const expected = encodeDispatchIdentity(sqlHash, offset, length, parameters);
  if (dispatchId !== expected) {
    throw new MigrationError(
      `${label}.dispatchId does not match its SQL range and parameters`,
      VibORMErrorCode.MIGRATION_CORRUPTION
    );
  }
  return { dispatchId, sqlHash, offset, length, parameters };
}

function parseParameter(value: unknown, label: string): MigrationParameterV1 {
  if (!(isRecord(value) && isString(value.kind))) {
    refuse(`${label} must be a tagged parameter`);
  }
  switch (value.kind) {
    case "null":
      exactObject(value, ["kind"], ["kind"], label);
      return { kind: "null" };
    case "boolean": {
      const record = exactObject(
        value,
        ["kind", "value"],
        ["kind", "value"],
        label
      );
      if (!isBoolean(record.value)) refuse(`${label}.value must be boolean`);
      return { kind: "boolean", value: record.value };
    }
    case "string": {
      const record = exactObject(
        value,
        ["kind", "value"],
        ["kind", "value"],
        label
      );
      if (!isString(record.value)) refuse(`${label}.value must be a string`);
      return { kind: "string", value: record.value };
    }
    case "number": {
      const record = exactObject(
        value,
        ["kind", "value"],
        ["kind", "value"],
        label
      );
      if (!(isNumber(record.value) && Number.isFinite(record.value))) {
        refuse(`${label}.value must be a finite number`);
      }
      return { kind: "number", value: record.value };
    }
    case "bigint":
    case "bytes":
    case "date-time":
    case "decimal": {
      const record = exactObject(
        value,
        ["kind", "value"],
        ["kind", "value"],
        label
      );
      if (!isString(record.value))
        refuse(`${label}.value must be canonical text`);
      return { kind: value.kind, value: record.value };
    }
    case "json": {
      const record = exactObject(
        value,
        ["kind", "value"],
        ["kind", "value"],
        label
      );
      return { kind: "json", value: record.value };
    }
    default:
      refuse(`${label}.kind is not a V1 parameter tag`);
  }
}
