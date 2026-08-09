/**
 * Owns bound relation topology and the surviving connect lookup subquery.
 * Parsed mutation meaning belongs to relation-mutation-parser; record and edge
 * effects belong to the write engine.
 */

import type { Model } from "@schema/model";
import {
  type AnyRelation,
  getPolymorphicInverseBinding,
  type PolymorphicStorage,
  type ReferentialAction,
} from "@schema/relation";
import { type Sql, sql } from "@sql";
import {
  createChildScope,
  getColumnName,
  getPrimaryKeyFields,
  getTableName,
} from "../context";
import { QueryEngineError, type QueryScope, type RelationInfo } from "../types";
import {
  hideMutationTarget,
  readsMutationTarget,
} from "./mutation-target-subquery";
import { buildWhereUnique } from "./where-unique-builder";

interface BoundRelationBase {
  readonly relationInfo: RelationInfo;
  readonly sourceModel: Model<any>;
}

export interface BoundForeignKeyRelation extends BoundRelationBase {
  readonly foreignFields: readonly string[];
  readonly referencedFields: readonly string[];
  readonly onUpdate: ReferentialAction | undefined;
}

export interface ParentHeldToOne extends BoundForeignKeyRelation {
  readonly kind: "parentHeldToOne";
}

export interface ChildHeldToOne extends BoundForeignKeyRelation {
  readonly kind: "childHeldToOne";
}

export interface ChildHeldToMany extends BoundForeignKeyRelation {
  readonly kind: "childHeldToMany";
}

export interface BoundPolymorphicChildHeldRelation
  extends BoundForeignKeyRelation {
  readonly foreignFields: readonly [string];
  readonly referencedFields: readonly [string];
  readonly storage: PolymorphicStorage;
  readonly storedType: string;
}

export interface PolymorphicChildHeldToOne
  extends BoundPolymorphicChildHeldRelation {
  readonly kind: "polymorphicChildHeldToOne";
}

export interface PolymorphicChildHeldToMany
  extends BoundPolymorphicChildHeldRelation {
  readonly kind: "polymorphicChildHeldToMany";
}

export type PolymorphicChildHeldRelation =
  | PolymorphicChildHeldToOne
  | PolymorphicChildHeldToMany;

export interface JunctionRelation extends BoundRelationBase {
  readonly kind: "junction";
}

export type BoundRelation =
  | ParentHeldToOne
  | ChildHeldToOne
  | ChildHeldToMany
  | PolymorphicChildHeldToOne
  | PolymorphicChildHeldToMany
  | JunctionRelation;

export function isPolymorphicChildHeldRelation(
  relation: BoundRelation
): relation is PolymorphicChildHeldRelation {
  return (
    relation.kind === "polymorphicChildHeldToOne" ||
    relation.kind === "polymorphicChildHeldToMany"
  );
}

/** Bind one relation to its structural position relative to the current model. */
export function bindRelation(
  ctx: QueryScope,
  relationInfo: RelationInfo
): BoundRelation {
  if (relationInfo.type === "manyToMany") {
    return {
      kind: "junction",
      relationInfo,
      sourceModel: ctx.model,
    };
  }

  const { fields, references, targetModel } = relationInfo;
  if (fields && fields.length > 0) {
    return {
      kind: "parentHeldToOne",
      relationInfo,
      sourceModel: ctx.model,
      foreignFields: fields,
      referencedFields: references ?? getPrimaryKeyFields(targetModel),
      onUpdate: relationInfo.relation["~"].state.onUpdate,
    };
  }

  const polymorphicInverse = bindPolymorphicInverse(ctx, relationInfo);
  if (polymorphicInverse) return polymorphicInverse;

  const inverse = findInverseRelationState(ctx.model, relationInfo);
  if (!inverse) {
    throw new QueryEngineError(
      `Cannot determine FK fields for relation '${relationInfo.name}'. ` +
        "Define the inverse relation with .fields([...]) or use explicit FK fields."
    );
  }

  const foreignKey = {
    relationInfo,
    sourceModel: ctx.model,
    foreignFields: inverse.fields,
    referencedFields:
      inverse.references && inverse.references.length > 0
        ? inverse.references
        : getPrimaryKeyFields(ctx.model),
    onUpdate: inverse.onUpdate,
  };

  if (relationInfo.isToOne) {
    return { kind: "childHeldToOne", ...foreignKey };
  }
  return { kind: "childHeldToMany", ...foreignKey };
}

