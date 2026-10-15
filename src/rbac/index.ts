// viborm/rbac: one predicate per (model, action), judged in the statement
// (docs/architecture/rbac-extension-plan.md). An ordinary definition built
// from public capabilities only.
//
// This file is the entry: `rbac(config)` checks the actor schema at once and
// compiles the policy against the schema it governs. The policy's types are
// opaque predicates (never a model's `where` type: the 1.2.0 TS2589 lesson);
// what the types check is the declaration's names: models, fields and actions
// against the schema and each other, actor paths against the actor schema.

import type { VibORMConfig } from "../index";
import type { InferOutput } from "../validation";
import { type ActorPaths, actorPaths } from "./actor";
import { type CompiledPolicy, compilePolicy, type RbacConfig } from "./compile";
import type { KeyLimit } from "./helpers";

export type { ActorPaths } from "./actor";
export type {
  CompiledModel,
  CompiledPolicy,
  ModelPolicy,
  RbacConfig,
} from "./compile";
export type {
  Ceiling,
  GrantShape,
  KeyLimit,
  MemberOptions,
  PolicyModel,
  Rule,
  Where,
} from "./helpers";
export {
  everyone,
  grant,
  keyLimit,
  member,
  notBanned,
  owner,
  role,
  session,
  team,
  up,
} from "./helpers";

type Schema = VibORMConfig["schema"];

// =============================================================================
// ACTIONS: what each model declares, and the names that must be among them
// =============================================================================

type Reserved =
  | "within"
  | "arms"
  | "actions"
  | "create"
  | "operations"
  | "fields"
  | "domains";

type Levels<Config> = Config extends { readonly levels: infer L }
  ? L extends readonly (infer Level extends string)[]
    ? Level
    : never
  : never;

/** A model's actions: its own map or the levels, and every rule key (D3). */
type ActionsOf<M, L extends string> =
  | (M extends { readonly actions: infer A } ? keyof A & string : L)
  | Exclude<keyof M & string, Reserved>;

type Values<T> = T extends object ? T[keyof T] : never;
type NamedActions<M> =
  | Values<M extends { readonly operations: infer O } ? O : never>
  | Values<
      M extends { readonly fields: infer F }
        ? { [K in keyof F]: Values<F[K]> }
        : never
    >
  | (M extends { readonly actions: infer A }
      ? Values<{
          [K in keyof A]: A[K] extends readonly (infer N)[] ? N : never;
        }>
      : never);

type UnknownActions<Config extends RbacConfig> = {
  [K in keyof Config["models"] & string]: Exclude<
    NamedActions<Config["models"][K]>,
    ActionsOf<Config["models"][K], Levels<Config>> | undefined
  > extends infer Unknown extends string
    ? [Unknown] extends [never]
      ? never
      : `${K}: ${Unknown}`
    : never;
}[keyof Config["models"] & string];

// =============================================================================
// ACTOR PATHS: the ones the declaration spells, against the actor schema
// =============================================================================

/** Required keys only: an optional key belongs to a payload type, never walked. */
type RequiredKeys<T> = {
  [K in keyof T]-?: Record<never, never> extends Pick<T, K> ? never : K;
}[keyof T];

/**
 * The actor paths a declaration spells: `{ actor: "path" }` values and
 * `{ actor: { path: value } }` conditions, found by a walk over the
 * declaration's literal (functions and helper results are opaque).
 */
type SpelledActorPaths<T> = T extends readonly (infer Item)[]
  ? SpelledActorPaths<Item>
  : T extends (...args: never[]) => unknown
    ? never
    : T extends object
      ? string extends keyof T
        ? never
        : {
            [K in RequiredKeys<T> & string]: K extends "actor"
              ? T[K] extends string
                ? T[K]
                : ConditionPaths<T[K]>
              : SpelledActorPaths<T[K]>;
          }[RequiredKeys<T> & string]
      : never;

