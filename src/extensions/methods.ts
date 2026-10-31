import type { TransactionClient, VibORMConfig } from "@client/client";
import { RAW_METHOD_NAMES, type RawSurface } from "@client/raw";
import type { ClientSchema } from "@client/schema-links";
import type {
  Client,
  ClientRowsContext,
  ComputedOperation,
  ComputedOperations,
  Operations,
  StampedOperation,
  StampedOperations,
} from "@client/types";
import { ClientInitializationError } from "@errors";
import { ROUTED_OPERATIONS } from "@query-engine/routed-operations";
import { isFunction, isRecord } from "@validation/value-guards";
import type { OfficialCacheControls } from "../cache/capability";
import { errorCause } from "../errors/diagnostic-safety";
import type { ResolvedExtensionChain } from "./chain";
import type {
  DefinitionControls,
  DefinitionData,
  NoControls,
  RowsModels,
} from "./controls";
import { extensionError } from "./definition";
import type { DefinitionResultFields, MergeResultFields } from "./result-types";

type NoMethods = Record<never, never>;
type ExtensionMethod = (this: void, ...args: never[]) => unknown;
export type ExtensionMethodRecord = Readonly<Record<string, ExtensionMethod>>;

export type RuntimeExtensionMethodFunction = (...args: never[]) => unknown;
export type RuntimeClientMethodContribution = RuntimeExtensionMethodFunction;
export type RuntimeModelMethodContribution = Readonly<
  Record<string, RuntimeExtensionMethodFunction>
>;

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
  CacheState extends ExtensionCacheState | undefined = undefined,
  ResultConsumerState extends
    | ExtensionResultConsumerState
    | undefined = undefined,
  Controls extends object = NoControls,
  RowModels extends string = never,
  Data = never,
  Result extends object = Record<never, never>,
> {
  readonly client: ClientMethods;
  readonly models: ModelMethods;
  readonly cache: CacheState;
  readonly resultConsumer: ResultConsumerState;
  /** The controls the chain declares: each one's values and placement. */
  readonly controls: Controls;
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

/**
 * Add the official cache capability without carrying its runtime config. Its
 * one control, `cache` on every write, joins the chain's controls as its
 * definition declares it.
 */
export type EnableExtensionCache<X extends ExtensionStateConstraint> =
  ClientExtensionState<
    X["client"],
    X["models"],
    ExtensionCacheState,
    X["resultConsumer"],
    X["controls"] &
      DefinitionControls<{ readonly controls: OfficialCacheControls }>,
    X["rows"],
    X["data"],
    X["result"]
  >;

/** Whether an earlier extension was typed against result-bearing delegates. */
export type HasResultConsumingExtension<X extends ExtensionStateConstraint> = [
  X["resultConsumer"],
] extends [undefined]
  ? false
  : [X["resultConsumer"]] extends [ExtensionResultConsumerState]
    ? true
    : false;

type MethodsForModel<
  X extends ExtensionStateConstraint,
  ModelName extends PropertyKey,
> = ModelName extends keyof X["models"] ? X["models"][ModelName] : NoMethods;

/**
 * One model's delegate after the chain's methods and controls. On a chain
 * that declares create `data`, its writes may leave out the fields the chain
 * writes on a create.
 */
export type ExtensionModelDelegate<
  C extends VibORMConfig,
  X extends ExtensionStateConstraint,
  ModelName extends keyof ClientSchema<C>,
> = ([X["data"]] extends [never]
  ? Client<C, ClientRowsContext<C, X["rows"]>, X["controls"]>[ModelName]
  : Omit<
      Client<C, ClientRowsContext<C, X["rows"]>, X["controls"]>[ModelName],
      StampedOperation
    > &
      StampedOperations<
        C,
        ClientRowsContext<C, X["rows"]>,
        X["controls"],
        X["data"],
        ModelName
      >) &
  MethodsForModel<X, ModelName>;

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
    X["controls"],
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
     * these values of this extension's own controls as if passed (a
     * `bound: true` control only from here). Its type is that client's,
     * which only the method knows: declare it with a `this` parameter,
     * `$with<Self>(this: Self, value: Value): Self`, outside the returned
     * literal (inside it, the factory's contextual type makes `Self` void).
     */
    readonly $bind: (values: Readonly<Record<string, unknown>>) => unknown;
  };

