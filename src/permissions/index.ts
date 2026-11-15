// viborm/permissions: one predicate per (model, action), judged in the statement
// (docs/architecture/rbac-extension-plan.md). An ordinary definition applied
// through public capabilities; compiling it reads the schema's declarations
// through the internal `["~"]` accessors.
//
// This file is the entry: `permissions(config)` checks the actor schema at once and
// compiles the policy against the schema it governs. The policy's types are
// opaque predicates (never a model's `where` type: the 1.2.0 TS2589 lesson);
// what the types check is the declaration's names: models, fields and actions
// against the schema and each other, actor paths against the actor schema.

import type { Operations } from "../client/exports";
import { ForbiddenError } from "../errors";
import { args, bound, oneOf } from "../extensions/args";
import { call } from "../extensions/call";
import { within } from "../extensions/confine";
import { extension } from "../extensions/extension";
import { lazy } from "../extensions/judge-words";
import { methods } from "../extensions/methods-part";
import { models as everyOperation, selecting, target } from "../extensions/on";
import { rule } from "../extensions/rule";
import type {
  AnyTarget,
  ClientSchema,
  EmptyFacts,
  Extension,
  Facts,
  PlacedArgument,
  Target,
  VibORMConfig,
} from "../index";
import type { InferOutput } from "../validation";
import { type ActorFacts, type ActorPaths, actorContract } from "./actor";
import {
  type CompiledPolicy,
  compilePolicy,
  DEFAULT_MODE,
  type EVIDENCE_KEY,
  MODE,
  type ModelPolicy,
  type PermissionsConfig,
  type PolicyCompiler,
  policyArguments,
  policyCompiler,
} from "./compile";
import type { PolicyModel, Where } from "./rules";

export type { ActorFacts, ActorPaths } from "./actor";
export type {
  CompiledModel,
  CompiledPolicy,
  ModelPolicy,
  PermissionsConfig,
} from "./compile";
export type { PolicyModel, Rule, Where } from "./rules";

type Schema = VibORMConfig["schema"];

// =============================================================================
// ACTIONS: what each model declares, and the names that must be among them
// =============================================================================

type Reserved = "mandatory" | "actions" | "operations" | "fields" | "domains";
/** A model's actions when it declares no `actions` graph. */
type Crud = "create" | "read" | "update" | "delete";

type RuleKeys<M> = Exclude<keyof M & string, Reserved>;
type Space = " " | "\t" | "\r" | "\n";
type Trim<S extends string> = S extends `${Space}${infer Rest}`
  ? Trim<Rest>
  : S extends `${infer Rest}${Space}`
    ? Trim<Rest>
    : S;
type SplitActions<S extends string> = S extends `${infer Head},${infer Tail}`
  ? Trim<Head> | SplitActions<Trim<Tail>>
  : S;

/** Groups contribute their individual actions, never a combined action name. */
type DeclaredActions<M> =
  | (M extends { readonly actions: infer A } ? keyof A & string : never)
  | SplitActions<RuleKeys<M>>;
type ActionsOf<M> =
  | DeclaredActions<M>
  | (Extract<DeclaredActions<M>, "update" | "delete"> extends never
      ? never
      : "read");

type InvalidGroup<
  S extends string,
  Seen extends string = never,
> = S extends `${infer Head},${infer Tail}`
  ? Trim<Head> extends "" | Reserved | "within" | "arms" | Seen
    ? S
    : InvalidGroup<Trim<Tail>, Seen | Trim<Head>>
  : [Seen] extends [never]
    ? never
    : S extends "" | Reserved | "within" | "arms" | Seen
      ? S
      : never;

type InvalidRuleKeys<M> = {
  [K in RuleKeys<M>]:
    | ([InvalidGroup<K>] extends [never] ? never : K)
    | ([
        Extract<SplitActions<K>, SplitActions<Exclude<RuleKeys<M>, K>>>,
      ] extends [never]
        ? never
        : K);
}[RuleKeys<M>];
type InvalidActionName<S> = S extends string
  ? S extends `${string},${string}` | "within" | "arms"
    ? S
    : never
  : never;

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

/**
 * Retired declaration keys, and rules absent from the model's action list:
 * its explicit graph, else create, read, update and delete. A declaration
 * still widened to its constraint (while a callback in it is inferred) has
 * no keys of its own to check.
 */
