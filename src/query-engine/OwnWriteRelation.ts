// biome-ignore-all lint/style/useFilenamingConvention: File matches its primary class export.
import type { Model } from "@schema/model";
import type { BoundRelation } from "./builders/relation-data-builder";
import type {
  NormalizedRelationUpsert,
  RelationMutationProgram,
} from "./builders/relation-mutation-parser";
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
import type { PredicateFieldSet, TargetConstraint } from "./TargetConstraint";
import {
  createIdentityConstraint,
  selectorConstraint,
  unknownConstraint,
  updateResultConstraints,
} from "./TargetConstraint";
import type { QueryScope } from "./types";

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
   * H3 — the unique selector of a `connect` this to-one payload composes with an
   * `update`. When it is present the modify does NOT read membership: the engine
   * locates the supplied row by exactly this selector, because correlating would
   * address the OUTGOING member (`RecordUpdateCompiler.interpretInverseToOneComposition`).
   * Keeping the analyzer's decision read on membership after H would report a
   * dependency the compiled plan does not have — a `disconnect` beside the pair would
   * be named as the update's premise while the update never asks about membership.
   */
  readonly composedSupplierSelector: Record<string, unknown> | undefined;

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
    this.relationName = boundRelation.relationInfo.name;
    this.target = boundRelation.relationInfo.targetModel;
    this.membershipScope = membershipScope;
    this.membershipOrientation = getMembershipReadOrientation(boundRelation);
    this.checkpoint = ledger.checkpoint();
    this.composedSupplierSelector = resolveComposedSupplierSelector(
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
    membershipScope = getRelationMembershipScope(boundRelation)
  ): OwnWriteRelation {
    const ledger = node.ledger.fork();
    for (const footprint of rootMembershipFootprints) {
      if (footprint.relation.relationInfo !== program.relationInfo) continue;
      ledger.appendMembership(
        node.rootOperation,
        getRelationMembershipEndpoints(
          boundRelation,
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

  appendUpsertUpdateSummary(
    input: NormalizedRelationUpsert,
    decision: TargetConstraint
  ): void {
    if (input.target.kind === "correlated") {
      this.appendTarget("upsert", decision);
      return;
    }
    const resultConstraints = updateResultConstraints(
      this.target,
      decision,
      input.update,
      input.target.where
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
      access === "read" &&
      this.boundRelation.membership.kind === "polymorphic"
        ? this.node.currentReadConstraint
        : this.node.currentConstraint;
    return getRelationMembershipEndpoints(
      this.boundRelation,
      currentConstraint,
      targetConstraint
    );
  }
}

/**
 * H3 — is this to-one payload a composed `connect` + `update`? The engine's own
 * composition owner (`composeToOneEntries`, in `RecordUpdateCompiler.ts`) admits a
 * supplier beside a modify only when the supplier is a `connect`, because its unique
 * selector is the one identity that exists before the fragment's first write; the
 * analyzer answers the same question the same way so the two cannot disagree about what
 * the modify reads.
 *
 * That agreement is asserted, not enforced — this predicate re-derives the rule rather
 * than consuming the compiler's answer, because the analyzer runs on the PROGRAM and the
 * composition is decided during compilation. So the two are one invariant with two
 * writers: widening the engine's composition without widening this predicate leaves the
 * analyzer deciding on membership while the plan locates by an identity, which reports a
 * dependency the plan does not have (or misses one it does). Both sites move together.
 */
function resolveComposedSupplierSelector(
  boundRelation: BoundRelation,
  program: RelationMutationProgram
): Record<string, unknown> | undefined {
  if (boundRelation.cardinality !== "one") {
    return undefined;
  }
  if (!program.entries.some((entry) => entry.kind === "update")) {
    return undefined;
  }
  for (const entry of program.entries) {
    if (entry.kind === "connect") return entry.targets[0];
  }
  return undefined;
}
