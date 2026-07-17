// biome-ignore-all lint/style/useFilenamingConvention: File matches its primary class export.
import type { Model } from "@schema/model";
import {
  getFkDirection,
  type NestedUpsertInput,
  type RelationMutation,
} from "./builders/relation-data-builder";
import { createChildScope } from "./context";
import type { OwnWriteNode } from "./OwnWriteAnalyzer";
import {
  type DependencyOperation,
  getMembershipReadOrientation,
  getRelationMembershipEndpoints,
  type MembershipReadOrientation,
  type OwnWriteDependencyFamily,
  type OwnWriteLedger,
} from "./OwnWriteLedger";
import { OwnWriteSteps } from "./OwnWriteSteps";
import type { RootMembershipFootprint } from "./RelationMembership";
import {
  getRelationMembershipScope,
  type RelationMembershipScope,
} from "./RelationMembership";
import { planRelationMutationSteps } from "./RelationMutationPlan";
import type { PredicateFieldSet, TargetConstraint } from "./TargetConstraint";
import {
  createIdentityConstraint,
  selectorConstraint,
  unknownConstraint,
  updateResultConstraints,
} from "./TargetConstraint";
import type { QueryScope, RelationInfo } from "./types";

type CreateOperation = "create" | "createMany" | "connectOrCreate" | "upsert";

interface CreateSummaryOptions {
  readonly appendMembership?: boolean;
  readonly appendTarget?: boolean;
}

export interface OwnWriteCreateSummary {
  readonly operation: Exclude<CreateOperation, "createMany">;
  readonly data: Readonly<Record<string, unknown>>;
}

export class OwnWriteRelation {
  readonly node: OwnWriteNode;
  readonly mutation: RelationMutation;
  readonly ledger: OwnWriteLedger;
  readonly membershipLedger: OwnWriteLedger | undefined;
  readonly relationName: string;
  readonly relationInfo: RelationInfo;
  readonly target: Model<any>;
  readonly membershipScope: RelationMembershipScope;
  readonly membershipOrientation: MembershipReadOrientation;
  readonly checkpoint: number;
  readonly steps: OwnWriteSteps;

  private constructor(
    node: OwnWriteNode,
    mutation: RelationMutation,
    ledger: OwnWriteLedger,
    membershipLedger: OwnWriteLedger | undefined
  ) {
    this.node = node;
    this.mutation = mutation;
    this.ledger = ledger;
    this.membershipLedger = membershipLedger;
    this.relationName = mutation.relationInfo.name;
    this.relationInfo = mutation.relationInfo;
    this.target = mutation.relationInfo.targetModel;
    this.membershipScope = getRelationMembershipScope(
      node.ctx,
      mutation.relationInfo
    );
    this.membershipOrientation = getMembershipReadOrientation(
      node.ctx,
      mutation.relationInfo
    );
    this.checkpoint = ledger.checkpoint();
    this.steps = new OwnWriteSteps(this);
  }

  static create(
    node: OwnWriteNode,
    mutation: RelationMutation,
    rootMembershipFootprints: readonly RootMembershipFootprint[],
    membershipLedger: OwnWriteLedger | undefined
  ): OwnWriteRelation {
    const ledger = node.ledger.fork();
    const membershipScope = getRelationMembershipScope(
      node.ctx,
      mutation.relationInfo
    );
    for (const footprint of rootMembershipFootprints) {
      if (footprint.relationInfo !== mutation.relationInfo) continue;
      ledger.appendMembership(
        node.rootOperation,
        getRelationMembershipEndpoints(
          node.ctx,
          mutation.relationInfo,
          membershipScope,
          node.currentConstraint,
          footprint.constraint
        ),
        membershipScope,
        "inverseTarget",
        "node"
      );
    }
    node.appendTransitiveMembershipWrites(ledger);
    return new OwnWriteRelation(node, mutation, ledger, membershipLedger);
  }

  analyze(): void {
    for (const step of planRelationMutationSteps(
      this.relationName,
      this.mutation,
      "after"
    )) {
      this.steps.processTree(step);
    }

    this.node.ledger.mergeDeltas(
      this.ledger
        .deltaSince(this.checkpoint)
        .filter(
          (footprint) =>
            footprint.dimension !== "targetExistence" ||
            footprint.visibility === "operation"
        )
    );
  }

  fork(
    ledger: OwnWriteLedger,
    membershipLedger: OwnWriteLedger | undefined
  ): OwnWriteRelation {
    return new OwnWriteRelation(
      this.node,
      this.mutation,
      ledger,
      membershipLedger
    );
  }

  get propagateMembership(): boolean {
    return this.node.analyzer.recurseDeterministic;
  }

  createChildScope(): QueryScope {
    return createChildScope(this.ctx, this.target, this.ctx.rootAlias);
  }

