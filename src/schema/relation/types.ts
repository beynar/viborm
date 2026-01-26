// Relation Types and Shared Interfaces

import { AnyModel } from "@schema/model";

/** Workaround to allow circular dependencies */
export type Getter = () => any;

/** Relation cardinality types */
export type RelationType =
  | "oneToOne"
  | "oneToMany"
  | "manyToOne"
  | "manyToMany";

/** Referential action for foreign key constraints */
export type ReferentialAction = "cascade" | "setNull" | "restrict" | "noAction";

// =============================================================================
// RELATION STATE
// =============================================================================

/**
 * Unified relation state interface
 * All properties are optional except type and getter
 * Specific relation types will only use relevant properties
 */
export interface RelationState {
  type: RelationType;
  getter: Getter;
  name?: string;
  // ToOne properties (oneToOne, manyToOne)
  fields?: string[];
  references?: string[];
  optional?: boolean;
  // Referential actions (ToOne and ManyToMany)
  onDelete?: ReferentialAction;
  onUpdate?: ReferentialAction;
  // ManyToMany properties
  through?: string;
  A?: string;
  B?: string;
  source?: AnyModel;
}

/** State for ToOne relations (oneToOne, manyToOne) */
export interface ToOneRelationState extends RelationState {
  type: "oneToOne" | "manyToOne";
}

/** State for ToMany relations (oneToMany) */
export interface ToManyRelationState extends RelationState {
  type: "oneToMany";
}

/** State for ManyToMany relations */
export interface ManyToManyRelationState extends RelationState {
  type: "manyToMany";
}

// =============================================================================
// INVERSE RELATION FIELDS
// =============================================================================

/** Any relation type (for generic constraints) */
export type AnyRelation = { "~": { state: RelationState } };

/** ToOneRelation shape (for type matching) */
export type ToOneRelationShape<
  State extends ToOneRelationState = ToOneRelationState,
> = {
  "~": { state: State };
};

/** Model shape for extracting relations */
type ModelWithRelations = {
  "~": { state: { relations: Record<string, AnyRelation> } };
};

/** Helper to extract fields from target model's relations */
type ExtractInverseFieldsRaw<TTargetModel, TSourceModel, TName> =
  TTargetModel extends ModelWithRelations
    ? {
        [K in keyof TTargetModel["~"]["state"]["relations"]]: TTargetModel["~"]["state"]["relations"][K] extends ToOneRelationShape<
          infer State
        >
          ? State["getter"] extends () => TSourceModel
            ? TName extends string
              ? State["name"] extends TName
                ? State["fields"]
                : never
              : State["fields"]
            : never
          : never;
      }[keyof TTargetModel["~"]["state"]["relations"]]
    : undefined;

/** Convert never to undefined */
type ExtractInverseFields<TTargetModel, TSourceModel, TName> = [
  ExtractInverseFieldsRaw<TTargetModel, TSourceModel, TName>,
] extends [never]
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
  TSourceModel,
> = S extends { type: "manyToOne" | "oneToOne" }
  ? S["fields"]
  : S["getter"] extends () => infer TTargetModel
    ? ExtractInverseFields<TTargetModel, TSourceModel, S["name"]>
    : undefined;

/**
 * Get the FK fields from the inverse relation at runtime.
 * - For manyToOne/oneToOne: returns its own fields
 * - For oneToMany/manyToMany: finds the inverse toOne relation in target model
 *
 * @param state - The current relation state
 * @param sourceModel - The source model (to verify the inverse points back)
 */
export function getInverseRelationFields<S extends RelationState, TSourceModel>(
  state: S,
  sourceModel: TSourceModel,
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
