/**
 * Relation Data Builder
 *
 * Handles nested write operations: connect, disconnect, create, connectOrCreate, delete.
 * Separates scalar and relation data, builds connect subqueries, and manages FK direction.
 */

import type { Model } from "@schema/model";
import type { AnyRelation } from "@schema/relation";
import { type Sql, sql } from "@sql";
import {
  createChildContext,
  getColumnName,
  getRelationInfo,
  getTableName,
  isRelation,
} from "../context";
import {
  NestedWriteError,
  type QueryContext,
  QueryEngineError,
  type RelationInfo,
} from "../types";
import { getPrimaryKeyFields } from "./correlation-utils";
import { buildWhereUnique } from "./where-builder";

// ============================================================
// TYPES
// ============================================================

/**
 * Separated scalar and relation data from input
 */
export interface SeparatedData {
  /** Scalar fields to INSERT/UPDATE directly */
  scalar: Record<string, unknown>;
  /** Relation mutations to process */
  relations: Record<string, RelationMutation>;
}

/**
 * A single relation mutation operation
 */
export interface RelationMutation {
  /** Relation metadata */
  relationInfo: RelationInfo;
  /** Connect to existing record(s) */
  connect?: Record<string, unknown> | Record<string, unknown>[];
  /** Disconnect from related record(s) */
  disconnect?: boolean | Record<string, unknown> | Record<string, unknown>[];
  /** Create new related record(s) */
  create?: Record<string, unknown> | Record<string, unknown>[];
  /** Connect if exists, otherwise create */
  connectOrCreate?: ConnectOrCreateInput | ConnectOrCreateInput[];
  /** Delete related record(s) */
  delete?: boolean | Record<string, unknown> | Record<string, unknown>[];
  /** Set (replace) related records - only for to-many */
  set?: Record<string, unknown>[];
}

/**
 * ConnectOrCreate input shape
 */
export interface ConnectOrCreateInput {
  where: Record<string, unknown>;
  create: Record<string, unknown>;
}

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
}

// ============================================================
// SEPARATING DATA
// ============================================================

/**
 * Separate scalar data from relation mutations
 *
 * @param ctx - Query context
 * @param data - Input data with mixed scalar and relation fields
 * @returns Separated scalar and relation data
 */
export function separateData(
  ctx: QueryContext,
  data: Record<string, unknown>
): SeparatedData {
  const scalar: Record<string, unknown> = {};
  const relations: Record<string, RelationMutation> = {};

  for (const [key, value] of Object.entries(data)) {
    if (value === undefined) {
      continue;
    }

    if (isRelation(ctx.model, key)) {
      const relationInfo = getRelationInfo(ctx, key);
      if (!relationInfo) {
        continue;
      }

      // Parse relation mutation
      const mutation = parseRelationMutation(relationInfo, value);
      if (mutation) {
        relations[key] = mutation;
      }
    } else {
      // Scalar field
      scalar[key] = value;
    }
  }

  return { scalar, relations };
}

/**
 * Parse a relation value into a RelationMutation
 */
function parseRelationMutation(
  relationInfo: RelationInfo,
  value: unknown
): RelationMutation | undefined {
  if (value === null || typeof value !== "object") {
    return undefined;
  }

  const input = value as Record<string, unknown>;
  const mutation: RelationMutation = { relationInfo };

  if ("connect" in input) {
    mutation.connect = input.connect as
      | Record<string, unknown>
      | Record<string, unknown>[];
  }

  if ("disconnect" in input) {
    mutation.disconnect = input.disconnect as
      | boolean
      | Record<string, unknown>
      | Record<string, unknown>[];
  }

  if ("create" in input) {
    mutation.create = input.create as
      | Record<string, unknown>
      | Record<string, unknown>[];
  }

  if ("connectOrCreate" in input) {
    mutation.connectOrCreate = input.connectOrCreate as
      | ConnectOrCreateInput
      | ConnectOrCreateInput[];
  }

  if ("delete" in input) {
    mutation.delete = input.delete as
      | boolean
      | Record<string, unknown>
      | Record<string, unknown>[];
  }

  if ("set" in input) {
    mutation.set = input.set as Record<string, unknown>[];
  }

  return mutation;
}