  analyzeCreate(
    data: Record<string, unknown>,
    rootOperation: "create" | "connectOrCreate" | "upsert" = "create",
    insertSummary?: OwnWriteCreateSummary
  ): void {
    this.node.analyzer.analyzeCreate(this, data, rootOperation, insertSummary);
  }

  analyzeUpdate(
    data: Record<string, unknown>,
    selector: Record<string, unknown> | undefined,
    rootOperation: "update" | "upsert" = "update"
  ): void {
    this.node.analyzer.analyzeUpdate(this, data, selector, rootOperation);
  }

  getInsertSummary(
    operation: OwnWriteCreateSummary["operation"],
    data: Readonly<Record<string, unknown>>
  ): OwnWriteCreateSummary | undefined {
    return this.isRelatedHeldRelation() ? { operation, data } : undefined;
  }

  assertTargetAndMembershipRead(
    operation: DependencyOperation,
    constraint: TargetConstraint,
    predicateFields?: PredicateFieldSet
  ): void {
    this.ledger.assertTargetRead(
      this.relationName,
      operation,
      constraint,
      predicateFields
    );
    this.assertMembershipRead(operation, constraint);
  }

  assertMembershipRead(
    operation: DependencyOperation,
    constraint: TargetConstraint
  ): void {
    this.ledger.assertMembershipRead(
      this.relationName,
      operation,
      this.membershipEndpoints(constraint),
      this.membershipScope,
      this.membershipOrientation
    );
  }

  assertConnectOrCreateDecision(
    where: Record<string, unknown>
  ): TargetConstraint {
    const selector = selectorConstraint(this.target, where);
    this.ledger.assertTargetRead(
      this.relationName,
      "connectOrCreate",
      selector
    );
    return selector;
  }

  assertUpsertDecision(
    where: Record<string, unknown> | undefined
  ): TargetConstraint {
    if (this.relationInfo.isToOne || !where) {
      const unknown = unknownConstraint(this.target);
      this.assertMembershipRead("upsert", unknown);
      return unknown;
    }
    const selector = selectorConstraint(this.target, where);
    this.assertTargetAndMembershipRead("upsert", selector);
    return selector;
  }

  appendUpsertUpdateSummary(
    input: NestedUpsertInput,
    decision: TargetConstraint
  ): void {
    if (this.relationInfo.isToOne || !input.where) {
      this.appendTarget("upsert", decision);
      return;
    }
    const resultConstraints = updateResultConstraints(
      this.target,
      decision,
      input.update,
      input.where
    );
    if (resultConstraints.length === 0) {
      this.ledger.appendRelationTarget("upsert", decision);
    }
    for (const constraint of resultConstraints) {
      this.appendTarget("upsert", constraint);
    }
  }

  appendCreateSummary(
    operation: CreateOperation,
    data: Readonly<Record<string, unknown>>,
    options: CreateSummaryOptions = {}
  ): void {
    const constraint = createIdentityConstraint(this.target, data);
    if (options.appendTarget !== false) {
      this.appendTarget(operation, constraint);
    }
    if (options.appendMembership !== false) {
      this.appendMembership(operation, constraint);
    }
  }

  appendInsertSummary(
    ledger: OwnWriteLedger,
    summary: OwnWriteCreateSummary
  ): void {
    const constraint = createIdentityConstraint(this.target, summary.data);
    ledger.appendMembership(
      summary.operation,
      this.membershipEndpoints(constraint),
      this.membershipScope,
      "physical",
      "operation"
    );
  }

  appendTarget(
    operation: DependencyOperation,
    constraint: TargetConstraint
  ): void {
    this.ledger.appendTarget(operation, "targetExistence", constraint);
  }

  appendMembership(
    operation: DependencyOperation,
    constraint: TargetConstraint
  ): void {
    const ledger = this.membershipLedger ?? this.ledger;
    ledger.appendMembership(
      operation,
      this.membershipEndpoints(constraint),
      this.membershipScope,
      "physical",
      this.propagateMembership ? "operation" : "node"
    );
  }

  get ctx(): QueryScope {
    return this.node.ctx;
  }

  get family(): OwnWriteDependencyFamily {
    return this.node.family;
  }

  private isRelatedHeldRelation(): boolean {
    return (
      this.relationInfo.type !== "manyToMany" &&
      !getFkDirection(this.ctx, this.relationInfo).holdsFK
    );
  }

  private membershipEndpoints(
    targetConstraint: TargetConstraint
  ): ReturnType<typeof getRelationMembershipEndpoints> {
    return getRelationMembershipEndpoints(
      this.ctx,
      this.relationInfo,
      this.membershipScope,
      this.node.currentConstraint,
      targetConstraint
    );
  }
}
