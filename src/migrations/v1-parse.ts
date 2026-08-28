/**
 * Hostile parsers and hash owners for Migration V1 estate, dispatch,
 * state, and transition artifacts.
 *
 * Snapshot and control admission live in sibling modules. This file
 * re-exports them so existing `./v1-parse` imports keep working.
 * Every JSON boundary admits a value only after exact-key validation,
 * re-canonicalization against the original bytes, and hash recomputation.
 * No `JSON.parse(...) as SchemaSnapshot` remains.
 */

import { MigrationError, VibORMErrorCode } from "../errors";
import { isBoolean, isRecord, isString } from "../validation/value-guards";
import {
  assertCanonicalBytes,
  canonicalizeJson,
  parseJsonBytes,
} from "./canonical-json";
import {
  domainHash,
  HASH_ALGORITHM,
  HASH_DOMAIN,
  parseSha256,
  type Sha256,
} from "./identity";
import type { MigrationTarget } from "./types";
import { parseDispatch } from "./v1-parse-dispatch";
import { exactObject, parseFormat, refuse } from "./v1-parse-shared";
import type {
  MigrationBooleanCheckV1,
  MigrationEstateDescriptorV1,
  MigrationOperationV1,
  MigrationParentTransitionV1,
  MigrationRollbackV1,
  MigrationStateManifestV1,
  MigrationStepV1,
} from "./v1-types";

export {
  encodePathHash,
  eventIdFor,
  parseLedgerEvent,
  parseMarkerRow,
} from "./v1-parse-control";
export { encodeDispatchIdentity, parseDispatch } from "./v1-parse-dispatch";
export {
  encodeSnapshot,
  parseSnapshotDocument,
} from "./v1-parse-snapshot";

const ESTATE_KEYS = ["format", "hash", "target"] as const;
const PG_TARGET_KEYS = ["dialect", "namespace"] as const;
const DIALECT_ONLY_TARGET_KEYS = ["dialect"] as const;
const CHECK_KEYS = ["equals", "id", "kind", "query"] as const;
const PROVEN_STEP_KEYS = ["execute", "postcheck", "precheck", "retry"] as const;
const OPAQUE_STEP_KEYS = ["execute", "retry"] as const;
const OPERATION_KEYS = ["id", "label", "origin", "risk", "steps"] as const;
const SCHEMA_ROLLBACK_KEYS = ["kind", "operations"] as const;
const MANUAL_ROLLBACK_KEYS = [
  "kind",
  "operations",
  "requestedBoundary",
] as const;
const IRREVERSIBLE_KEYS = ["kind", "reason"] as const;
const PARENT_KEYS = [
  "fromState",
  "operations",
  "originChecks",
  "requestedForwardBoundary",
  "rollback",
  "transitionHash",
] as const;
const STATE_KEYS = [
  "destinationChecks",
  "estateHash",
  "format",
  "name",
  "parents",
  "snapshotHash",
  "sqlHash",
  "stateId",
] as const;
const STATE_HASH_KEYS = [
  "destinationChecks",
  "estateHash",
  "format",
  "name",
  "parents",
  "snapshotHash",
  "sqlHash",
] as const;
const TRANSITION_HASH_KEYS = [
  "fromState",
  "operations",
  "originChecks",
  "requestedForwardBoundary",
  "rollback",
] as const;

export function parseMigrationTarget(
  value: unknown,
  label: string
): MigrationTarget {
  if (!isRecord(value)) refuse(`${label} must be an object`);
  const dialect = value.dialect;
  if (dialect === "postgresql") {
    const record = exactObject(value, PG_TARGET_KEYS, PG_TARGET_KEYS, label);
    if (!isString(record.namespace) || record.namespace.length === 0) {
      refuse(`${label}.namespace must be a non-empty string`);
    }
    return { dialect: "postgresql", namespace: record.namespace };
  }
  if (dialect === "mysql" || dialect === "sqlite") {
    exactObject(
      value,
      DIALECT_ONLY_TARGET_KEYS,
      DIALECT_ONLY_TARGET_KEYS,
      label
    );
    return { dialect };
  }
  refuse(`${label}.dialect is not a V1 migration target`);
}

