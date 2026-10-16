// viborm/rbac: one predicate per (model, action), judged in the statement
// (docs/architecture/rbac-extension-plan.md). An ordinary definition built
// from public capabilities only.
//
// This file is the entry: `rbac(config)` checks the actor schema at once and
// compiles the policy against the schema it governs. The policy's types are
// opaque predicates (never a model's `where` type: the 1.2.0 TS2589 lesson);
// what the types check is the declaration's names: models, fields and actions
// against the schema and each other, actor paths against the actor schema.

import type { OperationPayload } from "../client/exports"; // public today
import { ForbiddenError } from "../errors";
import type { RowsVerbs } from "../extensions/controls";
import type {
  ClientSchema,
  ClientTypeState,
  ExtendedClient,
  ExtensionState,
  MergeExtensionState,
  VibORMClient,
  VibORMConfig,
} from "../index";
import type { InferOutput } from "../validation";
import { type ActorFacts, type ActorPaths, actorPaths } from "./actor";
import {
  type CompiledModel,
  type CompiledPolicy,
  compilePolicy,
  DEFAULT_MODE,
  EVIDENCE_KEY,
  evidenceOf,
  type RbacConfig,
  verbsOf,
} from "./compile";
import {
  FALSE,
  type KeyLimit,
  type PolicyModel,
  type Rule,
  type Where,
} from "./helpers";

export type { ActorFacts, ActorPaths } from "./actor";
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
type AnyModel = Schema[string];
type Row = Readonly<Record<string, unknown>>;

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

/** On a model that lists its `actions`, a rule key it does not list (a typo). */
type UnlistedKeys<M> = M extends { readonly actions: infer A }
  ? Exclude<keyof M & string, Reserved | (keyof A & string)>
  : never;

