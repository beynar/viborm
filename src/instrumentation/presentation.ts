/**
 * The official extension's presentation: span options, attributes and log
 * events built from what a unit's words read. Core never names a span, an
 * attribute key or a log event.
 */

import { type DiagnosticDisclosure, isVibORMError } from "@errors";
import type { UnitContext as Unit } from "@extensions/contract";
import { disclosed } from "@extensions/disclosed";
import {
  correlation,
  driver,
  statements,
  table,
  text,
} from "@extensions/unit-words";
import { presentLogMetadata } from "./logger";
import {
  ATTR_DB_COLLECTION,
  ATTR_DB_DRIVER,
  ATTR_DB_NAMESPACE,
  ATTR_DB_OPERATION_NAME,
  ATTR_DB_QUERY_PARAMETER_PREFIX,
  ATTR_DB_QUERY_TEXT,
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
  attributes: NonNullable<InstrumentationNote["attributes"]>
): SpanAttributes {
  const defined: SpanAttributes = {};
  for (const [key, value] of Object.entries(attributes))
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
    root: noted.root === true,
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
    error: error instanceof Error ? disclosed(error) : undefined,
    meta: noted.meta === undefined ? undefined : presentLogMetadata(noted.meta),
  };
}

/**
 * The span of one logical operation, named by the operation the caller
 * requested; without `db.*` driver attributes when the driver's identity
 * cannot be read.
 */
export function createOperationSpanOptions(unit: Unit): VibORMSpanOptions {
  return {
    name: SPAN_OPERATION,
    attributes: createUnitAttributes(unit, table(unit)),
  };
}

/** The error log of an operation's failure, at the instant it settled. */
export function createOperationErrorLogEvent(
  unit: Unit,
  failure: Error,
  startedAt: number,
  duration: number
): LogEvent {
  return {
    level: "error",
    timestamp: new Date(startedAt + duration),
    error: disclosed(failure),
    model: unit.model,
    operation: resolvedOperation(unit),
    correlationId: correlation(unit),
    duration,
  };
}

/**
 * The driver identity plus the collection a unit addresses (an operation's
 * table, another unit's model), its operation and correlation. An empty
 * attribution string is never presented: a caller-supplied context may carry
 * `operation: ""`, which the fallback operation does not replace.
 */
function createUnitAttributes(
  unit: Unit,
  collection: string | undefined
): Record<string, string> {
  const { operation } = unit;
  return {
    ...createDriverAttributes(driver(unit)),
    ...(collection ? { [ATTR_DB_COLLECTION]: collection } : {}),
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
  const { includeParams, includeSql } = channelOf(tracing);
  const attributes: SpanAttributes = createUnitAttributes(unit, unit.model);
  if (includeSql && sql !== undefined) attributes[ATTR_DB_QUERY_TEXT] = sql;
  // The parameters are the unit's bounded snapshot (`parameters(u)`), plain
  // data, one attribute each per the OTel spec: db.query.parameter.0, .1, …
  if (includeParams)
    for (const [index, value] of (params ?? []).entries())
      attributes[`${ATTR_DB_QUERY_PARAMETER_PREFIX}.${index}`] =
        typeof value === "string" ? value : String(JSON.stringify(value));
  return { name: SPAN_EXECUTE, attributes };
}

/** One channel's SQL/parameter disclosure; `true` and absence disclose nothing. */
export function channelOf(
  channel: true | Readonly<DiagnosticDisclosure> | undefined
): DiagnosticDisclosure {
  return channel && channel !== true ? channel : {};
}

/** The span of one connection, transaction, or savepoint. */
export function createLifecycleSpanOptions(
  name: VibORMSpanName,
  unit: Unit
): VibORMSpanOptions {
  return { name, attributes: createUnitAttributes(unit, unit.model) };
}

/** The native batch member a failure names, if it names one. */
function statementIndexOf(error: Error): number | undefined {
  const index = isVibORMError(error) ? error.meta.statementIndex : undefined;
  return typeof index === "number" ? index : undefined;
}

/**
 * The query log of one statement, or with `failure` its error log, disclosed
 * per `logging`: a failure that names a native batch member is presented as
 * that member.
 */
export function createStatementLogEvent(
  logging: true | Readonly<DiagnosticDisclosure> | undefined,
  unit: Unit,
  startedAt: number,
  duration: number,
  shown: readonly unknown[] | undefined,
  failure?: Error
): LogEvent {
  const disclosure = channelOf(logging);
  const index = failure === undefined ? undefined : statementIndexOf(failure);
  const member = index === undefined ? undefined : statements(unit)?.[index];
  const sql = member?.sql ?? text(unit);
  // A batch's snapshot holds one list per member.
  const params =
    member === undefined || index === undefined
      ? shown
      : batchMemberParameters(shown, index);
  return {
    level: failure === undefined ? "query" : "error",
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
        : disclosed(failure, {
            sql: disclosure.includeSql,
            parameters: disclosure.includeParams,
          }),
  };
}

function batchMemberParameters(
  shown: readonly unknown[] | undefined,
  index: number
): readonly unknown[] | undefined {
  const member = shown?.[index];
  return Array.isArray(member) ? member : undefined;
}
