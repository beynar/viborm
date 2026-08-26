import type { ResolvedExtensionChain } from "@extensions/chain";
import {
  type LifecycleUnit,
  type ObservationCompletion,
  type ObserveHandler,
  readProtectedLifecycleCompletionFacts,
  readProtectedLifecycleFacts,
  registerTrustedProtectedObserver,
} from "@extensions/observation";
import { createInstrumentationContext } from "./context";
import type {
  CacheInstrumentationFacts,
  OfficialInstrumentationCapability,
  SegmentInstrumentationCompletionFacts,
} from "./lifecycle-facts";
import type { Span } from "./tracer";
import { prewarmTracer } from "./tracer";
import type {
  ExactInstrumentationConfig,
  InstrumentationConfig,
} from "./types";

const OFFICIAL_INSTRUMENTATION_NAME = "viborm.instrumentation";

/** The exact official contribution accepted by every concrete client schema. */
export type OfficialInstrumentationExtension = {
  readonly name: typeof OFFICIAL_INSTRUMENTATION_NAME;
  readonly observe: ObserveHandler;
};

const capabilitiesByChain = new WeakMap<
  ResolvedExtensionChain,
  OfficialInstrumentationCapability
>();

/** Create VibORM's fixed-name instrumentation extension. */
export function instrumentation<const Config>(
  config: Config & InstrumentationConfig & ExactInstrumentationConfig<Config>
): OfficialInstrumentationExtension {
  const context = createInstrumentationContext(config);
  const capability = Object.freeze({
    context,
    observesLifecycle:
      context.config.tracing !== undefined ||
      context.config.logging !== undefined,
    ...(context.config.tracing === undefined
      ? {}
      : { prewarm: () => prewarmTracer(context.tracer) }),
  });
  const handler: ObserveHandler =
    function officialInstrumentationObserver(): undefined {
      return undefined;
    };
  registerTrustedProtectedObserver(handler, capability, (unit, proceed) =>
    observeOfficialInstrumentation(capability, unit, proceed)
  );
  return Object.freeze({
    name: OFFICIAL_INSTRUMENTATION_NAME,
    observe: handler,
  });
}

export function getOfficialInstrumentationChainCapability(
  chain: ResolvedExtensionChain | undefined
): OfficialInstrumentationCapability | undefined {
  return chain === undefined ? undefined : capabilitiesByChain.get(chain);
}

export function registerOfficialInstrumentationChain(
  chain: ResolvedExtensionChain,
  capability: OfficialInstrumentationCapability
): void {
  capabilitiesByChain.set(chain, capability);
}

export function isOfficialInstrumentationName(name: string): boolean {
  return name === OFFICIAL_INSTRUMENTATION_NAME;
}

function observeOfficialInstrumentation(
  capability: OfficialInstrumentationCapability,
  unit: LifecycleUnit,
  proceed: () => Promise<ObservationCompletion>
): unknown {
  const facts = readProtectedLifecycleFacts(unit);
  if (facts?.kind === "segment") {
    return capability.context.tracer.startActiveSpan(
      facts.spanOptions,
      async (span) => {
        const outcome = await proceed();
        const completionFacts = readProtectedLifecycleCompletionFacts(unit);
        if (
          completionFacts &&
          "spanAttributes" in completionFacts &&
          completionFacts.spanAttributes !== undefined
        ) {
          setSegmentSpanAttributes(
            capability,
            span,
            completionFacts.spanAttributes
          );
        }
        if (outcome.status === "failure") throw createObservedFailure();
      }
    );
  }
  if (facts?.kind === "cache") {
    return observeCacheInstrumentation(capability, unit, facts, proceed);
  }
  if (facts?.kind === "statement" || facts?.kind === "driver-lifecycle") {
    const completion = proceed();
    return facts.presentation.then(async (presentation) => {
      if (presentation === undefined) {
        return facts.kind === "statement"
          ? observeStatementCompletion(capability, unit, completion)
          : observeLifecycleCompletion(completion);
      }
      const observeCompletion = () =>
        facts.kind === "statement"
          ? observeStatementCompletion(capability, unit, completion)
          : observeLifecycleCompletion(completion);
      if (presentation.spanOptions === undefined) {
        presentation.startExecution();
        return observeCompletion();
      }
      try {
        return await capability.context.tracer.startActiveSpan(
          presentation.spanOptions,
          () => {
            presentation.startExecution();
            return observeCompletion();
          }
        );
      } finally {
        // A hostile OTel provider cannot leave the authoritative child gated.
        presentation.startExecution();
      }
    });
  }
  if (facts?.kind !== "operation") return proceed();

  const observeCompletion = (): Promise<void> => {
    const completion = proceed();
    return completion.then((outcome) => {
      const completionFacts = readProtectedLifecycleCompletionFacts(unit);
      if (
        completionFacts &&
        "readCacheLogEvents" in completionFacts &&
        completionFacts.readCacheLogEvents !== undefined
      ) {
        for (const event of completionFacts.readCacheLogEvents()) {
          capability.context.logger?.cache(event);
        }
      }
      if (
        completionFacts &&
        "errorLogEvent" in completionFacts &&
        completionFacts.errorLogEvent !== undefined
      ) {
        capability.context.logger?.error(completionFacts.errorLogEvent);
      }
      if (outcome.status === "failure") throw createObservedFailure();
    });
  };

  return facts.spanOptions === undefined
    ? observeCompletion()
    : capability.context.tracer.startActiveSpan(
        facts.spanOptions,
        observeCompletion
      );
}

