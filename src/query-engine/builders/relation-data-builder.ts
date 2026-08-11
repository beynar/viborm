/**
 * Owns bound relation topology and the surviving connect lookup subquery.
 * Parsed mutation meaning belongs to relation-mutation-parser; record and edge
 * effects belong to the write engine.
 */

import type { Model } from "@schema/model";
import {
  type PolymorphicStorage,
  type ReferentialAction,
  type ResolvedInverseRelation,
  resolveInverseRelation,
  resolveOrdinaryInverse,
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

/**
 * Does the TARGET row store this membership? True for both ordinary child-held
 * arities and both polymorphic ones; false for a parent-held edge (the source row
 * stores it) and for a junction (a third table does, and it admits many parents).
 *
 * The distinction is what decides whether one membership can be shared by several
 * source rows, so it belongs to relation topology rather than to any one operation.
 */
export function isChildHeldRelation(relation: BoundRelation): boolean {
  return (
    relation.kind === "childHeldToOne" ||
    relation.kind === "childHeldToMany" ||
    isPolymorphicChildHeldRelation(relation)
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

  // The one candidate scan lives in the schema layer (`@schema/relation`'s
  // resolver); this binder only translates its verdicts into the engine's
  // established errors and bound shapes. A fields-less `manyToOne` (the
  // FK004-warned compatibility form) can never bind a polymorphic inverse, so
  // it asks for the ordinary-only resolution — the same gate the deleted
  // `bindPolymorphicInverse` kept.
  const relationName = relationInfo.relation["~"].state.name;
  const resolved =
    relationInfo.type === "oneToOne" || relationInfo.type === "oneToMany"
      ? resolveInverseRelation(
          relationInfo.targetModel,
          ctx.model,
          relationName
        )
      : resolveOrdinaryInverse(
          relationInfo.targetModel,
          ctx.model,
          relationName
        );

  if (resolved.kind === "polymorphic") {
    return bindResolvedPolymorphicInverse(ctx, relationInfo, resolved);
  }
  if (resolved.kind === "ambiguous") {
    const sourceName =
      ctx.model["~"].names.ts ?? ctx.model["~"].state.tableName ?? "unknown";
    const targetName =
      relationInfo.targetModel["~"].names.ts ??
      relationInfo.targetModel["~"].state.tableName ??
      "unknown";
    throw new QueryEngineError(
      `Ambiguous relation '${relationInfo.name}' on model '${sourceName}': ` +
        `multiple relations on '${targetName}' point back to it. ` +
        "Add .name() to both sides of each relation to disambiguate."
    );
  }
  if (resolved.kind === "missing") {
    throw new QueryEngineError(
      `Cannot determine FK fields for relation '${relationInfo.name}'. ` +
        "Define the inverse relation with .fields([...]) or use explicit FK fields."
    );
  }

  const foreignKey = {
    relationInfo,
    sourceModel: ctx.model,
    foreignFields: resolved.fields as readonly string[] as string[],
    referencedFields:
      resolved.references && resolved.references.length > 0
        ? (resolved.references as readonly string[] as string[])
        : getPrimaryKeyFields(ctx.model),
    onUpdate: resolved.onUpdate,
  };

  if (relationInfo.isToOne) {
    return { kind: "childHeldToOne", ...foreignKey };
  }
  return { kind: "childHeldToMany", ...foreignKey };
}

function bindResolvedPolymorphicInverse(
  ctx: QueryScope,
  relationInfo: RelationInfo,
  resolved: Extract<ResolvedInverseRelation, { kind: "polymorphic" }>
): PolymorphicChildHeldToOne | PolymorphicChildHeldToMany {
  const storage = relationInfo.targetModel["~"].getPolymorphicStorage(
    resolved.relationKey
  );
  const member = storage?.members.get(resolved.publicType);
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
    storedType: resolved.storedType,
  };
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
