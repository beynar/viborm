/**
 * The official extension's presentation: span options, attributes and log
 * events built from what a unit's words read. Core never names a span, an
 * attribute key or a log event.
 */

import {
  type CacheFacts,
  type CacheOutcome,
  cacheFacts,
} from "@cache/unit-facts";
import type { DriverIdentity } from "@drivers/driver-identity";
import {
  type DiagnosticDisclosure,
  EMPTY_DISCLOSURE,
  isVibORMError,
  sanitizeErrorForLogging,
} from "@errors";
import type { UnitContext as Unit } from "@extensions/contract";
import {
  type BatchMember,
  correlation,
  driver,
  table,
} from "@extensions/unit-words";
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
  SPAN_EXECUTE,
  SPAN_OPERATION,
  type VibORMSpanName,
} from "./spans";
import type { VibORMSpanOptions } from "./tracer";
import type { LogEvent, TracingConfig } from "./types";

type PresentedLog = Omit<LogEvent, "level">;

const OR_THROW = /OrThrow$/;

const CACHE_SPAN_NAMES: Readonly<Record<string, VibORMSpanName>> = {
  clear: SPAN_CACHE_CLEAR,
  delete: SPAN_CACHE_DELETE,
  get: SPAN_CACHE_GET,
  invalidate: SPAN_CACHE_INVALIDATE,
  revalidate: SPAN_OPERATION,
  set: SPAN_CACHE_SET,
};

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
  correlationId: string | undefined
): Record<string, string> {
  return correlationId ? { [ATTR_VIBORM_CORRELATION_ID]: correlationId } : {};
}

/** The operation an error log names: the one that resolved, without `OrThrow`. */
function resolvedOperation(unit: Unit): string | undefined {
  return unit.operation?.replace(OR_THROW, "");
}

/** The span of one cache step; a revalidation is a root operation span. */
export function createCacheSpanOptions(
  unit: Unit,
  facts: CacheFacts
): VibORMSpanOptions | undefined {
  const name =
    unit.operation === undefined ? undefined : CACHE_SPAN_NAMES[unit.operation];
  if (name === undefined) return undefined;
  const { driver: cacheDriver, read, ttl } = facts;
  // A backend step names its driver alone, as a span with no `db.*` should.
  if (unit.operation === "delete" || unit.operation === "clear")
    return {
      name,
      attributes:
        cacheDriver === undefined ? {} : { [ATTR_CACHE_DRIVER]: cacheDriver },
    };
  return {
    name,
    attributes: {
      ...(cacheDriver === undefined
        ? {}
        : { [ATTR_CACHE_DRIVER]: cacheDriver }),
      ...(ttl === undefined ? {} : { [ATTR_CACHE_TTL]: String(ttl) }),
      ...(read === undefined
        ? {}
        : {
            ...createDriverAttributes(read.driver),
            [ATTR_DB_COLLECTION]: read.model,
            [ATTR_DB_OPERATION_NAME]: read.operation,
          }),
      ...createCorrelationAttributes(correlation(unit)),
    },
    ...(read === undefined ? {} : { root: true }),
  };
}

/** The cache log event of one outcome. Keys never appear. */
export function presentCacheOutcome(
  unit: Unit,
  outcome: CacheOutcome
): PresentedLog {
  const call =
    unit.kind === "cache"
      ? cacheFacts(unit)
      : { model: unit.model, operation: resolvedOperation(unit) };
  const { error } = outcome;
  return Object.freeze({
    timestamp: new Date(outcome.at),
    model: call?.model,
    operation: call?.operation,
    correlationId: correlation(unit),
    error: error instanceof Error ? sanitizeErrorForLogging(error) : undefined,
    meta: Object.freeze({ event: outcome.event, status: outcome.status }),
  });
}

/**
 * The span of one logical operation, named by the operation the caller
 * requested; without `db.*` driver attributes when the driver's identity
 * cannot be read.
 */
