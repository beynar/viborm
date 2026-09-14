import type { Operations, Schema } from "@client/types";
import type { AnyDriver } from "@drivers";
import type { ExecutionBinding } from "@query-engine/raptor3/shared/operation-context";
import type Database from "better-sqlite3";
import type { ContractId, ScenarioId, WitnessFamily } from "../contracts";
import type { ProfileId, TransportProfileId } from "../profiles";

export type StateRows = Record<string, unknown[]>;

/** The SQL/rows are diagnostic; fixtures identify semantic cuts, never step N. */
export interface StatementCompletion {
  sql: string;
  parameters: readonly unknown[];
  rows: readonly unknown[];
  transactionOpen: boolean;
}

export interface DefaultObservation {
  name: string;
  value: string | number;
}

export interface ScenarioControls {
  readonly profile: ProfileId;
  readonly seed: number;
  readonly clockEpochMs: number;
  readonly fault?: ControlledFault;
  recordDefault(name: string, value: string | number): void;
  recordCut(name: string): void;
}

export type ControlledFault =
  | { kind: "before-dispatch"; times?: number }
  | { kind: "at-cut"; cut: string }
  | { kind: "after-rollback" };

export interface FailureObservation {
  name: string;
  message: string;
  code?: string;
  meta?: unknown;
  cause?: unknown;
  errors?: unknown[];
}

export type OperationOutcome =
  | { kind: "success"; value: unknown }
  | { kind: "failure"; failure: FailureObservation };

export interface RunObservation {
  outcome: OperationOutcome;
  subsequentOutcomes?: OperationOutcome[];
  initial: StateRows;
  final: StateRows;
  defaults: DefaultObservation[];
  reachedCuts: string[];
}

/** Private candidates receive public recipes, never fixture IDs or prepared nodes. */
export type CandidateEngineFactory = (config: {
  schema: Schema;
  driver: AnyDriver;
}) => {
  execute(
    modelName: string,
    operation: Operations,
    rawArgs: unknown,
    binding?: ExecutionBinding
  ): Promise<unknown>;
};

/** Each fixture owns its public call and independent SQL state/property oracle. */
export interface PreparedScenario {
  readonly publicInput: unknown;
  readonly requiredCuts: readonly string[];
  readonly expectedExecutions?: number;
  readonly subsequentOutcomes?: OperationOutcome[];
  seed(database: Database.Database): void;
  invoke(
    driver: AnyDriver,
    candidateFactory?: CandidateEngineFactory
  ): Promise<unknown>;
  inspect(database: Database.Database): StateRows;
  afterStatement?(
    database: Database.Database,
    completion: StatementCompletion
  ): string | readonly string[] | undefined;
  afterTransaction?(
    database: Database.Database,
    phase: "begin" | "commit" | "rollback"
  ): string | undefined;
  assert(observation: RunObservation): void;
}

export interface ScenarioDefinition {
  readonly id: ScenarioId;
  readonly specimen?: "wrong-parent-world";
  readonly family: WitnessFamily;
  readonly contracts: readonly ContractId[];
  readonly sources: readonly string[];
  prepare(controls: ScenarioControls): PreparedScenario;
}

/** Exact same-build replay evidence; these events are not cross-engine contracts. */
export type ControlledEvent =
  | { kind: "clock"; value: number }
  | { kind: "random"; source: "uuid" | "math"; value: string | number }
  | { kind: "default"; observation: DefaultObservation }
  | {
      kind: "dispatch";
      sql: string;
      parameters: readonly unknown[];
      transactionOpen: boolean;
    }
  | { kind: "completion"; statement: StatementCompletion; releaseTurns: number }
  | { kind: "dispatch-failure"; failure: FailureObservation }
  | { kind: "cleanup-failure"; failure: FailureObservation }
  | { kind: "transaction"; phase: "begin" | "commit" | "rollback" }
  | {
      kind: "transaction-failure";
      phase: "begin" | "commit" | "rollback";
      failure: FailureObservation;
    }
  | { kind: "cut"; name: string }
  | { kind: "injected-failure"; cut: string }
  | { kind: "release"; eligible: string[]; selected: string }
  | {
      kind: "transport";
      request: string;
      actor: string;
      correlationId: string;
      phase: "queued" | "committed" | "acknowledged" | "returned" | "rejected";
    };

export interface ReplayTape {
  events: readonly ControlledEvent[];
}

export interface G0ReplayRecord {
  scenarioId: ScenarioId;
  specimen?: "wrong-parent-world";
  candidate?: "commands";
  profile: ProfileId;
  seed: number;
  fault?: ControlledFault;
  publicInput: unknown;
  schema: readonly unknown[];
  sqliteVersion: string;
  tape: ReplayTape;
  observation: RunObservation;
  statements: readonly StatementCompletion[];
}

export interface TransportReplayRecord
  extends Omit<
    G0ReplayRecord,
    "scenarioId" | "profile" | "sqliteVersion" | "fault" | "specimen"
  > {
  scenarioId: "g1-transport" | "g2-transport";
  candidate?: "commands";
  profile: TransportProfileId;
  transportVersion: "explicit-replies-v1";
  specimen?: "wrong-publication" | "lost-progress" | "wrong-attribution";
}

export type ReplayRecord = G0ReplayRecord | TransportReplayRecord;
