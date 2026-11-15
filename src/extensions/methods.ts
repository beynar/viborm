import type { TransactionClient, VibORMConfig } from "@client/client";
import {
  RAW_METHOD_NAMES,
  type RawSurface,
  type RowsFragment,
} from "@client/raw";
import type { ClientSchema } from "@client/schema-links";
import type {
  Client,
  ClientRowsContext,
  ComputedOperation,
  ComputedOperations,
  Schema,
  StampedOperation,
  StampedOperations,
} from "@client/types";
import type { ModelSql } from "@query-engine/raptor3/shared/insert-value";
import { ROUTED_OPERATIONS } from "@query-engine/routed-operations";
import { isFunction, isRecord } from "@validation/value-guards";
import { type AdmittedArgs, notBound } from "./arguments";
import type { ExtensionPart } from "./chain";
import { extensionError } from "./chain";
import type { NoArguments } from "./contract";
import type { MergeResultFields } from "./result-types";

type NoMethods = Record<never, never>;
export type RuntimeExtensionMethodFunction = (...args: never[]) => unknown;

declare const extensionCacheState: unique symbol;
export interface ExtensionCacheState {
  readonly [extensionCacheState]: true;
}
declare const extensionResultConsumerState: unique symbol;
export interface ExtensionResultConsumerState {
  readonly [extensionResultConsumerState]: true;
}

/** The only static facts accumulated while extensions are chained. */
export interface ClientExtensionState<
  ClientMethods extends object = NoMethods,
  ModelMethods extends object = NoMethods,
  // Without the cache, either: a client the cache extends stays assignable
  // to the type of the client before it (the cache reads, it hides nothing).
  CacheState extends ExtensionCacheState | undefined =
    | ExtensionCacheState
    | undefined,
  ResultConsumerState extends
    | ExtensionResultConsumerState
    | undefined = undefined,
  Arguments extends object = NoArguments,
  RowModels extends string = never,
  Data = never,
  Result extends object = Record<never, never>,
> {
  readonly client: ClientMethods;
  readonly models: ModelMethods;
  readonly cache: CacheState;
  readonly resultConsumer: ResultConsumerState;
  /** The arguments the chain declares: each one's values and placement. */
  readonly args: Arguments;
  /** The models the chain's `rows` can hide from a relation read. */
  readonly rows: RowModels;
  /** The fields the chain's `data` writes, which a caller no longer writes. */
  readonly data: Data;
  /** The fields the chain's `result` computes, per model key, and their types. */
  readonly result: Result;
}

export type EmptyClientExtensionState = ClientExtensionState;

/** Internal constraint for either the absent or enabled nominal cache bit. */
export type ExtensionStateConstraint = ClientExtensionState<
  object,
  object,
  ExtensionCacheState | undefined,
  ExtensionResultConsumerState | undefined,
  object,
  string,
  unknown,
  object
>;

/** Whether the current type-state includes the official cache capability. */
export type HasExtensionCache<X extends ExtensionStateConstraint> = [
  X["cache"],
] extends [ExtensionCacheState]
  ? true
  : false;

/** Whether an earlier extension was typed against result-bearing delegates. */
export type HasResultConsumingExtension<X extends ExtensionStateConstraint> = [
  X["resultConsumer"],
] extends [undefined]
  ? false
  : [X["resultConsumer"]] extends [ExtensionResultConsumerState]
    ? true
    : false;

declare const delegateState: unique symbol;
/**
 * Declaration-only: what a result read on a delegate of a chain that adds
 * model methods depends on (its client's config, the models the chain's
 * `rows` can hide, its computed fields, the model), so a method typed with a
 * `this` parameter reads its result from the client it is called on
 * (`DelegateOperationResult`), whatever the chain added after it. Nothing
 * else of the extension state: a later step that changes none of these (the
 * cache) keeps the client assignable to the one before it. No property is
 * installed at runtime.
 */
export interface DelegateState<C, Rows, Result, ModelName> {
  readonly [delegateState]?: readonly [C, Rows, Result, ModelName];
}

type MethodsForModel<
  X extends ExtensionStateConstraint,
  ModelName extends PropertyKey,
> = ModelName extends keyof X["models"] ? X["models"][ModelName] : NoMethods;

/**
 * The link, on every delegate of a chain that adds model methods: decided by
 * the extension state alone, so a client generic over its schema without
 * them (the empty state) compares as before.
 */
type DelegateLink<
  C extends VibORMConfig,
  X extends ExtensionStateConstraint,
  ModelName extends PropertyKey,