type ConditionPaths<T> = T extends object
  ? string extends keyof T
    ? never
    : {
        [K in RequiredKeys<T> & string]: T[K] extends object
          ? K | `${K}.${ConditionPaths<T[K]>}`
          : K;
      }[RequiredKeys<T> & string]
  : never;

type LimitPaths<Limit> = Limit extends { readonly "~limit"?: infer L }
  ? L extends KeyLimit
    ?
        | L["when"]
        | L["scopes"]
        | Values<{
            [K in keyof L["ids"]]: L["ids"][K] extends {
              readonly path: infer P;
            }
              ? P
              : never;
          }>
    : never
  : never;

type UnknownActorPaths<Config extends RbacConfig> = Exclude<
  SpelledActorPaths<Config["models"]> | LimitPaths<Config["limit"]>,
  ActorPaths<InferOutput<Config["actor"]>>
>;

/** `unknown` when the declaration's names agree; else a member naming the first disagreement. */
type DeclarationCheck<Config extends RbacConfig> = [
  UnknownActorPaths<Config>,
] extends [never]
  ? [UnknownActions<Config>] extends [never]
    ? unknown
    : { readonly "undeclared action": UnknownActions<Config> }
  : { readonly "unknown actor path": UnknownActorPaths<Config> };

// =============================================================================
// SCHEMA: the model and field names the declaration spells
// =============================================================================

type ScalarsOf<M> = M extends {
  readonly "~": { readonly state: { readonly scalars: infer S } };
}
  ? keyof S
  : never;
type RelationsOf<M> = M extends {
  readonly "~": { readonly state: { readonly relations: infer R } };
}
  ? keyof R
  : never;
type CreateKeys<M> = M extends { readonly create: infer C }
  ? C extends (...args: never[]) => unknown
    ? never
    : keyof C
  : never;

type UnknownFields<S extends Schema, Config extends RbacConfig> = {
  [K in keyof Config["models"] & keyof S & string]: Exclude<
    | (Config["models"][K] extends { readonly fields: infer F }
        ? keyof F
        : never)
    | CreateKeys<Config["models"][K]>,
    ScalarsOf<S[K]> | RelationsOf<S[K]> | "AND" | "OR" | "NOT" | "actor" | "$if"
  > extends infer Unknown extends string
    ? [Unknown] extends [never]
      ? never
      : `${K}.${Unknown}`
    : never;
}[keyof Config["models"] & keyof S & string];

/** `unknown` when every model and field the declaration names is in the schema. */
type SchemaCheck<S extends Schema, Config extends RbacConfig> = [
  Exclude<keyof Config["models"], keyof S>,
] extends [never]
  ? [UnknownFields<S, Config>] extends [never]
    ? unknown
    : { readonly "unknown field": UnknownFields<S, Config> }
  : { readonly "unknown model": Exclude<keyof Config["models"], keyof S> };

// =============================================================================
// THE ENTRY
// =============================================================================

export interface Policy<Config extends RbacConfig> {
  readonly config: Config;
  /**
   * The policy compiled against the schema it governs (R1, plain data): per
   * model, its named predicates and the verbs, written fields, read-gated
   * fields, modes and placement that take them. Refusals are
   * `ClientInitializationError`s naming the declaration's path.
   */
  compile<S extends Schema>(schema: S & SchemaCheck<S, Config>): CompiledPolicy;
}

/**
 * One permission model: per model, a rule per action (`view`, `edit`, …),
 * `within` and the policy's `limit` conjoined with every action, `arms`
 * disjoined at every action. The actor schema is checked here, once.
 */
export function rbac<const Config extends RbacConfig>(
  config: Config & DeclarationCheck<Config>
): Policy<Config> {
  const hasPath = actorPaths(config.actor);
  return Object.freeze({
    config,
    compile: (schema: Schema) => compilePolicy(config, schema, hasPath),
  });
}