type NonFunctionKeys<Methods extends object> = {
  [Key in keyof Methods]: Methods[Key] extends CallableFunction ? never : Key;
}[keyof Methods];

type InvalidClientMethodKeys<
  Methods extends object,
  C extends VibORMConfig,
  X extends ExtensionStateConstraint,
> =
  | Exclude<keyof Methods, `$${string}`>
  | Extract<
      keyof Methods,
      | keyof RawSurface
      | "$driver"
      | "$schema"
      | "$transaction"
      | "$connect"
      | "$disconnect"
      | "$withCache"
      | "$invalidate"
      | "$extends"
      | keyof X["client"]
    >
  | (string extends keyof C["schema"]
      ? never
      : Extract<keyof Methods, keyof C["schema"]>)
  | NonFunctionKeys<Methods>;

type GuardMethodFactory<
  Factory,
  Forbidden extends PropertyKey,
> = Factory extends (...args: infer Params) => infer Methods
  ? Methods extends object
    ? (...args: Params) => Methods & Record<Forbidden, never>
    : (...args: Params) => never
  : never;

type ClientFactoryGuard<
  Definition,
  C extends VibORMConfig,
  X extends ExtensionStateConstraint,
> = Definition extends { readonly client: infer Factory }
  ? Factory extends (...args: never[]) => infer Methods
    ? Methods extends object
      ? {
          readonly client: GuardMethodFactory<
            Factory,
            InvalidClientMethodKeys<Methods, C, X>
          >;
        }
      : { readonly client: never }
    : { readonly client: never }
  : unknown;

/**
 * What every model factory may not return: a core operation or `then`. That
 * each returned member is a function is the definition's own factory type
 * (`ModelMethodFactory` returns an `ExtensionMethodRecord`), not this guard;
 * `object` only keeps the all-optional key list from being a weak type, which
 * would refuse every return that names none of those keys. Stated as a target
 * shape, not a conditional over the factory, so a factory map generic over the
 * client is checked rather than deferred. A method a prior extension put on
 * the model cannot be named here for a client generic over its extension
 * state: the runtime refuses that replacement when the extension is applied.
 */
type ModelFactoryGuard = (...args: never[]) => object & {
  readonly [Name in Operations | "then"]?: never;
};

/**
 * Model keys outside the schema are refused by the definition's own `model`
 * type (its per-schema factory table); this guard checks each factory's
 * methods.
 */
type ModelFactoriesGuard<Definition> = Definition extends {
  readonly model: infer Factories;
}
  ? {
      readonly model: {
        readonly [ModelName in keyof Factories]: ModelFactoryGuard;
      };
    }
  : unknown;

export type ExtensionMethodDefinitionGuard<
  Definition,
  C extends VibORMConfig,
  X extends ExtensionStateConstraint,
> = ClientFactoryGuard<Definition, C, X> & ModelFactoriesGuard<Definition>;

type ClientMethodsOf<Definition> = Definition extends {
  readonly client: (...args: never[]) => infer Methods;
}
  ? Methods extends object
    ? Methods
    : NoMethods
  : NoMethods;

type ModelMethodsOf<Definition> = Definition extends {
  readonly model: infer Factories;
}
  ? Factories extends object
    ? {
        readonly [ModelName in keyof Factories]: Factories[ModelName] extends (
          ...args: never[]
        ) => infer Methods
          ? Methods extends object
            ? Methods
            : NoMethods
          : NoMethods;
      }
    : NoMethods
  : NoMethods;

export type MergeModelMethods<Left extends object, Right extends object> = {
  readonly [ModelName in
    | keyof Left
    | keyof Right]: (ModelName extends keyof Left
    ? Left[ModelName]
    : NoMethods) &
    (ModelName extends keyof Right ? Right[ModelName] : NoMethods);
};

export type ResultConsumerContextOf<Definition> = Definition extends
  | { readonly client: unknown }
  | { readonly model: unknown }
  ? "result-consuming"
  : Definition extends { readonly query: infer Query }
    ? Query extends CallableFunction
      ? "result-independent"
      : "result-consuming"
    : "result-independent";

