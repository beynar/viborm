import {
  getOfficialCacheChainDefinition,
  getOfficialCacheQueryCapability,
  OFFICIAL_CACHE_NAME,
  officialCacheControls,
  registerOfficialCacheChain,
} from "@cache/extension";
import {
  getOfficialDefaultOmitChainCapability,
  getOfficialDefaultOmitRequestCapability,
  OFFICIAL_DEFAULT_OMIT_NAME,
  registerOfficialDefaultOmitChain,
} from "@client/default-omit-extension";
import type { Schema } from "@client/types";
import { isFunction } from "@validation/value-guards";
import { type PlacedControlDeclaration, placeControls } from "./controls";
import {
  type ControlLiteral,
  type ExtensionSchemaRegistry,
  extensionError,
  normalizeExtensionDefinition,
  type RuntimeControlDeclaration,
  type RuntimeDeletionDeclaration,
  type RuntimeExtensionDefinition,
  type RuntimeRowsDeclaration,
} from "./definition";
import type {
  RuntimeClientMethodContribution,
  RuntimeModelMethodContribution,
} from "./methods";
import {
  getOfficialInstrumentationChainCapability,
  getTrustedProtectedObserverCapability,
  registerOfficialInstrumentationChain,
} from "./observation";
import { bindRows, type RowsBinding } from "./rows";

/** The fixed name admission reserves for the official instrumentation extension. */
export const OFFICIAL_INSTRUMENTATION_NAME = "viborm.instrumentation";

export interface ResolvedExtensionHandler<
  Handler extends CallableFunction = CallableFunction,
> {
  readonly extension: string;
  readonly handler: Handler;
}

/**
 * A request or query handler. The controls its extension declares travel
 * with it: the only ones its `context.controls` shows.
 */
export interface ResolvedOperationHandler<
  Handler extends CallableFunction = CallableFunction,
> extends ResolvedExtensionHandler<Handler> {
  readonly controls?: readonly string[];
}

/** One precompiled handler array for each exact execution target. */
export interface ResolvedExtensionOperationLookup {
  readonly global: readonly ResolvedOperationHandler[];
  readonly models: Readonly<
    Record<
      string,
      Readonly<Record<string, readonly ResolvedOperationHandler[]>>
    >
  >;
}

export interface ResolvedExtension {
  readonly name: string;
  readonly client?: RuntimeClientMethodContribution;
  readonly model?: RuntimeModelMethodContribution;
}

/** Who owns a request or query handler: its extension and that one's controls. */
interface OperationHandlerOwner {
  readonly name: string;
  readonly controls?: readonly string[];
}

/** One control of the chain: its owner and how a value is admitted. */
export interface ResolvedControl {
  readonly name: string;
  readonly extension: string;
  readonly declaration: RuntimeControlDeclaration;
  /** What an absent argument admits: the `rows` control's default mode. */
  readonly fallback?: ControlLiteral;
}

/** One precompiled control list for each (model, operation) that has one. */
export interface ResolvedControls {
  /** Every control name on the chain: one name space. */
  readonly names: ReadonlySet<string>;
  /** Controls placed on an operation of every model. */
  readonly operations: Readonly<Record<string, readonly ResolvedControl[]>>;
  /** Per model, its operations' lists, every-model controls included. */
  readonly models: Readonly<
    Record<string, Readonly<Record<string, readonly ResolvedControl[]>>>
  >;
}

/** One `rows` member of the chain, with the extension that declared it. */
export interface ResolvedRows extends RuntimeRowsDeclaration {
  readonly extension: string;
}

/** What a delete of one managed model writes, and who declared it. */
export interface ResolvedDeletion {
  readonly extension: string;
  readonly at?: string;
  readonly assign: Readonly<Record<string, unknown>>;
  readonly removeWhen?: Readonly<Record<string, ControlLiteral>>;
}

/** Absent on an unextended client; fully frozen whenever it exists. */
export interface ResolvedExtensionChain {
  readonly controls?: ResolvedControls;
  readonly rows?: readonly ResolvedRows[];
  readonly deletion?: Readonly<Record<string, ResolvedDeletion>>;
  /** Derived from `rows` and `deletion`: what each call's controls resolve to. */
  readonly callRows?: RowsBinding;
  readonly extensions: readonly ResolvedExtension[];
  readonly hasCache: boolean;
  readonly hasRequestHandlers: boolean;
  readonly hasQueryHandlers: boolean;
  readonly hasResultConsumers: boolean;
  readonly request: ResolvedExtensionOperationLookup;
  readonly query: ResolvedExtensionOperationLookup;
  readonly statement: readonly ResolvedExtensionHandler[];
  readonly observe: readonly ResolvedExtensionHandler[];
}

