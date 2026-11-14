import { sanitizeErrorForLogging } from "@errors";
import { isFunction } from "@validation/value-guards";
import { isError } from "../errors/diagnostic-safety";
import type {
  ExtensionPart,
  ResolvedExtensionChain,
  ResolvedExtensionHandler,
} from "./chain";
import { ARRAYS, coordinate } from "./coordination";
import { extensionError } from "./definition";
import type {
  OfficialLifecycleCompletionFacts,
  OfficialLifecycleFacts,
  OfficialLifecycleFactsReader,
  OfficialObservationCapability,
} from "./official-facts";

/** The exact public facts carried by each protected lifecycle boundary. */
export type LifecycleUnit =
  | Readonly<{
      kind: "operation";
      operation: string;
      model?: string;
    }>
  | Readonly<{
      kind: "statement";
      operation?: string;
      model?: string;
    }>
  | Readonly<{
      kind: "batch";
      operation: string;
    }>
  | Readonly<{
      kind: "transaction";
      operation?: string;
    }>
  | Readonly<{
      kind: "savepoint";
      operation?: string;
    }>
  | Readonly<{
      kind: "connection";
      operation?: string;
    }>
  | Readonly<{
      kind: "cache";
      operation: "get" | "set" | "revalidate" | "invalidate";
    }>;

export type LifecycleUnitKind = LifecycleUnit["kind"];

export type CommitCertainty = "committed" | "may-have-committed";

export interface ObservationErrorSummary {
  readonly name: string;
  readonly message: string;
  readonly code?: string;
}

export interface ObservationCompletion {
  readonly status: "success" | "failure";
  readonly durationMs: number;
  readonly error?: ObservationErrorSummary;
  readonly commitCertainty?: CommitCertainty;
}

export interface ObservationCompletionFacts {
  readonly commitCertainty?: CommitCertainty;
}

export type ObservationCompletionFactsReader = () =>
  | ObservationCompletionFacts
  | undefined;

export type ObservationUnit = LifecycleUnit;

/**
 * What the observer of a definition that declares `observes` reads of the
 * unit it is called for: the facts core produced for what it said it wants,
 * and, once the unit settled, the facts of its completion.
 */
export interface ObservedFacts {
  read(): OfficialLifecycleFacts | undefined;
  completion(): OfficialLifecycleCompletionFacts | undefined;
}

export type ObserveHandler = (
  unit: ObservationUnit,
  proceed: () => Promise<ObservationCompletion>,
  /** Present only where the definition declares `observes`. */
  facts?: ObservedFacts
) => unknown;

type TrustedProtectedObserver = (
  unit: LifecycleUnit,
  proceed: () => Promise<ObservationCompletion>
) => unknown;

interface TrustedProtectedObserverRegistration {
  readonly capability: OfficialObservationCapability;
  readonly observer: TrustedProtectedObserver;
}

interface ProtectedLifecycleFactsState {
  readonly facts: OfficialLifecycleFacts;
  completion?: OfficialLifecycleCompletionFacts;
}

const trustedObservers = new WeakMap<
  CallableFunction,
  TrustedProtectedObserverRegistration
>();
const lifecycleFacts = new WeakMap<
  LifecycleUnit,
  ProtectedLifecycleFactsState
>();
const officialCapabilitiesByChain = new WeakMap<
  ResolvedExtensionChain,
  OfficialObservationCapability
>();
const settleObserverReturn = (): undefined => undefined;

/** The one official capability registered for this exact chain, if any. */
export function getOfficialInstrumentationChainCapability(
  chain: ResolvedExtensionChain | undefined
): OfficialObservationCapability | undefined {
  return chain === undefined
    ? undefined
    : officialCapabilitiesByChain.get(chain);
}

/** Bind the admitted official capability to one exact resolved chain. */
export function registerOfficialInstrumentationChain(
  chain: ResolvedExtensionChain,
  capability: OfficialObservationCapability
): void {
  officialCapabilitiesByChain.set(chain, capability);
}

