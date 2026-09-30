import type { VibORMConfig } from "@client/client";
import type { Operations, Schema } from "@client/types";
import type { AnyDriver } from "@drivers";
import { ClientInitializationError } from "@errors";
import { ROUTED_OPERATIONS } from "@query-engine/routed-operations";
import type { AnyModel } from "@schema/model";
import { isPlainRecord } from "@schema/relation/terminal";
import {
  isDate,
  isFunction,
  isRecord,
  isUint8Array,
} from "@validation/value-guards";
import type {
  ControlsContribution,
  DeletionContribution,
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
  readonly controls?: RuntimeControlsContribution;
  readonly rows?: RuntimeRowsDeclaration;
  readonly deletion?: RuntimeDeletionDeclaration;
}

export type ControlLiteral = string | number | boolean;

/** A validator as core calls it: one synchronous `validate`. */
export interface RuntimeControlSchema {
  readonly "~standard": { readonly validate: (value: unknown) => unknown };
}

export type RuntimeControlPlacement =
  | "reads"
  | "writes"
  | "all"
  | readonly string[];

/** One `controls` entry, copied in the shape it was declared in. */
export type RuntimeControlDeclaration = (
  | { readonly oneOf: readonly ControlLiteral[] }
  | { readonly schema: RuntimeControlSchema }
) & { readonly on?: RuntimeControlPlacement };

export type RuntimeControlsContribution = Readonly<
  Record<string, RuntimeControlDeclaration>
>;

type ConstantFields = Readonly<Record<string, unknown>>;

/** One model's modes in a `rows` member: a predicate per purpose. */
export type RuntimeRowModes = Readonly<
  Record<
    string,
    { readonly root?: ConstantFields; readonly related?: ConstantFields }
  >
>;

/** A `rows` member, copied: its control, default and per-model modes. */
export interface RuntimeRowsDeclaration {
  readonly control: string;
  readonly default: string;
  readonly models: Readonly<Record<string, RuntimeRowModes>>;
}

/** A `deletion` member, copied: what a delete of each named model writes. */
export interface RuntimeDeletionDeclaration {
  readonly removeWhen?: Readonly<Record<string, ControlLiteral>>;
  readonly models: Readonly<
    Record<string, { readonly at?: string; readonly assign: ConstantFields }>
  >;
}

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

/** Refuse a definition, naming its extension. */
function refuse(extension: string, message: string): never {
  extensionError(`Extension "${extension}" ${message}`, extension);
}

