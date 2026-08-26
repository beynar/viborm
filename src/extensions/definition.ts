import type { VibORMConfig } from "@client/client";
import type { Operations, Schema } from "@client/types";
import type { AnyDriver } from "@drivers";
import { ClientInitializationError } from "@errors";
import { ROUTED_OPERATIONS } from "@query-engine/write-engine/routing";
import { isFunction, isRecord } from "@validation/value-guards";
import type {
  EmptyClientExtensionState,
  ExtensionClientScope,
  ExtensionMethodDefinitionGuard,
  ExtensionMethodRecord,
  ExtensionModelClient,
  ExtensionStateConstraint,
  ResultConsumerContextOf,
  RuntimeClientMethodContribution,
  RuntimeModelMethodContribution,
} from "./methods";
import type { ObserveHandler } from "./observation";
import type {
  GenericQueryHandler,
  QueryHandlerMap,
  RuntimeQueryContribution,
} from "./query";
import type {
  GenericRequestHandler,
  RequestHandlerMap,
  RuntimeRequestContribution,
} from "./request";
import type { StatementHandler } from "./statement";

type RuntimeExtensionFunction = (...args: never[]) => unknown;

/** Host-owned frozen snapshot of one validated extension definition. */
export interface RuntimeExtensionDefinition {
  readonly name: string;
  readonly request?: RuntimeRequestContribution;
  readonly query?: RuntimeQueryContribution;
  readonly statement?: RuntimeExtensionFunction;
  readonly observe?: RuntimeExtensionFunction;
  readonly client?: RuntimeClientMethodContribution;
  readonly model?: RuntimeModelMethodContribution;
}

const DEFINITION_KEYS = new Set([
  "name",
  "request",
  "query",
  "statement",
  "observe",
  "client",
  "model",
]);

export function extensionError(message: string, extension?: string): never {
  throw new ClientInitializationError(message, {
    meta: extension ? { extension } : undefined,
  });
}

export function extensionCause(cause: unknown): Error {
  try {
    if (cause instanceof Error) return cause;
  } catch {
    // A hostile thrown proxy is still normalized at this boundary.
  }
  return new Error("A non-Error value was thrown.", { cause });
}

function readOwnKeys(
  value: Record<string, unknown>,
  extension?: string
): PropertyKey[] {
  try {
    return Reflect.ownKeys(value);
  } catch (cause) {
    throw new ClientInitializationError(
      extension
        ? `Extension "${extension}" members could not be inspected.`
        : "Client extension members could not be inspected.",
      {
        cause: extensionCause(cause),
        meta: extension ? { extension } : undefined,
      }
    );
  }
}

function readOwn(
  value: Record<string, unknown>,
  key: string,
  extension?: string
): unknown {
  try {
    return value[key];
  } catch (cause) {
    throw new ClientInitializationError(
      extension
        ? `Extension "${extension}" member "${key}" could not be read.`
        : `Client extension member "${key}" could not be read.`,
      {
        cause: extensionCause(cause),
        meta: extension ? { extension } : undefined,
      }
    );
  }
}

function requireFunction(
  value: unknown,
  label: string,
  extension: string
): RuntimeExtensionFunction {
  if (!isFunction(value)) {
    extensionError(
      `Extension "${extension}" ${label} must be a function.`,
      extension
    );
  }
  return value;
}

function snapshotOperationMap(
  component: unknown,
  label: "request" | "query",
  extension: string,
  schema?: Schema
): RuntimeExtensionDefinition["request"] {
  if (isFunction(component)) return component;
  if (!isRecord(component)) {
    extensionError(
      `Extension "${extension}" ${label} must be a function or model map.`,
      extension
    );
  }

  const models: Record<
    string,
    Readonly<Record<string, RuntimeExtensionFunction>>
  > = Object.create(null);
  for (const modelKey of readOwnKeys(component, extension)) {
    if (typeof modelKey !== "string") {
      extensionError(
        `Extension "${extension}" ${label} contains a non-string model key.`,
        extension
      );
    }
    if (schema && !Object.hasOwn(schema, modelKey)) {
      extensionError(
        `Extension "${extension}" ${label} names unknown model "${modelKey}".`,
        extension
      );
    }
    const handlers = readOwn(component, modelKey, extension);
    if (!isRecord(handlers)) {
      extensionError(
        `Extension "${extension}" ${label}.${modelKey} must be an operation map.`,
        extension
      );
    }
    const operations: Record<string, RuntimeExtensionFunction> =
      Object.create(null);
    for (const operationKey of readOwnKeys(handlers, extension)) {
      if (typeof operationKey !== "string") {
        extensionError(
          `Extension "${extension}" ${label}.${modelKey} contains a non-string operation key.`,
          extension
        );
      }
      if (!ROUTED_OPERATIONS.has(operationKey)) {
        extensionError(
          `Extension "${extension}" ${label}.${modelKey} names unknown operation "${operationKey}".`,
          extension
        );
      }
      operations[operationKey] = requireFunction(
        readOwn(handlers, operationKey, extension),
        `${label}.${modelKey}.${operationKey}`,
        extension
      );
    }
    models[modelKey] = Object.freeze(operations);
  }
  return Object.freeze(models);
}

