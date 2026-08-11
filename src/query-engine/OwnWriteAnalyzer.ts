// biome-ignore-all lint/style/useFilenamingConvention: File matches its primary class export.

import type { ResolvedPolymorphicMutation } from "./builders/polymorphic-mutation";
import {
  type BoundRelation,
  bindRelation,
} from "./builders/relation-data-builder";
import {
  buildParsedRelationPrograms,
  type RelationMutationProgram,
} from "./builders/relation-mutation-parser";
import {
  type DependencyOperation,
  type OwnWriteDependencyFamily,
  OwnWriteLedger,
} from "./OwnWriteLedger";
import {
  type OwnWriteCreateSummary,
  OwnWriteRelation,
} from "./OwnWriteRelation";
import {
  buildRootUpdateMembershipFootprints,
  buildTransitiveUpdateMembershipFootprints,
  getPolymorphicMembershipScope,
  getRelationMembershipScope,
  type RootMembershipFootprint,
} from "./RelationMembership";
import type { TargetConstraint } from "./TargetConstraint";
import {
  buildScalarUpdatePredicateFootprints,
  createIdentityConstraint,
  selectorConstraint,
  unknownConstraint,
  updateResultConstraints,
} from "./TargetConstraint";
import type { QueryScope } from "./types";

export class OwnWriteAnalyzer {
  readonly ledger = new OwnWriteLedger();

  analyze(
    ctx: QueryScope,
    relations: Record<string, RelationMutationProgram>,
    family: OwnWriteDependencyFamily,
    polymorphic: Readonly<Record<string, ResolvedPolymorphicMutation>> = {}
  ): void {
    new OwnWriteNode(this, ctx, family, this.ledger).analyze(
      relations,
      polymorphic
    );
  }

  analyzeCreate(
    relation: OwnWriteRelation,
    data: Record<string, unknown>,
    rootOperation: "create" | "connectOrCreate" | "upsert",
    insertSummary?: OwnWriteCreateSummary
  ): void {
    const childCtx = relation.createChildScope();
    const parsed = buildParsedRelationPrograms(childCtx, data);
    const insertBarrier = insertSummary
      ? new OwnWriteInsertBarrier(relation, insertSummary)
      : undefined;

    relation.ledger.withNestedScope(() => {
      new OwnWriteNode(
        this,
        childCtx,
        { kind: "create", rootOperation, scalarData: parsed.scalarData },
        relation.ledger
      ).analyze(parsed.relations, parsed.polymorphic, insertBarrier);
    });
  }

  analyzeUpdate(
    relation: OwnWriteRelation,
    data: Record<string, unknown>,
    selector: Record<string, unknown> | undefined,
    rootOperation: "update" | "upsert" = "update"
  ): void {
    const childCtx = relation.createChildScope();
    const parsed = buildParsedRelationPrograms(childCtx, data);

    relation.ledger.withNestedScope(() => {
      new OwnWriteNode(
        this,
        childCtx,
        {
          kind: "update",
          rootOperation,
          scalarData: parsed.scalarData,
          selector,
        },
        relation.ledger
      ).analyze(parsed.relations, parsed.polymorphic);
    });
  }
}

export class OwnWriteNode {
  readonly analyzer: OwnWriteAnalyzer;
  readonly ctx: QueryScope;
  readonly family: OwnWriteDependencyFamily;
  readonly ledger: OwnWriteLedger;
  readonly currentReadConstraint: TargetConstraint;
  readonly currentConstraint: TargetConstraint;
  readonly transitiveMembershipFootprints: readonly RootMembershipFootprint[];

  constructor(
    analyzer: OwnWriteAnalyzer,
    ctx: QueryScope,
    family: OwnWriteDependencyFamily,
    ledger: OwnWriteLedger
  ) {
    this.analyzer = analyzer;
    this.ctx = ctx;
    this.family = family;
    this.ledger = ledger;
    this.currentReadConstraint = getCurrentReadConstraint(ctx, family);
    this.currentConstraint = getCurrentConstraint(ctx, family);
    this.transitiveMembershipFootprints =
      family.kind === "update"
        ? buildTransitiveUpdateMembershipFootprints(
            ctx,
            family.scalarData,
            family.selector
          )
        : [];
  }