export function parseEstateDescriptor(bytes: Uint8Array): {
  descriptor: MigrationEstateDescriptorV1;
  estateHash: Sha256;
} {
  const parsed = parseJsonBytes(bytes, "estate.json");
  const record = exactObject(parsed, ESTATE_KEYS, ESTATE_KEYS, "estate.json");
  if (record.hash !== HASH_ALGORITHM) {
    refuse('estate.json hash algorithm must be "sha256"');
  }
  const descriptor: MigrationEstateDescriptorV1 = {
    format: parseFormat(record.format, "estate.json"),
    target: parseMigrationTarget(record.target, "estate.json.target"),
    hash: "sha256",
  };
  assertCanonicalBytes(bytes, descriptor, "estate.json");
  return { descriptor, estateHash: domainHash(HASH_DOMAIN.estate, bytes) };
}

export function encodeEstateDescriptor(target: MigrationTarget): {
  bytes: Uint8Array;
  estateHash: Sha256;
  descriptor: MigrationEstateDescriptorV1;
} {
  const descriptor: MigrationEstateDescriptorV1 = {
    format: "1",
    target,
    hash: "sha256",
  };
  const bytes = canonicalizeJson(descriptor);
  return {
    bytes,
    estateHash: domainHash(HASH_DOMAIN.estate, bytes),
    descriptor,
  };
}

function parseCheck(value: unknown, label: string): MigrationBooleanCheckV1 {
  const record = exactObject(value, CHECK_KEYS, CHECK_KEYS, label);
  if (record.kind !== "driver" && record.kind !== "trusted-read") {
    refuse(`${label}.kind must be driver or trusted-read`);
  }
  if (!isString(record.id) || record.id.length === 0) {
    refuse(`${label}.id must be a non-empty string`);
  }
  if (!isBoolean(record.equals)) refuse(`${label}.equals must be boolean`);
  return {
    kind: record.kind,
    id: record.id,
    query: parseDispatch(record.query, `${label}.query`),
    equals: record.equals,
  };
}

function parseStep(value: unknown, label: string): MigrationStepV1 {
  if (
    !isRecord(value) ||
    (value.retry !== "proven" && value.retry !== "opaque")
  ) {
    refuse(`${label}.retry must be proven or opaque`);
  }
  if (value.retry === "proven") {
    const record = exactObject(
      value,
      PROVEN_STEP_KEYS,
      PROVEN_STEP_KEYS,
      label
    );
    return {
      retry: "proven",
      precheck: parseCheck(record.precheck, `${label}.precheck`),
      execute: parseDispatch(record.execute, `${label}.execute`),
      postcheck: parseCheck(record.postcheck, `${label}.postcheck`),
    };
  }
  const record = exactObject(value, OPAQUE_STEP_KEYS, OPAQUE_STEP_KEYS, label);
  return {
    retry: "opaque",
    execute: parseDispatch(record.execute, `${label}.execute`),
  };
}

function parseOperation(value: unknown, label: string): MigrationOperationV1 {
  const record = exactObject(value, OPERATION_KEYS, OPERATION_KEYS, label);
  if (!isString(record.id) || record.id.length === 0)
    refuse(`${label}.id is required`);
  if (!isString(record.label) || record.label.length === 0) {
    refuse(`${label}.label is required`);
  }
  if (record.origin !== "generated" && record.origin !== "manual") {
    refuse(`${label}.origin must be generated or manual`);
  }
  if (
    record.risk !== "safe" &&
    record.risk !== "destructive" &&
    record.risk !== "opaque"
  ) {
    refuse(`${label}.risk is not a V1 risk class`);
  }
  if (!Array.isArray(record.steps) || record.steps.length === 0) {
    refuse(`${label}.steps must be a non-empty array`);
  }
  return {
    id: record.id,
    label: record.label,
    origin: record.origin,
    risk: record.risk,
    steps: record.steps.map((step, index) =>
      parseStep(step, `${label}.steps[${index}]`)
    ),
  };
}