function snapshotModelFactories(
  component: unknown,
  extension: string,
  schema?: Schema
): RuntimeExtensionDefinition["model"] {
  if (!isRecord(component)) {
    extensionError(
      `Extension "${extension}" model must be a model map.`,
      extension
    );
  }
  const factories: Record<string, RuntimeExtensionFunction> =
    Object.create(null);
  for (const modelKey of readOwnKeys(component, extension)) {
    if (typeof modelKey !== "string") {
      extensionError(
        `Extension "${extension}" model contains a non-string model key.`,
        extension
      );
    }
    if (schema && !Object.hasOwn(schema, modelKey)) {
      extensionError(
        `Extension "${extension}" model names unknown model "${modelKey}".`,
        extension
      );
    }
    factories[modelKey] = requireFunction(
      readOwn(component, modelKey, extension),
      `model.${modelKey}`,
      extension
    );
  }
  return Object.freeze(factories);
}

/**
 * Read a caller-owned definition once, validate it, and freeze only host-owned
 * snapshots. A failed application therefore cannot mutate the supplied value.
 */
export function normalizeExtensionDefinition(
  value: unknown,
  schema?: Schema
): RuntimeExtensionDefinition {
  if (!isRecord(value)) {
    extensionError("Client extension must be an object.");
  }
  const ownKeys = readOwnKeys(value);
  if (!ownKeys.includes("name")) {
    extensionError("Client extension name must be a non-empty string.");
  }
  const rawName = readOwn(value, "name");
  if (typeof rawName !== "string" || rawName.trim().length === 0) {
    extensionError("Client extension name must be a non-empty string.");
  }
  const name = rawName;
  for (const key of ownKeys) {
    if (typeof key !== "string" || !DEFINITION_KEYS.has(key)) {
      extensionError(
        `Extension "${name}" has unknown member "${String(key)}".`,
        name
      );
    }
  }

  const rawRequest = ownKeys.includes("request")
    ? readOwn(value, "request", name)
    : undefined;
  const request =
    rawRequest === undefined
      ? undefined
      : snapshotOperationMap(rawRequest, "request", name, schema);
  const rawQuery = ownKeys.includes("query")
    ? readOwn(value, "query", name)
    : undefined;
  const query =
    rawQuery === undefined
      ? undefined
      : snapshotOperationMap(rawQuery, "query", name, schema);
  const rawStatement = ownKeys.includes("statement")
    ? readOwn(value, "statement", name)
    : undefined;
  const statement =
    rawStatement === undefined
      ? undefined
      : requireFunction(rawStatement, "statement", name);
  const rawObserve = ownKeys.includes("observe")
    ? readOwn(value, "observe", name)
    : undefined;
  const observe =
    rawObserve === undefined
      ? undefined
      : requireFunction(rawObserve, "observe", name);
  const rawClient = ownKeys.includes("client")
    ? readOwn(value, "client", name)
    : undefined;
  const client =
    rawClient === undefined
      ? undefined
      : requireFunction(rawClient, "client", name);
  const rawModel = ownKeys.includes("model")
    ? readOwn(value, "model", name)
    : undefined;
  const model =
    rawModel === undefined
      ? undefined
      : snapshotModelFactories(rawModel, name, schema);

  return Object.freeze({
    name,
    ...(request ? { request } : {}),
    ...(query ? { query } : {}),
    ...(statement ? { statement } : {}),
    ...(observe ? { observe } : {}),
    ...(client ? { client } : {}),
    ...(model ? { model } : {}),
  });
}

type ExtensionConfig<S extends Schema> = {
  readonly schema: S;
  readonly driver: AnyDriver;
};

export type ContextualExtensionDefinition<
  C extends VibORMConfig,
  X extends ExtensionStateConstraint,