  analyze(
    relations: Record<string, RelationMutationProgram>,
    polymorphic: Readonly<Record<string, ResolvedPolymorphicMutation>> = {},
    insertBarrier?: OwnWriteInsertBarrier
  ): void {
    this.seedRootTargetWrites();
    this.seedDirectPolymorphicDisconnectWrites(polymorphic);
    const rootMembershipFootprints =
      this.family.kind === "update"
        ? buildRootUpdateMembershipFootprints(
            this.ctx,
            relations,
            this.family.scalarData,
            this.family.selector
          )
        : [];
    const beforeParentMembershipLedger =
      this.family.kind === "create" ? this.ledger.emptyFork() : undefined;
    const relationGroups = getRelationEntryGroups(
      this.ctx,
      relations,
      this.family.kind,
      polymorphic
    );

    for (const [groupIndex, relationEntries] of relationGroups.entries()) {
      for (const entry of relationEntries) {
        const { mutation } = entry;
        const boundRelation =
          entry.boundRelation ?? bindRelation(this.ctx, mutation.relationInfo);
        OwnWriteRelation.create(
          this,
          mutation,
          boundRelation,
          rootMembershipFootprints,
          this.family.kind === "create" && groupIndex === 0
            ? beforeParentMembershipLedger
            : undefined,
          entry.membershipScope
        ).analyze();
      }

      if (this.family.kind === "create" && groupIndex === 0) {
        this.ledger.appendTarget(
          this.rootOperation,
          "targetExistence",
          createIdentityConstraint(this.ctx.model, this.family.scalarData)
        );
        insertBarrier?.apply();
        if (beforeParentMembershipLedger) {
          this.ledger.mergeDeltas(beforeParentMembershipLedger.deltaSince(0));
        }
      }
    }

    this.appendTransitiveMembershipWrites(this.ledger);
  }

  get rootOperation(): DependencyOperation {
    return this.family.rootOperation ?? this.family.kind;
  }

  appendTransitiveMembershipWrites(ledger: OwnWriteLedger): void {
    for (const footprint of this.transitiveMembershipFootprints) {
      const relation = footprint.relation;
      const membershipScope = getRelationMembershipScope(relation);
      ledger.appendMembership(
        this.rootOperation,
        {
          first: footprint.constraint,
          second: unknownConstraint(
            relation.position === "parentHeld"
              ? relation.relationInfo.targetModel
              : relation.sourceModel
          ),
        },
        membershipScope,
        "inverseTarget",
        "operation"
      );
    }
  }

  private seedRootTargetWrites(): void {
    if (this.family.kind !== "update") return;

    for (const footprint of buildScalarUpdatePredicateFootprints(
      this.ctx.model,
      this.family.scalarData,
      this.family.selector
    )) {
      this.ledger.appendTarget(
        this.rootOperation,
        "targetPredicate",
        footprint.constraint,
        footprint.changedFields
      );
    }
  }

  private seedDirectPolymorphicDisconnectWrites(
    polymorphic: Readonly<Record<string, ResolvedPolymorphicMutation>>
  ): void {
    for (const mutation of Object.values(polymorphic)) {
      if (mutation.kind !== "disconnect") continue;
      for (const member of mutation.storage.members.values()) {
        this.ledger.appendMembership(
          "disconnect",
          {
            first: this.currentConstraint,
            second: unknownConstraint(member.targetModel),
          },
          getPolymorphicMembershipScope(
            this.ctx.model,
            member.targetModel,
            mutation.storage,
            member.storedType,
            member.referencedField
          ),
          "physical",
          "operation"
        );
      }
    }
  }
}

export function analyzeOwnWriteTree(
  ctx: QueryScope,
  relations: Record<string, RelationMutationProgram>,
  family: OwnWriteDependencyFamily,
  polymorphic: Readonly<Record<string, ResolvedPolymorphicMutation>> = {}
): OwnWriteLedger {
  const analyzer = new OwnWriteAnalyzer();
  analyzer.analyze(ctx, relations, family, polymorphic);
  return analyzer.ledger;
}

export function assertNoRelationsOwnWriteDependencies(
  ctx: QueryScope,
  relations: Record<string, RelationMutationProgram>,
  family: OwnWriteDependencyFamily,
  polymorphic: Readonly<Record<string, ResolvedPolymorphicMutation>> = {}
): void {
  analyzeOwnWriteTree(ctx, relations, family, polymorphic);
}

