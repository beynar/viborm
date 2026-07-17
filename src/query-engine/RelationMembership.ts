// biome-ignore-all lint/style/useFilenamingConvention: Architecture names this compiler owner RelationMembership.
import type { Model } from "@schema/model";
import { getManyToManyJoinInfo } from "./builders/many-to-many-utils";
import {
  getFkDirection,
  type RelationMutation,
} from "./builders/relation-data-builder";
import { getRelationInfo, getRelationNames } from "./context";
import {
  buildScalarUpdatePredicateFootprints,
  type TargetConstraint,
} from "./TargetConstraint";
import { NestedWriteError, type QueryScope, type RelationInfo } from "./types";

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
    };

export function getRelationMembershipScope(
  ctx: QueryScope,
  relationInfo: RelationInfo
): RelationMembershipScope {
  if (relationInfo.type === "manyToMany") {
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

  const direction = getFkDirection(ctx, relationInfo);
  const fields: Array<{ foreignKey: string; referencedKey: string }> = [];
  for (const [index, foreignKey] of direction.fkFields.entries()) {
    const referencedKey = direction.pkFields[index];
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
    holder: direction.fkHolder,
    referenced: direction.referenced,
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
  readonly relationInfo: RelationInfo;
  readonly constraint: TargetConstraint;
}

export function buildRootUpdateMembershipFootprints(
  ctx: QueryScope,
  relations: Readonly<Record<string, RelationMutation>>,
  scalarData: Readonly<Record<string, unknown>>,
  selector: Readonly<Record<string, unknown>> | undefined
): RootMembershipFootprint[] {
  const constraints = getUpdateConstraints(ctx, scalarData, selector);
  const footprints: RootMembershipFootprint[] = [];
  for (const mutation of Object.values(relations)) {
    const relationInfo = mutation.relationInfo;
    if (relationInfo.type === "manyToMany") continue;
    const direction = getFkDirection(ctx, relationInfo);
    if (
      direction.holdsFK ||
      direction.fkHolder !== ctx.model ||
      direction.referenced !== ctx.model ||
      !hasChangedForeignKey(direction.fkFields, scalarData)
    ) {
      continue;
    }
    for (const constraint of constraints) {
      footprints.push({ relationInfo, constraint });
    }
  }
  return footprints;
}

export function buildTransitiveUpdateMembershipFootprints(
  ctx: QueryScope,
  scalarData: Readonly<Record<string, unknown>>,
  selector: Readonly<Record<string, unknown>> | undefined
): RootMembershipFootprint[] {
  const relationInfos: RelationInfo[] = [];
  const membershipScopes: RelationMembershipScope[] = [];
  for (const relationName of getRelationNames(ctx.model)) {
    const relationInfo = getRelationInfo(ctx, relationName);
    if (!relationInfo || relationInfo.type === "manyToMany") continue;
    const direction = getFkDirection(ctx, relationInfo);
    if (
      direction.fkHolder !== ctx.model ||
      !hasChangedForeignKey(direction.fkFields, scalarData)
    ) {
      continue;
    }
    const membershipScope = getRelationMembershipScope(ctx, relationInfo);
    if (
      membershipScopes.some((existingScope) =>
        relationMembershipScopesEqual(existingScope, membershipScope)
      )
    ) {
      continue;
    }
    relationInfos.push(relationInfo);
    membershipScopes.push(membershipScope);
  }
  const constraints = getUpdateConstraints(ctx, scalarData, selector);
  return relationInfos.flatMap((relationInfo) =>
    constraints.map((constraint) => ({ relationInfo, constraint }))
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