> = {
  readonly name: string;
  readonly request?: GenericRequestHandler | RequestHandlerMap<C["schema"]>;
  readonly query?: GenericQueryHandler | QueryHandlerMap<C>;
  readonly statement?: StatementHandler;
  readonly observe?: ObserveHandler;
  readonly client?: (
    scope: ExtensionClientScope<C, X>
  ) => ExtensionMethodRecord;
  readonly model?: {
    readonly [ModelName in keyof C["schema"]]?: (
      delegate: ExtensionModelClient<C, X>[ModelName]
    ) => ExtensionMethodRecord;
  };
};

type SchemaGenericExtensionDefinition = Omit<
  ContextualExtensionDefinition<
    ExtensionConfig<Schema>,
    EmptyClientExtensionState
  >,
  "request" | "query"
> & {
  readonly request?: GenericRequestHandler;
  readonly query?: GenericQueryHandler;
};

/**
 * Public reusable extension definition.
 *
 * A schema with a string index has no exact model vocabulary, so its reusable
 * request/query contributions must use the polymorphic all-operation form.
 * Supplying a concrete schema retains its exact model and operation maps.
 */
export type ClientExtension<S extends Schema = Schema> = string extends keyof S
  ? SchemaGenericExtensionDefinition
  : ContextualExtensionDefinition<
      ExtensionConfig<S>,
      EmptyClientExtensionState
    >;

type DefinitionKeys = keyof ContextualExtensionDefinition<
  VibORMConfig,
  EmptyClientExtensionState
>;

declare const schemaBoundExtensionContext: unique symbol;

type SchemaBoundExtension<Definition> = Definition & {
  readonly [schemaBoundExtensionContext]: ResultConsumerContextOf<Definition>;
};

type UnknownDefinitionKeys<Definition> = Record<
  Exclude<
    keyof Definition,
    DefinitionKeys | typeof schemaBoundExtensionContext
  >,
  never
>;

type ConfigOmit<C extends VibORMConfig> = "omit" extends keyof C
  ? C[Extract<"omit", keyof C>]
  : undefined;

export type HasNamedClientOmit<C extends VibORMConfig> =
  string extends keyof NonNullable<ConfigOmit<C>>
    ? false
    : [Exclude<ConfigOmit<C>, undefined>] extends [never]
      ? false
      : true;

/** Refuse replaying a schema-bound result consumer into an omitted client. */
export type SchemaBoundExtensionAdmission<
  Definition,
  C extends VibORMConfig,
> = Definition extends {
  readonly [schemaBoundExtensionContext]: infer Context;
}
  ? Context extends "result-consuming"
    ? HasNamedClientOmit<C> extends true
      ? { readonly [schemaBoundExtensionContext]: never }
      : unknown
    : unknown
  : unknown;

type OperationMapGuard<Map, S extends Schema> = Map extends CallableFunction
  ? unknown
  : Map extends object
    ? Record<Exclude<keyof Map, keyof S>, never> & {
        readonly [ModelName in keyof Map]: ModelName extends keyof S
          ? Map[ModelName] extends object
            ? Record<Exclude<keyof Map[ModelName], Operations>, never>
            : never
          : never;
      }
    : never;

type ComponentMapGuard<
  Definition,
  Key extends "request" | "query",
  S extends Schema,
> = Definition extends { readonly [K in Key]: infer Component }
  ? { readonly [K in Key]: OperationMapGuard<Component, S> }
  : unknown;

/** Structural refusal for non-fresh extension definitions and contributions. */
export type ExactExtensionDefinition<
  Definition,
  C extends VibORMConfig,
  X extends ExtensionStateConstraint,
> = UnknownDefinitionKeys<Definition> &
  ComponentMapGuard<Definition, "request", C["schema"]> &
  ComponentMapGuard<Definition, "query", C["schema"]> &
  ExtensionMethodDefinitionGuard<Definition, C, X>;

export type DefineExtensionBinder<S extends Schema> = <const Definition>(
  definition: Definition &
    ContextualExtensionDefinition<
      ExtensionConfig<S>,
      EmptyClientExtensionState
    > &
    ExactExtensionDefinition<
      Definition,
      ExtensionConfig<S>,
      EmptyClientExtensionState
    >
) => SchemaBoundExtension<Definition>;

export function defineExtension<
  const Definition extends SchemaGenericExtensionDefinition,
>(
  definition: Definition &
    ExactExtensionDefinition<
      Definition,
      ExtensionConfig<Schema>,
      EmptyClientExtensionState
    >
): Definition;
export function defineExtension<S extends Schema>(): DefineExtensionBinder<S>;
export function defineExtension(
  ...definitions: [] | [definition: ClientExtension]
): unknown {
  if (definitions.length === 0) {
    return (schemaDefinition: unknown) =>
      normalizeExtensionDefinition(schemaDefinition);
  }
  return normalizeExtensionDefinition(definitions[0]);
}
