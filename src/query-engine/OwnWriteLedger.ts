// biome-ignore-all lint/style/useFilenamingConvention: Architecture names this compiler owner OwnWriteLedger.
import type { BoundRelation } from "./builders/relation-data-builder";
import type { RelationMutationEntry } from "./builders/relation-mutation-parser";
import {
  type RelationMembershipScope,
  relationMembershipScopesEqual,
} from "./RelationMembership";
import {
  classifyTargetConstraintOverlap,
  getTargetConstraintPredicateFields,
  type PredicateFieldSet,
  predicateFieldSetsIntersect,
  type TargetConstraint,
  type TargetConstraintOverlap,
} from "./TargetConstraint";
import { NestedWriteError } from "./types";

export type DependencyOperation = RelationMutationEntry["kind"];
export type TargetWriteDimension = "targetExistence" | "targetPredicate";
export type MembershipReadOrientation = "direct" | "inverse" | "manyToMany";
export type MembershipVisibility = "physical" | "inverseTarget";
export type MembershipPropagation = "node" | "operation";

export interface MembershipEndpoints {
  readonly first: TargetConstraint;
  readonly second: TargetConstraint;
}

/**
 * Which endpoint of a membership the CURRENT model is.
 *
 * A junction's answer is the orientation its own scope carries — the scope erases
 * orientation from what it COMPARES, and records the comparison's verdict beside
 * it, so this reads the fact rather than asking a second time. Row-held membership
 * answers by POSITION, not by holder identity: on a self-relation holder and
 * referenced are the same model, and only the position distinguishes the ends.
 */
export function getRelationMembershipEndpoints(
  relation: BoundRelation,
  scope: RelationMembershipScope,
  currentConstraint: TargetConstraint,
  targetConstraint: TargetConstraint
): MembershipEndpoints {
  const currentIsFirst =
    scope.kind === "manyToMany"
      ? scope.sourceIsFirst
      : relation.position === "parentHeld";
  return currentIsFirst
    ? { first: currentConstraint, second: targetConstraint }
    : { first: targetConstraint, second: currentConstraint };
}

export type OwnWriteDependencyFamily =
  | {
      readonly kind: "create";
      readonly rootOperation?: "create" | "connectOrCreate" | "upsert";
      readonly scalarData: Readonly<Record<string, unknown>>;
    }
  | {
      readonly kind: "update";
      readonly rootOperation?: "update" | "upsert";
      readonly scalarData: Readonly<Record<string, unknown>>;
      readonly selector: Readonly<Record<string, unknown>> | undefined;
    };

export type OwnWriteFootprint =
  | {
      readonly operation: DependencyOperation;
      readonly dimension: "targetExistence";
      readonly constraint: TargetConstraint;
      readonly visibility: "operation" | "relation";
      readonly localScope: symbol;
    }
  | {
      readonly operation: DependencyOperation;
      readonly dimension: "targetPredicate";
      readonly constraint: TargetConstraint;
      readonly predicateFields: PredicateFieldSet | undefined;
      readonly visibility: "node" | "operation";
      readonly localScope: symbol;
    }
  | {
      readonly operation: DependencyOperation;
      readonly dimension: "membership";
      readonly endpoints: MembershipEndpoints;
      readonly scope: RelationMembershipScope;
      readonly visibility: MembershipVisibility;
      readonly propagation: MembershipPropagation;
      readonly localScope: symbol;
    };

interface TargetDecisionRead {
  readonly operation: DependencyOperation;
  readonly dimension: "targetExistence";
  readonly constraint: TargetConstraint;
  readonly predicateFields?: PredicateFieldSet;
  readonly localScope: symbol;
}

interface MembershipDecisionRead {
  readonly operation: DependencyOperation;
  readonly dimension: "membership";
  readonly endpoints: MembershipEndpoints;
  readonly scope: RelationMembershipScope;
  readonly orientation: MembershipReadOrientation;
  readonly localScope: symbol;
}

type DecisionRead = TargetDecisionRead | MembershipDecisionRead;

export class OwnWriteLedger {
  readonly #writes: OwnWriteFootprint[];
  #localScope: symbol;

  constructor(
    writes: readonly OwnWriteFootprint[] = [],
    localScope = Symbol("own-write-root")
  ) {
    this.#writes = [...writes];
    this.#localScope = localScope;
  }

