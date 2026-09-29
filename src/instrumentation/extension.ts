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
  CacheBackendFacts,
  CacheUnitFacts,
  ObservationNeed,
  OfficialObservationCapability,
  WarningNotice,
} from "@extensions/official-facts";
import {
  createInstrumentationContext,
  type InstrumentationContext,
} from "./context";
import {
  createCacheSpanOptions,
  createLifecycleSpanOptions,
  createOperationErrorLogEvent,
  createOperationSpanOptions,
  createStatementLogEvent,
  createStatementSpanOptions,
  presentCacheOutcome,
} from "./presentation";
import {
  ATTR_CACHE_RESULT,
  SPAN_CONNECT,
  SPAN_DISCONNECT,
  SPAN_EXECUTE,
  SPAN_TRANSACTION,
  type VibORMSpanName,
} from "./spans";
import type { Span, VibORMSpanOptions } from "./tracer";
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

/**
 * Each registered capability's context. Core holds only the neutral
 * capability; the extension recovers its own context here, never through it.
 */
const instrumentationContexts = new WeakMap<
  OfficialObservationCapability,
  InstrumentationContext
>();

/** Create VibORM's fixed-name instrumentation extension. */
export function instrumentation<const Config>(
  config: Config & InstrumentationConfig & ExactInstrumentationConfig<Config>
): OfficialInstrumentationExtension {
  const context = createInstrumentationContext(config);
  const capability: OfficialObservationCapability = Object.freeze({
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
  instrumentationContexts.set(capability, context);
  registerTrustedProtectedObserver(handler, capability, (unit, proceed) =>
    observeOfficialInstrumentation(context, unit, proceed)
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
    // The last need of the closed union; another need fails to compile here.
    default:
      need satisfies "parameters";
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
  context: InstrumentationContext,
  unit: LifecycleUnit,
  proceed: () => Promise<ObservationCompletion>
): unknown {
  const facts = readProtectedLifecycleFacts(unit);
  if (
    unit.kind === "cache" &&
    (facts?.kind === "cache" || facts?.kind === "cache-backend")
  ) {
    return observeCacheInstrumentation(
      context,
      unit.operation,
      unit,
      facts,
      proceed
    );
  }
  if (facts?.kind === "statement") {
    const completion = proceed();
    return facts.dispatch.then((dispatch) =>
      dispatch === undefined
        ? observeLifecycleCompletion(completion)
        : presentDispatch(
            context,
            dispatch.start,
            wants(context, "statement")
              ? createStatementSpanOptions(context.config.tracing, dispatch)
              : undefined,
            () =>
              observeStatementCompletion(
                context,
                unit,
                completion,
                dispatch.startedAt
              )
          )
    );
  }
  if (facts?.kind === "driver-lifecycle") {
    const completion = proceed();
    return facts.dispatch.then((dispatch) =>
      dispatch === undefined
        ? observeLifecycleCompletion(completion)
        : presentDispatch(
            context,
            dispatch.start,
            createLifecycleSpanOptions(dispatch),
            () => observeLifecycleCompletion(completion)
          )
    );
  }
  if (facts?.kind !== "operation") return proceed();

  // The correlation id is created as the operation starts, never later.
  const correlationId = facts.context.correlationId;
  const observeCompletion = (): Promise<void> => {
    const completion = proceed();
    return completion.then((outcome) => {
      const completionFacts = readProtectedLifecycleCompletionFacts(unit);
      if (completionFacts?.kind === "operation") {
        const { failure, readCacheOutcomes } = completionFacts;
        if (readCacheOutcomes !== undefined) {
          for (const cacheOutcome of readCacheOutcomes()) {
            context.logger?.cache(
              presentCacheOutcome(facts.context, cacheOutcome)
            );
          }
        }
        if (failure !== undefined) {
          context.logger?.error(
            createOperationErrorLogEvent(
              facts,
              correlationId,
              failure,
              completionFacts.endedAt,
              outcome.durationMs
            )
          );
        }
      }
      if (outcome.status === "failure") throw createObservedFailure();
    });
  };

  return context.config.tracing === undefined
    ? observeCompletion()
    : context.tracer.startActiveSpan(
        createOperationSpanOptions(facts),
        observeCompletion
      );
}

function observeCacheInstrumentation(
  instrumentationContext: InstrumentationContext,
  operation: Extract<LifecycleUnit, { kind: "cache" }>["operation"],
  unit: LifecycleUnit,
  facts: CacheBackendFacts | CacheUnitFacts,
  proceed: () => Promise<ObservationCompletion>
): Promise<void> {
  const { logger, tracer } = instrumentationContext;
  const traced = wants(instrumentationContext, "cache");
  const context = facts.kind === "cache" ? facts.context : undefined;
  const logged =
    facts.kind === "cache" && wants(instrumentationContext, "cache-outcomes");
  // A revalidation presents its start at the instant it is observed.
  const startedAt = Date.now();
  const observeCompletion = async (span?: Span): Promise<void> => {
    if (logged && operation === "revalidate") {
      logger?.cache(
        presentCacheOutcome(context, {
          event: "revalidate",
          status: "start",
          at: startedAt,
        })
      );
    }
    const outcome = await proceed();
    const completionFacts = readProtectedLifecycleCompletionFacts(unit);
    if (completionFacts?.kind === "cache") {
      if (traced && completionFacts.result !== undefined) {
        setCacheSpanAttributes(span, {
          [ATTR_CACHE_RESULT]: completionFacts.result,
        });
      }
      if (logged && completionFacts.outcomes !== undefined) {
        for (const cacheOutcome of completionFacts.outcomes) {
          logger?.cache(presentCacheOutcome(context, cacheOutcome));
        }
      }
    }
    if (outcome.status === "failure") throw createObservedFailure();
  };

  return traced
    ? tracer.startActiveSpan(
        createCacheSpanOptions(operation, facts),
        observeCompletion
      )
    : observeCompletion();
}

/** Start the gated provider call exactly once, inside the span when one is presented. */
async function presentDispatch(
  context: InstrumentationContext,
  start: () => void,
  spanOptions: VibORMSpanOptions | undefined,
  observeCompletion: () => Promise<void>
): Promise<void> {
  if (spanOptions === undefined) {
    start();
    return observeCompletion();
  }
  try {
    return await context.tracer.startActiveSpan(spanOptions, () => {
      start();
      return observeCompletion();
    });
  } finally {
    // A hostile OTel provider cannot leave the authoritative child gated.
    start();
  }
}

async function observeStatementCompletion(
  context: InstrumentationContext,
  unit: LifecycleUnit,
  completion: Promise<ObservationCompletion>,
  startedAt: number
): Promise<void> {
  const outcome = await completion;
  const completionFacts = readProtectedLifecycleCompletionFacts(unit);
  if (completionFacts?.kind === "statement") {
    const event = createStatementLogEvent(
      completionFacts,
      startedAt,
      instrumentationContexts.get(completionFacts.capability)?.config.logging
    );
    if (completionFacts.failure === undefined) {
      context.logger?.query(event);
    } else {
      context.logger?.error(event);
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

function setCacheSpanAttributes(
  span: Span | undefined,
  attributes: NonNullable<VibORMSpanOptions["attributes"]>
): void {
  try {
    span?.setAttributes(attributes);
  } catch {
    // Instrumentation cannot change the cache outcome.
  }
}

function createObservedFailure(): Error {
  const failure = new Error("Operation failed");
  failure.stack = undefined;
  return failure;
}