/** Incoming facts keep their nominal bit derivation inside this named state. */
export interface ExtensionContributionState<
  ClientMethods extends object,
  ModelMethods extends object,
  Controls extends object,
  RowModels extends string,
  Data,
  ConsumerContext extends string,
  // Defaulted: 1.3.3 exported this state with six parameters.
  Result extends object = Record<never, never>,
> extends ExtensionStateConstraint {
  readonly client: ClientMethods;
  readonly models: ModelMethods;
  readonly cache: undefined;
  readonly resultConsumer: ConsumerContext extends "result-consuming"
    ? ExtensionResultConsumerState
    : undefined;
  readonly controls: Controls;
  readonly rows: RowModels;
  readonly data: Data;
  readonly result: Result;
}

/** Retain contribution facts, never the factory's contextual argument surface. */
export type ExtensionStateContributionOf<Definition> = [Definition] extends [
  unknown,
]
  ? ExtensionContributionState<
      ClientMethodsOf<Definition>,
      ModelMethodsOf<Definition>,
      DefinitionControls<Definition>,
      RowsModels<Definition>,
      DefinitionData<Definition>,
      ResultConsumerContextOf<Definition>,
      DefinitionResultFields<Definition>
    >
  : never;

/** Accumulate the same seven facts lazily, without retaining callback definitions. */
export interface AccumulatedExtensionState<
  X extends ExtensionStateConstraint,
  Contribution extends ExtensionStateConstraint,
> extends ExtensionStateConstraint {
  readonly client: X["client"] & Contribution["client"];
  readonly models: MergeModelMethods<X["models"], Contribution["models"]>;
  readonly cache: X["cache"];
  readonly resultConsumer: HasResultConsumingExtension<Contribution> extends true
    ? ExtensionResultConsumerState
    : X["resultConsumer"];
  readonly controls: X["controls"] & Contribution["controls"];
  readonly rows: X["rows"] | Contribution["rows"];
  readonly data: X["data"] | Contribution["data"];
  readonly result: MergeResultFields<X["result"], Contribution["result"]>;
}

/** Public compatibility surface: the incoming argument remains a definition. */
export type MergeExtensionState<
  X extends ExtensionStateConstraint,
  Definition,
> = AccumulatedExtensionState<X, ExtensionStateContributionOf<Definition>>;

type MethodRecord = Readonly<Record<string, RuntimeExtensionMethodFunction>>;

/**
 * The methods a view answers after some prefix of its chain: its client
 * methods, and one model's. Each is computed the first time it is read.
 */
export interface ExtensionMethods {
  readonly client: () => MethodRecord;
  readonly model: (model: string) => MethodRecord;
}

const NO_METHODS: MethodRecord = Object.freeze(Object.create(null));
const NO_LAYER: ExtensionMethods = Object.freeze({
  client: () => NO_METHODS,
  model: () => NO_METHODS,
});

const CORE_CLIENT_METHODS = new Set([
  "$driver",
  "$schema",
  "$transaction",
  "$connect",
  "$disconnect",
  "$withCache",
  "$invalidate",
  "$extends",
]);

function readMethodRecord(
  value: unknown,
  label: string,
  extension: string
): Record<string, RuntimeExtensionMethodFunction> {
  if (!isRecord(value)) {
    extensionError(
      `Extension "${extension}" ${label} factory must return an object.`,
      extension
    );
  }
  const methods: Record<string, RuntimeExtensionMethodFunction> =
    Object.create(null);
  let names: PropertyKey[];
  try {
    names = Reflect.ownKeys(value);
  } catch (cause) {
    throw new ClientInitializationError(
      `Extension "${extension}" ${label} methods could not be inspected.`,
      { cause: errorCause(cause), meta: { extension } }
    );
  }
  for (const name of names) {
    if (typeof name !== "string") {
      extensionError(
        `Extension "${extension}" ${label} returned a non-string method key.`,
        extension
      );
    }
    let method: unknown;
    try {
      method = value[name];
    } catch (cause) {
      throw new ClientInitializationError(
        `Extension "${extension}" ${label} method "${name}" could not be read.`,
        { cause: errorCause(cause), meta: { extension } }
      );
    }
    if (!isFunction(method)) {
      extensionError(
        `Extension "${extension}" ${label} method "${name}" must be a function.`,
        extension
      );
    }
    methods[name] = bindExtensionMethod(method);
  }
  return methods;
}