> = [keyof X["models"]] extends [never]
  ? unknown
  : DelegateState<C, X["rows"], X["result"], ModelName>;

/**
 * One model's delegate after the chain's methods and arguments. On a chain
 * that declares create `data`, its writes may leave out the fields the chain
 * writes on a create.
 */
export type ExtensionModelDelegate<
  C extends VibORMConfig,
  X extends ExtensionStateConstraint,
  ModelName extends keyof ClientSchema<C>,
> = ([X["data"]] extends [never]
  ? Client<C, ClientRowsContext<C, X["rows"]>, X["args"]>[ModelName]
  : Omit<
      Client<C, ClientRowsContext<C, X["rows"]>, X["args"]>[ModelName],
      StampedOperation
    > &
      StampedOperations<
        C,
        ClientRowsContext<C, X["rows"]>,
        X["args"],
        X["data"],
        ModelName
      >) &
  MethodsForModel<X, ModelName> &
  DelegateLink<C, X, ModelName> &
  ModelRows;

/** The core member every model delegate has beside its operations. */
interface ModelRows {
  /**
   * The rows of this model this client may read, as a `FROM` item of a
   * tagged `$queryRaw` named `alias`: a derived table filtered by the row
   * domain a `findMany` of this model on this client takes (permissions,
   * soft delete, bound arguments). Refused anywhere else.
   *
   * @example
   * ```ts
   * await db.$as(actor).$queryRaw`
   *   SELECT p.id FROM ${db.$as(actor).page.$rows("p")} WHERE p.title LIKE ${q}
   * `;
   * ```
   */
  $rows(alias: string): RowsFragment;
  /**
   * This model's names and values as this client's statements spell them:
   * its table, its columns, a value bound as one of its fields, and the rows
   * a call may see as a condition. For a fragment you write by hand and hand
   * to a model operation (a `computed` value, a filter's expression).
   */
  readonly $sql: ModelSql;
}

/**
 * One model's delegate on a chain that declares `result`: its projecting
 * operations rebuilt so `select` and `omit` name the computed fields and the
 * rows carry them. A chain without `result` never reaches this type.
 */
type ComputedModelDelegate<
  C extends VibORMConfig,
  X extends ExtensionStateConstraint,
  ModelName extends keyof ClientSchema<C>,
> = Omit<ExtensionModelDelegate<C, X, ModelName>, ComputedOperation> &
  ComputedOperations<
    C,
    ClientRowsContext<C, X["rows"]>,
    X["args"],
    X["data"],
    ModelName,
    X["result"]
  >;

/**
 * Model delegates after the methods contributed by the current chain. The
 * always-true test is deliberate: for a client generic over its config it
 * stays deferred, so the model map adds no index signature to that client and
 * its `$` members stay reachable inside a body generic over `C`. A chain
 * that declares `result` is told apart here, once per client.
 */
export type ExtensionModelClient<
  C extends VibORMConfig,
  X extends ExtensionStateConstraint,
> = [keyof C["schema"]] extends [PropertyKey]
  ? [keyof X["result"]] extends [never]
    ? {
        [ModelName in keyof ClientSchema<C>]: ExtensionModelDelegate<
          C,
          X,
          ModelName
        >;
      }
    : {
        [ModelName in keyof ClientSchema<C>]: ComputedModelDelegate<
          C,
          X,
          ModelName
        >;
      }
  : unknown;

/** The surface given to one client-method factory. */
export type ExtensionClientScope<
  C extends VibORMConfig,
  X extends ExtensionStateConstraint,
> = ExtensionModelClient<C, X> &
  RawSurface &
  X["client"] & {
    readonly $schema: ClientSchema<C>;
    readonly $transaction: TransactionClient<C, X>["$transaction"];
    /**
     * The client this scope's methods are called on, its calls admitting
     * these values of this extension's own arguments as if passed (a
     * `bound: true` argument only from here). Its type is that client's,
     * which only the method knows: declare it with a `this` parameter,
     * `$with<Self>(this: Self, value: Value): Self`, outside the returned
     * literal (inside it, the factory's contextual type makes `Self` void).
     */
    readonly $bind: (values: Readonly<Record<string, unknown>>) => unknown;
  };

export type MergeModelMethods<Left extends object, Right extends object> = {
  readonly [ModelName in
    | keyof Left
    | keyof Right]: (ModelName extends keyof Left
    ? Left[ModelName]
    : NoMethods) &
    (ModelName extends keyof Right ? Right[ModelName] : NoMethods);
};

