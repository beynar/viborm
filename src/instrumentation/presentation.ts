/**
 * The official extension's presentation: span options, attributes and log
 * events built from the neutral facts core publishes. Core never names a span,
 * an attribute key or a log event.
 */

import type { QueryExecutionContext } from "@drivers";
import type { DriverIdentity } from "@drivers/driver-identity";
import { sanitizeErrorForLogging } from "@errors";
import type {
  CacheBackendFacts,
  CacheOutcome,
  CacheUnitFacts,
} from "@extensions/official-facts";
import {
  ATTR_CACHE_DRIVER,
  ATTR_CACHE_TTL,
  ATTR_DB_COLLECTION,
  ATTR_DB_DRIVER,
  ATTR_DB_NAMESPACE,
  ATTR_DB_OPERATION_NAME,
  ATTR_DB_SYSTEM,
  ATTR_VIBORM_CORRELATION_ID,
  SPAN_CACHE_CLEAR,
  SPAN_CACHE_DELETE,
  SPAN_CACHE_GET,
  SPAN_CACHE_INVALIDATE,
  SPAN_CACHE_SET,
  SPAN_OPERATION,
} from "./spans";
import type { VibORMSpanOptions } from "./tracer";
import type { LogEvent } from "./types";

type PresentedLog = Omit<LogEvent, "level">;

const CACHE_SPAN_NAMES = {
  clear: SPAN_CACHE_CLEAR,
  delete: SPAN_CACHE_DELETE,
  get: SPAN_CACHE_GET,
  invalidate: SPAN_CACHE_INVALIDATE,
  revalidate: SPAN_OPERATION,
  set: SPAN_CACHE_SET,
} as const;

/**
 * The `db.*` identity of one driver. `db.namespace` is added here and nowhere
 * else, and its KEY IS ABSENT for an unqualified adapter: never `null`, `""`
 * or the text `undefined`.
 */
export function createDriverAttributes(
  identity: DriverIdentity | undefined
): Record<string, string> {
  if (identity === undefined) return {};
  const { dialect, driverName, namespace } = identity;
  return {
    [ATTR_DB_SYSTEM]: dialect,
    [ATTR_DB_DRIVER]: driverName,
    ...(namespace === undefined ? {} : { [ATTR_DB_NAMESPACE]: namespace }),
  };
}

function createCorrelationAttributes(
  context: QueryExecutionContext | undefined
): Record<string, string> {
  const correlationId = context?.correlationId;
  return correlationId === undefined
    ? {}
    : { [ATTR_VIBORM_CORRELATION_ID]: correlationId };
}

/** The span of one cache step; a revalidation is a root operation span. */
export function createCacheSpanOptions(
  operation: keyof typeof CACHE_SPAN_NAMES,
  facts: CacheBackendFacts | CacheUnitFacts
): VibORMSpanOptions {
  if (facts.kind === "cache-backend") {
    return {
      name: CACHE_SPAN_NAMES[facts.boundary],
      attributes: { [ATTR_CACHE_DRIVER]: facts.driverName },
    };
  }
  const { driverName, read, ttl } = facts;
  return {
    name: CACHE_SPAN_NAMES[operation],
    attributes: {
      ...(driverName === undefined ? {} : { [ATTR_CACHE_DRIVER]: driverName }),
      ...(ttl === undefined ? {} : { [ATTR_CACHE_TTL]: String(ttl) }),
      ...(read === undefined
        ? {}
        : {
            ...createDriverAttributes(read.identity),
            [ATTR_DB_COLLECTION]: read.model,
            [ATTR_DB_OPERATION_NAME]: read.operation,
          }),
      ...createCorrelationAttributes(facts.context),
    },
    ...(read === undefined ? {} : { root: true }),
  };
}

/** The cache log event of one outcome core recorded. Keys never appear. */
export function createCacheLogEvent(
  context: QueryExecutionContext | undefined,
  outcome: CacheOutcome
): PresentedLog {
  const { error } = outcome;
  return Object.freeze({
    timestamp: new Date(outcome.at),
    model: context?.model,
    operation: context?.operation,
    correlationId: context?.correlationId,
    error: error instanceof Error ? sanitizeErrorForLogging(error) : undefined,
    meta: Object.freeze({ event: outcome.event, status: outcome.status }),
  });
}
