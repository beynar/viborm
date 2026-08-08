/**
 * Owns bound relation topology and the surviving connect lookup subquery.
 * Parsed mutation meaning belongs to relation-mutation-parser; record and edge
 * effects belong to the write engine.
 */

import type { Model } from "@schema/model";
import type { ReferentialAction } from "@schema/relation";
import { type Sql, sql } from "@sql";
import { createChildScope, getColumnName, getTableName } from "../context";
import { QueryEngineError, type QueryScope, type RelationInfo } from "../types";
import {
  findInverseRelationState,
  getPrimaryKeyFields,
} from "./correlation-utils";
import {
  hideMutationTarget,
  readsMutationTarget,
} from "./mutation-target-subquery";
import { buildWhereUnique } from "./where-unique-builder";

interface BoundRelationBase {
  readonly relationInfo: RelationInfo;
  readonly sourceModel: Model<any>;
}

interface BoundForeignKeyRelation extends BoundRelationBase {
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

export interface JunctionRelation extends BoundRelationBase {
  readonly kind: "junction";
}

export type BoundRelation =
  | ParentHeldToOne
  | ChildHeldToOne
  | ChildHeldToMany
  | JunctionRelation;

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