type UnknownActions<Config extends RbacConfig> = {
  [K in keyof Config["models"] & string]: Exclude<
    NamedActions<Config["models"][K]> | UnlistedKeys<Config["models"][K]>,
    | Exclude<
        ActionsOf<Config["models"][K], Levels<Config>>,
        UnlistedKeys<Config["models"][K]>
      >
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

type ConfigKey = "actor" | "levels" | "limit" | "models" | "cache";

/** `unknown` when the declaration's names agree; else a member naming the first disagreement. */
type DeclarationCheck<Config extends RbacConfig> = [
  Exclude<keyof Config, ConfigKey>,
] extends [never]
  ? ActorAndActionCheck<Config>
  : { readonly "unknown policy key": Exclude<keyof Config, ConfigKey> };

type ActorAndActionCheck<Config extends RbacConfig> = [
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
type SchemaCheck<
  S extends Schema,
  Config extends RbacConfig,
> = string extends keyof S
  ? unknown
  : [Exclude<keyof Config["models"], keyof S>] extends [never]
    ? [UnknownFields<S, Config>] extends [never]
      ? unknown
      : { readonly "unknown field": UnknownFields<S, Config> }
    : { readonly "unknown model": Exclude<keyof Config["models"], keyof S> };

// =============================================================================
// THE ENTRY: a rows step and a methods step (plan §1.1; K7(b), OD-1 option 2)
// =============================================================================

const NAME = "viborm.rbac";
/** The call argument that narrows a call to one action or domain (R8). */
const MODE = "as";

type Listed<Config extends RbacConfig> = keyof Config["models"] & string;
type ActionOf<Config extends RbacConfig, K extends Listed<Config>> = ActionsOf<
  Config["models"][K],
  Levels<Config>
>;
type DomainsOf<M> = M extends { readonly domains: infer D }
  ? keyof D & string
  : never;
/** Every `as` value: the default, and each listed model's actions and domains. */
type ModeOf<Config extends RbacConfig> =
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
type AsMethod<Actor> = {
  /**
   * This client with the actor bound (K6): every call of the view is judged
   * for it. Validated once, here, against the policy's actor schema.
   */
  $as<Self>(this: Self, actor: Actor): Self;
};

/** Whether a model's actions are exactly the levels: its key reads the highest one held (D6). */
type Ordered<Config extends RbacConfig, M> = M extends {
  readonly actions: object;
}
  ? false
  : [Levels<Config>] extends [never]
    ? false
    : [ActionsOf<M, Levels<Config>>] extends [Levels<Config>]
      ? true
      : false;
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
type ModelVerbs<Config extends RbacConfig, K extends Listed<Config>> = {
  readonly predicates: RowsVerbs["predicates"];
} & ([ActionOf<Config, K>] extends [never]
  ? unknown
  : {
      readonly evidence: {
        readonly as: typeof EVIDENCE_KEY;
        readonly names: readonly ActionOf<Config, K>[];
        readonly ordered: Ordered<Config, Config["models"][K]>;
      };
    }) &
  ([GatedOf<Config["models"][K]>] extends [never]
    ? unknown
    : {
        readonly reads: {
          readonly [F in GatedOf<Config["models"][K]>]: string;
        };
      });

type RowsDefinition<C extends VibORMConfig, Config extends RbacConfig> = {
  readonly name: typeof NAME;
  readonly controls: {
    readonly actor: {
      readonly schema: Config["actor"];
      readonly bound: true;
      readonly required: true;
      readonly uncacheable: boolean;
    };
  };
  readonly rows: {
    readonly control: typeof MODE;
    readonly default: typeof DEFAULT_MODE;
    readonly models: {
      readonly [K in keyof C["schema"]]: {
        readonly [Mode in ModeOf<Config>]: { readonly root?: string | Where };
      };
    };
    readonly verbs: {
      readonly [K in Listed<Config>]: ModelVerbs<Config, K>;
    };
  };
  // Any scope: the one it is called with is the receiving client's.
  readonly client: (
    scope: unknown
  ) => AsMethod<ActorFacts<InferOutput<Config["actor"]>>>;
};

type WhereOf<C extends VibORMConfig, K> = Exclude<
  OperationPayload<"findUnique", ClientSchema<C>[K & keyof ClientSchema<C>]>,
  undefined
>["where"];

/** One listed model's answers, from its own predicates, through `$access` (D8). */
interface ModelAnswers<Action extends string, W> {
  /**
   * Whether the actor holds `action` on the one row `where` names (a unique
   * selector, as `findUnique` takes), or, for a list, each listed action,
   * each from its own predicate. A row the actor does not view holds none.
   */
  can(action: Action, where: W): Promise<boolean>;
  can<const Asked extends readonly Action[]>(
    actions: Asked,
    where: W
  ): Promise<{ readonly [A in Asked[number]]: boolean }>;
  /** Resolves when `can` holds for every action; else `ForbiddenError`, hidden row or not. */
  assert(action: Action | readonly Action[], where: W): Promise<void>;
}

type MethodsDefinition<C extends VibORMConfig, Config extends RbacConfig> = {
  readonly name: `${typeof NAME}.methods`;
  readonly model: {
    // The delegate of a client generic over its state stays deferred: untyped.
    readonly [K in Listed<Config>]: (
      delegate: never
    ) => ModelAnswers<ActionOf<Config, K>, WhereOf<C, K>>;
  };
};

type Governing<Config extends RbacConfig> = VibORMConfig & {
  readonly schema: Record<Listed<Config>, AnyModel>;
};
/** The rows step is typed by the client's one extension reducer. */
type RowsClient<
  C extends VibORMConfig,
  X extends ExtensionState,
  Config extends RbacConfig,
> = ExtendedClient<VibORMClient<C, X>, [RowsDefinition<C, Config>]>;
type MethodsClient<
  Client,
  Config extends RbacConfig,
> = Client extends ClientTypeState<infer C, infer X>
  ? Client extends VibORMClient<C, X>
    ? VibORMClient<C, MergeExtensionState<X, MethodsDefinition<C, Config>>>
    : never
  : never;
type PolicyClient<
  Base,
  Config extends RbacConfig,
> = Base extends ClientTypeState<infer C, infer X>
  ? Base extends VibORMClient<C, X>
    ? MethodsClient<RowsClient<C, X, Config>, Config>
    : never
  : never;

export interface Policy<Config extends RbacConfig> {
  /**
   * The governed client: the rows step, then the methods step. Every model
   * of `base` is governed, and every call needs an actor: `db.$as(actor)`.
   */
  // Infer the receiver from the argument only. Contextual factory comparison
  // must not expand a complete client over the generic governing schema.
  <
    Base extends ClientTypeState<VibORMConfig, ExtensionState> & {
      readonly $schema: Record<Listed<Config>, AnyModel>;
      readonly $extends: (...args: never[]) => unknown;
    },
  >(
    base: Base
  ): NoInfer<PolicyClient<Base, Config>>;
  readonly config: Config;
  /**
   * The policy compiled against the schema it governs (R1, plain data): per
   * model, its named predicates and the verbs, written fields, read-gated
   * fields, modes, placement, moves, acyclic relations and projection key
   * that take them. Refusals are
   * `ClientInitializationError`s naming the declaration's path. Public for
   * inspection; the entry applies it as it is.
   */
  compile<S extends Schema>(schema: S & SchemaCheck<S, Config>): CompiledPolicy;
  /**
   * Step one: the bound-only `actor`, the `as` mode, every model's
   * predicates and the verbs, placement, moves, projection key and
   * read-gated fields that name them (K3, K4, K5), and `$as`. `$as` binds the actor, so it lives where the
   * actor is declared (K6(a)); that makes this a client consumer, so it is
   * the last `rows` step of a chain (the order guard).
   */
  rows<C extends Governing<Config>, X extends ExtensionState>(
    base: ClientTypeState<C, X> & NoInfer<VibORMClient<C, X>>
  ): RowsClient<C, X, Config>;
  /** Step two: `can` and `assert` on every listed model, through `$access` (D8). */
  methods<C extends Governing<Config>, X extends ExtensionState>(
    client: ClientTypeState<C, X> & NoInfer<VibORMClient<C, X>>
  ): MethodsClient<VibORMClient<C, X>, Config>;
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

interface ModelCall {
  readonly kind: string;
  readonly model?: string;
  readonly operation: string;
  readonly controls?: Readonly<Record<string, unknown>>;
  proceed(): Promise<unknown>;
}

/**
 * R9: a root call whose domain is false when the policy is applied (a model
 * the policy does not list, a verb or a mode the model does not declare) is
 * refused before any statement with one class, `ForbiddenError` (OD-7); one
 * that folds false per call takes the ordinary outcome from its predicates.
 */
function refuseUnreachable(reach: ReadonlyMap<string, Reach>) {
  return async (context: ModelCall): Promise<unknown> => {
    if (context.kind === "model") {
      const { model, operation } = context as Required<ModelCall>;
      const at = reach.get(model)!;
      const verb = VERB_OF[operation];
      const mode = context.controls?.[MODE];
      if (
        !at.listed ||
        (verb !== undefined && !at.verbs.has(verb)) ||
        (typeof mode === "string" && !at.modes.has(mode))
      )
        throw new ForbiddenError(model, operation);
    }
    return await context.proceed();
  };
}

/**
 * Every model's modes, alike in name (one control): the default and the
 * model's read action narrow nothing (`read` already ANDs with every mode,
 * K3); another of its actions or domains narrows by its predicate (R8); a
 * mode it does not declare holds nothing, and a root call naming it is
 * refused before it runs (R9).
 */
function modesOf(compiled: CompiledPolicy) {
  const names = [
    DEFAULT_MODE,
    ...new Set(
      Object.values(compiled.models).flatMap((model) =>
        Object.keys(model.modes)
      )
    ),
  ];
  const narrowing = (model: CompiledModel, mode: string) => {
    if (mode === DEFAULT_MODE || mode === model.read) return {};
    return {
      root: Object.hasOwn(model.modes, mode) ? model.modes[mode]! : FALSE,
    };
  };
  return Object.fromEntries(
    Object.entries(compiled.models).map(([name, model]) => [
      name,
      Object.fromEntries(names.map((mode) => [mode, narrowing(model, mode)])),
    ])
  );
}

function reachOf(config: RbacConfig, compiled: CompiledPolicy) {
  return new Map(
    Object.entries(compiled.models).map(([name, model]) => [
      name,
      {
        listed: Object.hasOwn(config.models, name),
        verbs: new Set([
          ...(["read", "update", "delete"] as const).filter(
            (verb) => model[verb] !== undefined
          ),
          ...(Object.keys(model.writes).length > 0 ? ["update"] : []),
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

type ContextualRelation<Relation, Actor> = Relation extends {
  readonly "~": {
    readonly state: {
      readonly target: { readonly getter: () => infer Target };
    };
  };
}
  ?
      | string
      | (ContextualWhere<Target, Actor> & {
          readonly is?: ContextualRule<Target, Actor> | null;
          readonly isNot?: ContextualRule<Target, Actor> | null;
          readonly some?: ContextualRule<Target, Actor>;
          readonly every?: ContextualRule<Target, Actor>;
          readonly none?: ContextualRule<Target, Actor>;
        })
  : Where | string;

type ContextualWhere<Model, Actor> = Where & {
  readonly [Field in ScalarsOf<Model>]?: PolicyValue<Actor>;
} & {
  readonly [Relation in keyof ModelRelations<Model>]?: ContextualRelation<
    ModelRelations<Model>[Relation],
    Actor
  >;
} & ("actor" extends ScalarsOf<Model> | RelationsOf<Model>
    ? unknown
    : {
        readonly actor?: {
          readonly [Path in ActorPaths<InferOutput<Actor>>]?: unknown;
        };
      }) & {
    readonly AND?:
      | ContextualRule<Model, Actor>
      | readonly ContextualRule<Model, Actor>[];
    readonly OR?: readonly ContextualRule<Model, Actor>[];
    readonly NOT?:
      | ContextualRule<Model, Actor>
      | readonly ContextualRule<Model, Actor>[];
  };

type ContextualRule<Model, Actor> =
  | ContextualWhere<Model, Actor>
  | ((action: string, model: PolicyModel) => Rule);

type ContextualPolicy<
  C extends VibORMConfig,
  Actor,
> = string extends keyof C["schema"]
  ? unknown
  : {
      readonly actor: Actor;
      readonly models: {
        readonly [Model in keyof ClientSchema<C>]?: {
          readonly [Action: string]:
            | ContextualWhere<ClientSchema<C>[Model], Actor>
            | ((action: string, model: PolicyModel) => Rule)
            | readonly Rule[]
            | undefined;
        };
      };
    };

/**
 * The receiving `$extends` supplies C and X before the inline declaration is
 * contextualized. Unbound declarations retain the reusable generic Policy;
 * only a concrete receiving schema adds the specialized callback signature.
 */
export function rbac<
  C extends VibORMConfig,
  X extends ExtensionState,
  const Actor extends object,
  const Config extends RbacConfig,
>(
  config: Config & { readonly actor: Actor } & ContextualPolicy<
      NoInfer<C>,
      NoInfer<Actor>
    > &
    DeclarationCheck<Config> &
    SchemaCheck<NoInfer<C["schema"]>, Config>
): Policy<Config> &
  (string extends keyof C["schema"]
    ? unknown
    : (
        base: VibORMClient<C, X>
      ) => MethodsClient<RowsClient<C, X, Config>, Config>);
export function rbac<const Config extends RbacConfig>(
  config: Config & DeclarationCheck<Config>
): Policy<Config> {
  const hasPath = actorPaths(config.actor);
  const compile = (schema: Schema) => compilePolicy(config, schema, hasPath);
  const rows = (base: VibORMClient<VibORMConfig, ExtensionState>) => {
    const compiled = compile(base.$schema as Schema);
    const definition = {
      name: NAME,
      controls: {
        actor: {
          schema: config.actor,
          bound: true,
          required: true,
          uncacheable: config.cache !== "allow",
        },
      },
      rows: {
        control: MODE,
        default: DEFAULT_MODE,
        models: modesOf(compiled),
        verbs: verbsOf(compiled),
      },
      query: refuseUnreachable(reachOf(config, compiled)),
      client: (scope: {
        $bind(values: Readonly<Record<string, unknown>>): unknown;
      }) => {
        const methods: AsMethod<unknown> = {
          $as: (actor) => scope.$bind({ actor }) as never,
        };
        return methods;
      },
    };
    return extend(base, definition);
  };
  const methods = (client: VibORMClient<VibORMConfig, ExtensionState>) => {
    const answers = (model: string) => {
      const { names, ordered } = evidenceOf(config, model);
      return (delegate: never) => {
        const read = delegate as {
          findUnique(args: object): PromiseLike<Row | null>;
        };
        /**
         * The row `where` names, its `$access` at `asked` (D8): one statement,
         * or one per asked level on an ordered model. There the key reads the highest level held, which
         * says nothing of a lower one whose predicate an arm, `within` or
         * `limit` reads apart (R1 does not make P monotone), so each level
         * is asked by itself. A row the actor does not view reads null.
         */
        const ask = async (asked: readonly string[], where: object) => {
          // R9 (OD-7): an action the model does not declare is refused
          // before any statement, as an `as` mode it does not declare is.
          for (const action of asked)
            if (!names.includes(action))
              throw new ForbiddenError(model, action);
          const evidence = async (some: readonly string[]) =>
            (
              await read.findUnique({
                where,
                select: { [EVIDENCE_KEY]: some },
              })
            )?.[EVIDENCE_KEY];
          if (ordered)
            return Promise.all(
              asked.map(async (action) => (await evidence([action])) === action)
            );
          const held = (await evidence(asked)) as
            | Readonly<Record<string, boolean>>
            | undefined;
          return asked.map((action) => held?.[action] === true);
        };
        return {
          can: async (action: string | readonly string[], where: object) => {
            if (typeof action === "string")
              return (await ask([action], where))[0];
            const held = await ask(action, where);
            return Object.fromEntries(
              action.map((name, index) => [name, held[index]])
            );
          },
          assert: async (action: string | readonly string[], where: object) => {
            const asked = typeof action === "string" ? [action] : action;
            const held = await ask(asked, where);
            const lacking = asked.find((_, index) => !held[index]);
            if (lacking !== undefined) throw new ForbiddenError(model, lacking);
          },
        };
      };
    };
    return extend(client, {
      name: `${NAME}.methods`,
      model: Object.fromEntries(
        Object.keys(config.models).map((model) => [model, answers(model)])
      ),
    });
  };
  const apply = (base: VibORMClient<VibORMConfig, ExtensionState>) =>
    methods(rows(base));
  // The steps are typed by `Policy`: for a client generic over its state,
  // the client-method guard stays deferred and refuses every client method.
  return Object.freeze(
    Object.assign(apply, { config, compile, rows, methods })
  ) as unknown as Policy<Config>;
}

function extend(
  client: VibORMClient<VibORMConfig, ExtensionState>,
  definition: object
): VibORMClient<VibORMConfig, ExtensionState> {
  return Reflect.apply(client.$extends, client, [definition]);
}
