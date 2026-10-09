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
type SchemaKeyOf<S, T> = {
  [J in keyof S]-?: [SingularFieldTree<S[J]>] extends [SingularFieldTree<T>]
    ? [SingularFieldTree<T>] extends [SingularFieldTree<S[J]>]
      ? IsIdentical<S[J], T> extends true
        ? J
        : never
      : never
    : never;
}[keyof S];
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
} extends infer U
  ? { [K in keyof U]: U[K] }
  : never;

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
                          ? [LinkAt<L, K, F>] extends [never]
                            ? RS[Q]
                            : {
                                [T in keyof RS[Q]]: T extends "getter"
                                  ? unknown
                                  : RS[Q][T];
                              }
                          : RS[Q];
                      }>
                    : RS extends ModelToManyState
                      ? ModelToManyRelation<{
                          [Q in keyof RS]: Q extends "target"
                            ? [LinkAt<L, K, F>] extends [never]
                              ? RS[Q]
                              : {
                                  [T in keyof RS[Q]]: T extends "getter"
                                    ? unknown
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

type RepointTarget<Target, Link, S extends Schema, L> = Target extends {
  readonly kind: "model";
}
  ? [Link] extends [never]
    ? Target
    : Link extends keyof S
      ? {
          [P in keyof Target]: P extends "getter"
            ? () => Linked<S, L, Link>
            : Target[P];
        }
      : Target
  : Target extends {
        readonly kind: "variants";
        readonly entries: infer Entries;
      }
    ? {
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
      }
    : Target;

type RepointState<State, Link, S extends Schema, L> = {
  [P in keyof State]: P extends "target"
    ? RepointTarget<State[P], Link, S, L>
    : State[P];
};
type LinkedRelation<R, Link, S extends Schema, L> = R extends AnyRelation
  ? R["~"]["state"] extends infer State extends RelationState
    ? State extends ModelToOneState
      ? ModelToOneRelation<RepointState<State, Link, S, L>>
      : State extends ModelToManyState
        ? ModelToManyRelation<RepointState<State, Link, S, L>>
        : State extends VariantToOneState
          ? VariantToOneRelation<RepointState<State, Link, S, L>>
          : State extends VariantToManyState
            ? VariantToManyRelation<RepointState<State, Link, S, L>>
            : R
    : R
  : R;

/** Relinking operates only on the already-flat schema and resolved literal links. */
type LinkedState<S extends Schema, L, K extends keyof S> = S[K] extends Model<
  infer State
>
  ? {
      [P in keyof State]: P extends "shape" | "relations"
        ? {
            [F in keyof State[P]]: LinkedRelation<
              State[P][F],
              LinkAt<L, K, F>,
              S,
              L
            >;
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
    : RelationLinks<S>;

type SchemaSnapshot<S extends Schema, L> = {
  [K in keyof S]: [L] extends [never] ? S[K] : FlatSchema<S, L>[K];
};

type SchemaModel<S extends Schema, L, K extends keyof S> = [L] extends [
  undefined,
]
  ? S[K]
  : Linked<S, L, K>;

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