/** One observer that is handed facts, and what core asks of its declaration. */
export function registerTrustedProtectedObserver(
  handler: CallableFunction,
  capability: OfficialObservationCapability,
  observer: TrustedProtectedObserver
): void {
  trustedObservers.set(handler, { capability, observer });
}

/**
 * The observer of a definition that declares `observes`: it is handed the
 * facts of each unit, and core asks its declaration what to produce.
 */
export function registerFactsObserver(
  handler: ObserveHandler,
  capability: OfficialObservationCapability
): void {
  registerTrustedProtectedObserver(handler, capability, (unit, proceed) =>
    handler(unit, proceed, {
      read: () => readProtectedLifecycleFacts(unit),
      completion: () => readProtectedLifecycleCompletionFacts(unit),
    })
  );
}

/** Read facts only for the exact frozen unit created by this runner. */
export function readProtectedLifecycleFacts(
  unit: LifecycleUnit
): OfficialLifecycleFacts | undefined {
  return lifecycleFacts.get(unit)?.facts;
}

/** Read completion facts projected by core after the child settled. */
export function readProtectedLifecycleCompletionFacts(
  unit: LifecycleUnit
): OfficialLifecycleCompletionFacts | undefined {
  return lifecycleFacts.get(unit)?.completion;
}

/** Recognize the exact package-owned handler identity and nothing else. */
export function getTrustedProtectedObserverCapability(
  handler: unknown
): OfficialObservationCapability | undefined {
  return isFunction(handler)
    ? trustedObservers.get(handler)?.capability
    : undefined;
}

/**
 * The exact chain's one trusted observer, alone, or `undefined`. Dispatch
 * through it reaches no ordinary observer: cache backend delete/clear, which
 * have no public unit, run through the one runner this way.
 */
export function selectTrustedObservers(
  observers: readonly ResolvedExtensionHandler[] | undefined
): readonly ResolvedExtensionHandler[] | undefined {
  const trusted = observers?.find(({ handler }) =>
    trustedObservers.has(handler)
  );
  return trusted === undefined ? undefined : [trusted];
}

/** Resolve the one trusted readiness once before a coordinated array starts. */
export function prewarmProtectedObservers(
  observers: readonly ResolvedExtensionHandler[] | undefined
): void | Promise<void> {
  if (observers === undefined || observers.length === 0) return;
  for (const observer of observers) {
    const registration = trustedObservers.get(observer.handler);
    if (registration === undefined) continue;
    const readiness = prewarmTrustedObserver(registration.capability);
    if (readiness !== undefined) return readiness;
  }
}

/**
 * Runs completion-only observers without giving their onion authority over the
 * application promise.
 */