export function assertCreateOwnWriteSafety(
  ctx: QueryScope,
  scalarData: Record<string, unknown>,
  relations: Record<string, RelationMutationProgram>,
  polymorphic: Readonly<Record<string, ResolvedPolymorphicMutation>>
): void {
  assertNoRelationsOwnWriteDependencies(
    ctx,
    relations,
    {
      kind: "create",
      scalarData,
    },
    polymorphic
  );
}

export function assertUpdateOwnWriteSafety(
  ctx: QueryScope,
  scalarData: Record<string, unknown>,
  relations: Record<string, RelationMutationProgram>,
  polymorphic: Readonly<Record<string, ResolvedPolymorphicMutation>>,
  selector: Record<string, unknown> | undefined
): void {
  assertNoRelationsOwnWriteDependencies(
    ctx,
    relations,
    {
      kind: "update",
      scalarData,
      selector,
    },
    polymorphic
  );
}

class OwnWriteInsertBarrier {
  readonly ledger: OwnWriteLedger;
  private readonly relation: OwnWriteRelation;
  private readonly summary: OwnWriteCreateSummary;

  constructor(relation: OwnWriteRelation, summary: OwnWriteCreateSummary) {
    this.relation = relation;
    this.summary = summary;
    this.ledger = relation.ledger.emptyFork();
  }

  apply(): void {
    this.relation.appendInsertSummary(this.ledger, this.summary);
    this.relation.ledger.mergeDeltas(this.ledger.deltaSince(0));
  }
}

function getCurrentConstraint(
  ctx: QueryScope,
  family: OwnWriteDependencyFamily
): TargetConstraint {
  if (family.kind === "create") {
    return createIdentityConstraint(ctx.model, family.scalarData);
  }
  if (!family.selector) return unknownConstraint(ctx.model);

  const selector = selectorConstraint(ctx.model, family.selector);
  const results = updateResultConstraints(
    ctx.model,
    selector,
    family.scalarData,
    family.selector
  );
  return results.at(-1) ?? selector;
}

function getCurrentReadConstraint(
  ctx: QueryScope,
  family: OwnWriteDependencyFamily
): TargetConstraint {
  if (family.kind === "create") {
    return createIdentityConstraint(ctx.model, family.scalarData);
  }
  return family.selector
    ? selectorConstraint(ctx.model, family.selector)
    : unknownConstraint(ctx.model);
}

function getRelationEntryGroups(
  ctx: QueryScope,
  relations: Record<string, RelationMutationProgram>,
  family: OwnWriteDependencyFamily["kind"],
  polymorphic: Readonly<Record<string, ResolvedPolymorphicMutation>>
): RelationAnalysisEntry[][] {
  if (family === "update") {
    return [
      Object.entries(relations).map(([relationName, mutation]) => ({
        mutation,
        membershipScope: getDirectPolymorphicScope(
          ctx,
          polymorphic[relationName]
        ),
      })),
    ];
  }
  const currentHoldsFk: RelationAnalysisEntry[] = [];
  const relatedHoldsFk: RelationAnalysisEntry[] = [];
  for (const [relationName, mutation] of Object.entries(relations)) {
    const boundRelation = bindRelation(ctx, mutation.relationInfo);
    const entry = {
      mutation,
      boundRelation,
      membershipScope: getDirectPolymorphicScope(
        ctx,
        polymorphic[relationName]
      ),
    };
    if (boundRelation.position === "parentHeld") {
      currentHoldsFk.push(entry);
    } else {
      relatedHoldsFk.push(entry);
    }
  }
  return [currentHoldsFk, relatedHoldsFk];
}

interface RelationAnalysisEntry {
  readonly mutation: RelationMutationProgram;
  readonly boundRelation?: BoundRelation;
  readonly membershipScope?: ReturnType<typeof getRelationMembershipScope>;
}

function getDirectPolymorphicScope(
  ctx: QueryScope,
  mutation: ResolvedPolymorphicMutation | undefined
): ReturnType<typeof getRelationMembershipScope> | undefined {
  if (!mutation || mutation.kind !== "targeted") return undefined;
  const { edge } = mutation;
  return getPolymorphicMembershipScope(
    ctx.model,
    edge.targetModel,
    edge.storage,
    edge.storedType,
    edge.referencedField
  );
}