/** Return the precompiled array itself; lookup scans and merges nothing. */
export function lookupResolvedExtensionHandlers(
  chain: ResolvedExtensionChain | undefined,
  component: "request" | "query",
  model: string | undefined,
  operation: string
): readonly ResolvedOperationHandler[] | undefined {
  if (chain === undefined) return undefined;
  const lookup = chain[component];
  const global = lookup.global.length === 0 ? undefined : lookup.global;
  if (model === undefined) {
    return component === "query" ? global : undefined;
  }
  return lookup.models[model]?.[operation] ?? global;
}

/** The controls one (model, operation) accepts; the shared empty list when none. */
export function lookupPlacedControls(
  chain: ResolvedExtensionChain | undefined,
  model: string,
  operation: string
): readonly ResolvedControl[] {
  const controls = chain?.controls;
  if (controls === undefined) return NO_CONTROLS;
  return (
    controls.models[model]?.[operation] ??
    controls.operations[operation] ??
    NO_CONTROLS
  );
}

const NO_CONTROLS: readonly ResolvedControl[] = Object.freeze([]);

function resolvedHandler(
  extension: Pick<ResolvedExtension, "name">,
  handler: CallableFunction
): ResolvedExtensionHandler {
  return Object.freeze({ extension: extension.name, handler });
}

function resolvedOperationHandler(
  extension: OperationHandlerOwner,
  handler: CallableFunction
): ResolvedOperationHandler {
  return Object.freeze(
    extension.controls === undefined
      ? { extension: extension.name, handler }
      : { extension: extension.name, handler, controls: extension.controls }
  );
}

function appendModelHandler(
  models: Record<string, Record<string, ResolvedOperationHandler[]>>,
  model: string,
  operation: string,
  handler: ResolvedOperationHandler,
  global: readonly ResolvedOperationHandler[]
): void {
  const operations = (models[model] ??= Object.create(null));
  const handlers = (operations[operation] ??= [...global]);
  handlers.push(handler);
}

function appendGlobalHandler(
  models: Record<string, Record<string, ResolvedOperationHandler[]>>,
  handler: ResolvedOperationHandler
): void {
  for (const operations of Object.values(models)) {
    for (const handlers of Object.values(operations)) handlers.push(handler);
  }
}

function appendOperationHandlers(
  previous: ResolvedExtensionOperationLookup | undefined,
  extension: OperationHandlerOwner,
  contribution: RuntimeExtensionDefinition["request"]
): ResolvedExtensionOperationLookup {
  if (contribution === undefined && previous !== undefined) return previous;

  const models: Record<
    string,
    Record<string, ResolvedOperationHandler[]>
  > = Object.create(null);
  const global: ResolvedOperationHandler[] = previous
    ? [...previous.global]
    : [];

  if (previous) {
    for (const [modelName, operationMap] of Object.entries(previous.models)) {
      const operations: Record<string, ResolvedOperationHandler[]> =
        Object.create(null);
      for (const [operation, handlers] of Object.entries(operationMap)) {
        operations[operation] = [...handlers];
      }
      models[modelName] = operations;
    }
  }

  if (contribution) {
    if (isFunction(contribution)) {
      const handler = resolvedOperationHandler(extension, contribution);
      global.push(handler);
      appendGlobalHandler(models, handler);
    } else {
      for (const [modelName, operationMap] of Object.entries(contribution)) {
        for (const [operation, handler] of Object.entries(operationMap)) {
          appendModelHandler(
            models,
            modelName,
            operation,
            resolvedOperationHandler(extension, handler),
            global
          );
        }
      }
    }
  }

  const frozenModels: Record<
    string,
    Readonly<Record<string, readonly ResolvedOperationHandler[]>>
  > = Object.create(null);
  for (const [modelName, operationMap] of Object.entries(models)) {
    const frozenOperations: Record<
      string,
      readonly ResolvedOperationHandler[]
    > = Object.create(null);
    for (const [operation, handlers] of Object.entries(operationMap)) {
      frozenOperations[operation] = Object.freeze(handlers);
    }
    frozenModels[modelName] = Object.freeze(frozenOperations);
  }
  return Object.freeze({
    global: Object.freeze(global),
    models: Object.freeze(frozenModels),
  });
}