function invokeFactory(
  factory: RuntimeExtensionMethodFunction,
  argument: unknown,
  label: string,
  extension: string,
  scope?: unknown
): unknown {
  try {
    return Reflect.apply(
      factory,
      undefined,
      scope === undefined ? [argument] : [argument, scope]
    );
  } catch (cause) {
    throw new ClientInitializationError(
      `Extension "${extension}" ${label} factory failed.`,
      { cause: errorCause(cause), meta: { extension } }
    );
  }
}

function bindExtensionMethod(
  method: RuntimeExtensionMethodFunction
): RuntimeExtensionMethodFunction {
  return (...args: never[]) => Reflect.apply(method, undefined, args);
}

/** The methods before one extension with its own added, each name checked. */
function addMethods(
  previous: MethodRecord,
  added: MethodRecord,
  check: (name: string, taken: boolean) => void
): MethodRecord {
  const methods: Record<string, RuntimeExtensionMethodFunction> =
    Object.create(null);
  Object.assign(methods, previous);
  for (const [name, method] of Object.entries(added)) {
    check(name, Object.hasOwn(methods, name));
    methods[name] = method;
  }
  return Object.freeze(methods);
}

/**
 * The methods of one view's chain. Extension `i`'s factories are invoked
 * against the scope `createScope` builds over the methods of the extensions
 * before it, the first time a method they return could be read, one model at
 * a time: a view costs the factories it uses. `force` invokes every factory
 * in chain order, where a root view surfaces an extension's faults.
 */
export function bindExtensionMethods(
  chain: ResolvedExtensionChain,
  createScope: (prior: ExtensionMethods, extension: string) => object
): ExtensionMethods & { readonly force: () => void } {
  const layers: ExtensionMethods[] = [NO_LAYER];
  for (const {
    name,
    client: clientFactory,
    model: modelFactories,
  } of chain.extensions) {
    const prior = layers.at(-1)!;
    let scope: object | undefined;
    const scopeOf = () => (scope ??= createScope(prior, name));
    let client: MethodRecord | undefined;
    const models = new Map<string, MethodRecord>();
    layers.push({
      client: () =>
        (client ??=
          clientFactory === undefined
            ? prior.client()
            : addMethods(
                prior.client(),
                readMethodRecord(
                  invokeFactory(clientFactory, scopeOf(), "client", name),
                  "client",
                  name
                ),
                (method, taken) => {
                  if (!method.startsWith("$")) {
                    extensionError(
                      `Extension "${name}" client method "${method}" must be dollar-prefixed.`,
                      name
                    );
                  }
                  if (
                    taken ||
                    CORE_CLIENT_METHODS.has(method) ||
                    Object.hasOwn(RAW_METHOD_NAMES, method)
                  ) {
                    extensionError(
                      `Extension "${name}" client method "${method}" collides with the existing client surface.`,
                      name
                    );
                  }
                }
              )),
      model: (model) => {
        let methods = models.get(model);
        if (methods === undefined) {
          const factory = modelFactories?.[model];
          const label = `model.${model}`;
          methods =
            factory === undefined
              ? prior.model(model)
              : addMethods(
                  prior.model(model),
                  readMethodRecord(
                    invokeFactory(
                      factory,
                      Reflect.get(scopeOf(), model),
                      label,
                      name,
                      // The client scope, as a client factory receives it:
                      // what a model method needs beyond its own delegate.
                      scopeOf()
                    ),
                    label,
                    name
                  ),
                  (method, taken) => {
                    if (
                      taken ||
                      method === "then" ||
                      ROUTED_OPERATIONS.has(method)
                    ) {
                      extensionError(
                        `Extension "${name}" model method "${model}.${method}" collides with the existing model surface.`,
                        name
                      );
                    }
                  }
                );
          models.set(model, methods);
        }
        return methods;
      },
    });
  }
  const view = layers.at(-1)!;
  return {
    client: view.client,
    model: view.model,
    force: () => {
      for (const [index, { model }] of chain.extensions.entries()) {
        const layer = layers[index + 1]!;
        layer.client();
        for (const name of Object.keys(model ?? {})) layer.model(name);
      }
    },
  };
}
