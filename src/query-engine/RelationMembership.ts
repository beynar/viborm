// biome-ignore-all lint/style/useFilenamingConvention: Architecture names this compiler owner RelationMembership.
import type { Model } from "@schema/model";
import {
  type BoundJunctionMembership,
  type BoundMembership,
  type BoundRelation,
  bindRelation,
  type ChildHeldRelation,
  type JunctionReferenceMember,
  junctionSideMember,
  type ParentHeldRelation,
} from "./builders/relation-data-builder";
import type { RelationMutationProgram } from "./builders/relation-mutation-parser";
import { getRelationInfo, getRelationNames } from "./context";
import {
  buildScalarUpdatePredicateFootprints,
  type TargetConstraint,
} from "./TargetConstraint";
import type { QueryScope } from "./types";

export type RelationMembershipScope =
  | {
      readonly kind: "manyToMany";
      readonly junctionTable: string;
      /**
       * The junction's two sides in ORIENTATION-ERASED order, so that the two
       * spellings of one junction — a self-relation read from either end, the
       * paired A/B relations — produce scopes that compare equal. Which side the
       * current model is stays a real fact, answered by
       * {@link junctionSourceIsFirst} from the same comparison.
       */
      readonly first: readonly JunctionReferenceMember[];
      readonly second: readonly JunctionReferenceMember[];
      /**
       * Whether the bound relation's SOURCE side landed in `first` — the same
       * comparison that erased the orientation, carried so the membership ledger
       * reads it instead of asking a second time.
       *
       * It is deliberately NOT compared by {@link relationMembershipScopesEqual}:
       * a self-junction read from either end is ONE membership, and comparing
       * orientation would make `follows` and `followedBy` unequal, silently
       * blinding own-write conflict detection rather than failing loudly.
       */
      readonly sourceIsFirst: boolean;
    }
  | {
      readonly kind: "foreignKey";
      readonly holder: Model<any>;
      readonly referenced: Model<any>;
      readonly fields: readonly {
        readonly foreignKey: string;
        readonly referencedKey: string;
      }[];
    }
  | {
      readonly kind: "polymorphicForeignKey";
      readonly holder: Model<any>;
      readonly referenced: Model<any>;
      readonly typeField: string;
      readonly storedType: string;
      readonly identityField: string;
      readonly referencedField: string;
    };

/**
 * Does the junction's SOURCE side occupy the scope's canonical first slot?
 *
 * The scope erases orientation on purpose; the membership ledger's endpoint order
 * still needs it, so it is answered here — from the one comparison that erased it —
 * instead of re-deriving the junction topology a second time.
 */
export function junctionSourceIsFirst(
  membership: BoundJunctionMembership
): boolean {
  return (
    junctionSideMember(membership.source).junctionField.localeCompare(
      junctionSideMember(membership.target).junctionField
    ) <= 0
  );
}

/**
 * The analytical view of one bound physical membership.
 *
 * Every fact it reports is carried by the membership: the binder decided holder,
 * referenced model, member pairing and junction sides once. This reader only
 * chooses the CANONICAL ORDER equality needs — which is not the schema order the
 * write path needs, so the two orders coexist on the same data.
 */
export function getMembershipScope(
  membership: BoundMembership
): RelationMembershipScope {
  if (membership.kind === "junction") {
    const sourceIsFirst = junctionSourceIsFirst(membership);
    return {
      kind: "manyToMany",
      junctionTable: membership.table,
      first: sourceIsFirst
        ? membership.source.members
        : membership.target.members,
      second: sourceIsFirst
        ? membership.target.members
        : membership.source.members,
      sourceIsFirst,
    };
  }
  if (membership.kind === "polymorphic") {
    return {
      kind: "polymorphicForeignKey",
      holder: membership.holder,
      referenced: membership.referenced,
      typeField: membership.storage.typeColumn.name,
      storedType: membership.storedType,
      identityField: membership.storage.idColumn.name,
      referencedField: membership.referencedField,
    };
  }

  const fields = membership.members.map((member) => ({
    foreignKey: member.foreignField,
    referencedKey: member.referencedField,
  }));
  fields.sort((left, right) =>
    left.foreignKey === right.foreignKey
      ? left.referencedKey.localeCompare(right.referencedKey)
      : left.foreignKey.localeCompare(right.foreignKey)
  );
  return {
    kind: "foreignKey",
    holder: membership.holder,
    referenced: membership.referenced,
    fields,
  };
}

export function getRelationMembershipScope(
  relation: BoundRelation
): RelationMembershipScope {
  return getMembershipScope(relation.membership);
}

