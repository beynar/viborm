// biome-ignore-all lint/style/useFilenamingConvention: File matches its primary class export.

import { directPolymorphicMembership } from "./builders/polymorphic-relation";
import {
  type BoundRelation,
  bindRelation,
  buildPolymorphicMembership,
} from "./builders/relation-data-builder";
import {
  buildParsedRelationPrograms,
  type ParsedRelationMutation,
  type ProgramRelationMutation,
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
  getMembershipScope,
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
    relations: readonly ParsedRelationMutation[],
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
      ).analyze(parsed.relations, insertBarrier);
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
      ).analyze(parsed.relations);
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
    relations: readonly ParsedRelationMutation[],
    insertBarrier?: OwnWriteInsertBarrier
  ): void {
    this.seedRootTargetWrites();
    this.seedDirectPolymorphicDisconnectWrites(relations);
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
      for (const entry of relationEntries) {
        const { parsed } = entry;
        const mutation = parsed.program;
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
          // A resolved direct polymorphic edge writes a private `(type, id)` pair,
          // so its scope is the membership that edge builds — the same one an
          // inverse edge on that pair binds — rather than the ordinary topology of
          // the concrete relation the discriminator resolved to.
          parsed.kind === "polymorphicTarget"
            ? getMembershipScope(directPolymorphicMembership(parsed.edge))
            : getRelationMembershipScope(boundRelation)
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
          second: unknownConstraint(relation.membership.referenced),
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
    relations: readonly ParsedRelationMutation[]
  ): void {
    for (const mutation of relations) {
      if (mutation.kind !== "polymorphicDisconnect") continue;
      // ONE write per storage member, because a targetless disconnect names no
      // member: every model the storage can hold is a model it may be clearing.
      for (const member of mutation.storage.members.values()) {
        this.ledger.appendMembership(
          "disconnect",
          {
            first: this.currentConstraint,
            second: unknownConstraint(member.targetModel),
          },
          getMembershipScope(
            buildPolymorphicMembership(
              this.ctx.model,
              member.targetModel,
              mutation.storage,
              member
            )
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
  relations: readonly ParsedRelationMutation[],
  family: OwnWriteDependencyFamily
): OwnWriteLedger {
  const analyzer = new OwnWriteAnalyzer();
  analyzer.analyze(ctx, relations, family);
  return analyzer.ledger;
}

export function assertNoRelationsOwnWriteDependencies(
  ctx: QueryScope,
  relations: readonly ParsedRelationMutation[],
  family: OwnWriteDependencyFamily
): void {
  analyzeOwnWriteTree(ctx, relations, family);
}

export function assertCreateOwnWriteSafety(
  ctx: QueryScope,
  scalarData: Record<string, unknown>,
  relations: readonly ParsedRelationMutation[]
): void {
  assertNoRelationsOwnWriteDependencies(ctx, relations, {
    kind: "create",
    scalarData,
  });
}

export function assertUpdateOwnWriteSafety(
  ctx: QueryScope,
  scalarData: Record<string, unknown>,
  relations: readonly ParsedRelationMutation[],
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

/**
 * The parsed entries that have a program to analyse, grouped by the family's own
 * rule: update analyses them in one pass, create analyses parent-held edges before
 * the record's own INSERT and every other edge after it.
 *
 * A targetless polymorphic disconnect has no program and no bindable topology, so
 * it is not grouped here — {@link OwnWriteNode.seedDirectPolymorphicDisconnectWrites}
 * has already appended its per-member writes.
 */
function getRelationEntryGroups(
  ctx: QueryScope,
  relations: readonly ParsedRelationMutation[],
  family: OwnWriteDependencyFamily["kind"]
): RelationAnalysisEntry[][] {
  const parsedPrograms: ProgramRelationMutation[] = [];
  for (const parsed of relations) {
    if (parsed.kind !== "polymorphicDisconnect") parsedPrograms.push(parsed);
  }
  if (family === "update") {
    return [parsedPrograms.map((parsed) => ({ parsed }))];
  }
  const currentHoldsFk: RelationAnalysisEntry[] = [];
  const relatedHoldsFk: RelationAnalysisEntry[] = [];
  for (const parsed of parsedPrograms) {
    const boundRelation = bindRelation(ctx, parsed.program.relationInfo);
    const entry = { parsed, boundRelation };
    if (boundRelation.position === "parentHeld") {
      currentHoldsFk.push(entry);
    } else {
      relatedHoldsFk.push(entry);
    }
  }
  return [currentHoldsFk, relatedHoldsFk];
}

interface RelationAnalysisEntry {
  readonly parsed: ProgramRelationMutation;
  readonly boundRelation?: BoundRelation;
}
