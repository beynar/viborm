/** Declaration-only schema identity: one resolved key table, no runtime state. */
import type { Model } from "@schema/model";
import type {
  AnyRelation,
  ModelToManyState,
  ModelToOneState,
  RelationState,
  VariantToManyState,
  VariantToOneState,
} from "@schema/relation";
import type {
  VariantToManyRelation,
  VariantToOneRelation,
} from "@schema/relation/polymorphic";
import type { ModelToManyRelation } from "@schema/relation/to-many";
import type { ModelToOneRelation } from "@schema/relation/to-one";
import type { ObjectSchema } from "@validation/primitives/object";
import type { VibORMConfig } from "./client";
import type { Schema } from "./types";

export interface Links<L> {
  readonly " vibLinks"?: L;
}

// Equality compares the supplied models; inferring them again can recursively
// traverse identical getter graphs and overflow the TS5.8 compiler stack.
type IsIdentical<A, B> =
  (<T>() => T extends NoInfer<A> ? 1 : 2) extends <T>() => T extends NoInfer<B>
    ? 1
    : 2
    ? true
    : false;
// A necessary field-name projection rejects mismatches before comparing the full
// model. Following singular slots alone avoids expanding both sides of a chain;
// matching projections never establish identity. Bidirectional assignability
// is sufficient for this negative filter; full model equality decides matches.
type SingularFieldTree<M> = M extends {
  readonly "~": { readonly state: { readonly shape: infer Fields } };
}
  ? {
      [F in keyof Fields]: Fields[F] extends {
        readonly "~": {
          readonly state: {
            readonly cardinality: "one";
            readonly target: infer Target;
          };
        };
      }
        ? Target extends {
            readonly kind: "model";
            readonly getter: () => infer Next;
          }
          ? SingularFieldTree<Next>
          : Target extends {
                readonly kind: "variants";
                readonly entries: infer Entries;
              }
            ? {
                [V in keyof Entries]: Entries[V] extends {
                  readonly getter: () => infer Next;
                }
                  ? SingularFieldTree<Next>
                  : never;
              }
            : never
        : true;
    }
  : never;
// Each schema entry's projection is built once per schema. `Extract` filters
// those entries in one native pass, and only the survivors pay for the reverse
// projection test and full equality.
type TreeEntries<S> = {
  [J in keyof S]-?: [SingularFieldTree<S[J]>, J];
}[keyof S];
type SchemaKeyOf<S, T> =
  Extract<TreeEntries<S>, [SingularFieldTree<T>, unknown]> extends infer Hit
    ? Hit extends [infer Tree, infer J extends keyof S]
      ? [SingularFieldTree<T>] extends [Tree]
        ? IsIdentical<S[J], T> extends true
          ? J
          : never
        : never
      : never
    : never;
type TargetLinks<S, Target> = Target extends {
  readonly kind: "model";
  readonly getter: infer G;
}
  ? G extends () => infer M
    ? SchemaKeyOf<S, M>
    : never
  : Target extends {
        readonly kind: "variants";
        readonly entries: infer Entries;
      }
    ? {
        [V in keyof Entries]: Entries[V] extends { readonly getter: infer G }
          ? G extends () => infer M
            ? SchemaKeyOf<S, M>
            : never
          : never;
      }
    : never;

/** Resolve while the producer still owns the exact getter types. */
export type RelationLinks<S extends Schema> = {
  [K in keyof S]: {
    [R in keyof S[K]["~"]["state"]["relations"]]: TargetLinks<
      S,
      S[K]["~"]["state"]["relations"][R]["~"]["state"]["target"]
    >;
  };
};

type LinkAt<L, K, R> = K extends keyof L
  ? R extends keyof L[K]
    ? L[K][R]
    : never
  : never;
type VariantLink<T, V> = V extends keyof T ? T[V] : never;