export function runProtectedObservers<Result>(
  unit: LifecycleUnit,
  observers: readonly ResolvedExtensionHandler[] | undefined,
  child: () => Promise<Result>,
  readCompletionFacts?: ObservationCompletionFactsReader,
  readInstrumentationFacts?: OfficialLifecycleFactsReader
): Promise<Result> {
  if (observers === undefined || observers.length === 0) return child();

  const startedAt = Date.now();
  const immutableUnit = freezeLifecycleUnit(unit);
  let trustedIndex = -1;
  let trustedRegistration: TrustedProtectedObserverRegistration | undefined;
  for (const [index, observer] of observers.entries()) {
    const registration = trustedObservers.get(observer.handler);
    if (registration !== undefined) {
      trustedIndex = index;
      trustedRegistration = registration;
      break;
    }
  }
  let resolveCompletion:
    | ((completion: ObservationCompletion) => void)
    | undefined;
  let completionPromise: Promise<ObservationCompletion> | undefined;
  let resolveOuterCompletion:
    | ((completion: ObservationCompletion) => void)
    | undefined;
  const outerCompletionPromise =
    trustedRegistration === undefined
      ? undefined
      : new Promise<ObservationCompletion>((resolve) => {
          resolveOuterCompletion = resolve;
        });
  let settledCompletion: ObservationCompletion | undefined;
  let trustedSetupSettled = trustedRegistration === undefined;
  let applicationPromise: Promise<Result> | undefined;
  let observesApplicationCompletion = false;

  const resolveOuterWhenReady = (): void => {
    if (trustedSetupSettled && settledCompletion !== undefined) {
      resolveOuterCompletion?.(settledCompletion);
    }
  };

  const settleCompletion = (
    status: ObservationCompletion["status"],
    failure?: unknown
  ): void => {
    const durationMs = Math.max(0, Date.now() - startedAt);
    let commitCertainty: CommitCertainty | undefined;
    try {
      commitCertainty = readCompletionFacts?.()?.commitCertainty;
    } catch {
      commitCertainty = undefined;
    }
    const completion = createCompletion(
      status,
      durationMs,
      commitCertainty,
      failure
    );
    settledCompletion = completion;
    const factsState = lifecycleFacts.get(immutableUnit);
    if (factsState !== undefined) {
      try {
        factsState.completion = factsState.facts.complete({
          status,
          durationMs,
          ...(status === "failure" ? { failure } : {}),
        });
      } catch {
        factsState.completion = undefined;
      }
    }
    resolveCompletion?.(completion);
    resolveOuterWhenReady();
  };

  const observeApplicationCompletion = (): void => {
    if (
      observesApplicationCompletion ||
      completionPromise === undefined ||
      applicationPromise === undefined
    ) {
      return;
    }
    observesApplicationCompletion = true;
    applicationPromise.then(
      () => settleCompletion("success"),
      (failure: unknown) => settleCompletion("failure", failure)
    );
  };

  const readCompletionPromise = (): Promise<ObservationCompletion> => {
    if (completionPromise === undefined) {
      completionPromise = new Promise<ObservationCompletion>((resolve) => {
        resolveCompletion = resolve;
      });
    }
    observeApplicationCompletion();
    return completionPromise;
  };

  const startChild = (): Promise<Result> => {
    let started: Promise<Result>;
    try {
      started = child();
    } catch (failure) {
      started = Promise.reject(failure);
    }
    applicationPromise = started;
    observeApplicationCompletion();
    return started;
  };

  const startObserver = (index: number): Promise<Result> => {
    const observer = observers[index];
    if (observer === undefined) return startChild();

    const trustedObserver = trustedObservers.get(observer.handler);
    if (trustedObserver !== undefined) {
      if (readInstrumentationFacts !== undefined) {
        try {
          const facts = readInstrumentationFacts();
          if (facts !== undefined) lifecycleFacts.set(immutableUnit, { facts });
        } catch {
          // Instrumentation fact production cannot stop the application.
        }
      }
      // Promise executors run synchronously; TypeScript does not model that guarantee.
      let resolveApplication!: (value: Result | PromiseLike<Result>) => void;
      let rejectApplication!: (reason?: unknown) => void;
      const applicationBridge = new Promise<Result>((resolve, reject) => {
        resolveApplication = resolve;
        rejectApplication = reject;
      });
      let proceeded = false;
      const startNext = (): Promise<ObservationCompletion> => {
        if (!proceeded) {
          proceeded = true;
          startObserver(index + 1).then(
            (value) => resolveApplication(value),
            (failure: unknown) => rejectApplication(failure)
          );
        }
        return readCompletionPromise();
      };
      let setup: unknown;
      try {
        setup = trustedObserver.observer(immutableUnit, startNext);
      } catch {
        startNext();
        trustedSetupSettled = true;
        resolveOuterWhenReady();
        return applicationBridge;
      }
      Promise.resolve(setup).then(
        () => {
          if (!proceeded) startNext();
          trustedSetupSettled = true;
          resolveOuterWhenReady();
        },
        () => {
          if (!proceeded) startNext();
          trustedSetupSettled = true;
          resolveOuterWhenReady();
        }
      );
      return applicationBridge;
    }

    let nextApplicationPromise: Promise<Result> | undefined;
    const startNextApplication = (): Promise<Result> => {
      if (nextApplicationPromise === undefined) {
        nextApplicationPromise = startObserver(index + 1);
      }
      return nextApplicationPromise;
    };
    const proceed = (): Promise<ObservationCompletion> => {
      startNextApplication();
      return outerCompletionPromise !== undefined && index < trustedIndex
        ? outerCompletionPromise
        : readCompletionPromise();
    };

    let returned: unknown;
    try {
      returned = Reflect.apply(observer.handler, undefined, [
        immutableUnit,
        proceed,
      ]);
    } catch {
      returned = undefined;
    }
    const nextApplication = startNextApplication();
    consumeObserverReturn(returned);
    return nextApplication;
  };

  const readiness =
    readInstrumentationFacts === undefined || trustedRegistration === undefined
      ? undefined
      : prewarmTrustedObserver(trustedRegistration.capability);
  if (readiness === undefined) return startObserver(0);

  // Promise executors run synchronously; TypeScript does not model that guarantee.
  let resolveApplication!: (value: Result | PromiseLike<Result>) => void;
  let rejectApplication!: (reason?: unknown) => void;
  const applicationBridge = new Promise<Result>((resolve, reject) => {
    resolveApplication = resolve;
    rejectApplication = reject;
  });
  const startAfterPrewarm = (): void => {
    startObserver(0).then(
      (value) => resolveApplication(value),
      (failure: unknown) => rejectApplication(failure)
    );
  };
  readiness.then(startAfterPrewarm);
  return applicationBridge;
}

