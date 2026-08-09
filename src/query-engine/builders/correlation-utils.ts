/**
 * Correlation Utilities
 *
 * Shared utilities for building correlation conditions between
 * parent and related tables in relation queries.
 */

import type { Model } from "@schema/model";
import type { Sql } from "@sql";
import { getColumnName, getCompoundIdConstraint } from "../context";
import { QueryEngineError, type QueryScope, type RelationInfo } from "../types";
import {
  type BoundPolymorphicChildHeldRelation,
  bindRelation,
  isPolymorphicChildHeldRelation,
} from "./relation-data-builder";

export { getCompoundIdConstraint, getPrimaryKeyFields } from "../context";

/**
 * Build correlation condition between parent and related table.
 *
 * For manyToOne relations: uses fields/references directly
 * For oneToMany/oneToOne: finds inverse relation on target model to get FK info
 * For a resolved polymorphic inverse: binds its private id and fixed stored type
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
  ctx: QueryScope,
  relationInfo: RelationInfo,
  parentAlias: string,
  relatedAlias: string
): Sql {
  const { adapter } = ctx;
  const relation = bindRelation(ctx, relationInfo);
  if (isPolymorphicChildHeldRelation(relation)) {
    const parentIdentity = adapter.identifiers.column(
      parentAlias,
      getColumnName(ctx.model, relation.referencedFields[0])
    );
    return buildPolymorphicMembershipPredicate(
      ctx,
      relation,
      relatedAlias,
      parentIdentity
    );
  }

  if (relation.kind === "junction") {
    throw new QueryEngineError(
      `Many-to-many relation '${relationInfo.name}' cannot use buildCorrelation directly. ` +
        "Use getManyToManyJoinInfo() and buildManyToManyJoinParts() from many-to-many-utils.ts instead."
    );
  }

  const parentFields =
    relation.kind === "parentHeldToOne"
      ? relation.foreignFields
      : relation.referencedFields;
  const relatedFields =
    relation.kind === "parentHeldToOne"
      ? relation.referencedFields
      : relation.foreignFields;

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

export function buildPolymorphicMembershipPredicate(
  ctx: QueryScope,
  relation: BoundPolymorphicChildHeldRelation,
  childQualifier: string,
  parentIdentity: Sql
): Sql {
  const childId = ctx.adapter.identifiers.column(
    childQualifier,
    relation.storage.idColumn.name
  );
  const childType = ctx.adapter.identifiers.column(
    childQualifier,
    relation.storage.typeColumn.name
  );
  return ctx.adapter.operators.and(
    ctx.adapter.operators.eq(childId, parentIdentity),
    ctx.adapter.operators.exactTextEq(
      childType,
      ctx.adapter.literals.value(relation.storedType)
    )
  );
}

/**
 * Get model name for error messages
 */
function getModelName(model: Model<any>): string {
  return model["~"].names.ts ?? model["~"].state.tableName ?? "unknown";
}

/**
 * Wrap flat PK field values into whereUnique shape. Compound PKs nest under
 * the constraint name ({ tenantId_id: { tenantId, id } }); single-field PKs
 * stay flat. buildWhereUnique only accepts unique discriminators, so bare
 * compound member fields would be rejected.
 */
export function buildPrimaryKeyWhereUnique(
  model: Model<any>,
  values: Record<string, unknown>
): Record<string, unknown> {
  const compound = getCompoundIdConstraint(model);
  return compound ? { [compound.name]: values } : values;
}

/**
 * Get the single primary key field of a model, or throw.
 *
 * Junction tables key on one PK column per side, so many-to-many requires a
 * single-field PK on both models.
 */
export function getRequiredSinglePrimaryKeyField(model: Model<any>): string {
  const modelName = getModelName(model);

  const compoundId = model["~"].state.compoundId;
  if (compoundId && Object.keys(compoundId).length > 0) {
    throw new QueryEngineError(
      `Model "${modelName}" uses a compound primary key. ` +
        "Many-to-many relations with compound PKs are not supported. " +
        "Use a single-field surrogate key (e.g., s.string().id().ulid()) instead."
    );
  }

  for (const [name, field] of Object.entries(model["~"].state.scalars)) {
    if ((field as any)["~"].state.isId) {
      return name;
    }
  }

  throw new QueryEngineError(
    `Model "${modelName}" has no primary key field. ` +
      "Many-to-many relations require a single-field primary key."
  );
}
