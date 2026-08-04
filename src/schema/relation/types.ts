// Relation Types and Shared Interfaces

import type { AnyModel } from "@schema/model";

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
  // Deliberately `any`, NOT `Getter`: when a relation state is structurally
  // compared against this interface (e.g. model()'s ModelShape constraint or
  // a relation class's State constraint), a function-typed member forces
  // TypeScript to resolve the getter's return type. In mutually-recursive
  // schemas with chained relation builders on both sides (e.g. .name() on a
  // to-many plus .fields() on its inverse) that resolution is circular and
  // silently collapses both model consts to `any`. Comparing against `any`
  // short-circuits without touching the return type. Concrete states still
  // carry the precise `() => typeof model` type for inference.
  // biome-ignore lint/suspicious/noExplicitAny: see above
  getter: any;
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
            ? State extends { fields: infer Fields extends string[] }
              ? TName extends string
                ? State["name"] extends TName
                  ? Fields
                  : never
                : Fields
              : never
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
 * - For to-one relations with `.fields()`: returns its own fields
 * - For inverse one-to-one, one-to-many, and many-to-many relations: finds the
 *   inverse to-one relation in the target model and returns its fields
 *
 * The target model's relations are inferred from S["getter"].
 * If the relation has a name, only matches inverse relations with the same name.
 *
 * KNOWN RESIDUAL (M8b): the runtime {@link getInverseRelationMap} demotes that name
 * check to a disambiguator — a SOLE back-reference is the edge whether or not it echoes
 * the name — so on a schema whose lone back-reference does not echo it, this type still
 * omits nothing while the runtime omits (and the parse refuses) the foreign key. The gap
 * is in the safe direction: the compiler permits a key the parse answers with a typed
 * `ValidationError: Unknown key: <fk>` rather than the silent overwrite that preceded the
 * alignment. Closing it belongs with the type-surface work, together with
 * `ScannedInverseRelationMap` in `validation/relations/create.ts`, which scans the same
 * edge and applies the same name check the same rejecting way.
 */
export type GetInverseRelationMap<
  S extends RelationState,
  TSourceModel,
> = S extends {
  type: "manyToOne" | "oneToOne";
  fields: readonly string[];
}
  ? S["fields"]
  : S["getter"] extends () => infer TTargetModel
    ? ExtractInverseFields<TTargetModel, TSourceModel, S["name"]>
    : undefined;

/**
 * Get the FK fields from the inverse relation at runtime.
 * - For to-one relations with `.fields()`: returns its own fields
 * - For inverse one-to-one, one-to-many, and many-to-many relations: finds the
 *   inverse to-one relation in the target model, by the SAME rule the engine's
 *   {@link findInverseRelationState} uses (see the note at the scan below): the
 *   relation name disambiguates competing back-references, it never rejects the
 *   only one.
 *
 * @param state - The current relation state
 * @param sourceModel - The source model (to verify the inverse points back)
 */
export function getInverseRelationMap<S extends RelationState, TSourceModel>(
  state: S,
  sourceModel: TSourceModel
): GetInverseRelationMap<S, TSourceModel> {
  // To-one relations with explicit fields hold the FK on this side. Inverse
  // one-to-one relations have no fields and must scan the target model.
  if (
    (state.type === "manyToOne" || state.type === "oneToOne") &&
    state.fields
  ) {
    return state.fields as GetInverseRelationMap<S, TSourceModel>;
  }

  // oneToMany/manyToMany - find the inverse relation in target model
  const targetModel = state.getter() as {
    "~": { state: { relations: Record<string, AnyRelation> } };
  };
  const targetRelations = targetModel["~"].state.relations;

  const candidates: RelationState[] = [];
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

    candidates.push(relState);
  }

  // The relation name DISAMBIGUATES; it does not reject. When several to-one
  // back-references point at the source model, `.name()` says which one carries THIS
  // relation's foreign key. When there is exactly one, it IS this relation's foreign key
  // whatever either side spelled — `.name()` on a single relation pair is legal
  // decoration (R007 only asks for it when several relations run between two models, and
  // R003/R004 pair relations by type, never by name).
  //
  // This is the rule `findInverseRelationState` — the ENGINE's scanner, which resolves
  // the same edge for read correlation and for nested-write FK direction — has always
  // applied. Rejecting a name-mismatched SOLE back-reference here made the two scanners
  // answer differently about one edge: the parse omitted nothing, so it ADMITTED a
  // spelled child foreign key, and `CreateOperation`'s inject then overwrote that value
  // with the one the engine resolved — a user-supplied identity discarded silently.
  // Aligned on the engine's reading because two live callers need it: a name-mismatched
  // schema's reads correlate through that scanner with no parse boundary in front of
  // them, and its nested writes resolve their FK direction through it.
  if (candidates.length === 1) {
    return candidates[0]!.fields as GetInverseRelationMap<S, TSourceModel>;
  }
  for (const candidate of candidates) {
    if (!state.name || state.name === candidate.name) {
      return candidate.fields as GetInverseRelationMap<S, TSourceModel>;
    }
  }

  return undefined as GetInverseRelationMap<S, TSourceModel>;
}