function parseRollback(value: unknown, label: string): MigrationRollbackV1 {
  if (!(isRecord(value) && isString(value.kind)))
    refuse(`${label} must be a tagged rollback`);
  if (value.kind === "schema") {
    const record = exactObject(
      value,
      SCHEMA_ROLLBACK_KEYS,
      SCHEMA_ROLLBACK_KEYS,
      label
    );
    if (!Array.isArray(record.operations))
      refuse(`${label}.operations must be an array`);
    return {
      kind: "schema",
      operations: record.operations.map((operation, index) =>
        parseOperation(operation, `${label}.operations[${index}]`)
      ),
    };
  }
  if (value.kind === "manual") {
    const record = exactObject(
      value,
      MANUAL_ROLLBACK_KEYS,
      MANUAL_ROLLBACK_KEYS,
      label
    );
    if (
      record.requestedBoundary !== "transactional" &&
      record.requestedBoundary !== "stepwise"
    ) {
      refuse(`${label}.requestedBoundary must be transactional or stepwise`);
    }
    if (!Array.isArray(record.operations))
      refuse(`${label}.operations must be an array`);
    return {
      kind: "manual",
      requestedBoundary: record.requestedBoundary,
      operations: record.operations.map((operation, index) =>
        parseOperation(operation, `${label}.operations[${index}]`)
      ),
    };
  }
  if (value.kind === "irreversible") {
    const record = exactObject(
      value,
      IRREVERSIBLE_KEYS,
      IRREVERSIBLE_KEYS,
      label
    );
    if (!isString(record.reason) || record.reason.trim().length === 0) {
      refuse(`${label}.reason must be a non-empty string`);
    }
    return { kind: "irreversible", reason: record.reason };
  }
  refuse(`${label}.kind is not a V1 rollback`);
}

export function encodeTransitionHash(
  transition: Omit<MigrationParentTransitionV1, "transitionHash">
): Sha256 {
  const body: Record<string, unknown> = {};
  for (const key of TRANSITION_HASH_KEYS) {
    body[key] = transition[key];
  }
  return domainHash(HASH_DOMAIN.transition, canonicalizeJson(body));
}

function parseParent(
  value: unknown,
  label: string
): MigrationParentTransitionV1 {
  const record = exactObject(value, PARENT_KEYS, PARENT_KEYS, label);
  const fromState =
    record.fromState === null
      ? null
      : parseSha256(record.fromState, `${label}.fromState`);
  if (
    record.requestedForwardBoundary !== null &&
    record.requestedForwardBoundary !== "transactional" &&
    record.requestedForwardBoundary !== "stepwise"
  ) {
    refuse(`${label}.requestedForwardBoundary is invalid`);
  }
  if (!Array.isArray(record.originChecks))
    refuse(`${label}.originChecks must be an array`);
  if (!Array.isArray(record.operations))
    refuse(`${label}.operations must be an array`);
  const operations = record.operations.map((operation, index) =>
    parseOperation(operation, `${label}.operations[${index}]`)
  );
  const rollback = parseRollback(record.rollback, `${label}.rollback`);
  const origins = new Set(operations.map((operation) => operation.origin));
  if (origins.size > 1) {
    refuse(`${label} mixes generated and manual operations`);
  }
  if (record.requestedForwardBoundary !== null && origins.has("generated")) {
    refuse(
      `${label}.requestedForwardBoundary is only valid on a manual transition`
    );
  }
  if (rollback.kind === "manual" && origins.has("generated")) {
    refuse(`${label}.rollback cannot be manual on a generated transition`);
  }
  const parsed: Omit<MigrationParentTransitionV1, "transitionHash"> = {
    fromState,
    originChecks: record.originChecks.map((check, index) =>
      parseCheck(check, `${label}.originChecks[${index}]`)
    ),
    requestedForwardBoundary: record.requestedForwardBoundary,
    operations,
    rollback,
  };
  const transitionHash = parseSha256(
    record.transitionHash,
    `${label}.transitionHash`
  );
  const expected = encodeTransitionHash(parsed);
  if (transitionHash !== expected) {
    throw new MigrationError(
      `${label}.transitionHash does not match its transition`,
      VibORMErrorCode.MIGRATION_CORRUPTION
    );
  }
  return { ...parsed, transitionHash };
}

