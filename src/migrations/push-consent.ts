/**
 * Hostile admission for push options and inert consent.
 *
 * Consent is not authority. A forged or stale value can only refuse
 * execution. Apply replans under the lock and compares this closed shape.
 */

import { MigrationError, VibORMErrorCode } from "../errors";
import { canonicalizeJsonText } from "./canonical-json";
import { isSha256, type Sha256 } from "./identity";
import { snapshotExactArray, snapshotExactRecord } from "./input-boundary";
import { freezeDeep } from "./push-fingerprint";
import type { ResolveCallback } from "./types";
import type {
  PushConsent,
  PushResolution,
  PushTargetIdentity,
} from "./v1-types";

interface ConsentedPlan {
  readonly mode: PushConsent["mode"];
  readonly validation: PushConsent["validation"];
  readonly target: PushTargetIdentity;
  readonly sourceFingerprint: Sha256;
  readonly planHash: Sha256;
  readonly resolutions: readonly PushResolution[];
}

export interface ParsedPlanningOptions {
  readonly forceReset: boolean;
  readonly skipValidation: boolean;
  readonly resolve: ResolveCallback | undefined;
  readonly dryRun: boolean;
}

export function snapshotPushOptions(
  value: unknown
): Readonly<Record<string, unknown>> {
  return snapshotExactRecord(
    value,
    ["consent", "dryRun", "forceReset", "resolve", "skipValidation"],
    "push options",
    invalidOptions
  );
}

export function parsePlanningOptions(
  value: unknown,
  dryRun: boolean
): ParsedPlanningOptions {
  const record = snapshotExactRecord(
    value,
    ["dryRun", "forceReset", "resolve", "skipValidation"],
    "push options",
    invalidOptions
  );
  return parseSnapshottedPlanningOptions(record, dryRun);
}

export function parseSnapshottedPlanningOptions(
  record: Readonly<Record<string, unknown>>,
  dryRun: boolean
): ParsedPlanningOptions {
  if (record.dryRun !== undefined && typeof record.dryRun !== "boolean") {
    invalidOptions("push options.dryRun must be boolean");
  }
  if (
    record.forceReset !== undefined &&
    typeof record.forceReset !== "boolean"
  ) {
    invalidOptions("push options.forceReset must be boolean");
  }
  if (
    record.skipValidation !== undefined &&
    typeof record.skipValidation !== "boolean"
  ) {
    invalidOptions("push options.skipValidation must be boolean");
  }
  const candidate = record.resolve;
  if (candidate !== undefined && typeof candidate !== "function") {
    invalidOptions("push options.resolve must be a function");
  }
  const resolve: ResolveCallback | undefined =
    typeof candidate === "function"
      ? (change) => Reflect.apply(candidate, undefined, [change])
      : undefined;
  return {
    dryRun: dryRun || record.dryRun === true,
    forceReset: record.forceReset === true,
    skipValidation: record.skipValidation === true,
    resolve,
  };
}

export function parseConsent(value: unknown): PushConsent {
  const record = snapshotExactRecord(
    value,
    ["format", "mode", "planHash", "resolutions", "target", "validation"],
    "push consent",
    consentMismatch
  );
  if (record.format !== "1") consentMismatch("consent.format must be 1");
  if (record.mode !== "diff" && record.mode !== "force-reset") {
    consentMismatch("consent.mode is invalid");
  }
  if (record.validation !== "full" && record.validation !== "structural-only") {
    consentMismatch("consent.validation is invalid");
  }
  if (!isSha256(record.planHash)) {
    consentMismatch("consent.planHash is invalid");
  }
  const resolutionEntries = snapshotExactArray(
    record.resolutions,
    "consent.resolutions",
    consentMismatch
  );
  const resolutions = resolutionEntries.map((resolution, index) => {
    const item = snapshotExactRecord(
      resolution,
      ["decision", "id"],
      `consent.resolutions[${index}]`,
      consentMismatch
    );
    if (typeof item.id !== "string" || typeof item.decision !== "string") {
      consentMismatch(`consent.resolutions[${index}] is invalid`);
    }
    return { id: item.id, decision: item.decision };
  });
  return freezeDeep({
    format: "1",
    target: parseTarget(record.target),
    planHash: record.planHash,
    mode: record.mode,
    validation: record.validation,
    resolutions,
  });
}

