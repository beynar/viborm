import type { QueryExecutionContext } from "@drivers";
import { sanitizeErrorForLogging } from "@errors";
import type { InstrumentationContext } from "@instrumentation/context";
import {
  ATTR_DB_COLLECTION,
  ATTR_DB_OPERATION_NAME,
  ATTR_VIBORM_CORRELATION_ID,
} from "@instrumentation/spans";
import {
  getNoopTracer,
  type Span,
  type TracerWrapper,
} from "@instrumentation/tracer";

export type CacheLogEvent = "hit" | "miss" | "revalidate" | "bypass";

export function getCacheTracer(
  instrumentation: InstrumentationContext | undefined
): TracerWrapper {
  return instrumentation?.tracer ?? getNoopTracer();
}

export function getCacheOperationAttributes(
  modelName: string,
  operation: string,
  dbAttributes: Record<string, string> | undefined,
  context: QueryExecutionContext | undefined
): Record<string, string> {
  return {
    ...dbAttributes,
    [ATTR_DB_COLLECTION]: modelName,
    [ATTR_DB_OPERATION_NAME]: operation,
    ...(context?.correlationId
      ? { [ATTR_VIBORM_CORRELATION_ID]: context.correlationId }
      : {}),
  };
}

export function emitCacheLogEvent(
  instrumentation: InstrumentationContext | undefined,
  _key: string,
  event: CacheLogEvent,
  status: string | undefined,
  error: unknown,
  context: QueryExecutionContext | undefined
): void {
  const logger = instrumentation?.logger;
  if (!logger) return;
  logger.cache({
    timestamp: new Date(),
    model: context?.model,
    operation: context?.operation,
    correlationId: context?.correlationId,
    error: error instanceof Error ? sanitizeErrorForLogging(error) : undefined,
    meta: { event, status },
  });
}

export function setSpanAttribute(
  span: Span | undefined,
  key: string,
  value: string
): void {
  try {
    span?.setAttribute(key, value);
  } catch {
    // Span mutation is observational and cannot alter cache behavior.
  }
}