/** One read of caller data behind the hostile-definition boundary. */
function readGuarded<T>(read: () => T, label: string, extension: string): T {
  try {
    return read();
  } catch (cause) {
    throw new ClientInitializationError(
      `Extension "${extension}" ${label} could not be read.`,
      { cause: extensionCause(cause), meta: { extension } }
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
 * Copy caller data once: every getter runs once, a `Date` or `Uint8Array` is
 * copied, and nothing the caller keeps can change what core holds. Anything
 * but plain data (a function, a class instance, a cycle) is refused.
 */
function copyData(
  value: unknown,
  label: string,
  extension: string,
  seen: Set<object> = new Set()
): unknown {
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
  for (const key of readStringKeys(value, label, extension)) {
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
      value: copyData(entry, `${label}.${key}`, extension, seen),
      enumerable: true,
      writable: false,
      configurable: false,
    });
  }
  seen.delete(value);
  return Object.freeze(copy);
}

/** Whether caller data is a record; a revoked proxy is a refusal, not a raw error. */
function isGuardedRecord(
  value: unknown,
  label: string,
  extension: string
): value is Record<string, unknown> {
  return readGuarded(() => isRecord(value), label, extension);
}

/** A member of caller data that must be an object. */
function requireRecord(
  value: unknown,
  label: string,
  extension: string
): Record<string, unknown> {
  if (!isGuardedRecord(value, label, extension)) {
    refuse(extension, `${label} must be an object.`);
  }
  return value;
}

/** Copied plain data that must be a record (a predicate, an assignment). */
function copyRecord(
  value: unknown,
  label: string,
  extension: string
): ConstantFields {
  return requireRecord(copyData(value, label, extension), label, extension);
}

/** The own keys of caller data, each a string. */
function readStringKeys(
  value: object,
  label: string,
  extension: string
): string[] {
  const keys: string[] = [];
  for (const key of readOwnKeys(value, extension)) {
    if (typeof key !== "string") {
      refuse(extension, `${label} contains a symbol key.`);
    }
    keys.push(key);
  }
  return keys;
}

/** The own keys of a member, refusing any outside `allowed`. */
function readMemberKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
  extension: string
): string[] {
  const keys = readStringKeys(value, label, extension);
  for (const key of keys) {
    if (!allowed.includes(key)) {
      refuse(extension, `${label} has unknown member "${key}".`);
    }
  }
  return keys;
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

function snapshotPlacement(
  value: unknown,
  label: string,
  extension: string
): RuntimeControlPlacement {
  if (value === "reads" || value === "writes" || value === "all") {
    return value;
  }
  const listed = Array.isArray(value)
    ? copyData(value, `${label}.on`, extension)
    : undefined;
  if (!Array.isArray(listed) || listed.length === 0) {
    refuse(
      extension,
      `${label}.on must be "reads", "writes", "all" or a non-empty operation list.`
    );
  }
  const operations: string[] = [];
  for (const operation of listed) {
    if (typeof operation !== "string" || !ROUTED_OPERATIONS.has(operation)) {
      refuse(
        extension,
        `${label}.on names unknown operation "${String(operation)}".`
      );
    }
    operations.push(operation);
  }
  return Object.freeze(operations);
}

function isControlLiteral(value: unknown): value is ControlLiteral {
  return (
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  );
}

function snapshotControl(
  value: unknown,
  label: string,
  extension: string
): RuntimeControlDeclaration {
  const control = requireRecord(value, label, extension);
  const keys = readMemberKeys(
    control,
    ["oneOf", "schema", "on"],
    label,
    extension
  );
  const on = keys.includes("on")
    ? snapshotPlacement(readOwn(control, "on", extension), label, extension)
    : undefined;
  if (keys.includes("oneOf") === keys.includes("schema")) {
    refuse(
      extension,
      `${label} must declare exactly one of "oneOf" or "schema".`
    );
  }
  if (keys.includes("oneOf")) {
    const values = copyData(
      readOwn(control, "oneOf", extension),
      `${label}.oneOf`,
      extension
    );
    if (!Array.isArray(values) || values.length === 0) {
      refuse(extension, `${label}.oneOf must be a non-empty array.`);
    }
    const literals: ControlLiteral[] = [];
    for (const entry of values) {
      if (!isControlLiteral(entry) || literals.includes(entry)) {
        refuse(
          extension,
          `${label}.oneOf must hold distinct strings, finite numbers or booleans.`
        );
      }
      literals.push(entry);
    }
    const oneOf = Object.freeze(literals);
    return Object.freeze(on === undefined ? { oneOf } : { oneOf, on });
  }
  const schema = readOwn(control, "schema", extension);
  const standard = isGuardedRecord(schema, `${label}.schema`, extension)
    ? readOwn(schema, "~standard", extension)
    : undefined;
  const validate = isGuardedRecord(standard, `${label}.schema`, extension)
    ? readOwn(standard, "validate", extension)
    : undefined;
  if (!isFunction(validate)) {
    refuse(extension, `${label}.schema must be a Standard Schema.`);
  }
  // The one callable core uses, read once: a later change to the caller's
  // schema object cannot swap the validator.
  const snapshot: RuntimeControlSchema = Object.freeze({
    "~standard": Object.freeze({
      validate: (input: unknown) => Reflect.apply(validate, standard, [input]),
    }),
  });
  return Object.freeze(
    on === undefined ? { schema: snapshot } : { schema: snapshot, on }
  );
}

function snapshotControls(
  value: unknown,
  extension: string
): RuntimeControlsContribution {
  const component = requireRecord(value, "controls", extension);
  const controls: Record<string, RuntimeControlDeclaration> =
    Object.create(null);
  for (const name of readStringKeys(component, "controls", extension)) {
    controls[name] = snapshotControl(
      readOwn(component, name, extension),
      `controls.${name}`,
      extension
    );
  }
  return Object.freeze(controls);
}

function requireName(value: unknown, label: string, extension: string): string {
  if (typeof value !== "string" || value.length === 0) {
    refuse(extension, `${label} must be a non-empty string.`);
  }
  return value;
}

function sameNames(left: readonly string[], right: readonly string[]): boolean {
  return (
    left.length === right.length && left.every((name) => right.includes(name))
  );
}

/** One model's modes: each a `root` and a `related` scalar predicate. */
function snapshotRowModes(
  value: unknown,
  model: AnyModel | undefined,
  modelName: string,
  extension: string
): RuntimeRowModes {
  const entry = requireRecord(value, `rows.models.${modelName}`, extension);
  const modes: Record<string, RuntimeRowModes[string]> = Object.create(null);
  for (const mode of readStringKeys(
    entry,
    `rows.models.${modelName}`,
    extension
  )) {
    const label = `rows.models.${modelName}.${mode}`;
    const predicates = requireRecord(
      readOwn(entry, mode, extension),
      label,
      extension
    );
    const scoped: { root?: ConstantFields; related?: ConstantFields } = {};
    for (const purpose of readMemberKeys(
      predicates,
      ["root", "related"],
      label,
      extension
    )) {
      const where = copyRecord(
        readOwn(predicates, purpose, extension),
        `${label}.${purpose}`,
        extension
      );
      for (const field of Object.keys(where)) {
        requireScalarField(
          model,
          modelName,
          field,
          `${label}.${purpose}`,
          extension
        );
      }
      scoped[purpose === "root" ? "root" : "related"] = where;
    }
    modes[mode] = Object.freeze(scoped);
  }
  return Object.freeze(modes);
}

function snapshotRows(
  value: unknown,
  extension: string,
  schema: Schema | undefined
): RuntimeRowsDeclaration {
  const rows = requireRecord(value, "rows", extension);
  readMemberKeys(rows, ["control", "default", "models"], "rows", extension);
  const control = requireName(
    readOwn(rows, "control", extension),
    "rows.control",
    extension
  );
  const fallback = requireName(
    readOwn(rows, "default", extension),
    "rows.default",
    extension
  );
  const models = requireRecord(
    readOwn(rows, "models", extension),
    "rows.models",
    extension
  );
  const copied: Record<string, RuntimeRowModes> = Object.create(null);
  let modes: readonly string[] | undefined;
  for (const modelName of readStringKeys(models, "rows.models", extension)) {
    const entry = snapshotRowModes(
      readOwn(models, modelName, extension),
      readSchemaModel(schema, modelName, "rows.models", extension),
      modelName,
      extension
    );
    const entryModes = Object.keys(entry);
    if (modes === undefined) {
      modes = entryModes;
    } else if (!sameNames(modes, entryModes)) {
      refuse(
        extension,
        `rows.models.${modelName} must declare the same modes as every other entry (${modes.join(", ")}).`
      );
    }
    copied[modelName] = entry;
  }
  if (!(modes ?? [fallback]).includes(fallback)) {
    refuse(
      extension,
      `rows.default "${fallback}" must be a mode every entry declares.`
    );
  }
  return Object.freeze({
    control,
    default: fallback,
    models: Object.freeze(copied),
  });
}

const NO_FIELDS: ConstantFields = Object.freeze({});
const NO_CONTROLS: RuntimeControlsContribution = Object.freeze({});

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

function snapshotRemoveWhen(
  value: unknown,
  extension: string,
  declared: RuntimeControlsContribution
): Readonly<Record<string, ControlLiteral>> {
  const removeWhen = requireRecord(value, "deletion.removeWhen", extension);
  const names = readStringKeys(removeWhen, "deletion.removeWhen", extension);
  // An empty match would hold for every call and make every delete physical.
  if (names.length === 0) {
    refuse(extension, "deletion.removeWhen must name a control.");
  }
  const matched: Record<string, ControlLiteral> = Object.create(null);
  for (const name of names) {
    const control = Object.hasOwn(declared, name) ? declared[name] : undefined;
    if (control === undefined) {
      refuse(
        extension,
        `deletion.removeWhen names "${name}", which its controls do not declare.`
      );
    }
    if (!("oneOf" in control)) {
      refuse(
        extension,
        `deletion.removeWhen names control "${name}", which must declare "oneOf".`
      );
    }
    if (control.on !== undefined) {
      refuse(
        extension,
        `control "${name}" is placed by deletion.removeWhen and may not declare "on".`
      );
    }
    const expected = readOwn(removeWhen, name, extension);
    if (!(isControlLiteral(expected) && control.oneOf.includes(expected))) {
      refuse(
        extension,
        `deletion.removeWhen.${name} must be one of control "${name}"'s values.`
      );
    }
    matched[name] = expected;
  }
  return Object.freeze(matched);
}

function snapshotDeletionEntry(
  value: unknown,
  model: AnyModel | undefined,
  modelName: string,
  extension: string
): RuntimeDeletionDeclaration["models"][string] {
  const label = `deletion.models.${modelName}`;
  const entry = requireRecord(value, label, extension);
  const keys = readMemberKeys(entry, ["at", "assign"], label, extension);
  const at = keys.includes("at")
    ? requireName(readOwn(entry, "at", extension), `${label}.at`, extension)
    : undefined;
  if (at !== undefined) {
    requireTimestampField(model, modelName, at, `${label}.at`, extension);
  }
  const assign = keys.includes("assign")
    ? copyRecord(
        readOwn(entry, "assign", extension),
        `${label}.assign`,
        extension
      )
    : NO_FIELDS;
  for (const field of Object.keys(assign)) {
    requireScalarField(model, modelName, field, `${label}.assign`, extension);
    if (field === at) {
      refuse(
        extension,
        `${label}.assign names "${field}", the field "at" stamps.`
      );
    }
  }
  return Object.freeze(at === undefined ? { assign } : { at, assign });
}

function snapshotDeletion(
  value: unknown,
  extension: string,
  schema: Schema | undefined,
  declared: RuntimeControlsContribution
): RuntimeDeletionDeclaration {
  const deletion = requireRecord(value, "deletion", extension);
  const keys = readMemberKeys(
    deletion,
    ["removeWhen", "models"],
    "deletion",
    extension
  );
  const removeWhen = keys.includes("removeWhen")
    ? snapshotRemoveWhen(
        readOwn(deletion, "removeWhen", extension),
        extension,
        declared
      )
    : undefined;
  const models = requireRecord(
    readOwn(deletion, "models", extension),
    "deletion.models",
    extension
  );
  const copied: Record<string, RuntimeDeletionDeclaration["models"][string]> =
    Object.create(null);
  for (const modelName of readStringKeys(
    models,
    "deletion.models",
    extension
  )) {
    copied[modelName] = snapshotDeletionEntry(
      readOwn(models, modelName, extension),
      readSchemaModel(schema, modelName, "deletion.models", extension),
      modelName,
      extension
    );
  }
  return Object.freeze({
    ...(removeWhen === undefined ? {} : { removeWhen }),
    models: Object.freeze(copied),
  });
}

/** A control takes no name a core operation argument has: core would lose it. */
function refuseCoreArgumentNames(
  extension: string,
  names: readonly string[],
  coreArguments: CoreArgumentNames | undefined
): void {
  if (coreArguments === undefined || names.length === 0) return;
  const argumentNames = coreArguments();
  for (const name of names) {
    if (argumentNames.has(name)) {
      refuse(
        extension,
        `control "${name}" takes the name of a core operation argument.`
      );
    }
  }
}

/** The top-level argument names the receiving client's operation schemas own. */
export type CoreArgumentNames = () => ReadonlySet<string>;

/**
 * Read a caller-owned definition once, validate it, and freeze only host-owned
 * snapshots. A failed application therefore cannot mutate the supplied value.
 */
export function normalizeExtensionDefinition(
  value: unknown,
  schema?: Schema,
  coreArguments?: CoreArgumentNames
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
    rawRows === undefined ? undefined : snapshotRows(rawRows, name, schema);
  const rawDeletion = member("deletion");
  const deletion =
    rawDeletion === undefined
      ? undefined
      : snapshotDeletion(rawDeletion, name, schema, controls ?? NO_CONTROLS);
  refuseCoreArgumentNames(
    name,
    [...Object.keys(controls ?? NO_CONTROLS), ...(rows ? [rows.control] : [])],
    coreArguments
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
  readonly query?: GenericQueryHandler | QueryHandlerMap<C>;
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