function prewarmTrustedObserver(
  capability: OfficialObservationCapability
): void | Promise<void> {
  const prewarm = capability.prewarm;
  if (prewarm === undefined) return;
  let readiness: void | Promise<void>;
  try {
    readiness = prewarm();
  } catch {
    return;
  }
  if (readiness === undefined) return;
  return Promise.resolve(readiness).then(
    () => undefined,
    () => undefined
  );
}

function freezeLifecycleUnit(unit: LifecycleUnit): LifecycleUnit {
  return Object.freeze(unit);
}

function consumeObserverReturn(returned: unknown): void {
  if (
    returned === null ||
    (typeof returned !== "object" && typeof returned !== "function")
  ) {
    return;
  }
  try {
    const then = Reflect.get(returned, "then");
    if (!isFunction(then)) return;
    Reflect.apply(then, returned, [settleObserverReturn, settleObserverReturn]);
  } catch {
    // Observer returns cannot affect the application.
  }
}

function createCompletion(
  status: ObservationCompletion["status"],
  durationMs: number,
  commitCertainty: CommitCertainty | undefined,
  failure: unknown
): ObservationCompletion {
  const error = status === "failure" ? summarizeFailure(failure) : undefined;
  return Object.freeze({
    status,
    durationMs,
    ...(error === undefined ? {} : { error }),
    ...(commitCertainty === undefined ? {} : { commitCertainty }),
  });
}

