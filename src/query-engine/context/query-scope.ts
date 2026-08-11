import type { DatabaseAdapter } from "@adapters";
import { getModelKeyCatalog, type Model } from "@schema/model";
import type { AnyPolymorphicRelation } from "@schema/relation";
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
    if (storage) fields.set(name, { name, relation, storage });
  }
  polymorphicRelationsByModel.set(model, fields);
  return fields;
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
    isToMany: state.type === "oneToMany" || state.type === "manyToMany",
    isToOne: state.type === "oneToOne" || state.type === "manyToOne",
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
 * family (N7-U-A) rely on this function never answering an empty list.
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