function hasCompiledHandlers(
  lookup: ResolvedExtensionOperationLookup
): boolean {
  if (lookup.global.length > 0) return true;
  for (const operations of Object.values(lookup.models)) {
    if (Object.keys(operations).length > 0) return true;
  }
  return false;
}

function appendFlatHandler(
  previous: readonly ResolvedExtensionHandler[] | undefined,
  extension: Pick<ResolvedExtension, "name">,
  handler: CallableFunction | undefined
): readonly ResolvedExtensionHandler[] {
  if (handler === undefined) return previous ?? Object.freeze([]);
  const handlers = previous ? [...previous] : [];
  handlers.push(resolvedHandler(extension, handler));
  return Object.freeze(handlers);
}

function appendObserver(
  previous: readonly ResolvedExtensionHandler[] | undefined,
  extension: Pick<ResolvedExtension, "name">,
  handler: CallableFunction | undefined
): readonly ResolvedExtensionHandler[] {
  if (handler === undefined) return previous ?? Object.freeze([]);
  const official = getTrustedProtectedObserverCapability(handler);
  if (official !== undefined && !official.observesLifecycle) {
    return previous ?? Object.freeze([]);
  }
  return appendFlatHandler(previous, extension, handler);
}

type MutableControlLists = Record<string, ResolvedControl[]>;

function copyControlLists(
  lists: Readonly<Record<string, readonly ResolvedControl[]>> | undefined
): MutableControlLists {
  const copy: MutableControlLists = Object.create(null);
  for (const [operation, controls] of Object.entries(lists ?? {})) {
    copy[operation] = [...controls];
  }
  return copy;
}

function freezeControlLists(
  lists: MutableControlLists
): Readonly<Record<string, readonly ResolvedControl[]>> {
  const frozen: Record<string, readonly ResolvedControl[]> =
    Object.create(null);
  for (const [operation, controls] of Object.entries(lists)) {
    frozen[operation] = Object.freeze(controls);
  }
  return Object.freeze(frozen);
}

/**
 * Add one definition's controls to the chain's name space and placement. A
 * control on every model joins every model's list for its operations; a
 * control on some models starts their lists from the every-model ones.
 */
function appendControls(
  previous: ResolvedControls | undefined,
  extension: string,
  declarations: readonly PlacedControlDeclaration[]
): ResolvedControls {
  const names = new Set(previous?.names);
  const operations = copyControlLists(previous?.operations);
  const models: Record<string, MutableControlLists> = Object.create(null);
  for (const [model, lists] of Object.entries(previous?.models ?? {})) {
    models[model] = copyControlLists(lists);
  }
  for (const declaration of declarations) {
    if (names.has(declaration.name)) {
      extensionError(
        `Extension "${extension}" control "${declaration.name}" is already declared on this client.`,
        extension
      );
    }
    names.add(declaration.name);
    const control: ResolvedControl = Object.freeze({
      name: declaration.name,
      extension,
      declaration: declaration.declaration,
      ...(declaration.fallback === undefined
        ? {}
        : { fallback: declaration.fallback }),
    });
    for (const operation of declaration.operations) {
      if (declaration.models === undefined) {
        (operations[operation] ??= []).push(control);
        for (const lists of Object.values(models)) {
          lists[operation]?.push(control);
        }
        continue;
      }
      for (const model of declaration.models) {
        const lists = (models[model] ??= Object.create(null));
        (lists[operation] ??= [...(operations[operation] ?? [])]).push(control);
      }
    }
  }
  const frozenModels: Record<
    string,
    Readonly<Record<string, readonly ResolvedControl[]>>
  > = Object.create(null);
  for (const [model, lists] of Object.entries(models)) {
    frozenModels[model] = freezeControlLists(lists);
  }
  return Object.freeze({
    names,
    operations: freezeControlLists(operations),
    models: Object.freeze(frozenModels),
  });
}