export function createOperationSpanOptions(unit: Unit): VibORMSpanOptions {
  const collection = table(unit);
  return {
    name: SPAN_OPERATION,
    attributes: {
      ...createDriverAttributes(driver(unit)),
      ...(collection === undefined ? {} : { [ATTR_DB_COLLECTION]: collection }),
      ...(unit.operation === undefined
        ? {}
        : { [ATTR_DB_OPERATION_NAME]: unit.operation }),
      ...createCorrelationAttributes(correlation(unit)),
    },
  };
}

/** The error log of an operation's failure, at the instant it is presented. */
export function createOperationErrorLogEvent(
  unit: Unit,
  failure: Error,
  duration: number
): PresentedLog {
  return Object.freeze({
    timestamp: new Date(),
    error: sanitizeErrorForLogging(failure),
    model: unit.model,
    operation: resolvedOperation(unit),
    correlationId: correlation(unit),
    duration,
  });
}

/** One channel's SQL/parameter disclosure; `true` and absence disclose nothing. */
function readChannelDisclosure(
  channel: true | Readonly<DiagnosticDisclosure> | undefined
): DiagnosticDisclosure {
  return channel && channel !== true ? channel : EMPTY_DISCLOSURE;
}

/**
 * The driver identity plus the unit's model, operation and correlation. An
 * empty attribution string is never presented: a caller-supplied context may
 * carry `operation: ""`, which the fallback operation does not replace.
 */
function createUnitAttributes(unit: Unit): Record<string, string> {
  const { model, operation } = unit;
  return {
    ...createDriverAttributes(driver(unit)),
    ...(model ? { [ATTR_DB_COLLECTION]: model } : {}),
    ...(operation ? { [ATTR_DB_OPERATION_NAME]: operation } : {}),
    ...createCorrelationAttributes(correlation(unit)),
  };
}

/** The execute span of one physical send, disclosed per the tracing channel. */
export function createStatementSpanOptions(
  tracing: true | Readonly<TracingConfig> | undefined,
  unit: Unit,
  sql: string | undefined,
  params: readonly unknown[] | undefined
): VibORMSpanOptions {
  const { includeParams, includeSql } = readChannelDisclosure(tracing);
  return {
    name: SPAN_EXECUTE,
    attributes: createUnitAttributes(unit),
    ...(includeSql || includeParams
      ? {
          sql: {
            ...(includeSql && sql !== undefined ? { query: sql } : {}),
            ...(includeParams ? { params: [...(params ?? [])] } : {}),
          },
        }
      : {}),
  };
}

/** The span of one connection, transaction, or savepoint. */
export function createLifecycleSpanOptions(
  name: VibORMSpanName,
  unit: Unit
): VibORMSpanOptions {
  return { name, attributes: createUnitAttributes(unit) };
}

/** The native batch member a failure names, if it names one. */
export function statementIndexOf(error: Error): number | undefined {
  const index = isVibORMError(error) ? error.meta.statementIndex : undefined;
  return typeof index === "number" ? index : undefined;
}

/**
 * The query or error log of one statement, disclosed per `logging`; a
 * native batch member's failure is attributed to that member.
 */
export function createStatementLogEvent(
  logging: true | Readonly<DiagnosticDisclosure> | undefined,
  unit: Unit,
  startedAt: number,
  sql: string | undefined,
  params: readonly unknown[] | undefined,
  member?: BatchMember,
  failure?: Error
): PresentedLog {
  const disclosure = readChannelDisclosure(logging);
  const endedAt = Date.now();
  return Object.freeze({
    timestamp: new Date(endedAt),
    duration: endedAt - startedAt,
    model: member === undefined ? unit.model : member.model,
    operation: member === undefined ? unit.operation : member.operation,
    correlationId:
      member === undefined ? correlation(unit) : member.correlation,
    sql: disclosure.includeSql ? sql : undefined,
    params: disclosure.includeParams ? [...(params ?? [])] : undefined,
    error:
      failure === undefined
        ? undefined
        : sanitizeErrorForLogging(failure, disclosure),
  });
}

/** What a failed span is settled with: the failure's class and code only. */
export function presentTraceFailure(failure: unknown): Error {
  if (failure instanceof Error) return sanitizeErrorForLogging(failure);
  const generic = new Error("Operation failed");
  generic.stack = undefined;
  return generic;
}