type UnlistedKeys<M> =
  | Extract<RuleKeys<M>, "within" | "arms">
  | InvalidRuleKeys<M>
  | (M extends { readonly actions: infer A }
      ?
          | InvalidActionName<keyof A>
          | Exclude<SplitActions<RuleKeys<M>>, keyof A & string>
      : string extends RuleKeys<M>
        ? never
        : Exclude<SplitActions<RuleKeys<M>>, Crud>);

type UnknownActions<Config extends PermissionsConfig> = {
  [K in keyof Config["models"] & string]: Exclude<
    NamedActions<Config["models"][K]> | UnlistedKeys<Config["models"][K]>,
    | Exclude<ActionsOf<Config["models"][K]>, UnlistedKeys<Config["models"][K]>>
    | undefined
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
 * declaration's literal (functions and widened predicates are opaque).
 */
type SpelledActorPaths<T> = T extends readonly (infer Item)[]
  ? SpelledActorPaths<Item>
  : T extends (...args: never[]) => unknown
    ? never
    : T extends object
      ? string extends keyof T
        ? never
        :
            | ControlPath<T>
            | {
                [K in RequiredKeys<T> & string]: K extends "actor"
                  ? T[K] extends string
                    ? T[K]
                    : ConditionPaths<T[K]>
                  : SpelledActorPaths<T[K]>;
              }[RequiredKeys<T> & string]
      : never;

/** Explicit actor parameters and `$if` conditions use the same path vocabulary. */
type ControlPath<T> = T extends {
  readonly control: "actor";
  readonly path: infer Path extends string;
}
  ? Path
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

type TenantActorPath<Config> = Config extends {
  readonly tenant: { readonly actor: infer Path extends string };
}
  ? Path
  : never;
type UnknownActorPaths<Config extends PermissionsConfig> = Exclude<
  | SpelledActorPaths<Config["models"] | Config["mandatory"]>
  | TenantActorPath<Config>,
  ActorPaths<InferOutput<Config["actor"]>>
>;

type ConfigKey = "actor" | "mandatory" | "models" | "cache" | "tenant";

/** `unknown` when the declaration's names agree; else a member naming the first disagreement. */
type DeclarationCheck<Config extends PermissionsConfig> = [
  Exclude<keyof Config, ConfigKey>,
] extends [never]
  ? ActorAndActionCheck<Config>
  : { readonly "unknown policy key": Exclude<keyof Config, ConfigKey> };

type ActorAndActionCheck<Config extends PermissionsConfig> = [
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
  ? C extends boolean | ((...args: never[]) => unknown)
    ? never
    : keyof C
  : never;

type UnknownFields<
  S extends Schema,
  Models extends PermissionsConfig["models"],
> = {
  [K in keyof Models & keyof S & string]: Exclude<
    | (Models[K] extends { readonly fields: infer F } ? keyof F : never)
    | CreateKeys<Models[K]>,
    | ScalarsOf<S[K]>
    | RelationsOf<S[K]>
    | "AND"
    | "OR"
    | "NOT"
    | "actor"
    | "$if"
    | "$exists"
  > extends infer Unknown extends string
    ? [Unknown] extends [never]
      ? never
      : `${K}.${Unknown}`
    : never;
}[keyof Models & keyof S & string];

/** `unknown` when every model and field the declaration names is in the schema. */
type SchemaCheck<
  S extends Schema,
  Models extends PermissionsConfig["models"],
> = string extends keyof S
  ? unknown
  : [Exclude<keyof Models, keyof S>] extends [never]
    ? [UnknownFields<S, Models>] extends [never]
      ? unknown
      : { readonly "unknown field": UnknownFields<S, Models> }
    : { readonly "unknown model": Exclude<keyof Models, keyof S> };

// =============================================================================
// THE ENTRY: one extension (plan §1.1; K7(b))
// =============================================================================

const NAME = "viborm.permissions";

type Listed<Config extends PermissionsConfig> = keyof Config["models"] & string;
type ActionOf<
  Config extends PermissionsConfig,
  K extends Listed<Config>,
> = ActionsOf<Config["models"][K]>;
type DomainsOf<M> = M extends { readonly domains: infer D }
  ? keyof D & string
  : never;
/** Every `as` value: the default, and each listed model's actions and domains. */
type ModeOf<Config extends PermissionsConfig> =
  | typeof DEFAULT_MODE
  | {
      [K in Listed<Config>]:
        | ActionOf<Config, K>
        | DomainsOf<Config["models"][K]>;
    }[Listed<Config>];

/**
 * `$as`, declared apart (inline, the factory's contextual type makes `Self`
 * void) as a type, not an interface, so it is a method record.
 */
type ScopeOf<Config extends PermissionsConfig> = {
  [K in Listed<Config>]: `${K}.${ActionOf<Config, K>}`;
}[Listed<Config>];

type AsMethod<Actor, Scope extends string = string> = {
  /**
   * This client with the actor bound (K6): every call of the view is judged
   * for it. Validated once, here, against the policy's actor schema.
   */
  $as<Self>(this: Self, actor: Actor, scopes?: readonly Scope[]): Self;
};

/** The fields a model's declaration read-gates (D5). */
type GatedOf<M> = M extends { readonly fields: infer F }
  ? {
      [K in keyof F]: F[K] extends { readonly read: string } ? K : never;
    }[keyof F] &
      string
  : never;

/**
 * What the types read of a listed model's `rows.verbs` entry: its
 * projection key and its actions (K5's projected overloads), and its
 * read-gated fields (the gated default omit). The predicates stay opaque.
 */
type ModelVerbs<Config extends PermissionsConfig, K extends Listed<Config>> = {
  readonly predicates: {
    readonly [name: string]: { readonly [field: string]: unknown };
  };
} & ([ActionOf<Config, K>] extends [never]
  ? unknown
  : {
      readonly evidence: {
        readonly as: typeof EVIDENCE_KEY;
        readonly names: readonly ActionOf<Config, K>[];
      };
    }) &
  ([GatedOf<Config["models"][K]>] extends [never]
    ? unknown
    : {
        readonly reads: {
          readonly [F in GatedOf<Config["models"][K]>]: string;
        };
      });

/**
 * The policy's arguments as the delegates read them: its mode, on every
 * operation that selects rows. `actor` and `scopes` are bound: no call
 * passes them.
 */
type PolicyArguments<Config extends PermissionsConfig> = {
  readonly [MODE]: PlacedArgument<
    ModeOf<Config>,
    PropertyKey,
    Exclude<Operations, "create" | "createMany">
  >;
};

/**
 * What applying the policy adds: its arguments, every model of the client
 * governed (a to-one relation reads `| null`), the projection key and the
 * read-gated fields of each listed model, and `$as`.
 */
type PermissionsFacts<
  T extends AnyTarget,
  Config extends PermissionsConfig,
> = Facts<
  AsMethod<ActorFacts<InferOutput<Config["actor"]>>, ScopeOf<Config>>,
  Record<never, never>,
  PolicyArguments<Config>,
  keyof ClientSchema<T["config"]> & string,
  never,
  Record<never, never>,
  Record<never, never>,
  false,
  false,
  { readonly [K in Listed<Config>]: ModelVerbs<Config, K> }
>;

export interface Policy<Config extends PermissionsConfig> {
  readonly config: Config;
  /**
   * The policy compiled against the schema it governs (R1): per model, the
   * rule entry the extension applies, and each credential scope with the
   * scopes it implies. Refusals are `ClientInitializationError`s naming the
   * declaration's path. Public for inspection.
   */
  compile<S extends Schema>(
    schema: S & SchemaCheck<S, Config["models"]>
  ): CompiledPolicy;
}

const READS = /^(find|count|aggregate|groupBy|exist)/;
const CREATES = /^create/;
const UPDATES = /^update/;

/**
 * The action a root operation needs its model to grant (R9, K4), named by
 * its family; an operation of no other family deletes. An upsert is not asked
 * here: each of its arms is judged where it runs, the update where it locates
 * its row and the create in its statement.
 */
const actionOf = (operation: string) =>
  READS.test(operation)
    ? "read"
    : CREATES.test(operation)
      ? "create"
      : UPDATES.test(operation)
        ? "update"
        : "delete";

/**
 * Every model's modes, alike in name (one argument): the default and the
 * model's read action narrow nothing (`read` already ANDs with every mode,
 * K3); another of its actions or domains narrows by its predicate (R8); a
 * mode it does not declare holds nothing, and a root call naming it is
 * refused before it runs (R9).
 */
interface ScopeValues {
  readonly unrestricted: boolean;
  readonly allowed: readonly string[];
}
export interface ScopeSchema {
  readonly "~standard": {
    readonly version: 1;
    readonly vendor: string;
    readonly types?: {
      readonly input: readonly string[] | undefined;
      readonly output: ScopeValues;
    };
    validate(
      input: unknown
    ):
      | { readonly value: ScopeValues }
      | { readonly issues: readonly { readonly message: string }[] };
  };
}

/** Admit the credential once at binding, using the compiler's action closure. */
function scopeSchema(
  implications: Readonly<Record<string, readonly string[]>>
): ScopeSchema {
  return {
    "~standard": {
      version: 1,
      vendor: NAME,
      validate(input) {
        if (input === undefined)
          return { value: { unrestricted: true, allowed: [] } };
        if (!Array.isArray(input))
          return {
            issues: [
              { message: "Scopes must be an array of model.permission names" },
            ],
          };
        const allowed = new Set<string>();
        for (const scope of input) {
          if (typeof scope !== "string" || !Object.hasOwn(implications, scope))
            return {
              issues: [
                {
                  message: `Unknown permission scope: ${typeof scope === "string" ? scope : "expected a string"}`,
                },
              ],
            };
          for (const implied of implications[scope]!) allowed.add(implied);
        }
        return { value: { unrestricted: false, allowed: [...allowed] } };
      },
    },
  };
}

/** No client: what an extension written apart from one is built against. */
type Untyped = Target<
  VibORMConfig<Record<never, never>>,
  AnyTarget["state"],
  EmptyFacts
>;

/** Declaration context is field names, not the recursive operation payload. */
type PolicyValue<Actor> =
  | string
  | number
  | bigint
  | boolean
  | null
  | Date
  | object
  | {
      readonly actor?: ActorPaths<InferOutput<Actor>>;
      readonly [key: string]: PolicyValue<Actor> | undefined;
    };

type ModelRelations<Model> = Model extends {
  readonly "~": { readonly state: { readonly relations: infer Relations } };
}
  ? Relations
  : never;

type ContextualRelation<
  Relation,
  Actor,
  Dynamic extends boolean = true,
> = Relation extends {
  readonly "~": {
    readonly state: {
      readonly target: { readonly getter: () => infer Target };
    };
  };
}
  ?
      | string
      | (ContextualWhere<Target, Actor, Dynamic> & {
          readonly is?: ContextualRule<Target, Actor, Dynamic> | null;
          readonly isNot?: ContextualRule<Target, Actor, Dynamic> | null;
          readonly some?: ContextualRule<Target, Actor, Dynamic>;
          readonly every?: ContextualRule<Target, Actor, Dynamic>;
          readonly none?: ContextualRule<Target, Actor, Dynamic>;
        })
  : Where | string;

type ContextualWhere<Model, Actor, Dynamic extends boolean = true> = Where & {
  readonly [Field in ScalarsOf<Model>]?: PolicyValue<Actor>;
} & {
  readonly [Relation in keyof ModelRelations<Model>]?: ContextualRelation<
    ModelRelations<Model>[Relation],
    Actor,
    Dynamic
  >;
} & ("actor" extends ScalarsOf<Model> | RelationsOf<Model>
    ? unknown
    : {
        readonly actor?: {
          readonly [Path in ActorPaths<InferOutput<Actor>>]?: unknown;
        };
      }) & {
    readonly AND?:
      | ContextualRule<Model, Actor, Dynamic>
      | readonly ContextualRule<Model, Actor, Dynamic>[];
    readonly OR?: readonly ContextualRule<Model, Actor, Dynamic>[];
    readonly NOT?:
      | ContextualRule<Model, Actor, Dynamic>
      | readonly ContextualRule<Model, Actor, Dynamic>[];
  };

type ContextualRule<Model, Actor, Dynamic extends boolean = true> =
  | boolean
  | ContextualWhere<Model, Actor, Dynamic>
  | (Dynamic extends true
      ? (
          action: string,
          model: PolicyModel
        ) => ContextualRule<Model, Actor, Dynamic>
      : never);

/** Complete only the edited prefix, without enumerating action permutations. */
type GroupSuggestions<
  Key extends string,
  Actions extends string,
> = Key extends `${infer Head},${infer Tail}`
  ? Tail extends `${string},${string}`
    ? `${Head},${GroupSuggestions<Tail, Exclude<Actions, Trim<Head>>>}`
    : `${Head},${Tail extends ` ${string}` ? " " : ""}${Exclude<Actions, Trim<Head>>}`
  : never;
type SuggestedRules<M> =
  | Crud
  | ActionsOf<M>
  | GroupSuggestions<RuleKeys<M>, ActionsOf<M>>;

type ContextualPolicy<
  C extends VibORMConfig,
  Actor,
  Config extends PermissionsConfig,
> = string extends keyof C["schema"]
  ? unknown
  : {
      readonly actor: Actor;
      readonly models: {
        readonly [Model in keyof ClientSchema<C>]?: {
          readonly [Key in Reserved]?: Key extends "mandatory"
            ? ContextualWhere<ClientSchema<C>[Model], Actor, false>
            : ModelPolicy[Key];
        } & {
          readonly [Action in SuggestedRules<
            Model extends keyof Config["models"]
              ? Config["models"][Model]
              : never
          >]?: ContextualRule<ClientSchema<C>[Model], Actor>;
        } & {
          readonly [Action: string]:
            | ContextualRule<ClientSchema<C>[Model], Actor>
            | undefined;
        };
      };
    };

/**
 * The policy as one extension: `client.$extends(permissions({ actor, models
 * }))`. Model names are inferred from keys independently of callback bodies,
 * so schema admission does not force a context-sensitive Config to its broad
 * constraint; the receiving `$extends` supplies the client before the inline
 * declaration is contextualized. Applied, every model of the client is
 * governed, and every call needs an actor: `db.$as(actor)`.
 */
export function permissions<
  T extends AnyTarget,
  const Actor extends object,
  const ModelNames extends string,
  const Config extends PermissionsConfig,
>(
  config: Config & {
    readonly actor: Actor;
    readonly models: Record<ModelNames, unknown>;
  } & ContextualPolicy<NoInfer<T["config"]>, NoInfer<Actor>, NoInfer<Config>> &
    DeclarationCheck<Config> &
    SchemaCheck<
      NoInfer<T["config"]["schema"]>,
      Pick<Config["models"], ModelNames>
    >
): Policy<Config> & Extension<T, PermissionsFacts<T, Config>>;
export function permissions<const Config extends PermissionsConfig>(
  config: Config & DeclarationCheck<Config>
): unknown {
  const actor = actorContract(config.actor);
  const compile = (schema: Schema) => compilePolicy(config, schema, actor);
  const { modes, scopes } = policyArguments(config);
  /** A bound argument: a read that carries it is never cached, but under `cache: "allow"`. */
  const held = (schema: Parameters<typeof bound>[0]) => {
    const value = bound(schema).required();
    return config.cache === "allow" ? value : value.volatile();
  };
  /**
   * What applying the policy to one schema made: what the declaration
   * names, checked once, and what a root call may reach. Each model
   * compiles the first time a call needs it, into one state every client of
   * the schema shares; a rule's own refusal comes at its model's first call.
   * Made by the first rule part, which the extension runs once per schema,
   * and again for a schema object that gained or swapped a model: a model
   * the policy lacks would be left open (R9).
   */
  const applied = new WeakMap<Schema, PolicyCompiler>();
  const governed = extension(
    NAME,
    // Every model of the schema, each read when a call first needs it.
    rule<Untyped, (schema: Schema) => object>((schema) => {
      const compiler = policyCompiler(config, { ...schema }, actor);
      applied.set(schema, compiler);
      return Object.fromEntries(
        Object.keys(compiler.declared).map((name) => [
          name,
          lazy(() => compiler.model(name).entry),
        ])
      );
    }),
    // The tenant the policy's own whole-table sets stay in (`tenant`).
    rule<Untyped, (schema: Schema) => object>((schema) =>
      Object.fromEntries(
        // The first rule part, declared before this one, applied the policy.
        Object.entries(applied.get(schema)!.declared).flatMap(
          ([name, model]) =>
            model.bound === undefined
              ? []
              : [[name, { confine: within(model.bound) }]]
        )
      )
    ),
    args({
      actor: held(actor.schema),
      scopes: held(scopeSchema(scopes)),
      [MODE]: oneOf(...modes)
        .default(DEFAULT_MODE)
        .on(selecting),
    }),
    // R9, D3: a call the policy cannot reach is refused before its
    // arguments are validated.
    call((c) => {
      // target(models) selects model calls only: each names its model.
      const model = c.model!;
      const at = applied.get(c.schema)?.declared[model];
      const verb = actionOf(c.operation);
      const mode: unknown = c.values[MODE];
      if (
        !(
          at &&
          Object.hasOwn(config.models, model) &&
          (c.operation === "upsert" ||
            (verb === "create"
              ? Object.hasOwn(at.modes, verb)
              : at[verb] !== undefined))
        ) ||
        (typeof mode === "string" &&
          mode !== DEFAULT_MODE &&
          !Object.hasOwn(at.modes, mode))
      )
        throw new ForbiddenError(model, c.operation);
    }, target(everyOperation)),
    methods(
      (scope: {
        $bind(values: Readonly<Record<string, unknown>>): unknown;
      }) => ({
        $as: (bound: unknown, scopes?: readonly string[]) =>
          scope.$bind({ actor: bound, scopes }),
      })
    )
  );
  return Object.freeze({ ...(governed as object), config, compile });
}