/** One entry per managed model on the chain. */
function appendDeletion(
  previous: Readonly<Record<string, ResolvedDeletion>> | undefined,
  extension: string,
  deletion: RuntimeDeletionDeclaration
): Readonly<Record<string, ResolvedDeletion>> {
  const entries: Record<string, ResolvedDeletion> = Object.create(null);
  Object.assign(entries, previous);
  for (const [model, entry] of Object.entries(deletion.models)) {
    if (Object.hasOwn(entries, model)) {
      extensionError(
        `Extension "${extension}" deletion names model "${model}", which extension "${entries[model]?.extension}" already manages on this client.`,
        extension
      );
    }
    entries[model] = Object.freeze({
      extension,
      ...entry,
      ...(deletion.removeWhen === undefined
        ? {}
        : { removeWhen: deletion.removeWhen }),
    });
  }
  return Object.freeze(entries);
}

/** The cache's query leaves the chain's handlers; its control is its own. */
function asOfficialCacheDefinition(
  definition: RuntimeExtensionDefinition
): RuntimeExtensionDefinition {
  const { query: _officialCacheQuery, ...ordinaryDefinition } = definition;
  return Object.freeze({
    ...ordinaryDefinition,
    controls: officialCacheControls,
  });
}

function stripOfficialDefaultOmitRequest(
  definition: RuntimeExtensionDefinition
): RuntimeExtensionDefinition {
  const { request: _officialDefaultOmitRequest, ...ordinaryDefinition } =
    definition;
  return Object.freeze(ordinaryDefinition);
}

function consumesOperationResults(
  definition: RuntimeExtensionDefinition
): boolean {
  return (
    (definition.query !== undefined && !isFunction(definition.query)) ||
    definition.client !== undefined ||
    definition.model !== undefined
  );
}

function assertOfficialExtensionAdmission(options: {
  readonly definitionName: string;
  readonly officialName: string;
  readonly label: string;
  readonly hasIdentity: boolean;
  readonly isAlreadyPresent: boolean;
  readonly duplicateMessage: string;
}): void {
  if (options.hasIdentity && options.isAlreadyPresent) {
    extensionError(options.duplicateMessage, options.definitionName);
  }
  if (options.hasIdentity && options.definitionName !== options.officialName) {
    extensionError(
      `The official ${options.label} extension name must be "${options.officialName}".`,
      options.definitionName
    );
  }
  if (!options.hasIdentity && options.definitionName === options.officialName) {
    extensionError(
      `Extension name "${options.officialName}" is reserved for the official ${options.label} extension.`,
      options.definitionName
    );
  }
}

