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

import type { RowsVerbs } from "../client/exports";
import { ForbiddenError } from "../errors";
import type {
  ControlsContribution,
  DefinitionControls,
  RowsContribution,
} from "../extensions/controls";
import { compiledRows } from "../extensions/rule";
import {
  type AnyTarget,
  type ClientSchema,
  call,
  type Extension,
  models as everyOperation,
  extension,
  type Facts,
  methods,
  target,
  type VibORMConfig,
} from "../index";
import type { InferOutput } from "../validation";
import { type ActorFacts, type ActorPaths, actorContract } from "./actor";
import {
  type CompiledPolicy,
  compilePolicy,
  DEFAULT_MODE,
  type DeclaredModel,
  type EVIDENCE_KEY,
  type ModelPolicy,
  type PermissionsConfig,
  policyCompiler,
  verbsOf,
} from "./compile";
import { FALSE, type PolicyModel, type Where } from "./rules";

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
// THE ENTRY: one rows step (plan §1.1; K7(b))
// =============================================================================

const NAME = "viborm.permissions";
/** The call argument that narrows a call to one action or domain (R8). */
const MODE = "as";

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
  readonly predicates: RowsVerbs["predicates"];
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

/** The policy's two bound arguments, as the delegates read them. */
type PolicyControls<Config extends PermissionsConfig> = DefinitionControls<{
  readonly controls: {
    readonly actor: { readonly schema: Config["actor"]; readonly bound: true };
    readonly scopes: { readonly schema: ScopeSchema; readonly bound: true };
  };
  readonly rows: {
    readonly control: typeof MODE;
    readonly default: typeof DEFAULT_MODE;
    readonly models: {
      readonly [K in Listed<Config>]: {
        readonly [Mode in ModeOf<Config>]: object;
      };
    };
  };
}>;

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
  PolicyControls<Config>,
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
   * The policy compiled against the schema it governs (R1, plain data): per
   * model, its named predicates and the verbs, written fields, read-gated
   * fields, modes, placement, moves, acyclic relations and projection key
   * that take them. Refusals are
   * `ClientInitializationError`s naming the declaration's path. Public for
   * inspection; the entry applies it as it is.
   */
  compile<S extends Schema>(
    schema: S & SchemaCheck<S, Config["models"]>
  ): CompiledPolicy;
}

/** The verb each root operation is judged at; a create is judged by its placement (K4). */
const VERB_OF: Readonly<Record<string, "read" | "update" | "delete">> = {
  findMany: "read",
  findFirst: "read",
  findUnique: "read",
  findFirstOrThrow: "read",
  findUniqueOrThrow: "read",
  count: "read",
  aggregate: "read",
  groupBy: "read",
  exist: "read",
  update: "update",
  updateMany: "update",
  delete: "delete",
  deleteMany: "delete",
};

/** What a root call may reach on one model before its predicates run (R9). */
interface Reach {
  readonly listed: boolean;
  readonly verbs: ReadonlySet<string>;
  readonly modes: ReadonlySet<string>;
}

/**
 * Every model's modes, alike in name (one control): the default and the
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

function modesOf(models: { readonly [model: string]: DeclaredModel }) {
  const names = [
    DEFAULT_MODE,
    ...new Set(
      Object.values(models).flatMap((model) => Object.keys(model.modes))
    ),
  ];
  const narrowing = (model: DeclaredModel, mode: string) => ({
    ...(mode !== DEFAULT_MODE &&
      mode !== model.read && {
        root: Object.hasOwn(model.modes, mode) ? model.modes[mode]! : FALSE,
      }),
  });
  return Object.fromEntries(
    Object.entries(models).map(([name, model]) => [
      name,
      Object.fromEntries(names.map((mode) => [mode, narrowing(model, mode)])),
    ])
  );
}

/** The tenant the policy's own whole-table sets stay in (`tenant`). */
function confineOf(models: { readonly [model: string]: DeclaredModel }) {
  const confine: Record<string, Where> = {};
  for (const [name, model] of Object.entries(models))
    if (model.bound !== undefined) confine[name] = model.bound;
  return Object.keys(confine).length === 0 ? {} : { confine };
}

