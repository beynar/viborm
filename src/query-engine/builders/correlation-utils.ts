/**
 * Correlation Utilities
 *
 * Shared utilities for building correlation conditions between
 * parent and related tables in relation queries.
 */

import type { Model } from "@schema/model";
import type { Sql } from "@sql";
import { getColumnName, getCompoundIdConstraint } from "../context";
import { QueryEngineError, type QueryScope } from "../types";
import {
  type ChildHeldRelation,
  hasPolymorphicMembership,
  type ParentHeldRelation,
  type PolymorphicChildHeldRelation,
} from "./relation-data-builder";

export { getCompoundIdConstraint, getPrimaryKeyFields } from "../context";

/**
 * Build correlation condition between parent and related table.
 *
 * For a parent-held edge: uses the membership's own foreign/referenced columns
 * For a child-held edge: uses the inverse the binder resolved on the target model
 * For a resolved polymorphic inverse: binds its private id and fixed stored type
 *
 * A junction relation cannot reach here: it is a THIRD table's membership, it has
 * no parent/target column pair to compare, and the one classification
 * (`classifyRelation`, consumed by `relation-traversal.ts`) hands junctions to
 * `buildManyToManyJoinParts` instead. The bound union spells that out — this
 * signature admits only the two row-held arms — which is why the refusal this
 * function used to carry is gone rather than moved.
 *
 * @param ctx - Query context
 * @param relation - The bound row-held relation being traversed
 * @param parentAlias - Parent table alias
 * @param relatedAlias - Related table alias
 * @returns SQL condition for correlation
 * @throws QueryEngineError if unable to determine correlation
 */
export function buildCorrelation(
  ctx: QueryScope,
  relation: ParentHeldRelation | ChildHeldRelation,
  parentAlias: string,
  relatedAlias: string
): Sql {
  const { adapter } = ctx;
  const { relationInfo } = relation;
  if (hasPolymorphicMembership(relation)) {
    const parentIdentity = adapter.identifiers.column(
      parentAlias,
      getColumnName(ctx.model, relation.membership.referencedField)
    );
    return buildPolymorphicMembershipPredicate(
      ctx,
      relation,
      relatedAlias,
      parentIdentity
    );
  }

  // POSITION, not holder identity: a self-relation holds both ends, and this asks
  // which END the parent alias addresses.
  const parentHeld = relation.position === "parentHeld";
  const { foreignFields, referencedFields } = relation.membership;
  const parentFields = parentHeld ? foreignFields : referencedFields;
  const relatedFields = parentHeld ? referencedFields : foreignFields;

  // This read path's OWN refusal, with its own sentence — and, because it proves the
  // two lists have equal arity, the reason the member pairing below cannot refuse
  // here and displace it. It must therefore stay AHEAD of the first read of
  // `membership.members`: that getter owns a different refusal (guard #1's
  // NestedWriteError) which would otherwise displace this one.
  if (parentFields.length !== relatedFields.length) {
    throw new QueryEngineError(
      `Relation '${relationInfo.name}' has mismatched fields (${parentFields.length}) and references (${relatedFields.length}).`
    );
  }

  const conditions: Sql[] = relation.membership.members.map((member) => {
    const parentColumnName = getColumnName(
      ctx.model,
      parentHeld ? member.foreignField : member.referencedField
    );
    const relatedColumnName = getColumnName(
      relationInfo.targetModel,
      parentHeld ? member.referencedField : member.foreignField
    );
    const parentCol = adapter.identifiers.column(parentAlias, parentColumnName);
    const relatedCol = adapter.identifiers.column(
      relatedAlias,
      relatedColumnName
    );
    return adapter.operators.eq(parentCol, relatedCol);
  });

  return conditions.length === 1
    ? conditions[0]!
    : adapter.operators.and(...conditions);
}

export function buildPolymorphicMembershipPredicate(
  ctx: QueryScope,
  relation: PolymorphicChildHeldRelation,
  childQualifier: string,
  parentIdentity: Sql
): Sql {
  const { storage, storedType } = relation.membership;
  const childId = ctx.adapter.identifiers.column(
    childQualifier,
    storage.idColumn.name
  );
  const childType = ctx.adapter.identifiers.column(
    childQualifier,
    storage.typeColumn.name
  );
  return ctx.adapter.operators.and(
    ctx.adapter.operators.eq(childId, parentIdentity),
    ctx.adapter.operators.exactTextEq(
      childType,
      ctx.adapter.literals.value(storedType)
    )
  );
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
