/**
 * Correlation Utilities
 *
 * Shared utilities for building correlation conditions between
 * parent and related tables in relation queries.
 */

import type { Model } from "@schema/model";
import type { AnyRelation, ReferentialAction } from "@schema/relation";
import type { Sql } from "@sql";
import { getColumnName } from "../context";
import { QueryEngineError, type QueryScope, type RelationInfo } from "../types";
import { resolvePolymorphicInverse } from "./polymorphic-relation";

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
  const polymorphicInverse = resolvePolymorphicInverse(ctx, relationInfo);
  const state = relationInfo.relation["~"].state;
  const namedPolymorphicInverse =
    polymorphicInverse &&
    state.name !== undefined &&
    relationInfo.targetModel["~"].state.polymorphicRelations[
      polymorphicInverse.childRelationKey
    ]?.["~"].state.name === state.name
      ? polymorphicInverse
      : undefined;
  if (namedPolymorphicInverse) {
    return buildPolymorphicInverseCorrelation(
      ctx,
      namedPolymorphicInverse,
      parentAlias,
      relatedAlias
    );
  }

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
    if (inverseInfo) {
      // For oneToMany: parent.id = related.authorId
      // The inverse relation has: fields = [authorId], references = [id]
      // So we need: parent's references = related's fields
      parentFields = inverseInfo.references;
      relatedFields = inverseInfo.fields;
    } else if (polymorphicInverse) {
      return buildPolymorphicInverseCorrelation(
        ctx,
        polymorphicInverse,
        parentAlias,
        relatedAlias
      );
    } else {
      throw new QueryEngineError(
        `Relation '${relationInfo.name}' on model '${getModelName(ctx.model)}' requires an inverse relation ` +
          `on '${getModelName(relationInfo.targetModel)}' with explicit 'fields' and 'references'.`
      );
    }
  } else if (state.type === "manyToMany") {
    // manyToMany requires junction table handling - callers should use getManyToManyJoinInfo() instead
    throw new QueryEngineError(
      `Many-to-many relation '${relationInfo.name}' cannot use buildCorrelation directly. ` +
        "Use getManyToManyJoinInfo() and buildManyToManyJoinParts() from many-to-many-utils.ts instead."
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

function buildPolymorphicInverseCorrelation(
  ctx: QueryScope,
  inverse: NonNullable<ReturnType<typeof resolvePolymorphicInverse>>,
  parentAlias: string,
  relatedAlias: string
): Sql {
  const childId = ctx.adapter.identifiers.column(
    relatedAlias,
    inverse.storage.idColumn.name
  );
  const parentReference = ctx.adapter.identifiers.column(
    parentAlias,
    getColumnName(ctx.model, inverse.sourceReferencedField)
  );
  const childType = ctx.adapter.identifiers.column(
    relatedAlias,
    inverse.storage.typeColumn.name
  );
  return ctx.adapter.operators.and(
    ctx.adapter.operators.eq(childId, parentReference),
    ctx.adapter.operators.exactTextEq(
      childType,
      ctx.adapter.literals.value(inverse.storedType)
    )
  );
}

/**
 * Find the relation on the target model that points back to the source model
 * and carries the FK fields.
 *
 * When multiple relations point back (e.g. Post.author and Post.editor both
 * targeting User), disambiguates via explicit relation names (`.name()`).
 * Throws when no name match exists: silently picking one would correlate on
 * the wrong FK and return wrong rows.
 *
 * Shared by correlation building (reads) and nested-write FK resolution.
 *
 * The schema's `getInverseRelationMap` scans the same edge to decide which columns the
 * PARSE omits from a nested create, and is aligned on this rule (M8b): a name is a
 * disambiguator, never a rejection of the sole back-reference. The two must agree — an
 * edge the parse admits a foreign key for is one this scanner would resolve and inject
 * over it. Change one and change the other.
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
  const targetRelations = targetModel["~"].state.relations;

  const potentialInverses: Array<{
    relationName?: string;
    fields: string[];
    references: string[] | undefined;
    onUpdate: ReferentialAction | undefined;
  }> = [];

  for (const relation of Object.values(targetRelations ?? {})) {
    const relState = (relation as AnyRelation)["~"].state;
    const fields = relState.fields;
    if (relState.getter?.() === sourceModel && fields && fields.length > 0) {
      potentialInverses.push({
        relationName: relState.name,
        fields,
        references: relState.references,
        onUpdate: relState.onUpdate,
      });
    }
  }

  if (potentialInverses.length === 0) {
    return undefined;
  }

  if (potentialInverses.length === 1) {
    const inverse = potentialInverses[0]!;
    return {
      fields: inverse.fields,
      references: inverse.references,
      onUpdate: inverse.onUpdate,
    };
  }

  // Multiple potential inverses - disambiguate by explicit relation name (.name())
  if (currentRelationName) {
    const matchByName = potentialInverses.find(
      (inv) => inv.relationName === currentRelationName
    );
    if (matchByName) {
      return {
        fields: matchByName.fields,
        references: matchByName.references,
        onUpdate: matchByName.onUpdate,
      };
    }
  }

  throw new QueryEngineError(
    `Ambiguous relation '${relationInfo.name}' on model '${getModelName(sourceModel)}': ` +
      `multiple relations on '${getModelName(targetModel)}' point back to it. ` +
      "Add .name() to both sides of each relation to disambiguate."
  );
}

/**
 * Find the inverse relation on the target model that points back to the source model.
 * Returns the fields/references from the inverse relation, or undefined when no
 * inverse with both fields and references exists.
 */
function findInverseRelation(
  ctx: QueryScope,
  relationInfo: RelationInfo
): { fields: string[]; references: string[] } | undefined {
  const inverse = findInverseRelationState(ctx.model, relationInfo);
  if (!inverse?.references || inverse.references.length === 0) {
    return undefined;
  }
  return { fields: inverse.fields, references: inverse.references };
}

/**
 * Get model name for error messages
 */
function getModelName(model: Model<any>): string {
  return model["~"].names.ts ?? model["~"].state.tableName ?? "unknown";
}

/**
 * Get the compound primary key constraint of a model: its constraint name
 * (e.g. "tenantId_id") and its member field names (e.g. ["tenantId", "id"]).
 * Returns undefined when the model has no compound id.
 */
export function getCompoundIdConstraint(
  model: Model<any>
): { name: string; fields: string[] } | undefined {
  const compoundId = model["~"].state.compoundId;
  if (!compoundId) {
    return undefined;
  }
  const name = Object.keys(compoundId)[0];
  const entries = name ? compoundId[name]?.entries : undefined;
  if (!(name && entries)) {
    return undefined;
  }
  const fields = Object.keys(entries);
  return fields.length > 0 ? { name, fields } : undefined;
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
  // Check for compound ID first: return its member fields, not the
  // constraint name (Object.keys(compoundId) would yield "tenantId_id").
  const compound = getCompoundIdConstraint(model);
  if (compound) {
    return compound.fields;
  }

  // Check for field marked as id
  for (const [name, field] of Object.entries(model["~"].state.scalars)) {
    if ((field as any)["~"].state.isId) {
      return [name];
    }
  }

  // Default to "id"
  return ["id"];
}
