import type { TransactionClient, VibORMConfig } from "@client/client";
import { RAW_METHOD_NAMES, type RawSurface } from "@client/raw";
import type { Client, ClientRelationDefaults } from "@client/types";
import { ClientInitializationError } from "@errors";
import { ROUTED_OPERATIONS } from "@query-engine/write-engine/routing";
import { isFunction, isRecord } from "@validation/value-guards";
import type { ResolvedExtensionChain } from "./chain";
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
type ExtensionCacheState = typeof extensionCacheState;
declare const extensionResultConsumerState: unique symbol;
type ExtensionResultConsumerState = typeof extensionResultConsumerState;

/** The only static facts accumulated while extensions are chained. */
export interface ClientExtensionState<
  ClientMethods extends object = NoMethods,
  ModelMethods extends object = NoMethods,
  CacheState extends ExtensionCacheState | undefined = undefined,
  ResultConsumerState extends
    | ExtensionResultConsumerState
    | undefined = undefined,
> {
  readonly client: ClientMethods;
  readonly models: ModelMethods;
  readonly cache: CacheState;
  readonly resultConsumer: ResultConsumerState;
}

export type EmptyClientExtensionState = ClientExtensionState;

/** Internal constraint for either the absent or enabled nominal cache bit. */
export type ExtensionStateConstraint = ClientExtensionState<
  object,
  object,
  ExtensionCacheState | undefined,
  ExtensionResultConsumerState | undefined
>;

/** Whether the current type-state includes the official cache capability. */
export type HasExtensionCache<X extends ExtensionStateConstraint> = [
  X["cache"],
] extends [ExtensionCacheState]
  ? true
  : false;

/** Add the official cache capability without carrying its runtime config. */
export type EnableExtensionCache<X extends ExtensionStateConstraint> =
  ClientExtensionState<
    X["client"],
    X["models"],
    ExtensionCacheState,
    X["resultConsumer"]
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

/** Model delegates after the methods contributed by the current chain. */
export type ExtensionModelClient<
  C extends VibORMConfig,
  X extends ExtensionStateConstraint,
> = {
  [ModelName in keyof C["schema"]]: Client<
    C,
    ClientRelationDefaults<C>,
    HasExtensionCache<X>
  >[ModelName] &
    MethodsForModel<X, ModelName>;
};

/** The surface given to one client-method factory. */
export type ExtensionClientScope<
  C extends VibORMConfig,
  X extends ExtensionStateConstraint,
> = ExtensionModelClient<C, X> &
  RawSurface &
  X["client"] & {
    readonly $schema: C["schema"];
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

type ModelFactoryGuard<
  Factory,
  C extends VibORMConfig,
  X extends ExtensionStateConstraint,
  ModelName extends keyof C["schema"],
> = Factory extends (...args: never[]) => infer Methods
  ? Methods extends object
    ? GuardMethodFactory<
        Factory,
        | Extract<
            keyof Methods,
            keyof Client<C>[ModelName] | keyof MethodsForModel<X, ModelName>
          >
        | Extract<keyof Methods, "then">
        | NonFunctionKeys<Methods>
      >
    : never
  : never;

type ModelFactoriesGuard<
  Definition,
  C extends VibORMConfig,
  X extends ExtensionStateConstraint,
> = Definition extends { readonly model: infer Factories }
  ? Factories extends object
    ? {
        readonly model: Record<
          Exclude<keyof Factories, keyof C["schema"]>,
          never
        > & {
          readonly [ModelName in keyof Factories]: ModelName extends keyof C["schema"]
            ? ModelFactoryGuard<Factories[ModelName], C, X, ModelName>
            : never;
        };
      }
    : { readonly model: never }
  : unknown;

export type ExtensionMethodDefinitionGuard<
  Definition,
  C extends VibORMConfig,
  X extends ExtensionStateConstraint,
> = ClientFactoryGuard<Definition, C, X> &
  ModelFactoriesGuard<Definition, C, X>;

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

type ResultConsumerStateOf<
  X extends ExtensionStateConstraint,
  Definition,
> = ResultConsumerContextOf<Definition> extends "result-consuming"
  ? ExtensionResultConsumerState
  : X["resultConsumer"];

export type MergeExtensionState<
  X extends ExtensionStateConstraint,
  Definition,
> = ClientExtensionState<
  X["client"] & ClientMethodsOf<Definition>,
  MergeModelMethods<X["models"], ModelMethodsOf<Definition>>,
  X["cache"],
  ResultConsumerStateOf<X, Definition>
>;

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
