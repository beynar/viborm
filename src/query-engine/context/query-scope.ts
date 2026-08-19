import type { DatabaseAdapter } from "@adapters";
import { getModelKeyCatalog, type Model } from "@schema/model";
import {
  type AnyPolymorphicRelation,
  type PolymorphicStorage,
  polymorphicCardinality,
  relationCardinality,
} from "@schema/relation";
import type {
  PolymorphicRelationInfo,
  QueryScope,
  RelationInfo,
} from "../types";

const polymorphicRelationsByModel = new WeakMap<
  Model<any>,
  ReadonlyMap<string, PolymorphicRelationInfo>
>();

export function createQueryScope(
  adapter: DatabaseAdapter,
  model: Model<any>
): QueryScope {
  let nextAliasId = 0;
  const nextAlias = () => `t${nextAliasId++}`;
  return {
    adapter,
    model,
    nextAlias,
    rootAlias: nextAlias(),
    polymorphicRelations: getPolymorphicRelations(model),
  };
}

export function createChildScope(
  parent: QueryScope,
  model: Model<any>,
  alias: string
): QueryScope {
  return {
    adapter: parent.adapter,
    model,
    nextAlias: parent.nextAlias,
    rootAlias: alias,
    mutationTable: parent.mutationTable,
    polymorphicRelations: getPolymorphicRelations(model),
  };
}

function getPolymorphicRelations(
  model: Model<any>
): ReadonlyMap<string, PolymorphicRelationInfo> {
  const cached = polymorphicRelationsByModel.get(model);
  if (cached) return cached;
  const fields = new Map<string, PolymorphicRelationInfo>();
  const relations: Readonly<Record<string, AnyPolymorphicRelation>> =
    model["~"].state.polymorphicRelations;
  for (const [name, relation] of Object.entries(relations)) {
    const storage = model["~"].getPolymorphicStorage(name);
    // Both stored descriptors enter the scope since Package C. A missing one
    // still does not: an unvalidated group has no materialized storage, and the
    // read/write builders answer "no validated storage metadata" for it.
    if (storage) {
      fields.set(name, toPolymorphicRelationInfo(name, relation, storage));
    }
  }
  polymorphicRelationsByModel.set(model, fields);
  return fields;
}

/**
 * Pair one relation with its stored descriptor.
 *
 * The narrow is what makes the pair ASSIGNABLE: `PolymorphicRelationInfo` is a
 * union of the two arms — spelled that way so its guards subtract — and a
 * literal whose `storage` is still the descriptor union belongs to neither arm
 * until the descriptor itself is narrowed.
 */
function toPolymorphicRelationInfo(
  name: string,
  relation: AnyPolymorphicRelation,
  storage: PolymorphicStorage
): PolymorphicRelationInfo {
  return storage.kind === "toOne"
    ? { name, relation, storage }
    : { name, relation, storage };
}

export function getPolymorphicRelationInfo(
  scope: QueryScope,
  relationName: string
): PolymorphicRelationInfo | undefined {
  return scope.polymorphicRelations.get(relationName);
}

export function getRelationInfo(
  scope: QueryScope,
  relationName: string
): RelationInfo | undefined {
  const relations = scope.model["~"].state.relations;
  const relation = Object.hasOwn(relations, relationName)
    ? relations[relationName]
    : undefined;
  if (!relation) return undefined;

  const state = relation["~"].state;
  const targetModel = state.getter();
  return {
    name: relationName,
    relation,
    targetModel,
    type: state.type,
    cardinality: relationCardinality(state),
    isOptional: state.optional ?? false,
    fields: state.fields,
    references: state.references,
  };
}

/**
 * Return the named compound primary-key constraint and its ordered members —
 * a derived view of the model-key catalog: the row key, when it is a grouped
 * constraint rather than a bare scalar.
 */
export function getCompoundIdConstraint(
  model: Model<any>
): { name: string; fields: string[] } | undefined {
  const rowKey = getModelKeyCatalog(model).rowKey;
  return rowKey?.name === undefined
    ? undefined
    : { name: rowKey.name, fields: [...rowKey.fields] };
}

/**
 * Return the ordered scalar fields that form the model primary key — the
 * catalog row key's TOTAL view. The `["id"]` fallback for a model with no
 * declared key is load-bearing: thirty call sites and the converted dead-guard
 * family rely on this function never answering an empty list.
 */
export function getPrimaryKeyFields(model: Model<any>): string[] {
  const rowKey = getModelKeyCatalog(model).rowKey;
  return rowKey ? [...rowKey.fields] : ["id"];
}

export { getColumnName, getTableName } from "@schema/model";

export function getScalarFieldNames(model: Model<any>): string[] {
  return model["~"].scalarFieldNames;
}

export function getDefaultScalarFieldNames(model: Model<any>): string[] {
  const omitted = model["~"].state.omit;
  if (!omitted) return getScalarFieldNames(model);
  return getScalarFieldNames(model).filter(
    (fieldName) =>
      !Object.hasOwn(omitted, fieldName) || omitted[fieldName] !== true
  );
}

export function getRelationNames(model: Model<any>): string[] {
  return model["~"].relationNames;
}

export function isScalarField(model: Model<any>, fieldName: string): boolean {
  return model["~"].scalarFieldSet.has(fieldName);
}

/**
 * Whether the column behind a scalar field can hold SQL NULL.
 *
 * A NOT NULL column makes every null-placement request unobservable, which is
 * what lets the paginated ORDER BY drop the placement key and the cursor
 * predicate use a row-value comparison.
 */
export function isNullableScalarField(
  model: Model<any>,
  fieldName: string
): boolean {
  return model["~"].state.scalars[fieldName]?.["~"].state.nullable === true;
}

export function isRelation(model: Model<any>, fieldName: string): boolean {
  return model["~"].relationSet.has(fieldName);
}

export function isPolymorphicRelation(
  model: Model<any>,
  fieldName: string
): boolean {
  return model["~"].polymorphicRelationSet.has(fieldName);
}

/**
 * The COLLECTION half of {@link isPolymorphicRelation}, split out because root
 * `createMany` routing needs exactly that half and nothing wider.
 *
 * A direct polymorphic TO-ONE key in a bulk row stores private owner columns on
 * the row itself, and the grouped cross-row probe route
 * (`write-engine/bulk-polymorphic-connect.ts`) compiles it into the maximal
 * grouped INSERT — a shipped SQL contract pinned byte-for-byte. A COLLECTION key
 * has no such analogue: its membership lives in per-variant member junction rows
 * that only exist after the owner row does, so the row is relation-BEARING and
 * belongs to the record series.
 *
 * It branches through {@link polymorphicCardinality} rather than reading
 * `state.cardinality`, so the terminal the declaration selected stays the one
 * reading of this fact.
 */
export function isPolymorphicCollectionRelation(
  model: Model<any>,
  fieldName: string
): boolean {
  const relation = model["~"].state.polymorphicRelations[fieldName];
  return (
    relation !== undefined &&
    polymorphicCardinality(relation["~"].state) === "many"
  );
}
