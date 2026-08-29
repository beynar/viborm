/**
 * Hostile parsers and hash owner for Migration V1 marker and ledger rows.
 *
 * Path identity lives next to the marker it authenticates. Reset-plan
 * admission lives next to the ledger event that carries it.
 */

import { MigrationError, VibORMErrorCode } from "../errors";
import { isBoolean, isRecord, isString } from "../validation/value-guards";
import { canonicalizeJson } from "./canonical-json";
import { domainHash, HASH_DOMAIN, parseSha256, type Sha256 } from "./identity";
import { parseDispatch } from "./v1-parse-dispatch";
import {
  exactObject,
  parseFiniteInteger,
  parseFormat,
  parseRequiredString,
  refuse,
} from "./v1-parse-shared";
import type {
  LedgerEffectStateV1,
  LedgerEventKindV1,
  LedgerEventV1,
  MarkerPathEdgeV1,
  MigrationMarkerV1,
  ResetPlanV1,
} from "./v1-types";

export function encodePathHash(path: readonly MarkerPathEdgeV1[]): Sha256 {
  return domainHash(HASH_DOMAIN.path, canonicalizeJson(path));
}

export function eventIdFor(event: Omit<LedgerEventV1, "eventId">): Sha256 {
  return domainHash(HASH_DOMAIN.event, canonicalizeJson(event));
}

const MARKER_KEYS = [
  "estateHash",
  "format",
  "path",
  "pathHash",
  "revision",
  "snapshotHash",
  "stateId",
  "updatedAt",
] as const;
const PATH_EDGE_KEYS = [
  "baselineBoundary",
  "stateId",
  "transitionHash",
] as const;

export function parseMarkerRow(value: unknown): MigrationMarkerV1 {
  const record = exactObject(
    value,
    MARKER_KEYS,
    MARKER_KEYS,
    "migration marker"
  );
  if (!Array.isArray(record.path)) refuse("marker.path must be an array");
  const path = record.path.map((edge, index) => {
    const item = exactObject(
      edge,
      PATH_EDGE_KEYS,
      PATH_EDGE_KEYS,
      `marker.path[${index}]`
    );
    if (!isBoolean(item.baselineBoundary)) {
      refuse(`marker.path[${index}].baselineBoundary must be boolean`);
    }
    return {
      stateId: parseSha256(item.stateId, `marker.path[${index}].stateId`),
      transitionHash: parseSha256(
        item.transitionHash,
        `marker.path[${index}].transitionHash`
      ),
      baselineBoundary: item.baselineBoundary,
    };
  });
  const pathHash = parseSha256(record.pathHash, "marker.pathHash");
  if (pathHash !== encodePathHash(path)) {
    throw new MigrationError(
      "marker.pathHash does not match the stored path",
      VibORMErrorCode.MIGRATION_CORRUPTION
    );
  }
  if (!isString(record.updatedAt) || record.updatedAt.length === 0) {
    refuse("marker.updatedAt must be an ISO timestamp");
  }
  return {
    format: parseFormat(record.format, "marker"),
    estateHash: parseSha256(record.estateHash, "marker.estateHash"),
    stateId:
      record.stateId === null
        ? null
        : parseSha256(record.stateId, "marker.stateId"),
    snapshotHash: parseSha256(record.snapshotHash, "marker.snapshotHash"),
    path,
    pathHash,
    revision: parseFiniteInteger(record.revision, "marker.revision"),
    updatedAt: record.updatedAt,
  };
}

const LEDGER_KINDS: readonly LedgerEventKindV1[] = [
  "started",
  "step-confirmed",
  "applied",
  "failed",
  "rolled-back",
  "baselined",
  "resolved",
  "reset-started",
  "reset-step-confirmed",
  "reset-applied",
];
const EFFECT_STATES: readonly LedgerEffectStateV1[] = [
  "none",
  "committed",
  "partial",
  "may-have-committed",
];
const LEDGER_KEYS = [
  "attemptId",
  "direction",
  "dispatchId",
  "effectState",
  "estateHash",
  "eventId",
  "failure",
  "finishedAt",
  "format",
  "fromState",
  "kind",
  "operationId",
  "snapshotHash",
  "sqlHash",
  "startedAt",
  "toState",
  "toolVersion",
  "transitionHash",
] as const;
const RESET_LEDGER_KEYS = [...LEDGER_KEYS, "resetPlan"] as const;
const RESET_PLAN_KEYS = [
  "clearDispatches",
  "estateHash",
  "referencedStates",
  "replayPath",
  "resetPlanHash",
  "sourceFingerprint",
  "sourceRevision",
  "targetIdentity",
] as const;

