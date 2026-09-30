import type { VibORMConfig } from "@client/client";
import type { Operations, Schema } from "@client/types";
import type { AnyDriver } from "@drivers";
import { ClientInitializationError } from "@errors";
import { ROUTED_OPERATIONS } from "@query-engine/routed-operations";
import type { AnyModel } from "@schema/model";
import { isPlainRecord } from "@schema/relation/terminal";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import { parse } from "@validation";
import {
  isDate,
  isFunction,
  isRecord,
  isUint8Array,
} from "@validation/value-guards";
import {
  type ControlDeclaration,
  type ControlsContribution,
  type DeletionContribution,
  type RowsContribution,
  rowsModes,
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
  readonly controls?: ControlsContribution;
  readonly rows?: RowsContribution;
  readonly deletion?: DeletionContribution;
}

export type ControlLiteral = string | number | boolean;

type ConstantFields = Readonly<Record<string, unknown>>;

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

function readOwnKeys(value: object, extension?: string): PropertyKey[] {
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
  return readGuarded(() => value[key], `member "${key}"`, extension);
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

/** Refuse a definition, naming its extension. */
function refuse(extension: string, message: string): never {
  extensionError(`Extension "${extension}" ${message}`, extension);
}

/** One read of caller data behind the hostile-definition boundary. */
function readGuarded<T>(read: () => T, label: string, extension?: string): T {
  try {
    return read();
  } catch (cause) {
    throw new ClientInitializationError(
      `${extension ? `Extension "${extension}"` : "Client extension"} ${label} could not be read.`,
      {
        cause: extensionCause(cause),
        meta: extension ? { extension } : undefined,
      }
    );
  }
}

/** An empty array or record to copy plain data into; none for an instance. */
function emptyCopyOf(
  value: object
): Record<string, unknown> | unknown[] | undefined {
  if (Array.isArray(value)) return [];
  return isPlainRecord(value) ? {} : undefined;
}

/**
 * A Standard Schema's `validate`, read once and bound to the member that
 * carried it: a later change to the caller's schema cannot swap the validator.
 */
class ControlValidator implements StandardSchemaV1 {
  readonly "~standard": StandardSchemaV1["~standard"];
  constructor(validate: CallableFunction, standard: unknown) {
    this["~standard"] = Object.freeze({
      version: 1,
      vendor: "viborm",
      validate: (input: unknown) => Reflect.apply(validate, standard, [input]),
    });
    Object.freeze(this);
  }
}

/** The validator of a value carrying `~standard`; none without that member. */
function readValidator(
  value: object,
  label: string,
  extension: string
): ControlValidator | undefined {
  const standard = readGuarded(
    () => Reflect.get(value, "~standard"),
    label,
    extension
  );
  if (standard === undefined) return undefined;
  const validate = readGuarded(
    () => Reflect.get(new Object(standard), "validate"),
    label,
    extension
  );
  if (!isFunction(validate)) {
    refuse(extension, `${label} must be a Standard Schema.`);
  }
  return new ControlValidator(validate, standard);
}

/**
 * Copy one declaration member once; it is the only read of that member. Every
 * getter runs once, a `Date` or `Uint8Array` is copied, and nothing the caller
 * keeps can change what core holds. Which keys count is one rule for a member
 * and for the data inside it: the enumerable own string keys whose value is
 * not `undefined` (an undefined or non-enumerable member is absent; a symbol
 * key is refused). With `validators`, a value carrying `~standard` is kept as
 * its bound validator. Anything else that is not plain data (a function, a
 * class instance, a cycle) is refused.
 */
function copyData(
  value: unknown,
  label: string,
  extension: string,
  validators = false,
  seen: Set<object> = new Set()
): unknown {
  if (validators && (typeof value === "object" || isFunction(value))) {
    const validator = value && readValidator(value, label, extension);
    if (validator) return validator;
  }
  if (typeof value === "function" || typeof value === "symbol") {
    refuse(extension, `${label} must be plain data.`);
  }
  if (value === null || typeof value !== "object") return value;
  if (isDate(value)) return new Date(Date.prototype.getTime.call(value));
  if (isUint8Array(value)) return new Uint8Array(value);
  if (seen.has(value)) {
    refuse(extension, `${label} must not contain itself.`);
  }
  const copy = readGuarded(() => emptyCopyOf(value), label, extension);
  if (copy === undefined) {
    refuse(extension, `${label} must be plain data.`);
  }
  seen.add(value);
  for (const key of readOwnKeys(value, extension)) {
    if (typeof key !== "string") {
      refuse(extension, `${label} contains a symbol key.`);
    }
    const descriptor = readGuarded(
      () => Object.getOwnPropertyDescriptor(value, key),
      label,
      extension
    );
    if (descriptor?.enumerable !== true) continue;
    const entry = readGuarded(
      () => Reflect.get(value, key),
      `${label}.${key}`,
      extension
    );
    if (entry === undefined) continue;
    Object.defineProperty(copy, key, {
      value: copyData(entry, `${label}.${key}`, extension, validators, seen),
      enumerable: true,
      writable: false,
      configurable: false,
    });
  }
  seen.delete(value);
  return Object.freeze(copy);
}

/** A copied value that must be a record, holding only the members `allowed` names. */
function record(
  value: unknown,
  label: string,
  extension: string,
  allowed?: readonly string[]
): ConstantFields {
  if (!isPlainRecord(value)) refuse(extension, `${label} must be an object.`);
  for (const key of Object.keys(value)) {
    if (allowed && !allowed.includes(key)) {
      refuse(extension, `${label} has unknown member "${key}".`);
    }
  }
  return value;
}

function requireName(value: unknown, label: string, extension: string): string {
  if (typeof value !== "string" || value.length === 0) {
    refuse(extension, `${label} must be a non-empty string.`);
  }
  return value;
}

function readSchemaModel(
  schema: Schema | undefined,
  modelKey: string,
  label: string,
  extension: string
): AnyModel | undefined {
  if (schema === undefined) return undefined;
  if (!Object.hasOwn(schema, modelKey)) {
    refuse(extension, `${label} names unknown model "${modelKey}".`);
  }
  return schema[modelKey];
}

/** Refuse a field name that is not a scalar of the receiving model. */
function requireScalarField(
  model: AnyModel | undefined,
  modelKey: string,
  field: string,
  label: string,
  extension: string
): void {
  if (model === undefined) return;
  const { scalars, relations } = model["~"].state;
  if (Object.hasOwn(scalars, field)) return;
  refuse(
    extension,
    Object.hasOwn(relations, field)
      ? `${label} names relation "${modelKey}.${field}"; it takes scalar fields only.`
      : `${label} names unknown field "${modelKey}.${field}".`
  );
}

function isControlLiteral(value: unknown): value is ControlLiteral {
  return (
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  );
}

/**
 * One `controls` entry of the frozen copy `copyData` just made: a closed list
 * or a validator, and a placement. The checks below are the proof the
 * assertion states; it holds because the copy cannot change (ELEGANCE §5).
 */
function assertControl(
  entry: unknown,
  label: string,
  extension: string
): asserts entry is ControlDeclaration {
  const { oneOf, schema, on } = record(entry, label, extension, [
    "oneOf",
    "schema",
    "on",
  ]);
  if (on !== undefined && on !== "reads" && on !== "writes" && on !== "all") {
    if (!Array.isArray(on) || on.length === 0) {
      refuse(
        extension,
        `${label}.on must be "reads", "writes", "all" or a non-empty operation list.`
      );
    }
    for (const operation of on) {
      if (typeof operation !== "string" || !ROUTED_OPERATIONS.has(operation)) {
        refuse(
          extension,
          `${label}.on names unknown operation "${String(operation)}".`
        );
      }
    }
  }
  if ((oneOf === undefined) === (schema === undefined)) {
    refuse(
      extension,
      `${label} must declare exactly one of "oneOf" or "schema".`
    );
  }
  if (schema !== undefined) {
    if (!(schema instanceof ControlValidator)) {
      refuse(extension, `${label}.schema must be a Standard Schema.`);
    }
    return;
  }
  if (!Array.isArray(oneOf) || oneOf.length === 0) {
    refuse(extension, `${label}.oneOf must be a non-empty array.`);
  }
  const distinct = oneOf.every(
    (value, index) => isControlLiteral(value) && oneOf.indexOf(value) === index
  );
  if (!distinct) {
    refuse(
      extension,
      `${label}.oneOf must hold distinct strings, finite numbers or booleans.`
    );
  }
}

function snapshotControls(
  value: unknown,
  extension: string
): ControlsContribution {
  const controls = record(
    copyData(value, "controls", extension, true),
    "controls",
    extension
  );
  const snapshot: Record<string, ControlDeclaration> = Object.create(null);
  for (const [name, entry] of Object.entries(controls)) {
    assertControl(entry, `controls.${name}`, extension);
    snapshot[name] = entry;
  }
  return Object.freeze(snapshot);
}

function sameNames(left: readonly string[], right: readonly string[]): boolean {
  return (
    left.length === right.length && left.every((name) => right.includes(name))
  );
}

/**
 * A row predicate as the model's own `where` admits it, once, when the
 * extension is applied: the engine prepares the admitted form and never
 * validates it again. It names scalar fields only.
 */
function admitWhere(
  value: unknown,
  model: AnyModel | undefined,
  modelName: string,
  registry: ExtensionSchemaRegistry | undefined,
  label: string,
  extension: string
): ConstantFields {
  const where = record(value, label, extension);
  for (const field of Object.keys(where)) {
    requireScalarField(model, modelName, field, label, extension);
  }
  if (model === undefined || registry === undefined) return where;
  const result = parse(registry.getModelSchemas(model).core.where, where);
  if (result.issues) {
    refuse(
      extension,
      `${label} is not a valid where: ${result.issues.map((issue) => issue.message).join("; ")}.`
    );
  }
  return Object.freeze(record(result.value, label, extension));
}

function snapshotRows(
  value: unknown,
  extension: string,
  schema: Schema | undefined,
  registry: ExtensionSchemaRegistry | undefined
): RowsContribution {
  const rows = record(copyData(value, "rows", extension), "rows", extension, [
    "control",
    "default",
    "models",
  ]);
  const control = requireName(rows.control, "rows.control", extension);
  const fallback = requireName(rows.default, "rows.default", extension);
  const models: Record<string, RowsContribution["models"][string]> =
    Object.create(null);
  for (const [modelName, entry] of Object.entries(
    record(rows.models, "rows.models", extension)
  )) {
    const model = readSchemaModel(schema, modelName, "rows.models", extension);
    const scoped: Record<string, RowsContribution["models"][string][string]> =
      Object.create(null);
    const label = `rows.models.${modelName}`;
    for (const [mode, purposes] of Object.entries(
      record(entry, label, extension)
    )) {
      const predicates: Record<string, ConstantFields> = {};
      for (const [purpose, where] of Object.entries(
        record(purposes, `${label}.${mode}`, extension, ["root", "related"])
      )) {
        predicates[purpose] = admitWhere(
          where,
          model,
          modelName,
          registry,
          `${label}.${mode}.${purpose}`,
          extension
        );
      }
      scoped[mode] = Object.freeze(predicates);
    }
    models[modelName] = Object.freeze(scoped);
  }
  const declaration = Object.freeze({
    control,
    default: fallback,
    models: Object.freeze(models),
  });
  const modes = rowsModes(declaration);
  for (const [modelName, entry] of Object.entries(models)) {
    if (!sameNames(modes, Object.keys(entry))) {
      refuse(
        extension,
        `rows.models.${modelName} must declare the same modes as every other entry (${modes.join(", ")}).`
      );
    }
  }
  if (!modes.includes(fallback)) {
    refuse(
      extension,
      `rows.default "${fallback}" must be a mode every entry declares.`
    );
  }
  return declaration;
}

const NO_CONTROLS: ControlsContribution = Object.freeze({});

function requireTimestampField(
  model: AnyModel | undefined,
  modelName: string,
  field: string,
  label: string,
  extension: string
): void {
  requireScalarField(model, modelName, field, label, extension);
  const state = model?.["~"].state.scalars[field]?.["~"].state;
  if (state === undefined) return;
  if (state.type !== "datetime" || state.array) {
    refuse(
      extension,
      `${label} names "${modelName}.${field}", which is not a single DateTime field.`
    );
  }
}

/**
 * The `removeWhen` of the frozen copy `copyData` just made: it names at least
 * one declared control that has no `on`, and one of that control's `oneOf`
 * values. The checks below are the proof the assertion states (ELEGANCE §5).
 */
function assertRemoveWhen(
  value: unknown,
  extension: string,
  declared: ControlsContribution
): asserts value is Readonly<Record<string, ControlLiteral>> {
  const removeWhen = record(value, "deletion.removeWhen", extension);
  // An empty match would hold for every call and make every delete physical.
  if (Object.keys(removeWhen).length === 0) {
    refuse(extension, "deletion.removeWhen must name a control.");
  }
  for (const [name, expected] of Object.entries(removeWhen)) {
    const control = Object.hasOwn(declared, name) ? declared[name] : undefined;
    if (control === undefined) {
      refuse(
        extension,
        `deletion.removeWhen names "${name}", which its controls do not declare.`
      );
    }
    if (control.on !== undefined) {
      refuse(
        extension,
        `control "${name}" is placed by deletion.removeWhen and may not declare "on".`
      );
    }
    // A schema control has no values, so no value is one of them.
    const values: readonly ControlLiteral[] =
      "oneOf" in control ? control.oneOf : [];
    if (!(isControlLiteral(expected) && values.includes(expected))) {
      refuse(
        extension,
        `deletion.removeWhen.${name} must be one of control "${name}"'s values.`
      );
    }
  }
}

/**
 * One `deletion.models` entry of the frozen copy `copyData` just made: `at`
 * a single DateTime field, `assign` other scalar fields. The checks below are
 * the proof the assertion states (ELEGANCE §5).
 */
function assertDeletionEntry(
  value: unknown,
  model: AnyModel | undefined,
  modelName: string,
  extension: string
): asserts value is DeletionContribution["models"][string] {
  const label = `deletion.models.${modelName}`;
  const { at, assign } = record(value, label, extension, ["at", "assign"]);
  if (at !== undefined) {
    const field = requireName(at, `${label}.at`, extension);
    requireTimestampField(model, modelName, field, `${label}.at`, extension);
  }
  if (assign === undefined) return;
  for (const field of Object.keys(
    record(assign, `${label}.assign`, extension)
  )) {
    requireScalarField(model, modelName, field, `${label}.assign`, extension);
    if (field === at) {
      refuse(
        extension,
        `${label}.assign names "${field}", the field "at" stamps.`
      );
    }
  }
}

function snapshotDeletion(
  value: unknown,
  extension: string,
  schema: Schema | undefined,
  declared: ControlsContribution
): DeletionContribution {
  const { removeWhen, models } = record(
    copyData(value, "deletion", extension),
    "deletion",
    extension,
    ["removeWhen", "models"]
  );
  if (removeWhen !== undefined) {
    assertRemoveWhen(removeWhen, extension, declared);
  }
  const managed: Record<string, DeletionContribution["models"][string]> =
    Object.create(null);
  for (const [modelName, entry] of Object.entries(
    record(models, "deletion.models", extension)
  )) {
    assertDeletionEntry(
      entry,
      readSchemaModel(schema, modelName, "deletion.models", extension),
      modelName,
      extension
    );
    managed[modelName] = entry;
  }
  return Object.freeze({
    ...(removeWhen === undefined ? {} : { removeWhen }),
    models: Object.freeze(managed),
  });
}

/** A control takes no name a core operation argument has: core would lose it. */
function refuseCoreArgumentNames(
  extension: string,
  names: readonly string[],
  registry: ExtensionSchemaRegistry | undefined
): void {
  if (registry === undefined || names.length === 0) return;
  const argumentNames = registry.argumentNames();
  for (const name of names) {
    if (argumentNames.has(name)) {
      refuse(
        extension,
        `control "${name}" takes the name of a core operation argument.`
      );
    }
  }
}

/** What the receiving client's schema registry answers when an extension is applied. */
export interface ExtensionSchemaRegistry {
  /** The top-level argument names its operation schemas own. */
  argumentNames(): ReadonlySet<string>;
  getModelSchemas(model: AnyModel): {
    readonly core: { readonly where: StandardSchemaV1 };
  };
}

/**
 * Read a caller-owned definition once, validate it, and freeze only host-owned
 * snapshots. A failed application therefore cannot mutate the supplied value.
 */
export function normalizeExtensionDefinition(
  value: unknown,
  schema?: Schema,
  registry?: ExtensionSchemaRegistry
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

  // Each member is read once, and only when the definition has it.
  const member = (key: string): unknown =>
    ownKeys.includes(key) ? readOwn(value, key, name) : undefined;
  const rawRequest = member("request");
  const request =
    rawRequest === undefined
      ? undefined
      : snapshotOperationMap(rawRequest, "request", name, schema);
  const rawQuery = member("query");
  const query =
    rawQuery === undefined
      ? undefined
      : snapshotOperationMap(rawQuery, "query", name, schema);
  const rawStatement = member("statement");
  const statement =
    rawStatement === undefined
      ? undefined
      : requireFunction(rawStatement, "statement", name);
  const rawObserve = member("observe");
  const observe =
    rawObserve === undefined
      ? undefined
      : requireFunction(rawObserve, "observe", name);
  const rawClient = member("client");
  const client =
    rawClient === undefined
      ? undefined
      : requireFunction(rawClient, "client", name);
  const rawModel = member("model");
  const model =
    rawModel === undefined
      ? undefined
      : snapshotModelFactories(rawModel, name, schema);

  const rawControls = member("controls");
  const controls =
    rawControls === undefined ? undefined : snapshotControls(rawControls, name);
  const rawRows = member("rows");
  const rows =
    rawRows === undefined
      ? undefined
      : snapshotRows(rawRows, name, schema, registry);
  const rawDeletion = member("deletion");
  const deletion =
    rawDeletion === undefined
      ? undefined
      : snapshotDeletion(rawDeletion, name, schema, controls ?? NO_CONTROLS);
  refuseCoreArgumentNames(
    name,
    [...Object.keys(controls ?? NO_CONTROLS), ...(rows ? [rows.control] : [])],
    registry
  );

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
  });
}

