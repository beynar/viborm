/**
 * Relation Data Builder
 *
 * Handles nested write operations: create, createMany, connect,
 * connectOrCreate, disconnect, delete, deleteMany, set, update,
 * updateMany, and upsert.
 * Separates scalar and relation data, builds connect subqueries, and manages FK direction.
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

// ============================================================
// TYPES
// ============================================================

/**
 * Information about FK direction for a relation
 */
export interface FkDirection {
  /** Does current model hold the FK? */
  holdsFK: boolean;
  /** FK field names on FK holder */
  fkFields: string[];
  /** PK field names on referenced model */
  pkFields: string[];
  /** Which model holds the FK */
  fkHolder: Model<any>;
  /** Which model is referenced */
  referenced: Model<any>;
  /** Database action when the referenced key changes. */
  onUpdate: ReferentialAction | undefined;
}

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

// ============================================================
// FK DIRECTION
// ============================================================

/**
 * Determine FK direction for a relation
 *
 * FK direction affects order of operations:
 * - If current model holds FK: create related first, then current
 * - If related model holds FK: create current first, then related
 *
 * @param ctx - Query context
 * @param relationInfo - Relation metadata
 * @returns FK direction info
 */
export function getFkDirection(
  ctx: QueryScope,
  relationInfo: RelationInfo
): FkDirection {
  // Must come before any inverse-FK scanning: a to-one relation on the target
  // pointing back at this model (e.g. tag.featuredIn) would otherwise be
  // mistaken for this relation's FK and get silently overwritten.
  if (relationInfo.type === "manyToMany") {
    throw new QueryEngineError(
      `Relation '${relationInfo.name}' is many-to-many and has no FK direction. ` +
        "Many-to-many writes must go through the junction table handlers."
    );
  }

  const { fields, references, targetModel } = relationInfo;

  // If fields defined on this relation, current model holds the FK
  const holdsFK = !!(fields && fields.length > 0);

  if (holdsFK) {
    return {
      holdsFK: true,
      fkFields: fields!,
      pkFields: references ?? getPrimaryKeyFields(targetModel),
      fkHolder: ctx.model,
      referenced: targetModel,
      onUpdate: relationInfo.relation["~"].state.onUpdate,
    };
  }

  // Otherwise, the target model holds the FK (to-many from current's perspective)
  // Look for the inverse relation to find the actual FK fields on target model
  const inverse = findInverseRelationState(ctx.model, relationInfo);
  if (!inverse) {
    throw new QueryEngineError(
      `Cannot determine FK fields for relation '${relationInfo.name}'. ` +
        "Define the inverse relation with .fields([...]) or use explicit FK fields."
    );
  }

  return {
    holdsFK: false,
    fkFields: inverse.fields,
    // Prefer the inverse relation's references: the fields on this model the
    // FK actually points at. Falling back to getPrimaryKeyFields is only
    // correct when the FK targets the PK.
    pkFields:
      inverse.references && inverse.references.length > 0
        ? inverse.references
        : getPrimaryKeyFields(ctx.model),
    fkHolder: targetModel,
    referenced: ctx.model,
    onUpdate: inverse.onUpdate,
  };
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

  const direction = getFkDirection(ctx, relationInfo);
  const foreignKey = {
    relationInfo,
    sourceModel: ctx.model,
    foreignFields: direction.fkFields,
    referencedFields: direction.pkFields,
    onUpdate: direction.onUpdate,
  };

  if (direction.holdsFK) {
    return { kind: "parentHeldToOne", ...foreignKey };
  }
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