/** Incoming facts keep their nominal bit derivation inside this named state. */
export interface ExtensionContributionState<
  ClientMethods extends object,
  ModelMethods extends object,
  Arguments extends object,
  RowModels extends string,
  Data,
  ConsumerContext extends string,
  // Defaulted: 1.3.3 exported this state with six parameters.
  Result extends object = Record<never, never>,
  // Without the cache, either: a client the cache extends stays assignable
  // to the type of the client before it (the cache reads, it hides nothing).
  CacheState extends ExtensionCacheState | undefined =
    | ExtensionCacheState
    | undefined,
> extends ExtensionStateConstraint {
  readonly client: ClientMethods;
  readonly models: ModelMethods;
  readonly cache: CacheState;
  readonly resultConsumer: ConsumerContext extends "result-consuming"
    ? ExtensionResultConsumerState
    : undefined;
  readonly args: Arguments;
  readonly rows: RowModels;
  readonly data: Data;
  readonly result: Result;
}

/** Accumulate the same seven facts lazily, without retaining callback definitions. */
export interface AccumulatedExtensionState<
  X extends ExtensionStateConstraint,
  Contribution extends ExtensionStateConstraint,
> extends ExtensionStateConstraint {
  readonly client: X["client"] & Contribution["client"];
  readonly models: MergeModelMethods<X["models"], Contribution["models"]>;
  readonly cache: [Contribution["cache"]] extends [ExtensionCacheState]
    ? ExtensionCacheState
    : X["cache"];
  readonly resultConsumer: HasResultConsumingExtension<Contribution> extends true
    ? ExtensionResultConsumerState
    : X["resultConsumer"];
  readonly args: X["args"] & Contribution["args"];
  readonly rows: X["rows"] | Contribution["rows"];
  readonly data: X["data"] | Contribution["data"];
  readonly result: MergeResultFields<X["result"], Contribution["result"]>;
}

type MethodRecord = Readonly<Record<string, RuntimeExtensionMethodFunction>>;

/**
 * The methods a view answers after some prefix of its chain: its client
 * methods, and one model's. Each is computed the first time it is read.
 */
export interface ExtensionMethods {
  readonly client: () => MethodRecord;
  readonly model: (model: string) => MethodRecord;
}

/** A view's methods, and what invokes every factory of its chain in order. */
export type BoundExtensionMethods = ExtensionMethods & {
  readonly force: () => void;
};

const NO_METHODS: MethodRecord = /* @__PURE__ */ Object.freeze(
  Object.create(null)
);
const NO_LAYER: BoundExtensionMethods = /* @__PURE__ */ Object.freeze({
  client: () => NO_METHODS,
  model: () => NO_METHODS,
  force: () => undefined,
});

const CORE_CLIENT_METHODS = new Set([
  "$driver",
  "$schema",
  "$transaction",
  "$connect",
  "$disconnect",
  "$extends",
]);

/**
 * The methods before one extension with its own added, each a function and
 * each name (`at` the model's, for a model method) checked against what the
 * view already answers.
 */
function addMethods(
  previous: MethodRecord,
  added: readonly (readonly [string, unknown])[],
  refuse: (problem: string) => never,
  collides: (name: string) => boolean,
  surface: "client" | "model",
  at = ""
): MethodRecord {
  const methods: Record<string, RuntimeExtensionMethodFunction> =
    Object.create(null);
  Object.assign(methods, previous);
  for (const [name, method] of added) {
    const label = `${surface} method "${at}${name}"`;
    if (!isFunction(method)) refuse(`${label} must be a function`);
    if (Object.hasOwn(methods, name) || collides(name))
      refuse(`${label} collides with the existing ${surface} surface`);
    methods[name] = method;
  }
  return Object.freeze(methods);
}

/**
 * What one factory's methods add to a view, given the view's methods before
 * it: brought by the builder (`methods` its client methods, `modelMethods`
 * its model methods), so an extension carries only the half it writes. Its
 * `force` forces the view before it first.
 */
export type MethodsLayer = (made: {
  readonly prior: BoundExtensionMethods;
  /** The factory's answer, once per view, each key checked by `owns`. */
  readonly answer: () => Readonly<Record<string, unknown>>;
  readonly scope: () => object;
  readonly refuse: (problem: string) => never;
}) => BoundExtensionMethods;