type ExtensionConfig<S extends Schema> = {
  readonly schema: S;
  readonly driver: AnyDriver;
};

/**
 * A model factory, declared as a method so a factory typed against the client
 * it extends (`(delegate: M[K & keyof M]) => …`, generic over that client) is
 * compared in either direction rather than only contravariantly.
 */
type ModelMethodFactory<Delegate> = {
  factory(delegate: Delegate): ExtensionMethodRecord;
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
  readonly [ModelName in keyof C["schema"]]: ModelMethodFactory<
    ExtensionModelDelegate<C, X, ModelName>
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
  readonly model?: unknown extends Self
    ? {
        readonly [ModelName in keyof C["schema"]]?: ModelMethodFactory<
          ExtensionModelDelegate<C, X, ModelName>
        >;
      }
    : {
        readonly [ModelName in DefinitionModelKeys<Self>]?: ModelFactoryTable<
          C,
          X
        >[ModelName & keyof C["schema"]];
      };
};

type ExtensionMembers<
  C extends VibORMConfig,
  X extends ExtensionStateConstraint,
> = {
  readonly name: string;
  readonly request?: GenericRequestHandler | RequestHandlerMap<C["schema"]>;
  readonly query?: GenericQueryHandler | QueryHandlerMap<C, X["rows"]>;
  readonly statement?: StatementHandler;
  readonly observe?: ObserveHandler;
  readonly controls?: ControlsContribution;
  readonly rows?: RowsContribution;
  readonly deletion?: DeletionContribution;
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