function observeCacheInstrumentation(
  capability: OfficialInstrumentationCapability,
  unit: LifecycleUnit,
  facts: CacheInstrumentationFacts,
  proceed: () => Promise<ObservationCompletion>
): Promise<void> {
  const observeCompletion = async (span?: Span): Promise<void> => {
    if (facts.startLogEvents !== undefined) {
      for (const event of facts.startLogEvents) {
        capability.context.logger?.cache(event);
      }
    }
    const outcome = await proceed();
    const completionFacts = readProtectedLifecycleCompletionFacts(unit);
    if (
      completionFacts &&
      "spanAttributes" in completionFacts &&
      completionFacts.spanAttributes !== undefined
    ) {
      setCacheSpanAttributes(span, completionFacts.spanAttributes);
    }
    if (
      completionFacts &&
      "logEvents" in completionFacts &&
      completionFacts.logEvents !== undefined
    ) {
      for (const event of completionFacts.logEvents) {
        capability.context.logger?.cache(event);
      }
    }
    if (outcome.status === "failure") throw createObservedFailure();
  };

  return facts.spanOptions === undefined
    ? observeCompletion()
    : capability.context.tracer.startActiveSpan(
        facts.spanOptions,
        observeCompletion
      );
}

async function observeStatementCompletion(
  capability: OfficialInstrumentationCapability,
  unit: LifecycleUnit,
  completion: Promise<ObservationCompletion>
): Promise<void> {
  const outcome = await completion;
  const completionFacts = readProtectedLifecycleCompletionFacts(unit);
  if (completionFacts && "logEvent" in completionFacts) {
    const logEvent = completionFacts.logEvent;
    if (logEvent !== undefined) {
      capability.context.logger?.[logEvent.level](logEvent.event);
    }
  }
  if (outcome.status === "failure") throw createObservedFailure();
}

async function observeLifecycleCompletion(
  completion: Promise<ObservationCompletion>
): Promise<void> {
  const outcome = await completion;
  if (outcome.status === "failure") throw createObservedFailure();
}

function setSegmentSpanAttributes(
  capability: OfficialInstrumentationCapability,
  span: Span | undefined,
  attributes: SegmentInstrumentationCompletionFacts["spanAttributes"]
): void {
  setLifecycleSpanAttributes(capability, span, attributes);
}

function setCacheSpanAttributes(
  span: Span | undefined,
  attributes: SegmentInstrumentationCompletionFacts["spanAttributes"]
): void {
  try {
    span?.setAttributes(attributes);
  } catch {
    // Instrumentation cannot change the cache outcome.
  }
}

function setLifecycleSpanAttributes(
  capability: OfficialInstrumentationCapability,
  span: Span | undefined,
  attributes: SegmentInstrumentationCompletionFacts["spanAttributes"]
): void {
  try {
    if (span) {
      span.setAttributes(attributes);
    } else {
      capability.context.tracer.setActiveSpanAttributes?.(attributes);
    }
  } catch {
    // Instrumentation cannot change the lifecycle outcome.
  }
}

function createObservedFailure(): Error {
  const failure = new Error("Operation failed");
  failure.stack = undefined;
  return failure;
}