/** `methods`' half: the `$` client methods its factory returns. */
export const clientLayer: MethodsLayer = ({ prior, answer, refuse }) => {
  let client: MethodRecord | undefined;
  const methods = () =>
    (client ??= addMethods(
      prior.client(),
      Object.entries(answer()),
      refuse,
      (method) =>
        CORE_CLIENT_METHODS.has(method) ||
        Object.hasOwn(RAW_METHOD_NAMES, method),
      "client"
    ));
  return {
    client: methods,
    model: prior.model,
    force: () => {
      prior.force();
      methods();
    },
  };
};

/**
 * `modelMethods`' half: each model's methods, made the first time the model
 * is read on a view; a model's entry may be a function of its delegate and
 * the scope, and a model method is called with `this` equal to its delegate.
 */
export const modelLayer: MethodsLayer = ({ prior, answer, scope, refuse }) => {
  const models = new Map<string, MethodRecord>();
  const methods = (model: string) => {
    let made = models.get(model);
    if (made === undefined) {
      const given = answer()[model];
      const delegate: unknown = Reflect.get(scope(), model);
      const own: unknown = isFunction(given)
        ? Reflect.apply(given, undefined, [delegate, scope()])
        : given;
      if (own !== undefined && !isRecord(own))
        refuse(`methods.${model} must be an object of methods`);
      made = addMethods(
        prior.model(model),
        Object.entries(own ?? {}).map(([method, fn]) => [
          method,
          isFunction(fn)
            ? (...args: unknown[]) => Reflect.apply(fn, delegate, args)
            : fn,
        ]),
        refuse,
        (method) =>
          method === "then" ||
          method === "$rows" ||
          ROUTED_OPERATIONS.has(method),
        "model",
        `${model}.`
      );
      models.set(model, made);
    }
    return made;
  };
  return {
    client: prior.client,
    model: methods,
    force: () => {
      prior.force();
      for (const key of Object.keys(answer())) methods(key);
    },
  };
};

/** A `methods` factory as its part keeps it. */
export type RuntimeMethodsFactory = (scope: never) => unknown;

/** A chain's methods, and what binds one view's methods. */
export interface ExtensionMethodsState {
  readonly bind: (
    createScope: (prior: ExtensionMethods, extension: string) => object
  ) => BoundExtensionMethods;
  /**
   * A factory scope's `$bind` on a chain that declares no `bound` argument:
   * it binds nothing, and refuses any argument it is asked to.
   */
  readonly bindNone: (
    extension: string,
    values: Readonly<Record<string, unknown>>,
    previous: AdmittedArgs | undefined
  ) => AdmittedArgs;
}

/**
 * A methods part: what a view answers, in chain order. `owns` (which keys
 * the factory may return: why not, else `undefined`) and `layer` (what its
 * methods add to a view) are its builder's half (`methods-part.ts`).
 *
 * A view's methods are this part's layer over the view the chain's methods
 * before it bind. The factory is invoked against the scope `createScope`
 * builds over those, the first time a method it returns could be read: a
 * view costs the factories it uses. `force` invokes every factory in chain
 * order, where a root view surfaces an extension's faults.
 */
export function methodsPart(
  factory: RuntimeMethodsFactory,
  layer: MethodsLayer,
  owns: (key: string, schema: Schema) => string | undefined
): ExtensionPart {
  return {
    join({ next, name, schema }) {
      const before = next.methods;
      next.methods = {
        bind: (createScope) => {
          const prior = before?.bind(createScope) ?? NO_LAYER;
          // Typed where it is declared, so a call to it ends the argument flow.
          const refuse: (problem: string) => never = (problem) =>
            extensionError(`Extension "${name}" ${problem}.`, name);
          let scope: object | undefined;
          const scopeOf = () => (scope ??= createScope(prior, name));
          let returned: Readonly<Record<string, unknown>> | undefined;
          return layer({
            prior,
            // The factory's answer, once per view: the methods come from it.
            answer: () => {
              if (returned !== undefined) return returned;
              const value: unknown = Reflect.apply(factory, undefined, [
                scopeOf(),
              ]);
              if (!isRecord(value))
                refuse("methods factory must return an object");
              for (const key of Object.keys(value)) {
                const problem = owns(key, schema);
                if (problem) refuse(`methods returned "${key}", ${problem}`);
              }
              returned = value;
              return value;
            },
            scope: scopeOf,
            refuse,
          });
        },
        bindNone: (extension, values, previous) => {
          for (const key of Object.keys(values)) notBound(extension, key);
          return { ...previous };
        },
      };
    },
  };
}