function summarizeFailure(failure: unknown): ObservationErrorSummary {
  const normalized = isError(failure)
    ? failure
    : new Error("Application rejected with a non-Error value");
  const sanitized = sanitizeErrorForLogging(normalized);
  const code = Object.getOwnPropertyDescriptor(sanitized, "code")?.value;
  return Object.freeze({
    name: sanitized.name,
    message: sanitized.message,
    ...(typeof code === "string" ? { code } : {}),
  });
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

/** What runs a unit under a chain's lifecycle observers. */
export interface Observation {
  readonly run: <Result>(
    unit: LifecycleUnit,
    child: () => Promise<Result>,
    readCompletionFacts?: ObservationCompletionFactsReader,
    readInstrumentationFacts?: OfficialLifecycleFactsReader
  ) => Promise<Result>;
  readonly operation: <Result>(
    operation: string,
    model: string | undefined,
    child: () => Promise<Result>,
    readCompletionFacts?: ObservationCompletionFactsReader,
    readInstrumentationFacts?: OfficialLifecycleFactsReader
  ) => Promise<Result>;
  readonly statement: <Result>(
    operation: string | undefined,
    model: string | undefined,
    child: () => Promise<Result>,
    readCompletionFacts?: ObservationCompletionFactsReader,
    readInstrumentationFacts?: OfficialLifecycleFactsReader
  ) => Promise<Result>;
  readonly lifecycle: <Result>(
    kind: Extract<
      LifecycleUnitKind,
      "connection" | "savepoint" | "transaction"
    >,
    operation: string | undefined,
    child: () => Promise<Result>,
    readCompletionFacts?: ObservationCompletionFactsReader,
    readInstrumentationFacts?: OfficialLifecycleFactsReader
  ) => Promise<Result>;
  /** The one readiness the observers ask for before a coordinated array starts. */
  readonly prewarm: () => void | Promise<void>;
}

/** What reads the declaration of the one observer of a chain handed facts. */
export interface ObservesFacts {
  readonly capability: (
    chain: ResolvedExtensionChain | undefined
  ) => OfficialObservationCapability | undefined;
}

/** What reads the facts declaration a chain is registered with. */
export const OBSERVES: ObservesFacts = {
  capability: getOfficialInstrumentationChainCapability,
};

function observationOf(
  observers: readonly ResolvedExtensionHandler[]
): Observation {
  const observation: Observation = {
    run: (unit, child, completion, facts) =>
      runProtectedObservers(unit, observers, child, completion, facts),
    operation: (operation, model, child, completion, facts) =>
      observeOperation(observers, operation, model, child, completion, facts),
    statement: (operation, model, child, completion, facts) =>
      observeStatement(observers, operation, model, child, completion, facts),
    lifecycle: (kind, operation, child, completion, facts) =>
      observeDriverLifecycle(
        kind,
        observers,
        operation,
        child,
        completion,
        facts
      ),
    prewarm: () => prewarmProtectedObservers(observers),
  };
  return Object.freeze(observation);
}

/**
 * `observe` and `observes`: each unit of work and how it ended, and the facts
 * handed to the one observer that declares what it reads. Carried, so a
 * later extension's chain stays the one whose facts that observer reads.
 */
export const observePart: ExtensionPart = {
  members: ["observe", "observes"],
  carry: true,
  admit({ chain, definition }) {
    const declared = definition.observes;
    if (declared === undefined) return;
    if (getOfficialInstrumentationChainCapability(chain) !== undefined)
      extensionError(
        `Extension "${definition.name}" declares observes, which another extension on this client already declares: one observer is handed facts.`,
        definition.name
      );
    // Normalization admits `observes` only beside an `observe` handler.
    registerFactsObserver(definition.observe as ObserveHandler, declared);
  },
  join({ next, chain, definition, owner }) {
    const handler = definition.observe;
    if (handler === undefined) return;
    const official = getTrustedProtectedObserverCapability(handler);
    if (official !== undefined && !official.observesLifecycle) {
      next.observe = chain?.observe ?? Object.freeze([]);
      return;
    }
    const observers = Object.freeze([
      ...(chain?.observe ?? []),
      Object.freeze({ extension: owner.name, handler }),
    ]);
    next.observe = observers;
    next.observation = observationOf(observers);
    coordinate(next, ARRAYS);
  },
  seal({ next, chain, definition }) {
    const official =
      definition.observes ?? getOfficialInstrumentationChainCapability(chain);
    if (official === undefined) return;
    registerOfficialInstrumentationChain(next, official);
    next.observes = OBSERVES;
  },
};