export function appendResolvedExtension(
  chain: ResolvedExtensionChain | undefined,
  value: unknown,
  schema: Schema,
  registry?: ExtensionSchemaRegistry
): ResolvedExtensionChain {
  const definition = normalizeExtensionDefinition(value, schema, registry);
  const incomingCache = getOfficialCacheQueryCapability(definition.query);
  const existingOfficialCache = getOfficialCacheChainDefinition(chain);
  const incomingDefaultOmit = getOfficialDefaultOmitRequestCapability(
    definition.request
  );
  const existingDefaultOmit = getOfficialDefaultOmitChainCapability(chain);
  assertOfficialExtensionAdmission({
    definitionName: definition.name,
    officialName: OFFICIAL_CACHE_NAME,
    label: "cache",
    hasIdentity: incomingCache !== undefined,
    isAlreadyPresent: existingOfficialCache !== undefined,
    duplicateMessage:
      "The official cache extension is already present on this client.",
  });
  assertOfficialExtensionAdmission({
    definitionName: definition.name,
    officialName: OFFICIAL_DEFAULT_OMIT_NAME,
    label: "default omit",
    hasIdentity: incomingDefaultOmit !== undefined,
    // The generic duplicate-name check owns default-omit duplication after
    // instrumentation admission, preserving hostile hybrid error precedence.
    isAlreadyPresent: false,
    duplicateMessage: `Extension "${OFFICIAL_DEFAULT_OMIT_NAME}" is already present on this client.`,
  });
  if (incomingDefaultOmit !== undefined && chain?.hasResultConsumers === true) {
    extensionError(
      "The default omit extension cannot follow an extension that defines model-mapped query, client, or model behavior.",
      definition.name
    );
  }
  if (definition.rows !== undefined && chain?.hasResultConsumers === true) {
    extensionError(
      `Extension "${definition.name}" declares rows, which cannot follow an extension that defines model-mapped query, client, or model behavior.`,
      definition.name
    );
  }
  const incomingOfficial = getTrustedProtectedObserverCapability(
    definition.observe
  );
  const existingOfficial = getOfficialInstrumentationChainCapability(chain);
  assertOfficialExtensionAdmission({
    definitionName: definition.name,
    officialName: OFFICIAL_INSTRUMENTATION_NAME,
    label: "instrumentation",
    hasIdentity: incomingOfficial !== undefined,
    isAlreadyPresent: existingOfficial !== undefined,
    duplicateMessage:
      "The official instrumentation extension is already present on this client.",
  });
  if (
    chain?.extensions.some((extension) => extension.name === definition.name)
  ) {
    extensionError(
      `Extension "${definition.name}" is already present on this client.`,
      definition.name
    );
  }
  const effectiveDefinition =
    incomingCache === undefined
      ? incomingDefaultOmit === undefined
        ? definition
        : stripOfficialDefaultOmitRequest(definition)
      : asOfficialCacheDefinition(definition);
  const declaredControls =
    effectiveDefinition.controls === undefined &&
    effectiveDefinition.rows === undefined
      ? undefined
      : placeControls(effectiveDefinition);
  const resolved: ResolvedExtension = Object.freeze({
    name: definition.name,
    ...(effectiveDefinition.client === undefined
      ? {}
      : { client: effectiveDefinition.client }),
    ...(effectiveDefinition.model === undefined
      ? {}
      : { model: effectiveDefinition.model }),
  });
  const handlerOwner: OperationHandlerOwner =
    declaredControls === undefined
      ? resolved
      : {
          name: definition.name,
          controls: Object.freeze(
            declaredControls.map((control) => control.name)
          ),
        };
  const extensions = Object.freeze(
    chain ? [...chain.extensions, resolved] : [resolved]
  );
  const request = appendOperationHandlers(
    chain?.request,
    handlerOwner,
    effectiveDefinition.request
  );
  const query = appendOperationHandlers(
    chain?.query,
    handlerOwner,
    effectiveDefinition.query
  );
  const controls =
    declaredControls === undefined
      ? chain?.controls
      : appendControls(chain?.controls, definition.name, declaredControls);
  const rows =
    effectiveDefinition.rows === undefined
      ? chain?.rows
      : Object.freeze([
          ...(chain?.rows ?? []),
          Object.freeze({
            extension: definition.name,
            ...effectiveDefinition.rows,
          }),
        ]);
  const deletion =
    effectiveDefinition.deletion === undefined
      ? chain?.deletion
      : appendDeletion(
          chain?.deletion,
          definition.name,
          effectiveDefinition.deletion
        );
  const callRows =
    rows === chain?.rows && deletion === chain?.deletion
      ? chain?.callRows
      : bindRows(rows, deletion);
  const resolvedChain = Object.freeze({
    ...(controls === undefined ? {} : { controls }),
    ...(rows === undefined ? {} : { rows }),
    ...(deletion === undefined ? {} : { deletion }),
    ...(callRows === undefined ? {} : { callRows }),
    extensions,
    hasCache: incomingCache !== undefined || chain?.hasCache === true,
    hasRequestHandlers: hasCompiledHandlers(request),
    hasQueryHandlers: hasCompiledHandlers(query),
    hasResultConsumers:
      chain?.hasResultConsumers === true ||
      consumesOperationResults(effectiveDefinition),
    request,
    query,
    statement: appendFlatHandler(
      chain?.statement,
      resolved,
      effectiveDefinition.statement
    ),
    observe: appendObserver(
      chain?.observe,
      resolved,
      effectiveDefinition.observe
    ),
  });
  const official = incomingOfficial ?? existingOfficial;
  if (official !== undefined) {
    registerOfficialInstrumentationChain(resolvedChain, official);
  }
  const officialCache = incomingCache ?? existingOfficialCache;
  if (officialCache !== undefined) {
    registerOfficialCacheChain(resolvedChain, officialCache);
  }
  const officialDefaultOmit = incomingDefaultOmit ?? existingDefaultOmit;
  if (officialDefaultOmit !== undefined) {
    registerOfficialDefaultOmitChain(resolvedChain, officialDefaultOmit);
  }
  return resolvedChain;
}
