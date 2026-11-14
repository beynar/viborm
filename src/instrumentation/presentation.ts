/**
 * The official extension's presentation: span options, attributes and log
 * events built from what a unit's words read. Core never names a span, an
 * attribute key or a log event.
 */

import {
  type DiagnosticDisclosure,
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
  ATTR_DB_COLLECTION,
  ATTR_DB_DRIVER,
  ATTR_DB_NAMESPACE,
  ATTR_DB_OPERATION_NAME,
  ATTR_DB_SYSTEM,
  ATTR_VIBORM_CORRELATION_ID,
  SPAN_CONNECT,
  SPAN_DISCONNECT,
  SPAN_EXECUTE,
  SPAN_OPERATION,
  SPAN_TRANSACTION,
  type VibORMSpanName,
} from "./spans";
import type { SpanAttributes, VibORMSpanOptions } from "./tracer";
import type {
  InstrumentationNote,
  LogEvent,
  LogLevel,
  TracingConfig,
} from "./types";

type PresentedLog = Omit<LogEvent, "level">;

const OR_THROW = /OrThrow$/;

/**
 * The `db.*` identity of one driver. `db.namespace` is added here and nowhere
 * else, and its KEY IS ABSENT for an unqualified adapter: never `null`, `""`
 * or the text `undefined`.
 */
export function createDriverAttributes(
  identity: InstrumentationNote["database"]
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

/** A note, if `value` can be one: whoever noted it, it is read by its members. */
export const noteOf = (value: unknown): InstrumentationNote | undefined =>
  typeof value === "object" && value !== null ? value : undefined;

/**
 * The statement's text, summary and parameters: only the library presents
 * them, from the statement it sent, as `includeSql` and `includeParams` let
 * it. A note setting one is not refused but dropped, silently: the
 * instrumentation never fails the call it observes.
 */
const STATEMENT_FACTS = "db.query.";

/** The spans the library presents for a call's own units. */
const CALL_SPANS: ReadonlySet<string> = new Set([
  SPAN_OPERATION,
  SPAN_EXECUTE,
  SPAN_TRANSACTION,
  SPAN_CONNECT,
  SPAN_DISCONNECT,
]);

/**
 * Whether a note may trace its unit under the span it names: never as one
 * of a call's own spans, but as an operation of its own when that is a root
 * span (the cache's background revalidation), outside any call's trace. A
 * unit whose note may not is presented without a span.
 */
export const tracesAs = (
  noted: InstrumentationNote & { readonly span: string }
): boolean =>
  !CALL_SPANS.has(noted.span) ||
  (noted.span === SPAN_OPERATION && noted.root === true);

/**
 * The attributes a note gives, those given `undefined` and the statement's
 * facts left out.
 */
export function notedAttributes(
  attributes: InstrumentationNote["attributes"]
): SpanAttributes {
  const defined: SpanAttributes = {};
  for (const [key, value] of Object.entries(attributes ?? {}))
    if (value !== undefined && !key.startsWith(STATEMENT_FACTS))
      defined[key] = value;
  return defined;
}

/** The span a unit's first note names: its database, the call's correlation, its attributes. */
export function createNotedSpanOptions(
  unit: Unit,
  noted: InstrumentationNote & { readonly span: string }
): VibORMSpanOptions {
  return {
    name: noted.span,
    attributes: notedAttributes({
      ...createDriverAttributes(noted.database),
      ...createCorrelationAttributes(correlation(unit)),
      ...noted.attributes,
    }),
    ...(noted.root === true ? { root: true } : {}),
  };
}

/** The log a note asks for. Keys never appear: a note carries none. */
export function presentNoteLog(
  unit: Unit,
  level: LogLevel,
  noted: InstrumentationNote
): LogEvent {
  const { error } = noted;
  return {
    level,
    timestamp: new Date(noted.at ?? Date.now()),
    model: noted.model ?? unit.model,
    operation: noted.operation ?? resolvedOperation(unit),
    correlationId: correlation(unit),
    error: error instanceof Error ? sanitizeErrorForLogging(error) : undefined,
    meta: noted.meta,
  };
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

/** The error log of an operation's failure, at the instant it settled. */
export function createOperationErrorLogEvent(
  unit: Unit,
  failure: Error,
  startedAt: number,
  duration: number
): PresentedLog {
  return Object.freeze({
    timestamp: new Date(startedAt + duration),
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
  return channel && channel !== true ? channel : {};
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
  duration: number,
  sql: string | undefined,
  params: readonly unknown[] | undefined,
  member?: BatchMember,
  failure?: Error
): PresentedLog {
  const disclosure = readChannelDisclosure(logging);
  return Object.freeze({
    // The instant the statement settled, not when this log is made.
    timestamp: new Date(startedAt + duration),
    duration,
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
