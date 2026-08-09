// biome-ignore-all lint/style/useFilenamingConvention: Architecture names this compiler owner RelationMembership.
import type { Model } from "@schema/model";
import { getManyToManyJoinInfo } from "./builders/many-to-many-utils";
import {
  type BoundRelation,
  bindRelation,
  isPolymorphicChildHeldRelation,
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
      readonly firstField: string;
      readonly secondField: string;
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

export function getRelationMembershipScope(
  ctx: QueryScope,
  relation: BoundRelation
): RelationMembershipScope {
  const { relationInfo } = relation;
  if (relation.kind === "junction") {
    const joinInfo = getManyToManyJoinInfo(ctx, relationInfo);
    const orderedFields: [string, string] =
      joinInfo.sourceFieldName.localeCompare(joinInfo.targetFieldName) <= 0
        ? [joinInfo.sourceFieldName, joinInfo.targetFieldName]
        : [joinInfo.targetFieldName, joinInfo.sourceFieldName];
    return {
      kind: "manyToMany",
      junctionTable: joinInfo.junctionTableName,
      firstField: orderedFields[0],
      secondField: orderedFields[1],
    };
  }
  if (isPolymorphicChildHeldRelation(relation)) {
    return {
      kind: "polymorphicForeignKey",
      holder: relation.relationInfo.targetModel,
      referenced: relation.sourceModel,
      typeField: relation.storage.typeColumn.name,
      storedType: relation.storedType,
      identityField: relation.storage.idColumn.name,
      referencedField: relation.referencedFields[0],
    };
  }

  const fields: Array<{ foreignKey: string; referencedKey: string }> = [];
  for (const [index, foreignKey] of relation.foreignFields.entries()) {
    const referencedKey = relation.referencedFields[index];
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
      relation.kind === "parentHeldToOne"
        ? relation.sourceModel
        : relation.relationInfo.targetModel,
    referenced:
      relation.kind === "parentHeldToOne"
        ? relation.relationInfo.targetModel
        : relation.sourceModel,
    fields,
  };
}

export function relationMembershipScopesEqual(
  left: RelationMembershipScope,
  right: RelationMembershipScope
): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === "manyToMany" && right.kind === "manyToMany") {
    return (
      left.junctionTable === right.junctionTable &&
      left.firstField === right.firstField &&
      left.secondField === right.secondField
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
    if (relation.kind === "junction") continue;
    if (
      relation.kind === "parentHeldToOne" ||
      relation.relationInfo.targetModel !== ctx.model ||
      !hasChangedForeignKey(relation.foreignFields, scalarData)
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
    if (relation.kind === "junction") continue;
    if (
      (relation.kind !== "parentHeldToOne" &&
        relation.relationInfo.targetModel !== ctx.model) ||
      !hasChangedForeignKey(relation.foreignFields, scalarData)
    ) {
      continue;
    }
    const membershipScope = getRelationMembershipScope(ctx, relation);
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
