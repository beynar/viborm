/**
 * The official extension's presentation: span options, attributes and log
 * events built from the neutral facts core publishes. Core never names a span,
 * an attribute key or a log event.
 */

import type { QueryExecutionContext } from "@drivers";
import {
  type DriverIdentity,
  type DriverIdentitySource,
  readDriverIdentity,
} from "@drivers/driver-identity";
import { getExecutionExtensionChain } from "@drivers/execution-context";
import { type DiagnosticDisclosure, sanitizeErrorForLogging } from "@errors";
import { getOfficialInstrumentationChainCapability } from "@extensions/observation";
import type {
  CacheBackendFacts,
  CacheOutcome,
  CacheUnitFacts,
  LifecycleDispatch,
  StatementCompletionFacts,
  StatementDispatch,
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
  SPAN_CONNECT,
  SPAN_DISCONNECT,
  SPAN_EXECUTE,
  SPAN_OPERATION,
  SPAN_TRANSACTION,
} from "./spans";
import type { VibORMSpanOptions } from "./tracer";
import type { LogEvent, TracingConfig } from "./types";

type PresentedLog = Omit<LogEvent, "level">;

const EMPTY_DISCLOSURE: DiagnosticDisclosure = Object.freeze({
  includeParams: false,
  includeSql: false,
});

// Savepoints present under the transaction span name; there is no other.
const LIFECYCLE_SPAN_NAMES = {
  connect: SPAN_CONNECT,
  disconnect: SPAN_DISCONNECT,
  savepoint: SPAN_TRANSACTION,
  transaction: SPAN_TRANSACTION,
} as const;

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
export function presentCacheOutcome(
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

/** One channel's SQL/parameter disclosure; `true` and absence disclose nothing. */
function readChannelDisclosure(
  channel: true | Readonly<DiagnosticDisclosure> | undefined
): DiagnosticDisclosure {
  return channel && channel !== true ? channel : EMPTY_DISCLOSURE;
}

/** The driver identity plus the context's model, operation and correlation. */
export function createContextAttributes(
  driver: DriverIdentitySource,
  context: QueryExecutionContext
): Record<string, string> {
  const { model, operation, correlationId } = context;
  return {
    ...createDriverAttributes(readDriverIdentity(driver)),
    ...(model ? { [ATTR_DB_COLLECTION]: model } : {}),
    ...(operation ? { [ATTR_DB_OPERATION_NAME]: operation } : {}),
    ...(correlationId ? { [ATTR_VIBORM_CORRELATION_ID]: correlationId } : {}),
  };
}

/** The execute span of one provider dispatch, disclosed per the tracing channel. */
export function createStatementSpanOptions(
  tracing: true | Readonly<TracingConfig> | undefined,
  dispatch: StatementDispatch
): VibORMSpanOptions {
  const { includeParams, includeSql } = readChannelDisclosure(tracing);
  return {
    name: SPAN_EXECUTE,
    attributes: createContextAttributes(dispatch.driver, dispatch.context),
    ...(includeSql || includeParams
      ? {
          sql: {
            ...(includeSql ? { query: dispatch.sql } : {}),
            ...(includeParams ? { params: dispatch.params } : {}),
          },
        }
      : {}),
  };
}

/** The late span of one connection, transaction, or savepoint dispatch. */
export function createLifecycleSpanOptions(
  dispatch: LifecycleDispatch
): VibORMSpanOptions {
  return {
    name: LIFECYCLE_SPAN_NAMES[dispatch.boundary],
    attributes: createContextAttributes(dispatch.driver, dispatch.context),
  };
}

/**
 * The query or error log of one statement core decided to log, disclosed per
 * the logging channel of the context the log is attributed to.
 */
export function createStatementLogEvent(
  completion: StatementCompletionFacts,
  startedAt: number
): PresentedLog {
  const { context, endedAt, failure } = completion;
  const disclosure = readChannelDisclosure(
    getOfficialInstrumentationChainCapability(
      getExecutionExtensionChain(context)
    )?.context.config.logging
  );
  return Object.freeze({
    timestamp: new Date(endedAt),
    duration: endedAt - startedAt,
    model: context.model,
    operation: context.operation,
    correlationId: context.correlationId,
    sql: disclosure.includeSql ? completion.sql : undefined,
    params: disclosure.includeParams ? completion.params : undefined,
    error:
      failure === undefined
        ? undefined
        : sanitizeErrorForLogging(failure, disclosure),
  });
}
