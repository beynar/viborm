import type { TransactionClient, VibORMConfig } from "@client/client";
import { RAW_METHOD_NAMES, type RawSurface } from "@client/raw";
import type { ClientSchema } from "@client/schema-links";
import type {
  Client,
  ClientRowsContext,
  Operations,
  StampedOperation,
  StampedOperations,
} from "@client/types";
import { ClientInitializationError } from "@errors";
import { ROUTED_OPERATIONS } from "@query-engine/routed-operations";
import { isFunction, isRecord } from "@validation/value-guards";
import type { OfficialCacheControls } from "../cache/capability";
import type { ResolvedExtensionChain } from "./chain";
import type {
  DefinitionControls,
  DefinitionData,
  NoControls,
  RowsModels,
} from "./controls";
import { extensionCause, extensionError } from "./definition";

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
  unknown
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
    X["data"]
  >;

/** Whether an earlier extension was typed against result-bearing delegates. */
export type HasResultConsumingExtension<X extends ExtensionStateConstraint> = [
  X["resultConsumer"],
] extends [ExtensionResultConsumerState]
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
 * Model delegates after the methods contributed by the current chain. The
 * always-true test is deliberate: for a client generic over its config it
 * stays deferred, so the model map adds no index signature to that client and
 * its `$` members stay reachable inside a body generic over `C`.
 */
export type ExtensionModelClient<
  C extends VibORMConfig,
  X extends ExtensionStateConstraint,
> = [keyof C["schema"]] extends [PropertyKey]
  ? {
      [ModelName in keyof ClientSchema<C>]: ExtensionModelDelegate<
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

type MergeModelMethods<Left extends object, Right extends object> = {
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
      ResultConsumerContextOf<Definition>
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
}

/** Public compatibility surface: the incoming argument remains a definition. */
export type MergeExtensionState<
  X extends ExtensionStateConstraint,
  Definition,
> = AccumulatedExtensionState<X, ExtensionStateContributionOf<Definition>>;

export interface BoundExtensionMethods {
  readonly client: Readonly<Record<string, RuntimeExtensionMethodFunction>>;
  readonly models: Readonly<
    Record<string, Readonly<Record<string, RuntimeExtensionMethodFunction>>>
  >;
}

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
      { cause: extensionCause(cause), meta: { extension } }
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
        { cause: extensionCause(cause), meta: { extension } }
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
  extension: string
): unknown {
  try {
    return Reflect.apply(factory, undefined, [argument]);
  } catch (cause) {
    throw new ClientInitializationError(
      `Extension "${extension}" ${label} factory failed.`,
      { cause: extensionCause(cause), meta: { extension } }
    );
  }
}

function bindExtensionMethod(
  method: RuntimeExtensionMethodFunction
): RuntimeExtensionMethodFunction {
  return (...args: never[]) => Reflect.apply(method, undefined, args);
}

function snapshotMethods(
  clientMethods: Readonly<Record<string, RuntimeExtensionMethodFunction>>,
  modelMethods: Readonly<
    Record<string, Readonly<Record<string, RuntimeExtensionMethodFunction>>>
  >
): BoundExtensionMethods {
  const client: Record<string, RuntimeExtensionMethodFunction> =
    Object.create(null);
  for (const [name, method] of Object.entries(clientMethods)) {
    client[name] = method;
  }
  const models: Record<
    string,
    Readonly<Record<string, RuntimeExtensionMethodFunction>>
  > = Object.create(null);
  for (const [modelName, methods] of Object.entries(modelMethods)) {
    const model: Record<string, RuntimeExtensionMethodFunction> =
      Object.create(null);
    for (const [name, method] of Object.entries(methods)) {
      model[name] = method;
    }
    models[modelName] = Object.freeze(model);
  }
  return Object.freeze({
    client: Object.freeze(client),
    models: Object.freeze(models),
  });
}

export function bindExtensionMethods(
  chain: ResolvedExtensionChain,
  createScope: (
    clientMethods: Readonly<Record<string, RuntimeExtensionMethodFunction>>,
    modelMethods: Readonly<
      Record<string, Readonly<Record<string, RuntimeExtensionMethodFunction>>>
    >
  ) => object
): BoundExtensionMethods {
  const clientMethods: Record<string, RuntimeExtensionMethodFunction> =
    Object.create(null);
  const modelMethods: Record<
    string,
    Record<string, RuntimeExtensionMethodFunction>
  > = Object.create(null);

  for (const extension of chain.extensions) {
    const prior = snapshotMethods(clientMethods, modelMethods);
    const scope = createScope(prior.client, prior.models);
    const nextClientMethods = extension.client
      ? readMethodRecord(
          invokeFactory(extension.client, scope, "client", extension.name),
          "client",
          extension.name
        )
      : undefined;
    const nextModelMethods: Record<
      string,
      Record<string, RuntimeExtensionMethodFunction>
    > = Object.create(null);
    if (extension.model) {
      for (const [modelName, factory] of Object.entries(extension.model)) {
        const delegate = Reflect.get(scope, modelName);
        nextModelMethods[modelName] = readMethodRecord(
          invokeFactory(
            factory,
            delegate,
            `model.${modelName}`,
            extension.name
          ),
          `model.${modelName}`,
          extension.name
        );
      }
    }

    if (nextClientMethods) {
      for (const [name, method] of Object.entries(nextClientMethods)) {
        if (!name.startsWith("$")) {
          extensionError(
            `Extension "${extension.name}" client method "${name}" must be dollar-prefixed.`,
            extension.name
          );
        }
        if (
          CORE_CLIENT_METHODS.has(name) ||
          Object.hasOwn(RAW_METHOD_NAMES, name) ||
          Object.hasOwn(clientMethods, name)
        ) {
          extensionError(
            `Extension "${extension.name}" client method "${name}" collides with the existing client surface.`,
            extension.name
          );
        }
        clientMethods[name] = method;
      }
    }

    for (const [modelName, methods] of Object.entries(nextModelMethods)) {
      const accumulated = (modelMethods[modelName] ??= Object.create(null));
      for (const [name, method] of Object.entries(methods)) {
        if (
          name === "then" ||
          ROUTED_OPERATIONS.has(name) ||
          Object.hasOwn(accumulated, name)
        ) {
          extensionError(
            `Extension "${extension.name}" model method "${modelName}.${name}" collides with the existing model surface.`,
            extension.name
          );
        }
        accumulated[name] = method;
      }
    }
  }

  return snapshotMethods(clientMethods, modelMethods);
}
