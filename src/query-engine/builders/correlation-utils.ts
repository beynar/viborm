/**
 * Correlation Utilities
 *
 * Shared utilities for building correlation conditions between
 * parent and related tables in relation queries.
 */

import type { Model } from "@schema/model";
import type { Sql } from "@sql";
import { getColumnName } from "../context";
import type { QueryContext, RelationInfo } from "../types";
import { QueryEngineError } from "../types";

/**
 * Build correlation condition between parent and related table.
 *
 * For manyToOne relations: uses fields/references directly
 * For oneToMany/oneToOne: finds inverse relation on target model to get FK info
 * For manyToMany: will need junction table handling (not yet implemented)
 *
 * @param ctx - Query context
 * @param relationInfo - Relation metadata
 * @param parentAlias - Parent table alias
 * @param relatedAlias - Related table alias
 * @returns SQL condition for correlation
 * @throws QueryEngineError if unable to determine correlation
 */
export function buildCorrelation(
  ctx: QueryContext,
  relationInfo: RelationInfo,
  parentAlias: string,
  relatedAlias: string
): Sql {
  const { adapter } = ctx;
  const state = relationInfo.relation["~"].state;

  // Get field names for correlation - either from this relation or inverse
  let parentFields: string[];
  let relatedFields: string[];

  const fields = state.fields;
  const references = state.references;

  if (fields && references && fields.length > 0 && references.length > 0) {
    // This relation has explicit fields/references (typically manyToOne)
    parentFields = fields;
    relatedFields = references;
  } else if (state.type === "oneToMany" || state.type === "oneToOne") {
    // For oneToMany/oneToOne without explicit fields, find the inverse manyToOne
    const inverseInfo = findInverseRelation(ctx, relationInfo);
    if (!inverseInfo) {
      throw new QueryEngineError(
        `Relation '${relationInfo.name}' on model '${getModelName(ctx.model)}' requires an inverse relation ` +
          `on '${getModelName(relationInfo.targetModel)}' with explicit 'fields' and 'references'.`
      );
    }
    // For oneToMany: parent.id = related.authorId
    // The inverse relation has: fields = [authorId], references = [id]
    // So we need: parent's references = related's fields
    parentFields = inverseInfo.references;
    relatedFields = inverseInfo.fields;
  } else if (state.type === "manyToMany") {
    // manyToMany requires junction table handling - callers should use getManyToManyJoinInfo() instead
    throw new QueryEngineError(
      `Many-to-many relation '${relationInfo.name}' cannot use buildCorrelation directly. ` +
        `Use getManyToManyJoinInfo() and buildManyToManyJoinParts() from many-to-many-utils.ts instead.`
    );
  } else {
    throw new QueryEngineError(
      `Relation '${relationInfo.name}' on model '${getModelName(ctx.model)}' must define 'fields' and 'references' explicitly.`
    );
  }

  if (parentFields.length !== relatedFields.length) {
    throw new QueryEngineError(
      `Relation '${relationInfo.name}' has mismatched fields (${parentFields.length}) and references (${relatedFields.length}).`
    );
  }

  // Build equality conditions for each field/reference pair
  const conditions: Sql[] = [];
  for (let i = 0; i < parentFields.length; i++) {
    const parentColumnName = getColumnName(ctx.model, parentFields[i]!);
    const relatedColumnName = getColumnName(
      relationInfo.targetModel,
      relatedFields[i]!
    );
    const parentCol = adapter.identifiers.column(parentAlias, parentColumnName);
    const relatedCol = adapter.identifiers.column(
      relatedAlias,
      relatedColumnName
    );
    conditions.push(adapter.operators.eq(parentCol, relatedCol));
  }

  return conditions.length === 1
    ? conditions[0]!
    : adapter.operators.and(...conditions);
}

/**
 * Find the inverse relation on the target model that points back to the source model.
 * Returns the fields/references from the inverse relation.
 */
function findInverseRelation(
  ctx: QueryContext,
  relationInfo: RelationInfo
): { fields: string[]; references: string[] } | undefined {
  const targetModel = relationInfo.targetModel;
  const sourceModel = ctx.model;
  const targetRelations = targetModel["~"].state.relations;

  // Look for a relation on target that points to source
  for (const [, relation] of Object.entries(targetRelations)) {
    const relState = (relation as any)["~"].state;
    const relTarget = relState.getter();

    // Check if this relation points back to our source model
    if (relTarget === sourceModel) {
      const fields = relState.fields;
      const references = relState.references;
      if (fields && references && fields.length > 0 && references.length > 0) {
        return { fields, references };
      }
    }
  }

  return undefined;
}

/**
 * Get model name for error messages
 */
function getModelName(model: Model<any>): string {
  return model["~"].names.ts ?? model["~"].state.tableName ?? "unknown";
}

/**
 * Get primary key field name from a model.
 *
 * Checks for:
 * 1. Field marked as id (isId: true)
 * 2. Compound ID (first field)
 * 3. Falls back to "id" as default
 *
 * @param model - Model to inspect
 * @returns Primary key field name
 */
export function getPrimaryKeyField(model: Model<any>): string {
  const scalars = model["~"].state.scalars;

  // Check for field marked as id
  for (const [name, field] of Object.entries(scalars)) {
    if ((field as any)["~"].state.isId) {
      return name;
    }
  }

  // Check for compound ID
  const compoundId = model["~"].state.compoundId;
  if (compoundId) {
    const keys = Object.keys(compoundId);
    if (keys.length > 0) {
      return keys[0]!;
    }
  }

  // Default to "id"
  return "id";
}

/**
 * Get all primary key fields from a model.
 *
 * Returns array of field names that make up the primary key.
 * For single-field PKs returns single element array.
 * For compound PKs returns all fields.
 *
 * @param model - Model to inspect
 * @returns Array of primary key field names
 */
export function getPrimaryKeyFields(model: Model<any>): string[] {
  const scalars = model["~"].state.scalars;

  // Check for compound ID first
  const compoundId = model["~"].state.compoundId;
  if (compoundId) {
    const keys = Object.keys(compoundId);
    if (keys.length > 0) {
      return keys;
    }
  }

  // Check for field marked as id
  for (const [name, field] of Object.entries(scalars)) {
    if ((field as any)["~"].state.isId) {
      return [name];
    }
  }

  // Default to "id"
  return ["id"];
}
