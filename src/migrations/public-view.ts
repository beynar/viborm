/** Immutable, non-executable migration graph projections for public tooling. */

import { MigrationError, VibORMErrorCode } from "../errors";
import type { MigrationGraph } from "./graph";
import type { Sha256 } from "./identity";
import type { MigrationTarget } from "./types";
import type {
  MigrationOperationV1,
  MigrationParentTransitionV1,
  MigrationStateManifestV1,
} from "./v1-types";

export interface MigrationStateListItem {
  readonly stateId: Sha256;
  readonly name: string;
}

export interface MigrationStateMetadata extends MigrationStateListItem {
  readonly snapshotHash: Sha256;
  readonly sqlHash: Sha256;
  readonly root: boolean;
  readonly leaf: boolean;
}

export type MigrationRollbackMetadata =
  | {
      readonly kind: "schema" | "manual";
      readonly operationCount: number;
      readonly stepCount: number;
    }
  | {
      readonly kind: "irreversible";
      readonly reason: string;
      readonly operationCount: 0;
      readonly stepCount: 0;
    };

export interface MigrationEdgeMetadata {
  readonly fromState: Sha256 | null;
  readonly toState: Sha256;
  readonly transitionHash: Sha256;
  readonly requestedBoundary: "transactional" | "stepwise" | null;
  readonly operationCount: number;
  readonly stepCount: number;
  readonly origins: readonly ("generated" | "manual")[];
  readonly risks: readonly ("safe" | "destructive" | "opaque")[];
  readonly rollback: MigrationRollbackMetadata;
}

export interface MigrationStateDetails extends MigrationStateMetadata {
  readonly incoming: readonly MigrationEdgeMetadata[];
  readonly outgoing: readonly MigrationEdgeMetadata[];
}

export interface GraphResult {
  readonly estateHash: Sha256;
  readonly target: MigrationTarget;
  readonly roots: readonly Sha256[];
  readonly leaves: readonly Sha256[];
  readonly states: readonly MigrationStateMetadata[];
  readonly edges: readonly MigrationEdgeMetadata[];
}

export type ListResult = readonly MigrationStateListItem[];
export type ShowResult = MigrationStateDetails;

export function listMigrationStates(graph: MigrationGraph): ListResult {
  return Object.freeze(
    sortedStates(graph).map((state) =>
      Object.freeze({ stateId: state.stateId, name: state.name })
    )
  );
}

export function showMigrationState(
  graph: MigrationGraph,
  stateId: Sha256
): ShowResult {
  const state = graph.states.get(stateId);
  if (!state) {
    throw new MigrationError(
      "Resolved migration state is absent from its graph",
      VibORMErrorCode.INTERNAL_ERROR
    );
  }
  const edges = graphEdges(graph);
  return Object.freeze({
    ...stateMetadata(graph, state),
    incoming: Object.freeze(edges.filter((edge) => edge.toState === stateId)),
    outgoing: Object.freeze(edges.filter((edge) => edge.fromState === stateId)),
  });
}

export function migrationGraphResult(graph: MigrationGraph): GraphResult {
  return Object.freeze({
    estateHash: graph.estateHash,
    target: migrationTarget(graph.descriptor.target),
    roots: Object.freeze([...graph.roots].sort()),
    leaves: Object.freeze([...graph.leaves].sort()),
    states: Object.freeze(
      sortedStates(graph).map((state) => stateMetadata(graph, state))
    ),
    edges: graphEdges(graph),
  });
}

function sortedStates(graph: MigrationGraph): MigrationStateManifestV1[] {
  return [...graph.states.values()].sort((left, right) =>
    left.stateId.localeCompare(right.stateId)
  );
}

function stateMetadata(
  graph: MigrationGraph,
  state: MigrationStateManifestV1
): MigrationStateMetadata {
  return Object.freeze({
    stateId: state.stateId,
    name: state.name,
    snapshotHash: state.snapshotHash,
    sqlHash: state.sqlHash,
    root: graph.roots.includes(state.stateId),
    leaf: graph.leaves.includes(state.stateId),
  });
}

function graphEdges(graph: MigrationGraph): readonly MigrationEdgeMetadata[] {
  const edges: MigrationEdgeMetadata[] = [];
  for (const state of sortedStates(graph)) {
    for (const transition of state.parents) {
      edges.push(edgeMetadata(state.stateId, transition));
    }
  }
  edges.sort((left, right) => {
    const from = (left.fromState ?? "").localeCompare(right.fromState ?? "");
    return from === 0 ? left.toState.localeCompare(right.toState) : from;
  });
  return Object.freeze(edges);
}

function edgeMetadata(
  toState: Sha256,
  transition: MigrationParentTransitionV1
): MigrationEdgeMetadata {
  return Object.freeze({
    fromState: transition.fromState,
    toState,
    transitionHash: transition.transitionHash,
    requestedBoundary: transition.requestedForwardBoundary,
    operationCount: transition.operations.length,
    stepCount: stepCount(transition.operations),
    origins: uniqueOperationValues(transition.operations, "origin"),
    risks: uniqueOperationValues(transition.operations, "risk"),
    rollback: rollbackMetadata(transition),
  });
}

function rollbackMetadata(
  transition: MigrationParentTransitionV1
): MigrationRollbackMetadata {
  if (transition.rollback.kind === "irreversible") {
    return Object.freeze({
      kind: transition.rollback.kind,
      reason: transition.rollback.reason,
      operationCount: 0,
      stepCount: 0,
    });
  }
  const operations = transition.rollback.operations;
  return Object.freeze({
    kind: transition.rollback.kind,
    operationCount: operations.length,
    stepCount: stepCount(operations),
  });
}

function stepCount(operations: readonly MigrationOperationV1[]): number {
  let count = 0;
  for (const operation of operations) count += operation.steps.length;
  return count;
}

function uniqueOperationValues<K extends "origin" | "risk">(
  operations: readonly MigrationOperationV1[],
  key: K
): readonly MigrationOperationV1[K][] {
  const values: MigrationOperationV1[K][] = [];
  for (const operation of operations) {
    const value = operation[key];
    if (!values.includes(value)) values.push(value);
  }
  return Object.freeze(values);
}

function migrationTarget(target: MigrationTarget): MigrationTarget {
  return target.dialect === "postgresql"
    ? Object.freeze({ dialect: target.dialect, namespace: target.namespace })
    : Object.freeze({ dialect: target.dialect });
}