export function compareFromState(
  left: Sha256 | null,
  right: Sha256 | null
): number {
  if (left === right) return 0;
  if (left === null) return -1;
  if (right === null) return 1;
  return left < right ? -1 : 1;
}

export function sortParents(
  parents: readonly MigrationParentTransitionV1[]
): MigrationParentTransitionV1[] {
  return [...parents].sort((left, right) =>
    compareFromState(left.fromState, right.fromState)
  );
}

export function encodeStateId(
  manifest: Omit<MigrationStateManifestV1, "stateId">
): Sha256 {
  const body: Record<string, unknown> = {};
  for (const key of STATE_HASH_KEYS) {
    body[key] = manifest[key];
  }
  return domainHash(HASH_DOMAIN.state, canonicalizeJson(body));
}

export function parseStateManifest(
  bytes: Uint8Array,
  expectedId: Sha256
): MigrationStateManifestV1 {
  const parsed = parseJsonBytes(bytes, `states/${expectedId}.json`);
  const record = exactObject(parsed, STATE_KEYS, STATE_KEYS, "state manifest");
  if (!Array.isArray(record.parents) || record.parents.length === 0) {
    refuse("state manifest must have at least one parent transition");
  }
  if (!Array.isArray(record.destinationChecks)) {
    refuse("state manifest.destinationChecks must be an array");
  }
  if (!isString(record.name) || record.name.length === 0) {
    refuse("state manifest.name must be a non-empty string");
  }
  const parents = record.parents.map((parent, index) =>
    parseParent(parent, `state.parents[${index}]`)
  );
  for (let i = 1; i < parents.length; i++) {
    if (
      compareFromState(parents[i - 1]!.fromState, parents[i]!.fromState) >= 0
    ) {
      refuse(
        "state manifest parents must be sorted by fromState with null first"
      );
    }
  }
  const seen = new Set<string>();
  for (const parent of parents) {
    const key = parent.fromState ?? "null";
    if (seen.has(key)) refuse("state manifest has a duplicate parent");
    seen.add(key);
  }
  const withoutId: Omit<MigrationStateManifestV1, "stateId"> = {
    format: parseFormat(record.format, "state manifest"),
    estateHash: parseSha256(record.estateHash, "state.estateHash"),
    name: record.name,
    snapshotHash: parseSha256(record.snapshotHash, "state.snapshotHash"),
    sqlHash: parseSha256(record.sqlHash, "state.sqlHash"),
    destinationChecks: record.destinationChecks.map((check, index) =>
      parseCheck(check, `state.destinationChecks[${index}]`)
    ),
    parents,
  };
  assertCanonicalBytes(
    bytes,
    { ...withoutId, stateId: expectedId },
    `states/${expectedId}.json`
  );
  const stateId = parseSha256(record.stateId, "state.stateId");
  const expected = encodeStateId(withoutId);
  if (stateId !== expected || stateId !== expectedId) {
    throw new MigrationError(
      "stateId does not match the canonical manifest or filename",
      VibORMErrorCode.MIGRATION_CORRUPTION
    );
  }
  return { ...withoutId, stateId };
}

export function encodeStateManifest(
  manifest: Omit<MigrationStateManifestV1, "stateId">
): { bytes: Uint8Array; stateId: Sha256; manifest: MigrationStateManifestV1 } {
  const parents = sortParents(manifest.parents);
  const sorted = { ...manifest, parents };
  const stateId = encodeStateId(sorted);
  const complete = { ...sorted, stateId };
  return { bytes: canonicalizeJson(complete), stateId, manifest: complete };
}

export function encodeSqlBlob(bytes: Uint8Array): Sha256 {
  return domainHash(HASH_DOMAIN.sql, bytes);
}