function junctionSidesEqual(
  left: readonly JunctionReferenceMember[],
  right: readonly JunctionReferenceMember[]
): boolean {
  return (
    left.length === right.length &&
    left.every(
      (member, index) =>
        member.junctionField === right[index]?.junctionField &&
        member.referencedField === right[index]?.referencedField
    )
  );
}

export function relationMembershipScopesEqual(
  left: RelationMembershipScope,
  right: RelationMembershipScope
): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === "manyToMany" && right.kind === "manyToMany") {
    // `sourceIsFirst` is EXCLUDED on purpose — see its declaration.
    return (
      left.junctionTable === right.junctionTable &&
      junctionSidesEqual(left.first, right.first) &&
      junctionSidesEqual(left.second, right.second)
    );
  }
  if (
    left.kind === "polymorphicForeignKey" &&
    right.kind === "polymorphicForeignKey"
  ) {
    return (
      left.holder === right.holder &&
      left.referenced === right.referenced &&
      left.typeField === right.typeField &&
      left.storedType === right.storedType &&
      left.identityField === right.identityField &&
      left.referencedField === right.referencedField
    );
  }
  if (left.kind !== "foreignKey" || right.kind !== "foreignKey") return false;
  return (
    left.holder === right.holder &&
    left.referenced === right.referenced &&
    left.fields.length === right.fields.length &&
    left.fields.every(
      (field, index) =>
        field.foreignKey === right.fields[index]?.foreignKey &&
        field.referencedKey === right.fields[index]?.referencedKey
    )
  );
}

export interface RootMembershipFootprint {
  /** Row-held only: both builders skip junctions, whose membership has no holder. */
  readonly relation: ParentHeldRelation | ChildHeldRelation;
  readonly constraint: TargetConstraint;
}

export function buildRootUpdateMembershipFootprints(
  ctx: QueryScope,
  relations: Readonly<Record<string, RelationMutationProgram>>,
  scalarData: Readonly<Record<string, unknown>>,
  selector: Readonly<Record<string, unknown>> | undefined
): RootMembershipFootprint[] {
  const constraints = getUpdateConstraints(ctx, scalarData, selector);
  const footprints: RootMembershipFootprint[] = [];
  for (const mutation of Object.values(relations)) {
    const relationInfo = mutation.relationInfo;
    const relation = bindRelation(ctx, relationInfo);
    if (relation.position === "junction") continue;
    if (
      relation.position === "parentHeld" ||
      relation.relationInfo.targetModel !== ctx.model ||
      !hasChangedForeignKey(relation.membership.foreignFields, scalarData)
    ) {
      continue;
    }
    for (const constraint of constraints) {
      footprints.push({ relation, constraint });
    }
  }
  return footprints;
}

export function buildTransitiveUpdateMembershipFootprints(
  ctx: QueryScope,
  scalarData: Readonly<Record<string, unknown>>,
  selector: Readonly<Record<string, unknown>> | undefined
): RootMembershipFootprint[] {
  const relations: (ParentHeldRelation | ChildHeldRelation)[] = [];
  const membershipScopes: RelationMembershipScope[] = [];
  for (const relationName of getRelationNames(ctx.model)) {
    const relationInfo = getRelationInfo(ctx, relationName);
    if (!relationInfo) continue;
    const relation = bindRelation(ctx, relationInfo);
    if (relation.position === "junction") continue;
    if (
      (relation.position !== "parentHeld" &&
        relation.relationInfo.targetModel !== ctx.model) ||
      !hasChangedForeignKey(relation.membership.foreignFields, scalarData)
    ) {
      continue;
    }
    const membershipScope = getRelationMembershipScope(relation);
    if (
      membershipScopes.some((existingScope) =>
        relationMembershipScopesEqual(existingScope, membershipScope)
      )
    ) {
      continue;
    }
    relations.push(relation);
    membershipScopes.push(membershipScope);
  }
  const constraints = getUpdateConstraints(ctx, scalarData, selector);
  return relations.flatMap((relation) =>
    constraints.map((constraint) => ({ relation, constraint }))
  );
}

function getUpdateConstraints(
  ctx: QueryScope,
  scalarData: Readonly<Record<string, unknown>>,
  selector: Readonly<Record<string, unknown>> | undefined
): TargetConstraint[] {
  return buildScalarUpdatePredicateFootprints(
    ctx.model,
    scalarData,
    selector
  ).map((footprint) => footprint.constraint);
}

function hasChangedForeignKey(
  foreignKeyFields: readonly string[],
  scalarData: Readonly<Record<string, unknown>>
): boolean {
  return foreignKeyFields.some((field) => Object.hasOwn(scalarData, field));
}