function bindPolymorphicInverse(
  ctx: QueryScope,
  relationInfo: RelationInfo
): PolymorphicChildHeldToOne | PolymorphicChildHeldToMany | undefined {
  if (relationInfo.type !== "oneToOne" && relationInfo.type !== "oneToMany") {
    return undefined;
  }
  const binding = getPolymorphicInverseBinding(
    relationInfo.targetModel,
    ctx.model,
    relationInfo.relation["~"].state.name
  );
  if (!binding) return undefined;

  const storage = relationInfo.targetModel["~"].getPolymorphicStorage(
    binding.relationKey
  );
  const member = storage?.members.get(binding.publicType);
  if (!(storage && member)) {
    throw new QueryEngineError(
      `Polymorphic inverse '${relationInfo.name}' has no resolved storage binding.`
    );
  }

  return {
    kind: relationInfo.isToOne
      ? "polymorphicChildHeldToOne"
      : "polymorphicChildHeldToMany",
    relationInfo,
    sourceModel: ctx.model,
    foreignFields: [storage.idColumn.name],
    referencedFields: [member.referencedField],
    onUpdate: undefined,
    storage,
    storedType: binding.storedType,
  };
}

/**
 * Find the ordinary inverse relation on the target model that owns the FK.
 * An explicit relation name disambiguates multiple back-references.
 */
export function findInverseRelationState(
  sourceModel: Model<any>,
  relationInfo: RelationInfo
):
  | {
      fields: string[];
      references: string[] | undefined;
      onUpdate: ReferentialAction | undefined;
    }
  | undefined {
  const { targetModel } = relationInfo;
  const currentRelationName = relationInfo.relation["~"].state.name;
  const potentialInverses: Array<{
    relationName?: string;
    fields: string[];
    references: string[] | undefined;
    onUpdate: ReferentialAction | undefined;
  }> = [];
  const targetRelations: Record<string, AnyRelation> =
    targetModel["~"].state.relations ?? {};

  for (const relation of Object.values(targetRelations)) {
    const state = relation["~"].state;
    const fields = state.fields;
    if (state.getter?.() === sourceModel && fields && fields.length > 0) {
      potentialInverses.push({
        relationName: state.name,
        fields,
        references: state.references,
        onUpdate: state.onUpdate,
      });
    }
  }

  if (potentialInverses.length === 0) return undefined;
  if (potentialInverses.length === 1) {
    const inverse = potentialInverses[0]!;
    return {
      fields: inverse.fields,
      references: inverse.references,
      onUpdate: inverse.onUpdate,
    };
  }

  if (currentRelationName) {
    const inverse = potentialInverses.find(
      (candidate) => candidate.relationName === currentRelationName
    );
    if (inverse) {
      return {
        fields: inverse.fields,
        references: inverse.references,
        onUpdate: inverse.onUpdate,
      };
    }
  }

  const sourceName =
    sourceModel["~"].names.ts ?? sourceModel["~"].state.tableName ?? "unknown";
  const targetName =
    targetModel["~"].names.ts ?? targetModel["~"].state.tableName ?? "unknown";
  throw new QueryEngineError(
    `Ambiguous relation '${relationInfo.name}' on model '${sourceName}': ` +
      `multiple relations on '${targetName}' point back to it. ` +
      "Add .name() to both sides of each relation to disambiguate."
  );
}

/**
 * Build subquery to select a specific field for connect
 *
 * A caller that declares `mutationTable` (an UPDATE's `SET`, E1 U1/U2) gets the
 * lookup hidden behind a derived table when it reads the very table the statement
 * mutates — a SELF relation. MySQL refuses that read otherwise (ERROR 1093,
 * measured on 8.4.10); an INSERT's `VALUES` never declares a mutation table, so
 * the create root's spelling is byte-identical to before.
 */
export function buildConnectSubqueryForField(
  ctx: QueryScope,
  relationInfo: RelationInfo,
  connectInput: Record<string, unknown>,
  selectField: string
): Sql {
  const { adapter } = ctx;
  const { targetModel } = relationInfo;

  const targetTable = getTableName(targetModel);
  const subAlias = ctx.nextAlias();
  const childCtx = createChildScope(ctx, targetModel, subAlias);

  const whereClause = buildWhereUnique(childCtx, connectInput, subAlias);

  const fieldColumn = getColumnName(targetModel, selectField);
  const fieldSql = adapter.identifiers.column(subAlias, fieldColumn);
  const tableSql = adapter.identifiers.escape(targetTable);

  const lookup = sql`SELECT ${fieldSql} FROM ${tableSql} ${sql.raw([
    subAlias,
  ])} WHERE ${whereClause}`;
  return readsMutationTarget(ctx, [targetTable])
    ? sql`(${hideMutationTarget(ctx, sql`(${lookup})`)})`
    : sql`(${lookup})`;
}
