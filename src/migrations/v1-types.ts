/**
 * Closed Migration V1 artifact and command types.
 *
 * These are the persisted and public shapes. Parsers in `v1-parse.ts` are the
 * only admission boundary; nothing else JSON.parse-casts a snapshot or state.
 */

import type { Sql } from "@sql";
import type { Sha256 } from "./identity";
import type { MigrationTarget, ResolveCallback } from "./types";

export type MigrationFormatV1 = "1";

export interface MigrationEstateDescriptorV1 {
  readonly format: MigrationFormatV1;
  readonly target: MigrationTarget;
  readonly hash: "sha256";
}

export type MigrationParameterV1 =
  | { readonly kind: "null" }
  | { readonly kind: "target-namespace" }
  | { readonly kind: "boolean"; readonly value: boolean }
  | { readonly kind: "string"; readonly value: string }
  | { readonly kind: "number"; readonly value: number }
  | { readonly kind: "bigint"; readonly value: string }
  | { readonly kind: "bytes"; readonly value: string }
  | { readonly kind: "date-time"; readonly value: string }
  | { readonly kind: "decimal"; readonly value: string }
  | { readonly kind: "json"; readonly value: unknown };

export interface MigrationDispatchV1 {
  readonly dispatchId: Sha256;
  readonly sqlHash: Sha256;
  readonly offset: number;
  readonly length: number;
  readonly parameters: readonly MigrationParameterV1[];
}

export interface MigrationBooleanCheckV1 {
  readonly kind: "driver" | "trusted-read";
  readonly id: string;
  readonly query: MigrationDispatchV1;
  readonly equals: boolean;
}

export type MigrationStepV1 =
  | {
      readonly retry: "proven";
      readonly precheck: MigrationBooleanCheckV1;
      readonly execute: MigrationDispatchV1;
      readonly postcheck: MigrationBooleanCheckV1;
    }
  | {
      readonly retry: "opaque";
      readonly execute: MigrationDispatchV1;
    };

export interface MigrationOperationV1 {
  readonly id: string;
  readonly label: string;
  readonly origin: "generated" | "manual";
  readonly risk: "safe" | "destructive" | "opaque";
  readonly steps: readonly MigrationStepV1[];
}

export type MigrationRollbackV1 =
  | {
      readonly kind: "schema";
      readonly operations: readonly MigrationOperationV1[];
    }
  | {
      readonly kind: "manual";
      readonly requestedBoundary: "transactional" | "stepwise";
      readonly operations: readonly MigrationOperationV1[];
    }
  | { readonly kind: "irreversible"; readonly reason: string };

export interface MigrationParentTransitionV1 {
  readonly fromState: Sha256 | null;
  readonly transitionHash: Sha256;
  readonly originChecks: readonly MigrationBooleanCheckV1[];
  readonly requestedForwardBoundary: "transactional" | "stepwise" | null;
  readonly operations: readonly MigrationOperationV1[];
  readonly rollback: MigrationRollbackV1;
}

export interface MigrationStateManifestV1 {
  readonly format: MigrationFormatV1;
  readonly estateHash: Sha256;
  readonly name: string;
  readonly stateId: Sha256;
  readonly snapshotHash: Sha256;
  readonly sqlHash: Sha256;
  readonly destinationChecks: readonly MigrationBooleanCheckV1[];
  readonly parents: readonly MigrationParentTransitionV1[];
}

export interface MigrationSqlRangeV1 {
  readonly dispatchId: Sha256;
  readonly offset: number;
  readonly length: number;
}

export interface MigrationCheckInput {
  readonly kind: "trusted-read";
  readonly query: Sql;
  readonly equals: boolean;
}

export interface ManualTransitionInput {
  readonly from: Sha256 | null;
  readonly execution: "transactional" | "stepwise";
  readonly up: readonly Sql[];
  readonly originChecks?: readonly MigrationCheckInput[];
  readonly rollback:
    | {
        readonly kind: "manual";
        readonly execution: "transactional" | "stepwise";
        readonly sql: readonly Sql[];
      }
    | { readonly kind: "irreversible"; readonly reason: string };
}

export interface ManualMigrationInput {
  readonly transitions: readonly ManualTransitionInput[];
  readonly destinationChecks?: readonly MigrationCheckInput[];
}

export type StateSelector =
  | { readonly id: Sha256 }
  | { readonly prefix: string }
  | { readonly name: string };

export interface ApplyV1Options {
  readonly to?: StateSelector;
  readonly via?: readonly Sha256[];
  readonly dryRun?: boolean;
}

export interface ResetV1Options {
  readonly to?: StateSelector;
  readonly via?: readonly Sha256[];
  readonly dryRun?: boolean;
}

export interface BaselineOptions {
  readonly to: StateSelector;
  readonly via?: readonly Sha256[];
}

export type DownV1Options =
  | {
      readonly steps?: number;
      readonly to?: never;
      readonly dryRun?: boolean;
    }
  | {
      readonly to: StateSelector;
      readonly steps?: never;
      readonly dryRun?: boolean;
    };

export interface ResolveV1Options {
  readonly outcome: "complete" | "rolled-back" | "retry";
}

