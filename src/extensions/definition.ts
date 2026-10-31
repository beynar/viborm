import type { VibORMConfig } from "@client/client";
import type { ClientSchema } from "@client/schema-links";
import type { Operations, Schema } from "@client/types";
import type { AnyDriver } from "@drivers/exports";
import { ClientInitializationError } from "@errors";
import { ROUTED_OPERATIONS } from "@query-engine/routed-operations";
import { getModelKeyCatalog } from "@schema/model/keys";
import type { SchemaRegistryLookup } from "@validation/types";
import { isFunction, isRecord } from "@validation/value-guards";
import { errorCause } from "../errors/diagnostic-safety";
import { admitRows } from "./admission";
import type {
  ControlsContribution,
  DataContribution,
  DeletionContribution,
  OrderContribution,
  OrderTerm,
  RowsContribution,
} from "./controls";
import type {
  EmptyClientExtensionState,
  ExtensionClientScope,
  ExtensionMethodDefinitionGuard,
  ExtensionMethodRecord,
  ExtensionModelDelegate,
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
import { type RuntimeResultContribution, snapshotResult } from "./result";
import type { ResultDefinition, ResultInference } from "./result-types";
import type { StatementHandler } from "./statement";

type RuntimeExtensionFunction = (...args: never[]) => unknown;

/**
 * One extension definition as the chain binds it: a host-owned frozen
 * snapshot of the six handler members, `rows` as admission left it (against
 * a schema), and `controls`, `deletion` and `data` as the definition wrote
 * them.
 */
export interface RuntimeExtensionDefinition {
  readonly name: string;
  readonly request?: RuntimeRequestContribution;
  readonly query?: RuntimeQueryContribution;
  readonly statement?: RuntimeExtensionFunction;
  readonly observe?: RuntimeExtensionFunction;
  readonly client?: RuntimeClientMethodContribution;
  readonly model?: RuntimeModelMethodContribution;
  readonly controls?: ControlsContribution;
  readonly rows?: RowsContribution;
  readonly deletion?: DeletionContribution;
  readonly data?: DataContribution;
  readonly order?: OrderContribution;
  readonly result?: RuntimeResultContribution;
}

export type ControlLiteral = string | number | boolean;

/**
 * What `$extends` hands the chain. Schema-bound row/data/deletion model and
 * field names are checked before they can silently bind to no policy.
 * Handler members retain the hostile-definition boundary below.
 */
export type ExtensionDefinitionInput = Readonly<Record<string, unknown>> & {
  readonly controls?: ControlsContribution;
  readonly rows?: RowsContribution;
  readonly deletion?: DeletionContribution;
  readonly data?: DataContribution;
  readonly order?: OrderContribution;
};

const DEFINITION_KEYS = new Set([
  "name",
  "request",
  "query",
  "statement",
  "observe",
  "client",
  "model",
  "controls",
  "rows",
  "deletion",
  "data",
  "order",
  "result",
]);

export function extensionError(message: string, extension?: string): never {
  throw new ClientInitializationError(message, {
    meta: extension ? { extension } : undefined,
  });
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
        cause: errorCause(cause),
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
        cause: errorCause(cause),
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

/** Refuse named policy facts that could otherwise silently bind to nothing. */
function validateNamedPolicies(
  value: ExtensionDefinitionInput,
  schema: Schema | undefined,
  name: string
): void {
  if (!schema) return;
  const components: ("rows" | "data" | "deletion")[] = [
    "rows",
    "data",
    "deletion",
  ];
  for (const component of components) {
    const declaration = readOwn(value, component, name);
    if (declaration === undefined) continue;
    if (!isRecord(declaration))
      extensionError(
        `Extension "${name}" ${component} must be an object.`,
        name
      );
    const models = readOwn(declaration, "models", name);
    if (!isRecord(models))
      extensionError(
        `Extension "${name}" ${component}.models must be an object.`,
        name
      );
    let expectedModes: readonly string[] | undefined;
    const defaultMode =
      component === "rows" ? readOwn(declaration, "default", name) : undefined;
    for (const modelName of readOwnKeys(models, name)) {
      if (typeof modelName !== "string" || !Object.hasOwn(schema, modelName))
        extensionError(
          `Extension "${name}" ${component} names unknown model "${String(modelName)}".`,
          name
        );
      const model = schema[modelName]!;
      const entry = readOwn(models, modelName, name);
      if (!isRecord(entry))
        extensionError(
          `Extension "${name}" ${component}.${modelName} must be an object.`,
          name
        );
      // A row predicate's fields are its admission's (`admission.ts`).
      const fields = (input: unknown): void => {
        if (input === undefined) return;
        if (!isRecord(input))
          extensionError(
            `Extension "${name}" ${component}.${modelName} fields must be an object.`,
            name
          );
        for (const key of readOwnKeys(input, name)) {
          if (
            typeof key !== "string" ||
            !Object.hasOwn(model["~"].state.scalars, key)
          )
            extensionError(
              `Extension "${name}" ${component}.${modelName} names unknown field "${String(key)}".`,
              name
            );
        }
      };
      if (component === "rows") {
        const modes = readOwnKeys(entry, name).filter(
          (key): key is string => typeof key === "string"
        );
        const priorModes = expectedModes;
        if (
          typeof defaultMode !== "string" ||
          !modes.includes(defaultMode) ||
          (priorModes &&
            (priorModes.length !== modes.length ||
              modes.some((mode) => !priorModes.includes(mode))))
        )
          extensionError(
            `Extension "${name}" row models must share mode names and include the default mode.`,
            name
          );
        expectedModes ??= modes;
        for (const modeName of readOwnKeys(entry, name)) {
          if (typeof modeName !== "string")
            extensionError(
              `Extension "${name}" row mode must be a string.`,
              name
            );
          const mode = readOwn(entry, modeName, name);
          if (!isRecord(mode))
            extensionError(
              `Extension "${name}" row mode must be an object.`,
              name
            );
        }
      } else if (component === "data") {
        fields(readOwn(entry, "create", name));
        fields(readOwn(entry, "update", name));
      } else {
        const at = readOwn(entry, "at", name);
        if (
          at !== undefined &&
          (typeof at !== "string" ||
            !Object.hasOwn(model["~"].state.scalars, at))
        )
          extensionError(
            `Extension "${name}" deletion.${modelName}.at names unknown scalar.`,
            name
          );
        fields(readOwn(entry, "assign", name));
      }
    }
  }
}

/**
 * Read a caller-owned definition once. The six handler members are validated
 * and frozen as host-owned snapshots, so a failed application cannot mutate
 * the supplied value; against a schema, every `rows` predicate is admitted
 * through its model's `where` schema; `controls`, `deletion` and `data` are
 * bound as written.
 */
export function normalizeExtensionDefinition(
  value: ExtensionDefinitionInput,
  schema?: Schema,
  registry?: SchemaRegistryLookup<Schema>
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
  const rawResult = ownKeys.includes("result")
    ? readOwn(value, "result", name)
    : undefined;
  const result =
    rawResult === undefined
      ? undefined
      : snapshotResult(rawResult, name, schema);
  const { controls, deletion, data } = value;
  validateNamedPolicies({ rows: value.rows, deletion, data }, schema, name);
  const rows =
    schema && value.rows
      ? admitRows(value.rows, schema, name, registry)
      : value.rows;
  const order =
    value.order === undefined
      ? undefined
      : admitOrder(value.order, schema, name);

  return Object.freeze({
    name,
    ...(request ? { request } : {}),
    ...(query ? { query } : {}),
    ...(statement ? { statement } : {}),
    ...(observe ? { observe } : {}),
    ...(client ? { client } : {}),
    ...(model ? { model } : {}),
    ...(controls ? { controls } : {}),
    ...(rows ? { rows } : {}),
    ...(deletion ? { deletion } : {}),
    ...(data ? { data } : {}),
    ...(order ? { order } : {}),
    ...(result ? { result } : {}),
  });
}

/**
 * `order`, read once: per model, the terms its reads take when the caller
 * gives no `orderBy`, each `{ field: "asc" | "desc" }`. Against a schema, the
 * model must have a row key (its reads end with it, so the order is total)
 * and each field must be one of its scalars that orders as a value (not a
 * list, JSON, vector or point).
 */
function admitOrder(
  value: unknown,
  schema: Schema | undefined,
  name: string
): OrderContribution {
  const models = isRecord(value) ? readOwn(value, "models", name) : undefined;
  const admitted: Record<string, readonly OrderTerm[]> = {};
  for (const key of isRecord(models) ? readOwnKeys(models, name) : [""]) {
    const model = schema?.[key as string];
    const entry = isRecord(models)
      ? readOwn(models, key as string, name)
      : undefined;
    const terms = Array.isArray(entry) ? entry : [entry];
    const valid =
      typeof key === "string" &&
      (schema === undefined ||
        (model !== undefined &&
          getModelKeyCatalog(model).rowKey !== undefined)) &&
      terms.length > 0 &&
      terms.every((term) => {
        const fields = isRecord(term) ? readOwnKeys(term, name) : [];
        const field = fields[0];
        const direction = isRecord(term) ? term[field as string] : undefined;
        const state =
          typeof field === "string" &&
          model !== undefined &&
          Object.hasOwn(model["~"].state.scalars, field)
            ? model["~"].state.scalars[field]!["~"].state
            : undefined;
        return (
          fields.length === 1 &&
          (direction === "asc" || direction === "desc") &&
          (schema === undefined ||
            (state !== undefined &&
              !state.array &&
              !UNORDERED_SCALARS.has(state.type)))
        );
      });
    if (!valid)
      extensionError(
        `Extension "${name}" order${isRecord(models) ? `.${String(key)}` : ""} must map a model with a key to { field: "asc" | "desc" } terms over its ordered scalars.`,
        name
      );
    admitted[key as string] = Object.freeze(
      terms.map((term) => Object.freeze({ ...(term as OrderTerm) }))
    );
  }
  return Object.freeze({ models: Object.freeze(admitted) });
}
const UNORDERED_SCALARS = new Set(["json", "vector", "point", "blob"]);

type ExtensionConfig<S extends Schema> = {
  readonly schema: S;
  readonly driver: AnyDriver;
};

/**
 * A model factory, declared as a method so a factory typed against the client
 * it extends (`(delegate: M[K & keyof M]) => …`, generic over that client) is
 * compared in either direction rather than only contravariantly.
 */
type ModelMethodFactory<Delegate, Scope> = {
  factory(delegate: Delegate, scope: Scope): ExtensionMethodRecord;
}["factory"];

/**
 * One factory per schema model. A definition's model key is looked up here by
 * index, never by a conditional: a key outside the schema reads `never` (the
 * factory is refused where it is written), and a key set generic over the
 * client is substituted rather than deferred, so a plugin generic over `C`
 * type-checks and meets the schema check when it is applied.
 */
type ModelFactoryTable<
  C extends VibORMConfig,
  X extends ExtensionStateConstraint,
> = {
  readonly [ModelName in keyof ClientSchema<C>]: ModelMethodFactory<
    ExtensionModelDelegate<C, X, ModelName>,
    ExtensionClientScope<C, X>
  >;
};

/** The model keys a definition's own `model` map names. */
type DefinitionModelKeys<Self> = Self extends {
  readonly model?: infer Factories;
}
  ? keyof Factories
  : never;

/**
 * `Self` is the definition itself when `$extends` checks it (F-bounded), so
 * its model keys come from the definition; otherwise every schema model.
 */
export type ContextualExtensionDefinition<
  C extends VibORMConfig,
  X extends ExtensionStateConstraint,
  Self = unknown,
> = ExtensionMembers<C, X> & {
  readonly result?: ResultDefinition<C>;
  readonly model?: unknown extends Self
    ? {
        readonly [ModelName in keyof ClientSchema<C>]?: ModelMethodFactory<
          ExtensionModelDelegate<C, X, ModelName>,
          ExtensionClientScope<C, X>
        >;
      }
    : {
        readonly [ModelName in DefinitionModelKeys<Self>]?: ModelFactoryTable<
          C,
          X
        >[ModelName & keyof ClientSchema<C>];
      };
};

type ExtensionMembers<
  C extends VibORMConfig,
  X extends ExtensionStateConstraint,
> = {
  readonly name: string;
  readonly request?: GenericRequestHandler | RequestHandlerMap<ClientSchema<C>>;
  readonly query?: GenericQueryHandler | QueryHandlerMap<C, X["rows"]>;
  readonly statement?: StatementHandler;
  readonly observe?: ObserveHandler;
  readonly controls?: ControlsContribution;
  readonly rows?: RowsContribution;
  readonly deletion?: DeletionContribution;
  readonly data?: DataContribution;
  readonly order?: OrderContribution;
  readonly client?: (
    scope: ExtensionClientScope<C, X>
  ) => ExtensionMethodRecord;
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

/** Policy model keys must be a subset of a concrete bound schema. */
type PolicyModelsGuard<
  Definition,
  S extends Schema,
  Key extends "data" | "rows" | "deletion" | "order",
> = Definition extends {
  readonly [K in Key]: { readonly models: infer Models };
}
  ? string extends keyof S
    ? unknown
    : [keyof Models] extends [keyof S]
      ? unknown
      : {
          readonly [K in Key]: { readonly models: Record<keyof Models, never> };
        }
  : unknown;

/** Structural refusal for non-fresh extension definitions and contributions. */
export type ExactExtensionDefinition<
  Definition,
  C extends VibORMConfig,
  X extends ExtensionStateConstraint,
> = UnknownDefinitionKeys<Definition> &
  ComponentMapGuard<Definition, "request", C["schema"]> &
  ComponentMapGuard<Definition, "query", C["schema"]> &
  PolicyModelsGuard<Definition, C["schema"], "data"> &
  PolicyModelsGuard<Definition, C["schema"], "rows"> &
  PolicyModelsGuard<Definition, C["schema"], "deletion"> &
  PolicyModelsGuard<Definition, C["schema"], "order"> &
  ExtensionMethodDefinitionGuard<Definition, C, X>;

// The definition is inferred from its declaration, never from a receiving
// `$extends` overload's return context (which may be a client factory).
export type DefineExtensionBinder<S extends Schema> = <
  const Definition,
  Fields = unknown,
>(
  definition: Definition &
    ContextualExtensionDefinition<
      ExtensionConfig<S>,
      EmptyClientExtensionState
    > &
    ExactExtensionDefinition<
      Definition,
      ExtensionConfig<S>,
      EmptyClientExtensionState
    > &
    ResultInference<ExtensionConfig<S>, Record<never, never>, Fields>
) => SchemaBoundExtension<NoInfer<Definition>>;

export function defineExtension<
  const Definition extends SchemaGenericExtensionDefinition,
>(
  definition: Definition &
    ExactExtensionDefinition<
      Definition,
      ExtensionConfig<Schema>,
      EmptyClientExtensionState
    >
): NoInfer<Definition>;
export function defineExtension<S extends Schema>(): DefineExtensionBinder<S>;
export function defineExtension(
  ...definitions: [] | [definition: ClientExtension]
): unknown {
  if (definitions.length === 0) {
    return (schemaDefinition: ExtensionDefinitionInput) =>
      normalizeExtensionDefinition(schemaDefinition);
  }
  return normalizeExtensionDefinition(definitions[0]);
}