/** Whether `name` has a self relation holding its key: what `acyclic` may name. */
function selfKeyed(schema: Schema, name: string): boolean {
  const relations = (
    schema[name]!["~"].state as unknown as {
      relations: Record<
        string,
        {
          "~": {
            state: { foreignKey?: unknown };
            settleTarget(): unknown;
          };
        }
      >;
    }
  ).relations;
  return Object.values(relations).some(
    (relation) =>
      relation["~"].state.foreignKey !== undefined &&
      relation["~"].settleTarget() === schema[name]
  );
}

function reachOf(
  config: PermissionsConfig,
  models: { readonly [model: string]: DeclaredModel }
) {
  return new Map(
    Object.entries(models).map(([name, model]) => [
      name,
      {
        listed: Object.hasOwn(config.models, name),
        verbs: new Set([
          ...(["read", "update", "delete"] as const).filter(
            (verb) => model[verb] !== undefined
          ),
        ]),
        modes: new Set([DEFAULT_MODE, ...Object.keys(model.modes)]),
      },
    ])
  );
}

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
  /** What applying the policy to one schema hands the host. */
  interface Application {
    readonly models: Schema;
    readonly rows: RowsContribution;
    readonly controls: ControlsContribution;
    readonly reach: ReadonlyMap<string, Reach>;
  }
  // An application is kept per schema, never a client, actor or driver:
  // every client of a schema shares one, so the host admits its predicates
  // once.
  const prepared = new WeakMap<Schema, Application>();
  /**
   * The application of the policy to `schema`, made once: applying it checks
   * what the declaration names, and each model compiles the first time a
   * call needs it, into one state every client of the schema shares. A
   * rule's own refusal comes at its model's first call.
   */
  const preparedFor = (base: Schema): Application => {
    const known = prepared.get(base);
    // A schema object that gained or swapped a model is prepared again by
    // the client, so the policy is applied again: a model it lacks would be
    // left open (R9), and a later compile must read the models applied.
    const keys = Object.keys(base);
    if (
      known !== undefined &&
      keys.length === Object.keys(known.models).length &&
      keys.every((name) => known.models[name] === base[name])
    )
      return known;
    const schema = { ...base };
    const compiler = policyCompiler(config, schema, actor);
    const verbs = Object.fromEntries(
      Object.keys(schema).map((name) => {
        if (!Object.hasOwn(config.models, name))
          return [
            name,
            verbsOf({ models: { [name]: compiler.model(name) } })[name],
          ];
        // Only a self relation holding the model's key can be kept acyclic,
        // and knowing whether one is takes every model compiled.
        const acyclic = selfKeyed(schema, name)
          ? () => compiler.acyclic(name)
          : undefined;
        let entry: RowsVerbs | undefined;
        const resolve = (): RowsVerbs => {
          if (entry !== undefined) return entry;
          const own = verbsOf({ models: { [name]: compiler.model(name) } })[
            name
          ]!;
          entry = acyclic ? { ...own, acyclic } : own;
          return entry;
        };
        return [name, resolve];
      })
    );
    const declared = compiler.declared;
    const rows: RowsContribution = {
      control: MODE,
      default: DEFAULT_MODE,
      models: modesOf(declared),
      verbs,
      ...confineOf(declared),
    };
    const uncacheable = config.cache !== "allow";
    const application: Application = {
      models: schema,
      rows,
      controls: {
        actor: {
          schema: actor.schema,
          bound: true,
          required: true,
          uncacheable,
        },
        scopes: {
          schema: scopeSchema(compiler.scopes),
          bound: true,
          required: true,
          uncacheable,
        },
      },
      reach: reachOf(config, declared),
    };
    prepared.set(base, application);
    return application;
  };
  const governed = extension(
    NAME,
    // The compiled policy, handed to the rows host as it reads it.
    compiledRows((schema) => preparedFor(schema)),
    // R9, D3: a call the policy cannot reach is refused before its
    // arguments are validated.
    call((c) => {
      if (c.kind !== "model" || c.model === undefined) return;
      const at = preparedFor(c.schema).reach.get(c.model)!;
      const verb = VERB_OF[c.operation];
      const mode: unknown = c.values[MODE];
      if (
        !at.listed ||
        (verb !== undefined && !at.verbs.has(verb)) ||
        (typeof mode === "string" && !at.modes.has(mode))
      )
        throw new ForbiddenError(c.model, c.operation);
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