export interface GenerateV1Options {
  readonly name?: string;
  /** Full parent state id, or `null` for the virtual empty root. */
  readonly from?: Sha256 | null;
  readonly dryRun?: boolean;
  readonly resolve?: ResolveCallback;
  readonly skipValidation?: boolean;
  readonly manualMigration?: ManualMigrationInput;
}

export type PathHash = Sha256;

export interface MarkerPathEdgeV1 {
  readonly stateId: Sha256;
  readonly transitionHash: Sha256;
  readonly baselineBoundary: boolean;
}

export interface MigrationMarkerV1 {
  readonly format: MigrationFormatV1;
  readonly estateHash: Sha256;
  readonly stateId: Sha256 | null;
  readonly snapshotHash: Sha256;
  readonly path: readonly MarkerPathEdgeV1[];
  readonly pathHash: PathHash;
  readonly revision: number;
  readonly updatedAt: string;
}

export type LedgerEventKindV1 =
  | "started"
  | "step-confirmed"
  | "applied"
  | "failed"
  | "rolled-back"
  | "baselined"
  | "resolved"
  | "reset-started"
  | "reset-step-confirmed"
  | "reset-applied";

export type LedgerEffectStateV1 =
  | "none"
  | "committed"
  | "partial"
  | "may-have-committed";

export interface ResetPlanV1 {
  readonly estateHash: Sha256;
  readonly targetIdentity: string;
  readonly sourceRevision: number;
  readonly sourceFingerprint: Sha256;
  readonly replayPath: readonly Sha256[];
  readonly clearDispatches: readonly MigrationDispatchV1[];
  readonly referencedStates: readonly Sha256[];
  readonly resetPlanHash: Sha256;
}

export interface LedgerEventV1 {
  readonly format: MigrationFormatV1;
  readonly eventId: Sha256;
  readonly attemptId: Sha256;
  readonly kind: LedgerEventKindV1;
  readonly estateHash: Sha256;
  readonly snapshotHash: Sha256;
  readonly sqlHash: Sha256 | null;
  readonly fromState: Sha256 | null;
  readonly toState: Sha256 | null;
  readonly transitionHash: Sha256 | null;
  readonly direction: "forward" | "rollback" | "reset" | "baseline" | "resolve";
  readonly operationId: string | null;
  readonly dispatchId: Sha256 | null;
  readonly effectState: LedgerEffectStateV1;
  readonly startedAt: string;
  readonly finishedAt: string | null;
  readonly toolVersion: string;
  readonly resetPlan?: ResetPlanV1;
  readonly failure: string | null;
}

export interface PushPlanningOptions {
  readonly forceReset?: boolean;
  readonly skipValidation?: boolean;
  readonly resolve?: ResolveCallback;
}

export type PushTargetIdentity =
  | {
      readonly dialect: "postgresql";
      readonly database: string;
      readonly namespace: string;
      readonly bindingId: string;
    }
  | {
      readonly dialect: "mysql";
      readonly database: string;
      readonly bindingId: string;
    }
  | {
      readonly dialect: "sqlite";
      readonly location: string | null;
      readonly bindingId: string;
    };

export interface PushStatementPreview {
  readonly sql: string;
  readonly parameters: readonly MigrationParameterV1[];
}

export interface PushResolution {
  readonly id: string;
  readonly decision: string;
}

export interface PushConsent {
  readonly format: MigrationFormatV1;
  readonly target: PushTargetIdentity;
  readonly planHash: Sha256;
  readonly mode: "diff" | "force-reset";
  readonly validation: "full" | "structural-only";
  readonly resolutions: readonly PushResolution[];
}

export type PushOptionsV1 =
  | (PushPlanningOptions & { readonly dryRun: true })
  | (PushPlanningOptions & {
      readonly dryRun?: false;
      readonly consent?: never;
    })
  | {
      readonly consent: PushConsent;
      readonly dryRun?: false;
    };

export type PushOptionKey =
  | "forceReset"
  | "skipValidation"
  | "resolve"
  | "dryRun"
  | "consent";

export type ExactPushOptions<O> = O &
  Record<Exclude<keyof O & string, PushOptionKey>, never>;

export interface PushOperation {
  readonly id: string;
  readonly label: string;
  readonly risk: "safe" | "destructive" | "opaque";
}

export interface PushPreview {
  readonly outcome: "planned" | "noop";
  readonly target: PushTargetIdentity;
  readonly planHash: Sha256;
  readonly destructive: boolean;
  readonly operations: readonly PushOperation[];
  readonly statements: readonly PushStatementPreview[];
  readonly consent: PushConsent;
}

export interface PushApplyResult {
  readonly outcome: "applied" | "noop";
  readonly target: PushTargetIdentity;
  readonly planHash: Sha256;
  readonly operations: readonly PushOperation[];
  readonly statements: readonly PushStatementPreview[];
}

export interface PathWitness {
  readonly routes: readonly (readonly Sha256[])[];
  readonly frontier: readonly Sha256[];
  readonly more: boolean;
}

export type AtomicityClass = "transactional" | "stepwise";