export function assertAcceptedPlan(
  accepted: ConsentedPlan,
  locked: ConsentedPlan
): void {
  if (
    accepted.sourceFingerprint !== locked.sourceFingerprint ||
    accepted.planHash !== locked.planHash
  ) {
    throw new MigrationError(
      "The live push plan changed before the locked replan",
      VibORMErrorCode.MIGRATION_CONSENT_MISMATCH,
      {
        meta: {
          expectedChecksum: accepted.planHash,
          actualChecksum: locked.planHash,
          planHash: locked.planHash,
          expectedFingerprint: accepted.sourceFingerprint,
          actualFingerprint: locked.sourceFingerprint,
        },
      }
    );
  }
}

export function assertConsent(consent: PushConsent, plan: ConsentedPlan): void {
  const targetMatches =
    canonicalizeJsonText(consent.target) === canonicalizeJsonText(plan.target);
  const resolutionsMatch =
    canonicalizeJsonText(consent.resolutions) ===
    canonicalizeJsonText(plan.resolutions);
  if (
    consent.mode !== plan.mode ||
    consent.validation !== plan.validation ||
    !targetMatches ||
    !resolutionsMatch ||
    consent.planHash !== plan.planHash
  ) {
    throw new MigrationError(
      "Push consent does not match the locked live plan",
      VibORMErrorCode.MIGRATION_CONSENT_MISMATCH,
      {
        meta: {
          expectedChecksum: consent.planHash,
          actualChecksum: plan.planHash,
          planHash: plan.planHash,
          fingerprint: plan.sourceFingerprint,
        },
      }
    );
  }
}

export function hasConsent(
  options: Readonly<Record<string, unknown>>
): options is Readonly<Record<string, unknown>> & { readonly consent: unknown } {
  return "consent" in options;
}

function parseTarget(value: unknown): PushTargetIdentity {
  const record = snapshotExactRecord(
    value,
    ["bindingId", "database", "dialect", "location", "namespace"],
    "consent.target",
    consentMismatch
  );
  if (record.dialect === "postgresql") {
    refuseTargetKeys(record, [
      "bindingId",
      "database",
      "dialect",
      "namespace",
    ]);
    return {
      dialect: "postgresql",
      database: requiredString(record.database, "consent.target.database"),
      namespace: requiredString(record.namespace, "consent.target.namespace"),
      bindingId: requiredString(record.bindingId, "consent.target.bindingId"),
    };
  }
  if (record.dialect === "mysql") {
    refuseTargetKeys(record, ["bindingId", "database", "dialect"]);
    return {
      dialect: "mysql",
      database: requiredString(record.database, "consent.target.database"),
      bindingId: requiredString(record.bindingId, "consent.target.bindingId"),
    };
  }
  if (record.dialect === "sqlite") {
    refuseTargetKeys(record, ["bindingId", "dialect", "location"]);
    if (record.location !== null && typeof record.location !== "string") {
      consentMismatch("consent.target.location must be string or null");
    }
    return {
      dialect: "sqlite",
      location: record.location,
      bindingId: requiredString(record.bindingId, "consent.target.bindingId"),
    };
  }
  consentMismatch("consent.target.dialect is invalid");
}

function refuseTargetKeys(
  target: Readonly<Record<string, unknown>>,
  allowed: readonly string[]
): void {
  for (const key of Object.keys(target)) {
    if (!allowed.includes(key)) {
      consentMismatch(`consent.target contains unknown key ${key}`);
    }
  }
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    consentMismatch(`${label} must be a non-empty string`);
  }
  return value;
}

function invalidOptions(message: string, cause?: Error): never {
  throw new MigrationError(message, VibORMErrorCode.INVALID_INPUT, { cause });
}

function consentMismatch(message: string, cause?: Error): never {
  throw new MigrationError(message, VibORMErrorCode.MIGRATION_CONSENT_MISMATCH, {
    cause,
  });
}