  appendTarget(
    operation: DependencyOperation,
    dimension: TargetWriteDimension,
    constraint: TargetConstraint,
    predicateFields?: PredicateFieldSet
  ): void {
    if (dimension === "targetExistence") {
      this.#writes.push({
        operation,
        dimension,
        constraint,
        visibility: "operation",
        localScope: this.#localScope,
      });
      return;
    }
    this.#writes.push({
      operation,
      dimension,
      constraint,
      predicateFields,
      visibility: "operation",
      localScope: this.#localScope,
    });
  }

  appendRelationTarget(
    operation: DependencyOperation,
    constraint: TargetConstraint
  ): void {
    this.#writes.push({
      operation,
      dimension: "targetExistence",
      constraint,
      visibility: "relation",
      localScope: this.#localScope,
    });
  }

  appendMembership(
    operation: DependencyOperation,
    endpoints: MembershipEndpoints,
    scope: RelationMembershipScope,
    visibility: MembershipVisibility = "physical",
    propagation: MembershipPropagation = "node"
  ): void {
    this.#writes.push({
      operation,
      dimension: "membership",
      endpoints,
      scope,
      visibility,
      propagation,
      localScope: this.#localScope,
    });
  }

  assertTargetRead(
    relationName: string,
    operation: DependencyOperation,
    constraint: TargetConstraint,
    predicateFields?: PredicateFieldSet
  ): void {
    this.assertIndependent(relationName, {
      operation,
      dimension: "targetExistence",
      constraint,
      predicateFields,
      localScope: this.#localScope,
    });
  }

  assertMembershipRead(
    relationName: string,
    operation: DependencyOperation,
    endpoints: MembershipEndpoints,
    scope: RelationMembershipScope,
    orientation: MembershipReadOrientation
  ): void {
    this.assertIndependent(relationName, {
      operation,
      dimension: "membership",
      endpoints,
      scope,
      orientation,
      localScope: this.#localScope,
    });
  }

  checkpoint(): number {
    return this.#writes.length;
  }

  fork(): OwnWriteLedger {
    return new OwnWriteLedger(this.#writes, this.#localScope);
  }

  emptyFork(): OwnWriteLedger {
    return new OwnWriteLedger([], this.#localScope);
  }

  deltaSince(checkpoint: number): OwnWriteFootprint[] {
    return this.#writes.slice(checkpoint);
  }

  mergeDeltas(...deltas: readonly OwnWriteFootprint[][]): void {
    for (const delta of deltas) {
      this.#writes.push(...delta);
    }
  }

  withNestedScope(run: () => void): void {
    const parentScope = this.#localScope;
    this.#localScope = Symbol("own-write-nested");
    try {
      run();
    } finally {
      this.#localScope = parentScope;
    }
  }

  private assertIndependent(relationName: string, read: DecisionRead): void {
    for (const write of this.#writes) {
      const overlap = getDependencyOverlap(write, read);
      if (!overlap) continue;
      if (overlap === "disjoint") continue;

      const dependencyLabel =
        read.dimension === "targetExistence" ? "target" : "membership";
      throw new NestedWriteError(
        `Nested operation '${read.operation}' on relation '${relationName}' depends on an earlier '${write.operation}' ${dependencyLabel} write in the same nested write. Split these operations into separate queries.`,
        relationName,
        {
          meta: {
            operation: read.operation,
            conflictsWith: write.operation,
            dependency: read.dimension,
            overlap,
          },
        }
      );
    }
  }
}

export function getMembershipReadOrientation(
  relation: BoundRelation
): MembershipReadOrientation {
  if (relation.position === "junction") return "manyToMany";
  return relation.position === "parentHeld" ? "direct" : "inverse";
}

function writeCanAffectRead(
  write: Exclude<OwnWriteFootprint, { dimension: "membership" }>,
  read: TargetDecisionRead
): boolean {
  if (write.dimension === "targetExistence") {
    return (
      write.visibility === "operation" || write.localScope === read.localScope
    );
  }
  if (
    write.visibility !== "operation" &&
    write.localScope !== read.localScope
  ) {
    return false;
  }

  const changedFields = write.predicateFields;
  if (!changedFields || changedFields === "unknown") return false;
  const readFields =
    read.predicateFields ?? getTargetConstraintPredicateFields(read.constraint);
  return predicateFieldSetsIntersect(changedFields, readFields);
}

function getDependencyOverlap(
  write: OwnWriteFootprint,
  read: DecisionRead
): TargetConstraintOverlap | undefined {
  if (read.dimension === "membership") {
    if (write.dimension !== "membership") return undefined;
    if (
      write.propagation !== "operation" &&
      write.localScope !== read.localScope
    ) {
      return undefined;
    }
    if (!relationMembershipScopesEqual(write.scope, read.scope)) {
      return undefined;
    }
    if (write.visibility !== "physical" && read.orientation !== "inverse") {
      return undefined;
    }
    return classifyMembershipOverlap(write.endpoints, read.endpoints);
  }

  if (write.dimension === "membership") return undefined;
  if (write.constraint.model !== read.constraint.model) return undefined;
  if (!writeCanAffectRead(write, read)) return undefined;
  return classifyTargetConstraintOverlap(write.constraint, read.constraint);
}

function classifyMembershipOverlap(
  write: MembershipEndpoints,
  read: MembershipEndpoints
): TargetConstraintOverlap {
  const first = classifyTargetConstraintOverlap(write.first, read.first);
  if (first === "disjoint") return "disjoint";
  const second = classifyTargetConstraintOverlap(write.second, read.second);
  if (second === "disjoint") return "disjoint";
  return first === "equal" && second === "equal" ? "equal" : "unknown";
}
