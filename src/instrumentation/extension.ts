import { OFFICIAL_INSTRUMENTATION_NAME } from "@extensions/chain";
import {
  type LifecycleUnit,
  type ObservationCompletion,
  type ObserveHandler,
  readProtectedLifecycleCompletionFacts,
  readProtectedLifecycleFacts,
  registerTrustedProtectedObserver,
} from "@extensions/observation";
import type {
  ObservationNeed,
  WarningNotice,
} from "@extensions/official-facts";
import {
  createInstrumentationContext,
  type InstrumentationContext,
} from "./context";
import type {
  CacheInstrumentationFacts,
  OfficialInstrumentationCapability,
  SegmentInstrumentationCompletionFacts,
} from "./lifecycle-facts";
import {
  SPAN_CONNECT,
  SPAN_DISCONNECT,
  SPAN_EXECUTE,
  SPAN_TRANSACTION,
  type VibORMSpanName,
} from "./spans";
import type { Span } from "./tracer";
import { prewarmTracer, shouldTraceSpan } from "./tracer";
import type {
  ExactInstrumentationConfig,
  InstrumentationConfig,
  LogLevel,
} from "./types";

/** The exact official contribution accepted by every concrete client schema. */
export type OfficialInstrumentationExtension = {
  readonly name: typeof OFFICIAL_INSTRUMENTATION_NAME;
  readonly observe: ObserveHandler;
};

/** Create VibORM's fixed-name instrumentation extension. */
export function instrumentation<const Config>(
  config: Config & InstrumentationConfig & ExactInstrumentationConfig<Config>
): OfficialInstrumentationExtension {
  const context = createInstrumentationContext(config);
  const capability: OfficialInstrumentationCapability = Object.freeze({
    context,
    observesLifecycle:
      context.config.tracing !== undefined ||
      context.config.logging !== undefined,
    ...(context.config.tracing === undefined
      ? {}
      : { prewarm: () => prewarmTracer(context.tracer) }),
    diagnostics: context.config.diagnostics,
    wants: (need: ObservationNeed) => wants(context, need),
    warn: (notice: WarningNotice) => warn(context, notice),
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

/** Answer one core enablement question from this chain's live context. */
function wants(
  context: InstrumentationContext,
  need: ObservationNeed
): boolean {
  switch (need) {
    case "statement":
      return traces(context, SPAN_EXECUTE);
    // Savepoints present under the transaction span name; there is no other.
    case "transaction":
    case "savepoint":
      return traces(context, SPAN_TRANSACTION);
    case "connect":
      return traces(context, SPAN_CONNECT);
    case "disconnect":
      return traces(context, SPAN_DISCONNECT);
    case "cache":
      return context.config.tracing !== undefined;
    case "cache-outcomes":
      return logs(context, "cache");
    case "query-log":
      return logs(context, "query");
    case "error-log":
      return logs(context, "error");
    // The one remaining need of the closed union: "parameters".
    default:
      return disclosesParameters(context);
  }
}

function traces(
  context: InstrumentationContext,
  name: VibORMSpanName
): boolean {
  return (
    context.config.tracing !== undefined &&
    shouldTraceSpan(context.tracer, name)
  );
}

function logs(context: InstrumentationContext, level: LogLevel): boolean {
  return context.logger?.isLevelEnabled(level) === true;
}

/** Whether a logging or tracing channel discloses statement parameters. */
function disclosesParameters(context: InstrumentationContext): boolean {
  const { logging, tracing } = context.config;
  if (
    logging !== undefined &&
    logging !== true &&
    logging.includeParams === true &&
    (logs(context, "query") || logs(context, "error"))
  ) {
    return true;
  }
  return (
    tracing !== undefined &&
    tracing !== true &&
    tracing.includeParams === true &&
    shouldTraceSpan(context.tracer, SPAN_EXECUTE)
  );
}

function warn(context: InstrumentationContext, notice: WarningNotice): boolean {
  const logger = context.logger;
  if (logger?.isLevelEnabled("warning") !== true) return false;
  logger.warn({
    timestamp: new Date(),
    model: notice.model,
    operation: notice.operation,
    correlationId: notice.correlationId,
    meta: { notice: notice.message },
  });
  return true;
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
        if (completionFacts?.kind === "segment") {
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
        completionFacts?.kind === "operation" &&
        completionFacts.readCacheLogEvents !== undefined
      ) {
        for (const event of completionFacts.readCacheLogEvents()) {
          capability.context.logger?.cache(event);
        }
      }
      if (
        completionFacts?.kind === "operation" &&
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
      completionFacts?.kind === "cache" &&
      completionFacts.spanAttributes !== undefined
    ) {
      setCacheSpanAttributes(span, completionFacts.spanAttributes);
    }
    if (
      completionFacts?.kind === "cache" &&
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
  if (completionFacts?.kind === "statement") {
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
