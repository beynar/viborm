// Relation Types and Shared Interfaces

import type { AnyModel } from "@schema/model";
import { resolveOrdinaryInverse } from "./inverse";

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
              ? State["fields"] extends readonly []
                ? never
                : K
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
              ? State["fields"] extends readonly []
                ? never
                : TName extends string
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
 * The relation name DISAMBIGUATES; it does not reject — the SAME rule the one
 * candidate scan (`./inverse`) applies for every consumer. A SOLE
 * back-reference IS this relation's foreign key whether or not it echoes the name, and
 * the name only picks among SEVERAL competing back-references.
 *
 * THE TYPE LEVEL AND THE RUNTIME ANSWER THIS IDENTICALLY, and must. The name check
 * used to REJECT at the type level while the runtime demoted it, so on a schema whose
 * lone back-reference does not echo the name the two disagreed about one edge and a
 * legal nested `createMany` row demanded a foreign key the runtime had already made
 * optional. The alignment is expressible because `.fields()` keeps its literal tuple
 * through the model type and {@link IsSingleMember} answers `candidates.length === 1`
 * over the target's RELATION KEYS — counting keys rather than tuples is what keeps a
 * `.fields()` collapse to `string[]` from fusing two candidates.
 */
export type GetInverseRelationMap<
  S extends RelationState,
  TSourceModel,
> = S extends {
  type: "manyToOne" | "oneToOne";
  fields: readonly string[];
}
  ? S["fields"] extends readonly []
    ? // A zero-argument `.fields()` is fields-LESS — the aligned reading — so
      // the edge falls to the inverse scan exactly as the runtime does.
      S["getter"] extends () => infer TTargetModel
      ? ExtractInverseFields<TTargetModel, TSourceModel, S["name"]>
      : undefined
    : S["fields"]
  : S["getter"] extends () => infer TTargetModel
    ? ExtractInverseFields<TTargetModel, TSourceModel, S["name"]>
    : undefined;

/**
 * Get the FK fields from the inverse relation at runtime.
 * - For to-one relations with `.fields()`: returns its own fields
 * - For inverse one-to-one, one-to-many, and many-to-many relations: derives the
 *   FK-omission projection from the one candidate scan in `./inverse`: the
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
  // To-one relations with explicit NON-EMPTY fields hold the FK on this side —
  // the aligned reading (`fields.length > 0`) the engine has always applied. A
  // zero-argument `.fields()` is fields-less and falls to the inverse scan,
  // which is what retired guard-ledger site 11's only route.
  if (
    (state.type === "manyToOne" || state.type === "oneToOne") &&
    state.fields &&
    state.fields.length > 0
  ) {
    return state.fields as GetInverseRelationMap<S, TSourceModel>;
  }

  // The FK-OMISSION projection of the one ordinary resolution (`inverse.ts`).
  //
  // This view deliberately never consults the polymorphic arms: it answers
  // "which fields might the enclosing edge supply to nested data", and a
  // name-paired polymorphic edge does not stop the physical foreign key from
  // being the fields the child data must omit. What differs from the engine's
  // consumption of the same resolution is ONE policy, preserved exactly: on an
  // `ambiguous` verdict with no `.name()` the FIRST declared candidate answers
  // (the historical omission behavior), where `bindRelation` refuses; with a
  // `.name()` matching none, this view answers undefined.
  const resolved = resolveOrdinaryInverse(
    state.getter() as AnyModel,
    sourceModel,
    state.name
  );
  if (resolved.kind === "ordinary") {
    return resolved.fields as GetInverseRelationMap<S, TSourceModel>;
  }
  if (resolved.kind === "ambiguous" && !state.name) {
    return resolved.candidates[0]?.fields as GetInverseRelationMap<
      S,
      TSourceModel
    >;
  }
  return undefined as GetInverseRelationMap<S, TSourceModel>;
}
