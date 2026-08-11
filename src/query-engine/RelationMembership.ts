// biome-ignore-all lint/style/useFilenamingConvention: Architecture names this compiler owner RelationMembership.
import type { Model } from "@schema/model";
import type { PolymorphicStorage } from "@schema/relation";
import {
  type BoundJunctionMembership,
  type BoundRelation,
  bindRelation,
  type JunctionReferenceMember,
  junctionSideMember,
} from "./builders/relation-data-builder";
import type { RelationMutationProgram } from "./builders/relation-mutation-parser";
import { getRelationInfo, getRelationNames } from "./context";
import {
  buildScalarUpdatePredicateFootprints,
  type TargetConstraint,
} from "./TargetConstraint";
import { NestedWriteError, type QueryScope } from "./types";

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

type PolymorphicRelationMembershipScope = Extract<
  RelationMembershipScope,
  { kind: "polymorphicForeignKey" }
>;

export function getPolymorphicMembershipScope(
  holder: Model<any>,
  referenced: Model<any>,
  storage: PolymorphicStorage,
  storedType: string,
  referencedField: string
): PolymorphicRelationMembershipScope {
  return {
    kind: "polymorphicForeignKey",
    holder,
    referenced,
    typeField: storage.typeColumn.name,
    storedType,
    identityField: storage.idColumn.name,
    referencedField,
  };
}

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

export function getRelationMembershipScope(
  relation: BoundRelation
): RelationMembershipScope {
  const { relationInfo, membership } = relation;
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
    };
  }
  if (membership.kind === "polymorphic") {
    return getPolymorphicMembershipScope(
      relation.relationInfo.targetModel,
      relation.sourceModel,
      membership.storage,
      membership.storedType,
      membership.referencedFields[0]
    );
  }

  const fields: Array<{ foreignKey: string; referencedKey: string }> = [];
  for (const [index, foreignKey] of membership.foreignFields.entries()) {
    const referencedKey = membership.referencedFields[index];
    if (referencedKey === undefined) {
      throw new NestedWriteError(
        `Relation '${relationInfo.name}' has mismatched foreign-key metadata.`,
        relationInfo.name
      );
    }
    fields.push({ foreignKey, referencedKey });
  }
  fields.sort((left, right) =>
    left.foreignKey === right.foreignKey
      ? left.referencedKey.localeCompare(right.referencedKey)
      : left.foreignKey.localeCompare(right.foreignKey)
  );
  return {
    kind: "foreignKey",
    holder:
      relation.position === "parentHeld"
        ? relation.sourceModel
        : relation.relationInfo.targetModel,
    referenced:
      relation.position === "parentHeld"
        ? relation.relationInfo.targetModel
        : relation.sourceModel,
    fields,
  };
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
  readonly relation: BoundRelation;
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
  const relations: BoundRelation[] = [];
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