/** Clone every state fact inline; no alias retains the original recursive shape. */
export type FlatSchema<S extends Schema, L> = {
  [K in keyof S]: S[K] extends Model<infer State>
    ? Model<{
        [P in keyof State]: P extends "shape" | "relations"
          ? {
              [F in keyof State[P]]: State[P][F] extends AnyRelation
                ? State[P][F]["~"]["state"] extends infer RS extends
                    RelationState
                  ? RS extends ModelToOneState
                    ? ModelToOneRelation<{
                        [Q in keyof RS]: Q extends "target"
                          ? {
                              [T in keyof RS[Q]]: T extends "getter"
                                ? [LinkAt<L, K, F>] extends [never]
                                  ? RS[Q][T]
                                  : unknown
                                : RS[Q][T];
                            }
                          : RS[Q];
                      }>
                    : RS extends ModelToManyState
                      ? ModelToManyRelation<{
                          [Q in keyof RS]: Q extends "target"
                            ? {
                                [T in keyof RS[Q]]: T extends "getter"
                                  ? [LinkAt<L, K, F>] extends [never]
                                    ? RS[Q][T]
                                    : unknown
                                  : RS[Q][T];
                              }
                            : RS[Q];
                        }>
                      : RS extends VariantToOneState
                        ? VariantToOneRelation<{
                            [Q in keyof RS]: Q extends "target"
                              ? RS[Q] extends {
                                  readonly entries: infer Entries;
                                }
                                ? {
                                    [T in keyof RS[Q]]: T extends "entries"
                                      ? {
                                          [V in keyof Entries]: {
                                            [E in keyof Entries[V]]: E extends "getter"
                                              ? [
                                                  VariantLink<
                                                    LinkAt<L, K, F>,
                                                    V
                                                  >,
                                                ] extends [never]
                                                ? Entries[V][E]
                                                : unknown
                                              : Entries[V][E];
                                          };
                                        }
                                      : RS[Q][T];
                                  }
                                : RS[Q]
                              : RS[Q];
                          }>
                        : RS extends VariantToManyState
                          ? VariantToManyRelation<{
                              [Q in keyof RS]: Q extends "target"
                                ? RS[Q] extends {
                                    readonly entries: infer Entries;
                                  }
                                  ? {
                                      [T in keyof RS[Q]]: T extends "entries"
                                        ? {
                                            [V in keyof Entries]: {
                                              [E in keyof Entries[V]]: E extends "getter"
                                                ? [
                                                    VariantLink<
                                                      LinkAt<L, K, F>,
                                                      V
                                                    >,
                                                  ] extends [never]
                                                  ? Entries[V][E]
                                                  : unknown
                                                : Entries[V][E];
                                            };
                                          }
                                        : RS[Q][T];
                                    }
                                  : RS[Q]
                                : RS[Q];
                            }>
                          : State[P][F]
                  : State[P][F]
                : State[P][F];
            }
          : P extends "scalars" | "uniques"
            ? { [F in keyof State[P]]: State[P][F] }
            : P extends "compoundId" | "compoundUniques"
              ? State[P] extends infer Constraints extends State[P]
                ? Constraints extends object
                  ? {
                      [F in keyof Constraints]: Constraints[F] extends ObjectSchema<
                        infer Entries,
                        infer Options,
                        infer Input,
                        infer Output
                      >
                        ? ObjectSchema<
                            { [E in keyof Entries]: Entries[E] },
                            Options,
                            Input extends object
                              ? { [E in keyof Input]: Input[E] }
                              : Input,
                            Output extends object
                              ? { [E in keyof Output]: Output[E] }
                              : Output
                          >
                        : Constraints[F];
                    }
                  : Constraints
                : never
              : State[P];
      }>
    : never;
};

/** One linked target; a union of twin keys answers a union of targets. */
type LinkedTarget<S extends Schema, L, J> = J extends keyof S
  ? Linked<S, L, J>
  : never;

// A getter the flat view kept is an unlinked target and stays as it was. A
// model target's erased getter is relinked behind a function return type, so
// its link is resolved only when something follows the slot: comparing a hub
// model's state, or reading its slot names, no longer resolves every link it
// holds. Variant members keep their eager links: resolved inside the member
// mapping, every member's getter answered the union of all member targets.
type RepointTarget<Target, S extends Schema, L, K, F> = Target extends {
  readonly kind: "model";
}
  ? {
      [P in keyof Target]: P extends "getter"
        ? Target[P] extends () => unknown
          ? Target[P]
          : () => LinkedTarget<S, L, LinkAt<L, K, F>>
        : Target[P];
    }
  : Target extends {
        readonly kind: "variants";
        readonly entries: infer Entries;
      }
    ? RepointVariants<Target, Entries, LinkAt<L, K, F>, S, L>
    : Target;

