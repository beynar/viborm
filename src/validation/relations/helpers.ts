import type { AnyModel } from "@schema/model";
import type {
  AnyRelation,
  RelationState,
  ToOneRelation,
} from "@schema/relation";
import type { ModelSchemas } from "@validation/builder";

export type TargetModel<S extends RelationState> =
  S["getter"] extends () => infer T ? (T extends AnyModel ? T : never) : never;

export type GetTargetSchemas<S extends RelationState> = ModelSchemas<
  TargetModel<S>
>;

type CreateSchemaGetter<S extends RelationState> = (
  state: S
) => () => GetTargetSchemas<S>;

export type SchemaGetter<S extends RelationState> = ReturnType<
  CreateSchemaGetter<S>
>;

// =============================================================================
// INVERSE RELATION FIELDS
// =============================================================================

/** Helper to extract fields from target model's relations */
type ExtractInverseFieldsRaw<
  TTargetModel extends AnyModel,
  TSourceModel extends AnyModel,
  TName,
> = {
  [K in keyof TTargetModel["~"]["state"]["relations"]]: TTargetModel["~"]["state"]["relations"][K] extends ToOneRelation<
    infer State
  >
    ? State["getter"] extends () => TSourceModel
      ? TName extends string
        ? State["name"] extends TName
          ? State["fields"] | K
          : never
        : State["fields"] | K
      : never
    : never;
}[keyof TTargetModel["~"]["state"]["relations"]];

/** Convert never to undefined */
type ExtractInverseFields<
  TTargetModel extends AnyModel,
  TSourceModel extends AnyModel,
  TName,
> = [ExtractInverseFieldsRaw<TTargetModel, TSourceModel, TName>] extends [never]
  ? undefined
  : ExtractInverseFieldsRaw<TTargetModel, TSourceModel, TName>;

/**
 * Get the FK fields from the inverse relation.
 * - For manyToOne/oneToOne: returns its own fields (it holds the FK)
 * - For oneToMany/manyToMany: finds the inverse toOne relation in target model and returns its fields
 *
 * The target model's relations are inferred from S["getter"].
 * If the relation has a name, only matches inverse relations with the same name.
 */
export type GetInverseRelationFields<
  S extends RelationState,
  TSourceModel extends AnyModel,
> = S["type"] extends "manyToOne" | "oneToOne"
  ? S["fields"]
  : ExtractInverseFields<TargetModel<S>, TSourceModel, S["name"]>;

/**
 * Get the FK fields from the inverse relation at runtime.
 * - For manyToOne/oneToOne: returns its own fields
 * - For oneToMany/manyToMany: finds the inverse toOne relation in target model
 *
 * @param state - The current relation state
 * @param sourceModel - The source model (to verify the inverse points back)
 */
export function getInverseRelationFields<
  S extends RelationState,
  TSourceModel extends AnyModel,
>(
  state: S,
  sourceModel: TSourceModel
): GetInverseRelationFields<S, TSourceModel> {
  // manyToOne/oneToOne already have FK fields on this side
  if (state.type === "manyToOne" || state.type === "oneToOne") {
    return state.fields as GetInverseRelationFields<S, TSourceModel>;
  }

  // oneToMany/manyToMany - find the inverse relation in target model
  const targetModel = state.getter() as {
    "~": { state: { relations: Record<string, AnyRelation> } };
  };
  const targetRelations = targetModel["~"].state.relations;

  for (const relation of Object.values(targetRelations)) {
    const relState = relation["~"].state;

    // Must be manyToOne/oneToOne with fields
    if (
      (relState.type !== "manyToOne" && relState.type !== "oneToOne") ||
      !relState.fields
    ) {
      continue;
    }

    // The inverse relation's target must be the source model
    if (relState.getter() !== sourceModel) {
      continue;
    }

    // If source relation has a name, inverse must have the same name
    if (state.name && state.name !== relState.name) {
      continue;
    }

    return relState.fields as GetInverseRelationFields<S, TSourceModel>;
  }

  return undefined as GetInverseRelationFields<S, TSourceModel>;
}