export function parseLedgerEvent(value: unknown): LedgerEventV1 {
  if (!isRecord(value)) refuse("ledger event must be an object");
  const kind = parseLedgerKind(value.kind);
  const record = exactObject(
    value,
    kind === "reset-started" ? RESET_LEDGER_KEYS : LEDGER_KEYS,
    kind === "reset-started" ? RESET_LEDGER_KEYS : LEDGER_KEYS,
    "ledger event"
  );
  const event = {
    format: parseFormat(record.format, "ledger event"),
    eventId: parseSha256(record.eventId, "ledger.eventId"),
    attemptId: parseSha256(record.attemptId, "ledger.attemptId"),
    kind,
    estateHash: parseSha256(record.estateHash, "ledger.estateHash"),
    snapshotHash: parseSha256(record.snapshotHash, "ledger.snapshotHash"),
    sqlHash:
      record.sqlHash === null
        ? null
        : parseSha256(record.sqlHash, "ledger.sqlHash"),
    fromState:
      record.fromState === null
        ? null
        : parseSha256(record.fromState, "ledger.fromState"),
    toState:
      record.toState === null
        ? null
        : parseSha256(record.toState, "ledger.toState"),
    transitionHash:
      record.transitionHash === null
        ? null
        : parseSha256(record.transitionHash, "ledger.transitionHash"),
    direction: parseDirection(record.direction),
    operationId:
      record.operationId === null
        ? null
        : parseRequiredString(record.operationId, "ledger.operationId"),
    dispatchId:
      record.dispatchId === null
        ? null
        : parseSha256(record.dispatchId, "ledger.dispatchId"),
    effectState: parseEffectState(record.effectState),
    startedAt: parseRequiredString(record.startedAt, "ledger.startedAt"),
    finishedAt:
      record.finishedAt === null
        ? null
        : parseRequiredString(record.finishedAt, "ledger.finishedAt"),
    toolVersion: parseRequiredString(record.toolVersion, "ledger.toolVersion"),
    failure:
      record.failure === null
        ? null
        : parseRequiredString(record.failure, "ledger.failure"),
  };
  const admitted =
    kind === "reset-started"
      ? { ...event, resetPlan: parseResetPlan(record.resetPlan) }
      : event;
  const { eventId, ...body } = admitted;
  if (eventId !== eventIdFor(body)) {
    throw new MigrationError(
      "ledger eventId does not match the canonical event",
      VibORMErrorCode.MIGRATION_CORRUPTION
    );
  }
  return admitted;
}

function parseLedgerKind(value: unknown): LedgerEventKindV1 {
  if (isString(value)) {
    for (const kind of LEDGER_KINDS) {
      if (value === kind) return kind;
    }
  }
  refuse("ledger event.kind is not a V1 kind");
}

function parseEffectState(value: unknown): LedgerEffectStateV1 {
  if (isString(value)) {
    for (const effectState of EFFECT_STATES) {
      if (value === effectState) return effectState;
    }
  }
  refuse("ledger event.effectState is invalid");
}

function parseDirection(value: unknown): LedgerEventV1["direction"] {
  if (
    value === "forward" ||
    value === "rollback" ||
    value === "reset" ||
    value === "baseline" ||
    value === "resolve"
  ) {
    return value;
  }
  refuse("ledger event.direction is invalid");
}

function parseResetPlan(value: unknown): ResetPlanV1 {
  const record = exactObject(
    value,
    RESET_PLAN_KEYS,
    RESET_PLAN_KEYS,
    "reset plan"
  );
  if (
    !(
      Array.isArray(record.replayPath) &&
      Array.isArray(record.clearDispatches) &&
      Array.isArray(record.referencedStates)
    )
  ) {
    refuse("reset plan arrays are malformed");
  }
  const plan: ResetPlanV1 = {
    estateHash: parseSha256(record.estateHash, "resetPlan.estateHash"),
    targetIdentity: parseRequiredString(
      record.targetIdentity,
      "resetPlan.targetIdentity"
    ),
    sourceRevision: parseFiniteInteger(
      record.sourceRevision,
      "resetPlan.sourceRevision"
    ),
    sourceFingerprint: parseSha256(
      record.sourceFingerprint,
      "resetPlan.sourceFingerprint"
    ),
    replayPath: record.replayPath.map((id, index) =>
      parseSha256(id, `resetPlan.replayPath[${index}]`)
    ),
    clearDispatches: record.clearDispatches.map((dispatch, index) =>
      parseDispatch(dispatch, `resetPlan.clearDispatches[${index}]`)
    ),
    referencedStates: record.referencedStates.map((id, index) =>
      parseSha256(id, `resetPlan.referencedStates[${index}]`)
    ),
    resetPlanHash: parseSha256(record.resetPlanHash, "resetPlan.resetPlanHash"),
  };
  const { resetPlanHash, ...body } = plan;
  if (
    resetPlanHash !== domainHash(HASH_DOMAIN.resetPlan, canonicalizeJson(body))
  ) {
    throw new MigrationError(
      "resetPlanHash does not match the canonical reset plan",
      VibORMErrorCode.MIGRATION_CORRUPTION
    );
  }
  return plan;
}