type RepointVariants<Target, Entries, Link, S extends Schema, L> = {
  [P in keyof Target]: P extends "entries"
    ? {
        [V in keyof Entries]: {
          [E in keyof Entries[V]]: E extends "getter"
            ? VariantLink<Link, V> extends infer J
              ? [J] extends [never]
                ? Entries[V][E]
                : J extends keyof S
                  ? () => Linked<S, L, J>
                  : Entries[V][E]
              : Entries[V][E]
            : Entries[V][E];
        };
      }
    : Target[P];
};

type RepointState<State, S extends Schema, L, K, F> = {
  [P in keyof State]: P extends "target"
    ? RepointTarget<State[P], S, L, K, F>
    : State[P];
};
// The arms are told apart by cardinality and target kind alone: matching the
// full declaration states would resolve each slot's link to compare getters.
type LinkedRelation<R, S extends Schema, L, K, F> = R extends {
  readonly "~": { readonly state: infer State };
}
  ? State extends SlotKind<"one", "model">
    ? ModelToOneRelation<RepointState<State, S, L, K, F>>
    : State extends SlotKind<"many", "model">
      ? ModelToManyRelation<RepointState<State, S, L, K, F>>
      : State extends SlotKind<"one", "variants">
        ? VariantToOneRelation<RepointState<State, S, L, K, F>>
        : State extends SlotKind<"many", "variants">
          ? VariantToManyRelation<RepointState<State, S, L, K, F>>
          : R
  : R;
type SlotKind<Cardinality, Kind> = {
  readonly kind: "relation";
  readonly cardinality: Cardinality;
  readonly target: { readonly kind: Kind };
};

/** Relinking operates only on the already-flat schema and its literal links. */
type LinkedState<S extends Schema, L, K extends keyof S> = S[K] extends Model<
  infer State
>
  ? {
      [P in keyof State]: P extends "shape" | "relations"
        ? {
            [F in keyof State[P]]: LinkedRelation<State[P][F], S, L, K, F>;
          }
        : State[P];
    }
  : never;

export type Linked<S extends Schema, L, K extends keyof S> = Model<
  LinkedState<S, L, K>
>;

type SchemaRelationKeys<S extends Schema> = {
  [K in keyof S]: keyof S[K]["~"]["state"]["relations"];
}[keyof S];

/** Only a finite schema with relations has getter facts to carry. */
type SchemaLinks<S extends Schema> = string extends keyof S
  ? never
  : [SchemaRelationKeys<S>] extends [never]
    ? never
    : // Re-mapped once so emitted declarations print the literal table, not
      // `RelationLinks` over the original recursive models.
      RelationLinks<S> extends infer U
      ? { [K in keyof U]: U[K] }
      : never;

type SchemaSnapshot<S extends Schema, L> = {
  [K in keyof S]: [L] extends [never] ? S[K] : FlatSchema<S, L>[K];
};

type SchemaModel<S extends Schema, L, K extends keyof S> = [L] extends [
  undefined,
]
  ? S[K]
  : Linked<S, L, K>;

/** The existing declaration links, for consumers walking named schema slots. */
export type ClientRelationLinks<C extends VibORMConfig> =
  " vibLinks" extends keyof C
    ? C extends Links<infer L>
      ? L
      : never
    : SchemaLinks<C["schema"]>;

/** Raw aliases and carried configs share the same schema-only model view. */
export type ClientSchema<C extends VibORMConfig> = {
  [K in keyof C["schema"]]: " vibLinks" extends keyof C
    ? C extends Links<infer L>
      ? SchemaModel<C["schema"], L, K>
      : C["schema"][K]
    : SchemaModel<
        SchemaSnapshot<C["schema"], SchemaLinks<C["schema"]>>,
        SchemaLinks<C["schema"]>,
        K
      >;
};

/** Driver and other config facts do not participate in schema projection. */
export type LinkedClientConfig<C extends VibORMConfig, L = undefined> = {
  [P in keyof C]: P extends "schema"
    ? SchemaSnapshot<
        C["schema"],
        L extends undefined ? SchemaLinks<C["schema"]> : L
      >
    : C[P];
} & Links<L extends undefined ? SchemaLinks<C["schema"]> : L>;
