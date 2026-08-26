import {
  getOfficialCacheChainCapability,
  getOfficialCacheQueryCapability,
  isOfficialCacheName,
  registerOfficialCacheChain,
} from "@cache/extension";
import {
  getOfficialDefaultOmitChainCapability,
  getOfficialDefaultOmitRequestCapability,
  OFFICIAL_DEFAULT_OMIT_NAME,
  registerOfficialDefaultOmitChain,
} from "@client/default-omit-extension";
import type { Schema } from "@client/types";
import {
  getOfficialInstrumentationChainCapability,
  isOfficialInstrumentationName,
  registerOfficialInstrumentationChain,
} from "@instrumentation/extension";
import { isFunction } from "@validation/value-guards";
import {
  extensionError,
  normalizeExtensionDefinition,
  type RuntimeExtensionDefinition,
} from "./definition";
import type {
  RuntimeClientMethodContribution,
  RuntimeModelMethodContribution,
} from "./methods";
import { getTrustedProtectedObserverCapability } from "./observation";

export interface ResolvedExtensionHandler<
  Handler extends CallableFunction = CallableFunction,
> {
  readonly extension: string;
  readonly handler: Handler;
}

/** One precompiled handler array for each exact execution target. */
export interface ResolvedExtensionOperationLookup {
  readonly global: readonly ResolvedExtensionHandler[];
  readonly models: Readonly<
    Record<
      string,
      Readonly<Record<string, readonly ResolvedExtensionHandler[]>>
    >
  >;
  readonly raw: Readonly<Record<string, readonly ResolvedExtensionHandler[]>>;
}

export interface ResolvedExtension {
  readonly name: string;
  readonly client?: RuntimeClientMethodContribution;
  readonly model?: RuntimeModelMethodContribution;
}

/** Absent on an unextended client; fully frozen whenever it exists. */
export interface ResolvedExtensionChain {
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
): readonly ResolvedExtensionHandler[] | undefined {
  if (chain === undefined) return undefined;
  const lookup = chain[component];
  const global = lookup.global.length === 0 ? undefined : lookup.global;
  if (model === undefined) {
    return (
      lookup.raw[operation] ?? (component === "query" ? global : undefined)
    );
  }
  return lookup.models[model]?.[operation] ?? global;
}

function resolvedHandler(
  extension: Pick<ResolvedExtension, "name">,
  handler: CallableFunction
): ResolvedExtensionHandler {
  return Object.freeze({ extension: extension.name, handler });
}

function appendModelHandler(
  models: Record<string, Record<string, ResolvedExtensionHandler[]>>,
  model: string,
  operation: string,
  handler: ResolvedExtensionHandler,
  global: readonly ResolvedExtensionHandler[]
): void {
  const operations = (models[model] ??= Object.create(null));
  const handlers = (operations[operation] ??= [...global]);
  handlers.push(handler);
}

function appendGlobalHandler(
  models: Record<string, Record<string, ResolvedExtensionHandler[]>>,
  raw: Record<string, ResolvedExtensionHandler[]>,
  handler: ResolvedExtensionHandler
): void {
  for (const operations of Object.values(models)) {
    for (const handlers of Object.values(operations)) handlers.push(handler);
  }
  for (const handlers of Object.values(raw)) handlers.push(handler);
}

function appendOperationHandlers(
  previous: ResolvedExtensionOperationLookup | undefined,
  extension: Pick<ResolvedExtension, "name">,
  contribution: RuntimeExtensionDefinition["request"]
): ResolvedExtensionOperationLookup {
  if (contribution === undefined && previous !== undefined) return previous;

  const models: Record<
    string,
    Record<string, ResolvedExtensionHandler[]>
  > = Object.create(null);
  const raw: Record<string, ResolvedExtensionHandler[]> = Object.create(null);
  const global: ResolvedExtensionHandler[] = previous
    ? [...previous.global]
    : [];

  if (previous) {
    for (const [modelName, operationMap] of Object.entries(previous.models)) {
      const operations: Record<string, ResolvedExtensionHandler[]> =
        Object.create(null);
      for (const [operation, handlers] of Object.entries(operationMap)) {
        operations[operation] = [...handlers];
      }
      models[modelName] = operations;
    }
    for (const [operation, handlers] of Object.entries(previous.raw)) {
      raw[operation] = [...handlers];
    }
  }

  if (contribution) {
    if (isFunction(contribution)) {
      const handler = resolvedHandler(extension, contribution);
      global.push(handler);
      appendGlobalHandler(models, raw, handler);
    } else {
      for (const [modelName, operationMap] of Object.entries(contribution)) {
        for (const [operation, handler] of Object.entries(operationMap)) {
          appendModelHandler(
            models,
            modelName,
            operation,
            resolvedHandler(extension, handler),
            global
          );
        }
      }
    }
  }

  const frozenModels: Record<
    string,
    Readonly<Record<string, readonly ResolvedExtensionHandler[]>>
  > = Object.create(null);
  for (const [modelName, operationMap] of Object.entries(models)) {
    const frozenOperations: Record<
      string,
      readonly ResolvedExtensionHandler[]
    > = Object.create(null);
    for (const [operation, handlers] of Object.entries(operationMap)) {
      frozenOperations[operation] = Object.freeze(handlers);
    }
    frozenModels[modelName] = Object.freeze(frozenOperations);
  }
  const frozenRaw: Record<string, readonly ResolvedExtensionHandler[]> =
    Object.create(null);
  for (const [operation, handlers] of Object.entries(raw)) {
    frozenRaw[operation] = Object.freeze(handlers);
  }
  return Object.freeze({
    global: Object.freeze(global),
    models: Object.freeze(frozenModels),
    raw: Object.freeze(frozenRaw),
  });
}