// ============================================================
// FK DIRECTION
// ============================================================

/**
 * Find the FK fields on the target model by looking for the inverse relation
 *
 * Searches target model's relations for one pointing back to current model
 * and returns its fields (the actual FK columns).
 *
 * @param currentModel - Current model
 * @param targetModel - Target model to search in
 * @param relationName - Name of the relation (for error messages)
 * @returns FK field names on target model
 * @throws QueryEngineError if no inverse relation found
 */
function findInverseFkFields(
  currentModel: Model<any>,
  targetModel: Model<any>,
  relationName: string
): string[] {
  // Look through target model's relations for one pointing back to current
  const targetRelations = targetModel["~"].state.relations;
  if (targetRelations) {
    for (const [, rel] of Object.entries(targetRelations)) {
      const relInternals = (rel as AnyRelation)["~"];
      // Check if this relation points back to current model
      const relTarget = relInternals.state?.getter?.();
      if (relTarget === currentModel && relInternals.state?.fields?.length) {
        return relInternals.state.fields;
      }
    }
  }

  // No inverse found - this is a schema issue
  throw new QueryEngineError(
    `Cannot determine FK fields for relation '${relationName}'. ` +
      "Define the inverse relation with .fields([...]) or use explicit FK fields."
  );
}

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
  ctx: QueryContext,
  relationInfo: RelationInfo
): FkDirection {
  const { fields, references, targetModel, name } = relationInfo;

  // If fields defined on this relation, current model holds the FK
  const holdsFK = !!(fields && fields.length > 0);

  if (holdsFK) {
    return {
      holdsFK: true,
      fkFields: fields!,
      pkFields: references ?? getPrimaryKeyFields(targetModel),
      fkHolder: ctx.model,
      referenced: targetModel,
    };
  }

  // Otherwise, the target model holds the FK (to-many from current's perspective)
  // Look for the inverse relation to find the actual FK fields on target model
  const inverseFkFields = findInverseFkFields(ctx.model, targetModel, name);

  return {
    holdsFK: false,
    fkFields: inverseFkFields,
    pkFields: getPrimaryKeyFields(ctx.model),
    fkHolder: targetModel,
    referenced: ctx.model,
  };
}

// ============================================================
// CONNECT SUBQUERY
// ============================================================

/**
 * Build a subquery to get FK value for a connect operation
 *
 * This allows connecting without a transaction:
 * INSERT INTO posts (title, author_id)
 * VALUES ('Hello', (SELECT id FROM users WHERE id = '123'))
 *
 * For compound FKs, this returns a subquery for a single field.
 * Use buildConnectFkValues() to get all FK field values.
 *
 * @param ctx - Query context
 * @param relationInfo - Relation metadata
 * @param connectInput - WhereUnique input for the record to connect
 * @param fieldIndex - Index of the FK field to get (default 0)
 * @returns Sql subquery that returns the FK value
 */
