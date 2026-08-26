import type { QueryExecutionContext } from "@drivers";
import { getExecutionExtensionChain } from "@drivers/execution-context";
import { sanitizeErrorForLogging } from "@errors";
import { getOfficialInstrumentationChainCapability } from "@instrumentation/extension";
import type {
  InstrumentationLifecycleFactsReader,
  InstrumentationLifecycleOutcome,
} from "@instrumentation/lifecycle-facts";
import {
  ATTR_CACHE_DRIVER,
  ATTR_DB_COLLECTION,
  ATTR_DB_OPERATION_NAME,
  ATTR_VIBORM_CORRELATION_ID,
  type VibORMSpanName,
} from "@instrumentation/spans";
import type { VibORMSpanOptions } from "@instrumentation/tracer";
import type { LogEvent } from "@instrumentation/types";

export type CacheLogEvent = "hit" | "miss" | "revalidate" | "bypass";

type CacheLog = Omit<LogEvent, "level">;

interface CacheExecutionLogState {
  readonly events: CacheLog[];
  completed: boolean;
}

interface CacheLifecycleInstrumentationOptions {
  readonly context: QueryExecutionContext | undefined;
  readonly driverName?: string;
  readonly spanName: VibORMSpanName;
  readonly spanAttributes?: Readonly<Record<string, string>>;
  readonly rootSpan?: boolean;
  readonly readSpanAttributes?: () =>
    | NonNullable<VibORMSpanOptions["attributes"]>
    | undefined;
  readonly readStartLogEvents?: () => readonly CacheLog[] | undefined;
  readonly readCompletionLogEvents?: (
    outcome: InstrumentationLifecycleOutcome
  ) => readonly CacheLog[] | undefined;
}

const executionLogEvents = new WeakMap<
  QueryExecutionContext,
  CacheExecutionLogState
>();

/** Whether this trusted execution belongs to the exact official extension. */
export function hasOfficialCacheInstrumentation(
  context: QueryExecutionContext | undefined
): boolean {
  return getOfficialCacheInstrumentation(context) !== undefined;
}

/** Whether the exact official extension will present cache log facts. */
export function hasOfficialCacheLogging(
  context: QueryExecutionContext | undefined
): boolean {
  return (
    getOfficialCacheInstrumentation(context)?.context.logger?.isLevelEnabled(
      "cache"
    ) === true
  );
}

export function getCacheOperationAttributes(
  modelName: string,
  operation: string,
  dbAttributes: Record<string, string> | undefined
): Record<string, string> {
  return {
    ...dbAttributes,
    [ATTR_DB_COLLECTION]: modelName,
    [ATTR_DB_OPERATION_NAME]: operation,
  };
}

export function emitCacheLogEvent(
  _key: string,
  event: CacheLogEvent,
  status: string | undefined,
  error: unknown,
  context: QueryExecutionContext | undefined
): void {
  const capability = getOfficialCacheInstrumentation(context);
  if (
    capability !== undefined &&
    context !== undefined &&
    capability.context.logger?.isLevelEnabled("cache") === true
  ) {
    const state = executionLogEvents.get(context) ?? {
      completed: false,
      events: [],
    };
    state.events.push(createCacheLogEvent(context, event, status, error));
    executionLogEvents.set(context, state);
  }
}

/** Read and close the exact logical-cache event record at presentation time. */
export function createOfficialCacheExecutionLogReader(
  context: QueryExecutionContext
): (() => readonly CacheLog[]) | undefined {
  const state = executionLogEvents.get(context);
  if (state === undefined) return undefined;
  return () => {
    state.completed = true;
    return Object.freeze([...state.events]);
  };
}

/** Keep background set failure after the logical miss when it is still open. */
export function completeOfficialCacheSetFailure(
  context: QueryExecutionContext | undefined,
  failure: unknown
): readonly CacheLog[] | undefined {
  if (context === undefined || !hasOfficialCacheLogging(context)) {
    return undefined;
  }
  const event = createCacheLogEvent(
    context,
    "miss",
    "cache-set-failed",
    failure
  );
  const state = executionLogEvents.get(context);
  if (state !== undefined && !state.completed) {
    state.events.push(event);
    return undefined;
  }
  return Object.freeze([event]);
}

/** Build one private fact reader for the existing protected cache unit. */
export function createCacheLifecycleInstrumentationFacts(
  options: CacheLifecycleInstrumentationOptions
): InstrumentationLifecycleFactsReader | undefined {
  const capability = getOfficialCacheInstrumentation(options.context);
  if (capability?.observesLifecycle !== true) return undefined;
  const hasTracing = capability.context.config.tracing !== undefined;
  const hasCacheLogging =
    capability.context.logger?.isLevelEnabled("cache") === true;
  if (!(hasTracing || hasCacheLogging)) return undefined;

  return () => {
    const spanOptions: VibORMSpanOptions | undefined = hasTracing
      ? Object.freeze({
          name: options.spanName,
          attributes: Object.freeze({
            ...(options.driverName === undefined
              ? {}
              : { [ATTR_CACHE_DRIVER]: options.driverName }),
            ...options.spanAttributes,
            ...(options.context?.correlationId === undefined
              ? {}
              : {
                  [ATTR_VIBORM_CORRELATION_ID]: options.context.correlationId,
                }),
          }),
          ...(options.rootSpan === true ? { root: true } : {}),
        })
      : undefined;
    const startLogEvents = hasCacheLogging
      ? options.readStartLogEvents?.()
      : undefined;
    return Object.freeze({
      kind: "cache" as const,
      ...(spanOptions === undefined ? {} : { spanOptions }),
      ...(startLogEvents === undefined
        ? {}
        : { startLogEvents: Object.freeze([...startLogEvents]) }),
      complete(outcome: InstrumentationLifecycleOutcome) {
        const spanAttributes = hasTracing
          ? options.readSpanAttributes?.()
          : undefined;
        const logEvents = hasCacheLogging
          ? options.readCompletionLogEvents?.(outcome)
          : undefined;
        if (spanAttributes === undefined && logEvents === undefined) {
          return undefined;
        }
        return Object.freeze({
          kind: "cache" as const,
          ...(spanAttributes === undefined
            ? {}
            : { spanAttributes: Object.freeze({ ...spanAttributes }) }),
          ...(logEvents === undefined
            ? {}
            : { logEvents: Object.freeze([...logEvents]) }),
        });
      },
    });
  };
}

/** Create the disclosure-approved cache log fact at the event boundary. */
export function createCacheInstrumentationLogEvent(
  context: QueryExecutionContext | undefined,
  event: CacheLogEvent,
  status?: string,
  error?: unknown
): CacheLog {
  return createCacheLogEvent(context, event, status, error);
}

function getOfficialCacheInstrumentation(
  context: QueryExecutionContext | undefined
) {
  return getOfficialInstrumentationChainCapability(
    getExecutionExtensionChain(context)
  );
}

function createCacheLogEvent(
  context: QueryExecutionContext | undefined,
  event: CacheLogEvent,
  status: string | undefined,
  error: unknown
): CacheLog {
  return Object.freeze({
    timestamp: new Date(),
    model: context?.model,
    operation: context?.operation,
    correlationId: context?.correlationId,
    error: error instanceof Error ? sanitizeErrorForLogging(error) : undefined,
    meta: Object.freeze({ event, status }),
  });
}
