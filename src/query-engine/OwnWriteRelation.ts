// biome-ignore-all lint/style/useFilenamingConvention: File matches its primary class export.
import type { Model } from "@schema/model";
import type { BoundRelation } from "./builders/relation-data-builder";
import type {
  RecordMutationData,
  RelationMutationProgram,
} from "./builders/relation-mutation-parser";
import {
  classifyToOneComposition,
  type ToOneContinuation,
} from "./builders/to-one-composition";
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
import type {
  RelationMembershipScope,
  RootMembershipFootprint,
} from "./RelationMembership";
import type { PredicateFieldSet, TargetConstraint } from "./TargetConstraint";
import {
  createIdentityConstraint,
  selectorConstraint,
  unknownConstraint,
} from "./TargetConstraint";
import type { QueryScope } from "./types";

export type OwnWriteCreateOperation =
  | "create"
  | "createMany"
  | "connectOrCreate"
  | "upsert";

interface CreateSummaryOptions {
  readonly appendMembership?: boolean;
  readonly appendTarget?: boolean;
}

export interface OwnWriteCreateSummary {
  readonly operation: OwnWriteCreateOperation;
  readonly data: Readonly<Record<string, unknown>>;
}

export class OwnWriteRelation {
  readonly node: OwnWriteNode;
  readonly program: RelationMutationProgram;
  readonly ledger: OwnWriteLedger;
  readonly membershipLedger: OwnWriteLedger | undefined;
  readonly relationName: string;
  readonly boundRelation: BoundRelation;
  readonly target: Model<any>;
  readonly membershipScope: RelationMembershipScope;
  readonly membershipOrientation: MembershipReadOrientation;
  readonly checkpoint: number;
  readonly steps: OwnWriteSteps;
  /**
   * H3 — how a modify composed with a supplier reaches its row. Present means the modify
   * does NOT read membership before the fragment's first write: either the engine
   * locates the supplied row by the `connect`'s own unique selector, or the locate is a
   * post-supply capture inside a record series, which observes the supplier's effect by
   * construction. Keeping the analyzer's decision read on membership in either case
   * would report a dependency the compiled plan does not have — a `disconnect` beside
   * the pair would be named as the update's premise while the update never asks about
   * membership.
   */
  readonly composedContinuation: ToOneContinuation | undefined;

  private constructor(
    node: OwnWriteNode,
    program: RelationMutationProgram,
    boundRelation: BoundRelation,
    ledger: OwnWriteLedger,
    membershipLedger: OwnWriteLedger | undefined,
    membershipScope: RelationMembershipScope
  ) {
    this.node = node;
    this.program = program;
    this.ledger = ledger;
    this.membershipLedger = membershipLedger;
    this.boundRelation = boundRelation;
    this.relationName = boundRelation.relationRef.name;
    this.target = boundRelation.relationRef.targetModel;
    this.membershipScope = membershipScope;
    this.membershipOrientation = getMembershipReadOrientation(boundRelation);
    this.checkpoint = ledger.checkpoint();
    this.composedContinuation = resolveComposedContinuation(
      boundRelation,
      program
    );
    this.steps = new OwnWriteSteps(this);
  }

  static create(
    node: OwnWriteNode,
    program: RelationMutationProgram,
    boundRelation: BoundRelation,
    rootMembershipFootprints: readonly RootMembershipFootprint[],
    membershipLedger: OwnWriteLedger | undefined,
    /** The analyser states it from the parsed entry: an ordinary edge's bound
     *  topology, or the membership a resolved direct polymorphic edge builds. It is
     *  required rather than defaulted, because a default here is an exact-membership
     *  override channel — a second answer to "which membership is this" living one
     *  argument away from the first. */
    membershipScope: RelationMembershipScope
  ): OwnWriteRelation {
    const ledger = node.ledger.fork();
    for (const footprint of rootMembershipFootprints) {
      if (footprint.relation.relationRef !== program.relationRef) continue;
      ledger.appendMembership(
        node.rootOperation,
        getRelationMembershipEndpoints(
          boundRelation,
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
    return new OwnWriteRelation(
      node,
      program,
      boundRelation,
      ledger,
      membershipLedger,
      membershipScope
    );
  }

  analyze(): void {
    for (const entry of this.program.entries) {
      this.steps.processTree(entry);
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
      this.program,
      this.boundRelation,
      ledger,
      membershipLedger,
      this.membershipScope
    );
  }

  createChildScope(): QueryScope {
    return createChildScope(this.ctx, this.target, this.ctx.rootAlias);
  }

  analyzeCreate(
    data: RecordMutationData,
    rootOperation: OwnWriteCreateOperation = "create",
    insertSummary?: OwnWriteCreateSummary
  ): void {
    this.node.analyzer.analyzeCreate(this, data, rootOperation, insertSummary);
  }

  analyzeUpdate(
    data: RecordMutationData,
    selector: Record<string, unknown> | undefined,
    rootOperation: "update" | "upsert" = "update"
  ): void {
    this.node.analyzer.analyzeUpdate(this, data, selector, rootOperation);
  }

  getInsertSummary(
    operation: OwnWriteCreateSummary["operation"],
    data: Readonly<Record<string, unknown>>
  ): OwnWriteCreateSummary | undefined {
    return this.boundRelation.position === "childHeld"
      ? { operation, data }
      : undefined;
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
      this.membershipEndpoints(constraint, "read"),
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
    if (this.boundRelation.cardinality === "one" || !where) {
      const unknown = unknownConstraint(this.target);
      this.assertMembershipRead("upsert", unknown);
      return unknown;
    }
    const selector = selectorConstraint(this.target, where);
    this.assertTargetAndMembershipRead("upsert", selector);
    return selector;
  }

  appendCreateSummary(
    operation: OwnWriteCreateOperation,
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
      this.membershipEndpoints(constraint, "write"),
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
      this.membershipEndpoints(constraint, "write"),
      this.membershipScope,
      "physical",
      "operation"
    );
  }

  get ctx(): QueryScope {
    return this.node.ctx;
  }

  get family(): OwnWriteDependencyFamily {
    return this.node.family;
  }

  private membershipEndpoints(
    targetConstraint: TargetConstraint,
    access: "read" | "write"
  ): ReturnType<typeof getRelationMembershipEndpoints> {
    const currentConstraint =
      access === "read" && this.boundRelation.membership.kind === "polymorphic"
        ? this.node.currentReadConstraint
        : this.node.currentConstraint;
    return getRelationMembershipEndpoints(
      this.boundRelation,
      this.membershipScope,
      currentConstraint,
      targetConstraint
    );
  }
}

/**
 * H3 — how a composed modify reaches its row, read from the SHARED classification owner
 * (`builders/to-one-composition.ts`) that `RecordUpdateCompiler` also lowers. The two
 * used to re-derive one rule and agree only by construction, which the guard ledger
 * recorded as one invariant with two writers; now there is one writer and this is a
 * reader of it.
 */
function resolveComposedContinuation(
  boundRelation: BoundRelation,
  program: RelationMutationProgram
): ToOneContinuation | undefined {
  if (boundRelation.cardinality !== "one") return undefined;
  return classifyToOneComposition(
    boundRelation.relationRef.name,
    program.entries
  )?.continuation;
}
