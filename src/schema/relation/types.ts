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

/** `(U extends unknown ? … )` distributed into a parameter position, so a union
 *  becomes an intersection — the standard vehicle for {@link IsSingleMember}. */
type UnionToIntersection<U> = (
  U extends unknown
    ? (x: U) => void
    : never
) extends (x: infer I) => void
  ? I
  : never;

/**
 * True exactly when `U` has ONE member — the type-level form of the runtime
 * scan's `candidates.length === 1`. `never` (no candidate) is false, and a
 * union of two or more is false because a union is not assignable to its own
 * intersection.
 *
 * It is asked about the target model's RELATION KEYS, never about the field
 * tuples those relations carry: two relations can name the same column, and
 * counting tuples would fuse two candidates into one and take the
 * single-candidate branch for an ambiguous edge.
 */
export type IsSingleMember<U> = [U] extends [never]
  ? false
  : [U] extends [UnionToIntersection<U>]
    ? true
    : false;

/** Every to-one back-reference on the target model that carries a foreign key to
 *  the source — the candidate set the runtime scan collects BEFORE the name is
 *  asked. Keyed by relation name, which is unique by construction. */
type InverseCandidateKeys<TTargetModel, TSourceModel> =
  TTargetModel extends ModelWithRelations
    ? {
        [K in keyof TTargetModel["~"]["state"]["relations"]]: TTargetModel["~"]["state"]["relations"][K] extends ToOneRelationShape<
          infer State
        >
          ? State["getter"] extends () => TSourceModel
            ? State extends { fields: string[] }
              ? K
              : never
            : never
          : never;
      }[keyof TTargetModel["~"]["state"]["relations"]]
    : never;

/** The candidates whose `.name()` matches — what the name is FOR when several
 *  back-references compete. */
type NamedInverseCandidateKeys<TTargetModel, TSourceModel, TName> =
  TTargetModel extends ModelWithRelations
    ? {
        [K in keyof TTargetModel["~"]["state"]["relations"]]: TTargetModel["~"]["state"]["relations"][K] extends ToOneRelationShape<
          infer State
        >
          ? State["getter"] extends () => TSourceModel
            ? State extends { fields: string[] }
              ? TName extends string
                ? State["name"] extends TName
                  ? K
                  : never
                : K
              : never
            : never
          : never;
      }[keyof TTargetModel["~"]["state"]["relations"]]
    : never;

/** The `.fields()` tuple of one named candidate. */
type InverseFieldsAt<TTargetModel, K> = TTargetModel extends ModelWithRelations
  ? K extends keyof TTargetModel["~"]["state"]["relations"]
    ? TTargetModel["~"]["state"]["relations"][K] extends ToOneRelationShape<
        infer State
      >
      ? State extends { fields: infer Fields extends string[] }
        ? Fields
        : never
      : never
    : never
  : never;

/** Helper to extract fields from target model's relations */
type ExtractInverseFieldsRaw<TTargetModel, TSourceModel, TName> =
  TTargetModel extends ModelWithRelations
    ? IsSingleMember<
        InverseCandidateKeys<TTargetModel, TSourceModel>
      > extends true
      ? InverseFieldsAt<
          TTargetModel,
          InverseCandidateKeys<TTargetModel, TSourceModel>
        >
      : InverseFieldsAt<
          TTargetModel,
          NamedInverseCandidateKeys<TTargetModel, TSourceModel, TName>
        >
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
 *
 * The relation name DISAMBIGUATES; it does not reject — the SAME rule the runtime
 * {@link getInverseRelationMap} and the engine's `findInverseRelationState` apply. A SOLE
 * back-reference IS this relation's foreign key whether or not it echoes the name, and
 * the name only picks among SEVERAL competing back-references.
 *
 * TH — the residual D5 left here is closed. The name check used to REJECT at the type
 * level while the runtime demoted it, so on a schema whose lone back-reference does not
 * echo the name the two answered differently about one edge. Measured through the public
 * client at 620a171: a nested `createMany` row DEMANDED the foreign key
 * (`Property 'orgId' is missing … but required`) that the runtime schema had already made
 * optional and the engine derives — a legal call the compiler refused. The alignment is
 * expressible because `.fields()` keeps its literal tuple through the model type and
 * {@link IsSingleMember} answers `candidates.length === 1` over the target's RELATION
 * KEYS (the recorded risk — a `.fields()` collapse to `string[]` fusing two candidates —
 * was measured NOT to occur, and counting keys rather than tuples makes it unreachable
 * either way).
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
