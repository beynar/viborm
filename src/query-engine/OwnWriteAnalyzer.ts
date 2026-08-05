// biome-ignore-all lint/style/useFilenamingConvention: File matches its primary class export.
import { getFkDirection } from "./builders/relation-data-builder";
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
    family: OwnWriteDependencyFamily
  ): void {
    new OwnWriteNode(this, ctx, family, this.ledger).analyze(relations);
  }

  analyzeCreate(
    relation: OwnWriteRelation,
    data: Record<string, unknown>,
    rootOperation: "create" | "connectOrCreate" | "upsert",
    insertSummary?: OwnWriteCreateSummary
  ): void {
    const childCtx = relation.createChildScope();
    const { scalarData, relations } = buildParsedRelationPrograms(
      childCtx,
      data
    );
    const insertBarrier = insertSummary
      ? new OwnWriteInsertBarrier(relation, insertSummary)
      : undefined;

    relation.ledger.withNestedScope(() => {
      new OwnWriteNode(
        this,
        childCtx,
        { kind: "create", rootOperation, scalarData },
        relation.ledger
      ).analyze(relations, insertBarrier);
    });
  }

  analyzeUpdate(
    relation: OwnWriteRelation,
    data: Record<string, unknown>,
    selector: Record<string, unknown> | undefined,
    rootOperation: "update" | "upsert" = "update"
  ): void {
    const childCtx = relation.createChildScope();
    const { scalarData, relations } = buildParsedRelationPrograms(
      childCtx,
      data
    );

    relation.ledger.withNestedScope(() => {
      new OwnWriteNode(
        this,
        childCtx,
        { kind: "update", rootOperation, scalarData, selector },
        relation.ledger
      ).analyze(relations);
    });
  }
}

export class OwnWriteNode {
  readonly analyzer: OwnWriteAnalyzer;
  readonly ctx: QueryScope;
  readonly family: OwnWriteDependencyFamily;
  readonly ledger: OwnWriteLedger;
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
    insertBarrier?: OwnWriteInsertBarrier
  ): void {
    this.seedRootTargetWrites();
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
      this.family.kind
    );

    for (const [groupIndex, relationEntries] of relationGroups.entries()) {
      for (const [, mutation] of relationEntries) {
        OwnWriteRelation.create(
          this,
          mutation,
          rootMembershipFootprints,
          this.family.kind === "create" && groupIndex === 0
            ? beforeParentMembershipLedger
            : undefined
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
      const direction = getFkDirection(this.ctx, footprint.relationInfo);
      const membershipScope = getRelationMembershipScope(
        this.ctx,
        footprint.relationInfo
      );
      ledger.appendMembership(
        this.rootOperation,
        {
          first: footprint.constraint,
          second: unknownConstraint(direction.referenced),
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
}

export function analyzeOwnWriteTree(
  ctx: QueryScope,
  relations: Record<string, RelationMutationProgram>,
  family: OwnWriteDependencyFamily
): OwnWriteLedger {
  const analyzer = new OwnWriteAnalyzer();
  analyzer.analyze(ctx, relations, family);
  return analyzer.ledger;
}

export function assertNoRelationsOwnWriteDependencies(
  ctx: QueryScope,
  relations: Record<string, RelationMutationProgram>,
  family: OwnWriteDependencyFamily
): void {
  analyzeOwnWriteTree(ctx, relations, family);
}

export function assertCreateOwnWriteSafety(
  ctx: QueryScope,
  scalarData: Record<string, unknown>,
  relations: Record<string, RelationMutationProgram>
): void {
  assertNoRelationsOwnWriteDependencies(ctx, relations, {
    kind: "create",
    scalarData,
  });
}

export function assertUpdateOwnWriteSafety(
  ctx: QueryScope,
  scalarData: Record<string, unknown>,
  relations: Record<string, RelationMutationProgram>,
  selector: Record<string, unknown> | undefined
): void {
  assertNoRelationsOwnWriteDependencies(ctx, relations, {
    kind: "update",
    scalarData,
    selector,
  });
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

function getRelationEntryGroups(
  ctx: QueryScope,
  relations: Record<string, RelationMutationProgram>,
  family: OwnWriteDependencyFamily["kind"]
): [string, RelationMutationProgram][][] {
  if (family === "update") return [Object.entries(relations)];
  const currentHoldsFk: [string, RelationMutationProgram][] = [];
  const relatedHoldsFk: [string, RelationMutationProgram][] = [];
  for (const entry of Object.entries(relations)) {
    const relationInfo = entry[1].relationInfo;
    if (
      relationInfo.type !== "manyToMany" &&
      getFkDirection(ctx, relationInfo).holdsFK
    ) {
      currentHoldsFk.push(entry);
    } else {
      relatedHoldsFk.push(entry);
    }
  }
  return [currentHoldsFk, relatedHoldsFk];
}
