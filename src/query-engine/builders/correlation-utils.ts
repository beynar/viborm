/**
 * Correlation Utilities
 *
 * Shared utilities for building correlation conditions between
 * parent and related tables in relation queries.
 */

import { Sql } from "@sql";
import type { Model } from "@schema/model";
import type { QueryContext, RelationInfo } from "../types";
import { QueryEngineError } from "../types";
import { getColumnName } from "../context";

/**
 * Build correlation condition between parent and related table.
 *
 * Requires explicit fields/references to be defined on the relation.
 * Throws QueryEngineError if not defined.
 *
 * @param ctx - Query context
 * @param relationInfo - Relation metadata
 * @param parentAlias - Parent table alias
 * @param relatedAlias - Related table alias
 * @returns SQL condition for correlation
 * @throws QueryEngineError if fields/references not defined
 */
export function buildCorrelation(
  ctx: QueryContext,
  relationInfo: RelationInfo,
  parentAlias: string,
  relatedAlias: string
): Sql {
  const { adapter } = ctx;
  const internals = relationInfo.relation["~"];

  // Get field names for correlation
  const fields = internals.fields;
  const references = internals.references;

  // Require explicit fields/references - no guessing
  if (!fields || !references || fields.length === 0 || references.length === 0) {
    throw new QueryEngineError(
      `Relation '${relationInfo.name}' on model '${ctx.model.name}' must define 'fields' and 'references' explicitly. ` +
        `Use .fields([...]).references([...]) in your schema definition.`
    );
  }

  if (fields.length !== references.length) {
    throw new QueryEngineError(
      `Relation '${relationInfo.name}' on model '${ctx.model.name}' has mismatched fields (${fields.length}) and references (${references.length}).`
    );
  }

  // Build equality conditions for each field/reference pair
  // Resolve field names to column names (handles .map() overrides)
  const conditions: Sql[] = [];
  for (let i = 0; i < fields.length; i++) {
    const parentColumnName = getColumnName(ctx.model, fields[i]!);
    const relatedColumnName = getColumnName(relationInfo.targetModel, references[i]!);
    const parentCol = adapter.identifiers.column(parentAlias, parentColumnName);
    const relatedCol = adapter.identifiers.column(relatedAlias, relatedColumnName);
    conditions.push(adapter.operators.eq(parentCol, relatedCol));
  }

  return conditions.length === 1
    ? conditions[0]!
    : adapter.operators.and(...conditions);
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
  // Check for field marked as id
  for (const [name, field] of model["~"].fieldMap) {
    if (field["~"].state.isId) {
      return name;
    }
  }

  // Check for compound ID
  const compoundId = model["~"].compoundId;
  if (compoundId && compoundId.fields.length > 0) {
    return compoundId.fields[0]!;
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
  // Check for compound ID first
  const compoundId = model["~"].compoundId;
  if (compoundId && compoundId.fields.length > 0) {
    return compoundId.fields;
  }

  // Check for field marked as id
  for (const [name, field] of model["~"].fieldMap) {
    if (field["~"].state.isId) {
      return [name];
    }
  }

  // Default to "id"
  return ["id"];
}

