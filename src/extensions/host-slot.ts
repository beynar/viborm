/**
 * Where the client finds the code that admits and runs extensions. The client
 * brings none of it: what builds a definition does (`defineExtension()`,
 * `defineHooks()` and the official extensions), so a program that applies no
 * extension does not carry it.
 *
 * Each function here answers by itself what a client without extensions is
 * owed, and asks the host for anything else.
 */
import { ClientInitializationError } from "@errors";
import type {
  ResolvedExtensionChain,
  ResolvedExtensionHandler,
  ResolvedOperationHandler,
} from "./chain";
import type { ResolvedControl } from "./controls";
import type { EXTENSION_HOST } from "./host";
import type {
  LifecycleUnit,
  LifecycleUnitKind,
  ObservationCompletionFactsReader,
} from "./observation";
import type { OfficialLifecycleFactsReader } from "./official-facts";
import type {
  PreparedQueryContext,
  QueryInterceptorExecutionControl,
  TransactionWriteOutcomes,
  WriteOutcomeNotifications,
  WriteOutcomeRegistration,
} from "./query";

export type ExtensionHost = typeof EXTENSION_HOST;

let installed: ExtensionHost | undefined;

export const installExtensionHost = (host: ExtensionHost): void => {
  installed = host;
};

/** What admits and runs extensions: there once something built a definition. */
export function extensionHost(): ExtensionHost {
  if (installed === undefined)
    throw new ClientInitializationError(
      "An extension was applied to a client, and nothing brought the code that runs extensions: build its definition with defineExtension() or defineHooks(), or call enableExtensions() once."
    );
  return installed;
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

export const NO_CONTROLS: readonly ResolvedControl[] = Object.freeze([]);

/** The controls one (model, operation) accepts; the shared empty list when none. */
export function lookupPlacedControls(
  chain: ResolvedExtensionChain | undefined,
  model: string,
  operation: string
): readonly ResolvedControl[] {
  return chain?.controls?.placed(model, operation) ?? NO_CONTROLS;
}

/** The declaration of what one observer of the chain is handed facts for, if any. */
export const getOfficialInstrumentationChainCapability = (
  chain: ResolvedExtensionChain | undefined
) =>
  chain === undefined
    ? undefined
    : installed?.getOfficialInstrumentationChainCapability(chain);

/** One lifecycle unit under the chain's observers: the child alone where there is none. */
export function runProtectedObservers<Result>(
  unit: LifecycleUnit,
  observers: readonly ResolvedExtensionHandler[] | undefined,
  child: () => Promise<Result>,
  readCompletionFacts?: ObservationCompletionFactsReader,
  readInstrumentationFacts?: OfficialLifecycleFactsReader
): Promise<Result> {
  return observers === undefined || observers.length === 0
    ? child()
    : extensionHost().runProtectedObservers(
        unit,
        observers,
        child,
        readCompletionFacts,
        readInstrumentationFacts
      );
}

/** Observe one logical operation without duplicating its completion protocol. */
export function observeOperation<Result>(
  observers: readonly ResolvedExtensionHandler[],
  operation: string,
  model: string | undefined,
  child: () => Promise<Result>,
  readCompletionFacts?: ObservationCompletionFactsReader,
  readInstrumentationFacts?: OfficialLifecycleFactsReader
): Promise<Result> {
  return runProtectedObservers(
    {
      kind: "operation",
      operation,
      ...(model === undefined ? {} : { model }),
    },
    observers,
    child,
    readCompletionFacts,
    readInstrumentationFacts
  );
}

/** Observe one driver-owned physical statement boundary. */
export function observeStatement<Result>(
  observers: readonly ResolvedExtensionHandler[],
  operation: string | undefined,
  model: string | undefined,
  child: () => Promise<Result>,
  readCompletionFacts?: ObservationCompletionFactsReader,
  readInstrumentationFacts?: OfficialLifecycleFactsReader
): Promise<Result> {
  return runProtectedObservers(
    {
      kind: "statement",
      ...(operation === undefined ? {} : { operation }),
      ...(model === undefined || model === "$raw" ? {} : { model }),
    },
    observers,
    child,
    readCompletionFacts,
    readInstrumentationFacts
  );
}

/** Observe one driver-owned connection, transaction, or savepoint boundary. */
export function observeDriverLifecycle<Result>(
  kind: Extract<LifecycleUnitKind, "connection" | "savepoint" | "transaction">,
  observers: readonly ResolvedExtensionHandler[],
  operation: string | undefined,
  child: () => Promise<Result>,
  readCompletionFacts?: ObservationCompletionFactsReader,
  readInstrumentationFacts?: OfficialLifecycleFactsReader
): Promise<Result> {
  return runProtectedObservers(
    {
      kind,
      ...(operation === undefined ? {} : { operation }),
    },
    observers,
    child,
    readCompletionFacts,
    readInstrumentationFacts
  );
}

/** The one readiness the chain's observers ask for before a coordinated array starts. */
export const prewarmProtectedObservers = (
  observers: readonly ResolvedExtensionHandler[] | undefined
): void | Promise<void> =>
  observers === undefined || observers.length === 0
    ? undefined
    : extensionHost().prewarmProtectedObservers(observers);

/** The failures a coordinated query folded into one, where `failure` is such a fold. */
export const decomposeQueryCoordinationFailure = (failure: unknown) =>
  installed?.decomposeQueryCoordinationFailure(failure);

/** The failures of the listeners a publication ran, where `failure` folds several. */
export const decomposeWriteOutcomePublicationFailure = (
  failure: unknown
): readonly unknown[] =>
  installed?.decomposeWriteOutcomePublicationFailure(failure) ?? [failure];

/** One prepared operation through its query handlers: the child alone where nothing intercepts it. */
export function executePreparedQuery<Result, Input extends object>(
  context: PreparedQueryContext<Input> | undefined,
  interceptors: readonly ResolvedOperationHandler[] | undefined,
  child: (notifications?: WriteOutcomeNotifications) => Promise<Result>,
  isWrite: boolean,
  transactionWriteOutcomes?: TransactionWriteOutcomes,
  control?: QueryInterceptorExecutionControl,
  preRegisteredWriteOutcome?: WriteOutcomeRegistration
): Promise<Result> {
  return (context === undefined ||
    interceptors === undefined ||
    interceptors.length === 0) &&
    preRegisteredWriteOutcome === undefined
    ? child()
    : extensionHost().executePreparedQuery(
        context,
        interceptors,
        child,
        isWrite,
        transactionWriteOutcomes,
        control,
        preRegisteredWriteOutcome
      );
}
