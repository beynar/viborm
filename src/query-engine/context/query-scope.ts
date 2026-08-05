import type { DatabaseAdapter } from "@adapters";
import type { Model } from "@schema/model";
import type { QueryScope, RelationInfo } from "../types";

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
  };
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