export function buildConnectSubquery(
  ctx: QueryContext,
  relationInfo: RelationInfo,
  connectInput: Record<string, unknown>,
  fieldIndex = 0
): Sql {
  const { adapter } = ctx;
  const { targetModel, name } = relationInfo;
  const fkDir = getFkDirection(ctx, relationInfo);

  if (!fkDir.holdsFK) {
    throw new NestedWriteError(
      `Cannot use connect subquery for relation '${name}' - ` +
        "FK is on the related model. Use transaction-based connect instead.",
      name
    );
  }

  // Build the subquery to select PK from target
  const targetTable = getTableName(targetModel);
  const subAlias = ctx.nextAlias();
  const childCtx = createChildContext(ctx, targetModel, subAlias);

  // Build WHERE clause from connect input
  const whereClause = buildWhereUnique(childCtx, connectInput, subAlias);
  if (!whereClause) {
    throw new NestedWriteError(
      `Invalid connect input for relation '${name}': no conditions`,
      name
    );
  }

  // Select the PK field at the specified index
  const pkFields = fkDir.pkFields;
  if (fieldIndex >= pkFields.length) {
    throw new NestedWriteError(
      `Invalid field index ${fieldIndex} for relation '${name}' with ${pkFields.length} PK fields`,
      name
    );
  }

  const pkColumn = getColumnName(targetModel, pkFields[fieldIndex]!);
  const pkSql = adapter.identifiers.column(subAlias, pkColumn);
  const tableSql = adapter.identifiers.escape(targetTable);

  return sql`(SELECT ${pkSql} FROM ${tableSql} ${sql.raw([
    subAlias,
  ])} WHERE ${whereClause})`;
}

/**
 * Build FK assignments for a connect operation
 *
 * Returns a map of FK field -> subquery for each FK field.
 * Handles both single and compound FKs.
 *
 * @param ctx - Query context
 * @param relationInfo - Relation metadata
 * @param connectInput - WhereUnique input for the record to connect
 * @returns Map of FK field name to value/subquery
 */
export function buildConnectFkValues(
  ctx: QueryContext,
  relationInfo: RelationInfo,
  connectInput: Record<string, unknown>
): Record<string, Sql> {
  const fkDir = getFkDirection(ctx, relationInfo);

  if (!fkDir.holdsFK) {
    // Can't assign FK - it's on the other side
    return {};
  }

  const fkFields = fkDir.fkFields;
  const pkFields = fkDir.pkFields;

  if (fkFields.length !== pkFields.length) {
    throw new NestedWriteError(
      `FK/PK mismatch for relation '${relationInfo.name}': ` +
        `${fkFields.length} FK fields, ${pkFields.length} PK fields`,
      relationInfo.name
    );
  }

  const result: Record<string, Sql> = {};

  // Check if all PK values are directly provided in the connect input
  const allPkValuesProvided = pkFields.every(
    (pkField) => pkField in connectInput
  );

  if (allPkValuesProvided) {
    // Simple case: all PK values provided directly - no subqueries needed
    for (let i = 0; i < fkFields.length; i++) {
      const fkField = fkFields[i]!;
      const pkField = pkFields[i]!;
      const value = connectInput[pkField];
      result[fkField] = ctx.adapter.literals.value(value);
    }
  } else {
    // Need subqueries to get the PK values
    // For compound FKs, build a separate subquery for each FK field
    for (let i = 0; i < fkFields.length; i++) {
      const fkField = fkFields[i]!;
      const pkField = pkFields[i]!;

      // Check if this specific PK value is directly provided
      if (pkField in connectInput) {
        const value = connectInput[pkField];
        result[fkField] = ctx.adapter.literals.value(value);
      } else {
        // Build subquery to select this specific PK field
        result[fkField] = buildConnectSubqueryForField(
          ctx,
          relationInfo,
          connectInput,
          pkField
        );
      }
    }
  }

  return result;
}

/**
 * Build subquery to select a specific field for connect
 */
function buildConnectSubqueryForField(
  ctx: QueryContext,
  relationInfo: RelationInfo,
  connectInput: Record<string, unknown>,
  selectField: string
): Sql {
  const { adapter } = ctx;
  const { targetModel } = relationInfo;

  const targetTable = getTableName(targetModel);
  const subAlias = ctx.nextAlias();
  const childCtx = createChildContext(ctx, targetModel, subAlias);

  const whereClause = buildWhereUnique(childCtx, connectInput, subAlias);
  if (!whereClause) {
    throw new NestedWriteError(
      `Invalid connect input for relation '${relationInfo.name}'`,
      relationInfo.name
    );
  }

  const fieldColumn = getColumnName(targetModel, selectField);
  const fieldSql = adapter.identifiers.column(subAlias, fieldColumn);
  const tableSql = adapter.identifiers.escape(targetTable);

  return sql`(SELECT ${fieldSql} FROM ${tableSql} ${sql.raw([
    subAlias,
  ])} WHERE ${whereClause})`;
}

