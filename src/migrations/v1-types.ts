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

/**
 * One destructive change of a generated transition, approved through the
 * resolve callback at `generate`. It names the change by identity only, so the
 * same decision on the same diff always encodes to the same bytes.
 */
export interface MigrationApprovalV1 {
  readonly operation: "dropTable" | "dropColumn" | "addColumn" | "alterColumn";
  readonly table: string;
  readonly column: string | null;
}

export interface MigrationParentTransitionV1 {
  readonly fromState: Sha256 | null;
  readonly transitionHash: Sha256;
  readonly originChecks: readonly MigrationBooleanCheckV1[];
  readonly requestedForwardBoundary: "transactional" | "stepwise" | null;
  readonly operations: readonly MigrationOperationV1[];
  readonly rollback: MigrationRollbackV1;
  /**
   * Present, non-empty and part of `transitionHash` only when the transition
   * carries destructive changes, so a transition without one keeps the bytes
   * and the ids it had before approvals existed.
   */
  readonly approvals?: readonly MigrationApprovalV1[];
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
  /**
   * What to do when the database marker is AHEAD of this history — its arrival
   * path leaves this estate after a state it holds, because newer code
   * migrated the database. `"refuse"` (the default) throws V11002; `"noop"`
   * returns a `noop` outcome without touching the database. A marker unknown
   * to this estate altogether is always refused.
   */
  readonly ifAhead?: "noop" | "refuse";
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

/**
 * `reanchor()` (plan T3) moves a marker this history does not hold onto the
 * one state the live schema matches. `to` adopts the state it names instead:
 * the explicit consent to take the live schema as a new baseline there, which
 * several matching states need.
 */
export interface ReanchorOptions {
  readonly to?: StateSelector;
  readonly via?: readonly Sha256[];
}

/**
 * `down({ to })` is the form for automation: a retry finds the marker already
 * there and does nothing. The relative `steps` form takes `expectRevision`, the
 * `marker.revision` the caller read, so a retried call refuses (V11015)
 * instead of rolling back one more state.
 */
export type DownV1Options = (
  | {
      readonly steps?: number;
      readonly to?: never;
    }
  | {
      readonly to: StateSelector;
      readonly steps?: never;
    }
) & {
  readonly dryRun?: boolean;
  /** Refuse with V11015 unless the marker is still at this revision. */
  readonly expectRevision?: number;
  /**
   * Answers each destructive change the rollback would make to a table that
   * holds rows, as `generate` and `push` ask: `change.proceed()` approves it.
   * Without it, such a rollback refuses with V11017.
   */
  readonly resolve?: ResolveCallback;
};

/**
 * One edge of a `down({ dryRun: true })` preview, in the order `down` would
 * roll it back: the state left, the state reached, and the review of its
 * rollback SQL.
 */
export interface DownPreviewEdgeV1 {
  readonly stateId: Sha256;
  readonly toState: Sha256 | null;
  readonly sql: string;
}

/**
 * `down` itself returns `preview: false`. A dry run returns each edge's
 * rollback SQL and `refusal`: the error `down` would raise with the same
 * options (an irreversible step, an unapproved loss of rows, drift), or `null`.
 * Plain data, so it crosses an RPC boundary intact.
 */
export type DownV1Result =
  | { readonly path: readonly Sha256[]; readonly preview: false }
  | {
      readonly path: readonly Sha256[];
      readonly preview: true;
      readonly edges: readonly DownPreviewEdgeV1[];
      readonly refusal: {
        readonly code: string;
        readonly message: string;
      } | null;
    };

/**
 * One `createPredefinedResolver` decision, plain JSON. Each names the change
 * it answers by that change's own fields: a rename by table and old and new
 * name, an enum value removal by its column, a destructive change by its
 * approval identity (`column` is `null` for a table).
 */
export type MigrationDecisionV1 =
  | {
      readonly type: "column";
      readonly tableName: string;
      readonly from: string;
      readonly to: string;
      readonly resolution: "rename" | "addAndDrop";
    }
  | {
      readonly type: "table";
      readonly from: string;
      readonly to: string;
      readonly resolution: "rename" | "addAndDrop";
    }
  | {
      readonly type: "enumValueRemoval";
      readonly tableName: string;
      readonly columnName: string;
      readonly mapValues: Readonly<Record<string, string | null>>;
    }
  | ({ readonly type: "destructive" } & MigrationApprovalV1);

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
  /**
   * PostgreSQL (plan T5b): build each index on, and add each foreign key to,
   * a table the migration does not create without a lock that blocks writes
   * while it reads the table. The change is published as consecutive states:
   * the rest of it in one transaction, each index `CREATE INDEX CONCURRENTLY`
   * outside any, the keys `NOT VALID`, then their `VALIDATE CONSTRAINT` in a
   * commit of its own. A step outside a transaction needs a direct session,
   * which a transaction pooler cannot give. Other dialects ignore it.
   */
  readonly lowLock?: boolean;
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

/**
 * PostgreSQL: a partial index of the marked snapshot and its predicate as the
 * server deparsed it (`pg_get_expr`), read from the catalog by the apply that
 * wrote the marker once it proved the snapshot. Stored in the marker row
 * beside the marker (`predicates`), never in a snapshot, so state ids do not
 * change; a no-op compares the live deparse with it in one statement.
 */
export interface MarkerIndexPredicateV1 {
  readonly table: string;
  readonly index: string;
  readonly deparsed: string;
}

export type LedgerEventKindV1 =
  | "started"
  | "step-confirmed"
  | "applied"
  | "failed"
  | "rolled-back"
  | "baselined"
  | "reanchored"
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
    }
  | {
      readonly dialect: "mysql";
      readonly database: string;
    }
  | {
      readonly dialect: "sqlite";
      readonly location: string | null;
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