function hasCompiledHandlers(
  lookup: ResolvedExtensionOperationLookup
): boolean {
  if (lookup.global.length > 0 || Object.keys(lookup.raw).length > 0) {
    return true;
  }
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

function stripOfficialCacheQuery(
  definition: RuntimeExtensionDefinition
): RuntimeExtensionDefinition {
  const { query: _officialCacheQuery, ...ordinaryDefinition } = definition;
  return Object.freeze(ordinaryDefinition);
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

export function appendResolvedExtension(
  chain: ResolvedExtensionChain | undefined,
  value: unknown,
  schema: Schema
): ResolvedExtensionChain {
  const definition = normalizeExtensionDefinition(value, schema);
  const incomingCache = getOfficialCacheQueryCapability(definition.query);
  const existingOfficialCache = getOfficialCacheChainCapability(chain);
  const incomingDefaultOmit = getOfficialDefaultOmitRequestCapability(
    definition.request
  );
  const existingDefaultOmit = getOfficialDefaultOmitChainCapability(chain);
  if (incomingCache !== undefined && existingOfficialCache !== undefined) {
    extensionError(
      "The official cache extension is already present on this client.",
      definition.name
    );
  }
  if (incomingCache !== undefined && !isOfficialCacheName(definition.name)) {
    extensionError(
      'The official cache extension name must be "viborm.cache".',
      definition.name
    );
  }
  if (incomingCache === undefined && isOfficialCacheName(definition.name)) {
    extensionError(
      'Extension name "viborm.cache" is reserved for the official cache extension.',
      definition.name
    );
  }
  if (
    incomingDefaultOmit !== undefined &&
    definition.name !== OFFICIAL_DEFAULT_OMIT_NAME
  ) {
    extensionError(
      `The official default omit extension name must be "${OFFICIAL_DEFAULT_OMIT_NAME}".`,
      definition.name
    );
  }
  if (
    incomingDefaultOmit === undefined &&
    definition.name === OFFICIAL_DEFAULT_OMIT_NAME
  ) {
    extensionError(
      `Extension name "${OFFICIAL_DEFAULT_OMIT_NAME}" is reserved for the official default omit extension.`,
      definition.name
    );
  }
  if (incomingDefaultOmit !== undefined && chain?.hasResultConsumers === true) {
    extensionError(
      "The default omit extension cannot follow an extension that defines model-mapped query, client, or model behavior.",
      definition.name
    );
  }
  const incomingOfficial = getTrustedProtectedObserverCapability(
    definition.observe
  );
  const existingOfficial = getOfficialInstrumentationChainCapability(chain);
  if (incomingOfficial !== undefined && existingOfficial !== undefined) {
    extensionError(
      "The official instrumentation extension is already present on this client.",
      definition.name
    );
  }
  if (
    incomingOfficial !== undefined &&
    !isOfficialInstrumentationName(definition.name)
  ) {
    extensionError(
      'The official instrumentation extension name must be "viborm.instrumentation".',
      definition.name
    );
  }
  if (
    incomingOfficial === undefined &&
    isOfficialInstrumentationName(definition.name)
  ) {
    extensionError(
      'Extension name "viborm.instrumentation" is reserved for the official instrumentation extension.',
      definition.name
    );
  }
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
      : stripOfficialCacheQuery(definition);
  const resolved: ResolvedExtension = Object.freeze({
    name: definition.name,
    ...(effectiveDefinition.client === undefined
      ? {}
      : { client: effectiveDefinition.client }),
    ...(effectiveDefinition.model === undefined
      ? {}
      : { model: effectiveDefinition.model }),
  });
  const extensions = Object.freeze(
    chain ? [...chain.extensions, resolved] : [resolved]
  );
  const request = appendOperationHandlers(
    chain?.request,
    resolved,
    effectiveDefinition.request
  );
  const query = appendOperationHandlers(
    chain?.query,
    resolved,
    effectiveDefinition.query
  );
  const resolvedChain = Object.freeze({
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