// ============================================================
// DISCONNECT
// ============================================================

/**
 * Build disconnect operation
 *
 * For to-one where current holds FK: SET FK to NULL
 * For to-many: handled via target model's FK
 *
 * @param ctx - Query context
 * @param relationInfo - Relation metadata
 * @param disconnectInput - true, or whereUnique for specific record
 * @returns FK field(s) to set to NULL, or undefined if FK is on other side
 */
export function buildDisconnectFkNulls(
  ctx: QueryContext,
  relationInfo: RelationInfo,
  _disconnectInput: boolean | Record<string, unknown>
): string[] | undefined {
  const fkDir = getFkDirection(ctx, relationInfo);

  if (!fkDir.holdsFK) {
    // FK is on the other side - disconnect needs to UPDATE the related records
    return undefined;
  }

  // Current model holds FK - return FK field names to set to NULL
  return fkDir.fkFields;
}

// ============================================================
// ANALYSIS HELPERS
// ============================================================

/**
 * Check if the current model holds the FK for a relation
 *
 * Simplified check that doesn't require full QueryContext.
 * For to-many relations (oneToMany), FK is always on the related model.
 * For to-one relations (manyToOne), FK is on current model if fields defined.
 *
 * @param relationInfo - Relation metadata
 * @returns true if current model holds FK, false if related model holds FK
 */
function currentHoldsFK(relationInfo: RelationInfo): boolean {
  // For to-many (oneToMany), FK is always on the related side
  if (relationInfo.isToMany) {
    return false;
  }
  // For to-one (manyToOne), check if fields are defined on current model
  return !!(relationInfo.fields && relationInfo.fields.length > 0);
}

/**
 * Check if any relation mutations require a transaction
 *
 * Transactions needed for:
 * - create (need to get generated ID)
 * - connectOrCreate (check existence + create)
 * - disconnect/delete on to-many (update related records)
 * - set on to-many (delete existing + connect new)
 *
 * NOT needed for:
 * - connect when current model holds FK (use subquery)
 */
export function needsTransaction(
  relations: Record<string, RelationMutation>
): boolean {
  for (const mutation of Object.values(relations)) {
    // Create always needs transaction to get generated ID
    if (mutation.create) {
      return true;
    }

    // ConnectOrCreate needs transaction
    if (mutation.connectOrCreate) {
      return true;
    }

    // Delete on relations needs transaction
    if (mutation.delete) {
      return true;
    }

    // Set on to-many needs transaction
    if (mutation.set) {
      return true;
    }

    // Disconnect where FK is on other side needs transaction
    if (mutation.disconnect && !currentHoldsFK(mutation.relationInfo)) {
      return true;
    }
    // Connect where FK is on other side needs transaction
    if (mutation.connect && !currentHoldsFK(mutation.relationInfo)) {
      return true;
    }
  }

  return false;
}

/**
 * Check if relation mutations can be handled with subqueries only
 */
export function canUseSubqueryOnly(
  relations: Record<string, RelationMutation>
): boolean {
  return !needsTransaction(relations);
}

/**
 * Get connect operations that can be done via subquery (FK on current model)
 */
export function getSubqueryConnects(
  ctx: QueryContext,
  relations: Record<string, RelationMutation>
): Array<{ relationName: string; mutation: RelationMutation }> {
  const result: Array<{ relationName: string; mutation: RelationMutation }> =
    [];

  for (const [relationName, mutation] of Object.entries(relations)) {
    if (!mutation.connect) {
      continue;
    }

    const fkDir = getFkDirection(ctx, mutation.relationInfo);
    if (fkDir.holdsFK) {
      result.push({ relationName, mutation });
    }
  }

  return result;
}
