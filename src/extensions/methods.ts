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
import { ClientInitializationError } from "@errors";
import type { ModelSql } from "@query-engine/raptor3/shared/insert-value";
import { ROUTED_OPERATIONS } from "@query-engine/routed-operations";
import { isFunction, isRecord } from "@validation/value-guards";
import type { OfficialCacheControls } from "../cache/schema";
import { errorCause } from "../errors/diagnostic-safety";
import type { ExtensionPart } from "./chain";
import {
  type AdmittedControls,
  type DefinitionControls,
  type NoControls,
  undeclaredBinding,
} from "./controls";
import { extensionError } from "./definition";
import type { MergeResultFields } from "./result-types";

type NoMethods = Record<never, never>;
type ExtensionMethod = (this: void, ...args: never[]) => unknown;
export type ExtensionMethodRecord = Readonly<Record<string, ExtensionMethod>>;

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
  MethodsForModel<X, ModelName> &
  DelegateLink<C, X, ModelName> &
  ModelRows;

/** The core member every model delegate has beside its operations. */
interface ModelRows {
  /**
   * The rows of this model this client may read, as a `FROM` item of a
   * tagged `$queryRaw` named `alias`: a derived table filtered by the row
   * domain a `findMany` of this model on this client takes (permissions,
   * soft delete, bound controls). Refused anywhere else.
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
  Controls extends object,
  RowModels extends string,
  Data,
  ConsumerContext extends string,
  // Defaulted: 1.3.3 exported this state with six parameters.
  Result extends object = Record<never, never>,
  CacheState extends ExtensionCacheState | undefined = undefined,
> extends ExtensionStateConstraint {
  readonly client: ClientMethods;
  readonly models: ModelMethods;
  readonly cache: CacheState;
  readonly resultConsumer: ConsumerContext extends "result-consuming"
    ? ExtensionResultConsumerState
    : undefined;
  readonly controls: Controls;
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
  readonly controls: X["controls"] & Contribution["controls"];
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
  "$extends",
]);

/**
 * The methods before one extension with its own added, each a function and
 * each name checked against what the view already answers.
 */
function addMethods(
  previous: MethodRecord,
  added: readonly (readonly [string, unknown])[],
  refuse: (problem: string) => never,
  collides: (name: string) => boolean,
  surface: "client" | "model",
  label: (name: string) => string
): MethodRecord {
  const methods: Record<string, RuntimeExtensionMethodFunction> =
    Object.create(null);
  Object.assign(methods, previous);
  for (const [name, method] of added) {
    if (!isFunction(method)) refuse(`${label(name)} must be a function`);
    if (Object.hasOwn(methods, name) || collides(name))
      refuse(`${label(name)} collides with the existing ${surface} surface`);
    methods[name] = method;
  }
  return Object.freeze(methods);
}

/**
 * The methods of one view's chain. Extension `i`'s factory is invoked against
 * the scope `createScope` builds over the methods of the extensions before
 * it, the first time a method it returns could be read: a view costs the
 * factories it uses. `force` invokes every factory in chain order, where a
 * root view surfaces an extension's faults.
 */
export function bindExtensionMethods(
  entries: readonly MethodEntry[],
  createScope: (prior: ExtensionMethods, extension: string) => object
): BoundExtensionMethods {
  const layers: ExtensionMethods[] = [NO_LAYER];
  const made: (() => Readonly<Record<string, unknown>>)[] = [];
  for (const { name, factory, schema } of entries) {
    const prior = layers.at(-1)!;
    // Typed where it is declared, so a call to it ends the control flow.
    const refuse: (problem: string) => never = (problem) =>
      extensionError(`Extension "${name}" ${problem}.`, name);
    let scope: object | undefined;
    const scopeOf = () => (scope ??= createScope(prior, name));
    let returned: Readonly<Record<string, unknown>> | undefined;
    // The factory's answer, once per view: the client's methods and each
    // model's come from it.
    const answer = (): Readonly<Record<string, unknown>> => {
      if (returned !== undefined) return returned;
      let value: unknown;
      try {
        value = Reflect.apply(factory, undefined, [scopeOf()]);
      } catch (cause) {
        throw new ClientInitializationError(
          `Extension "${name}" methods factory failed.`,
          { cause: errorCause(cause), meta: { extension: name } }
        );
      }
      if (!isRecord(value)) refuse("methods factory must return an object");
      for (const key of Object.keys(value))
        if (!(key.startsWith("$") || Object.hasOwn(schema, key)))
          refuse(
            `methods returned "${key}", which is neither a $ client method nor a model`
          );
      returned = value;
      return value;
    };
    made.push(answer);
    let client: MethodRecord | undefined;
    const models = new Map<string, MethodRecord>();
    layers.push({
      client: () =>
        (client ??= addMethods(
          prior.client(),
          Object.entries(answer()).filter(([key]) => key.startsWith("$")),
          refuse,
          (method) =>
            CORE_CLIENT_METHODS.has(method) ||
            Object.hasOwn(RAW_METHOD_NAMES, method),
          "client",
          (method) => `client method "${method}"`
        )),
      model: (model) => {
        let methods = models.get(model);
        if (methods === undefined) {
          const given = answer()[model];
          // A model's entry may be a function of its delegate and the scope.
          const delegate: unknown = Reflect.get(scopeOf(), model);
          const own: unknown = isFunction(given)
            ? Reflect.apply(given, undefined, [delegate, scopeOf()])
            : given;
          if (own !== undefined && !isRecord(own))
            refuse(`methods.${model} must be an object of methods`);
          methods = addMethods(
            prior.model(model),
            // A model method is called with `this` equal to its delegate.
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
            (method) => `model method "${model}.${method}"`
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
      for (const [index, answer] of made.entries()) {
        const layer = layers[index + 1]!;
        layer.client();
        for (const key of Object.keys(answer()))
          if (!key.startsWith("$")) layer.model(key);
      }
    },
  };
}

/** A `methods` factory as a definition keeps it. */
export type RuntimeMethodsFactory = (scope: never) => unknown;

/**
 * One extension's methods factory, as the chain keeps it, and the schema it
 * was applied to: a key it returns names a `$` client method or a model.
 */
export interface MethodEntry {
  readonly name: string;
  readonly factory: RuntimeMethodsFactory;
  readonly schema: Schema;
}

export type BoundExtensionMethods = ExtensionMethods & {
  readonly force: () => void;
};

/** A chain's method factories, and what binds one view's methods. */
export interface ExtensionMethodsState {
  readonly entries: readonly MethodEntry[];
  readonly bind: (
    createScope: (prior: ExtensionMethods, extension: string) => object
  ) => BoundExtensionMethods;
  /**
   * A factory scope's `$bind` on a chain that declares no control: it binds
   * nothing, and refuses any control it is asked to.
   */
  readonly bindNone: (
    extension: string,
    values: Readonly<Record<string, unknown>>,
    previous: AdmittedControls | undefined
  ) => AdmittedControls;
}

/** `methods`: what a view answers, in chain order. */
export const methodsPart: ExtensionPart = {
  join({ next, chain, definition, schema }) {
    const { name, methods: factory } = definition;
    if (factory === undefined) return;
    const entries = Object.freeze([
      ...(chain?.methods?.entries ?? []),
      Object.freeze({ name, factory, schema }),
    ]);
    next.methods = Object.freeze({
      entries,
      bind: (
        createScope: (prior: ExtensionMethods, extension: string) => object
      ) => bindExtensionMethods(entries, createScope),
      bindNone: (
        extension: string,
        values: Readonly<Record<string, unknown>>,
        previous: AdmittedControls | undefined
      ) => {
        for (const control of Object.keys(values))
          undeclaredBinding(extension, control);
        return Object.freeze({ ...previous });
      },
    });
  },
};
