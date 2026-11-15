import type {
  AnyTarget,
  EmptyFacts,
  Extension,
  UnitContext as Unit,
  UnitOutcome as UnitEnd,
} from "@extensions/contract";
import { disclosed } from "@extensions/disclosed";
import { disclosure } from "@extensions/disclosure";
import { extension } from "@extensions/extension";
import { unit as unitPart } from "@extensions/unit";
import {
  failure,
  notes,
  origin,
  parameters,
  text,
} from "@extensions/unit-words";
import {
  createInstrumentationContext,
  type InstrumentationContext,
} from "./context";
import {
  createLifecycleSpanOptions,
  createNotedSpanOptions,
  createOperationErrorLogEvent,
  createOperationSpanOptions,
  createStatementLogEvent,
  createStatementSpanOptions,
  notedAttributes,
  noteOf,
  presentNoteLog,
  tracesAs,
} from "./presentation";
import {
  SPAN_CONNECT,
  SPAN_DISCONNECT,
  SPAN_EXECUTE,
  SPAN_OPERATION,
  SPAN_TRANSACTION,
  type VibORMSpanName,
} from "./spans";
import {
  setSpanAttributes,
  type TracerWrapper,
  type VibORMSpanOptions,
} from "./tracer";
import type {
  ExactInstrumentationConfig,
  InstrumentationConfig,
  InstrumentationNote,
  LogLevel,
  TracingSpan,
} from "./types";

const NAME = "viborm.instrumentation";

const ignore = (): undefined => undefined;

/**
 * Create VibORM's instrumentation extension: one handler around every unit
 * of real work, presenting spans and logs from the facts it reads, and the
 * `disclosure` of its `diagnostics`.
 */
export function instrumentation<T extends AnyTarget, const Config>(
  config: Config & InstrumentationConfig & ExactInstrumentationConfig<Config>
): Extension<T, EmptyFacts>;
export function instrumentation(config: InstrumentationConfig): unknown {
  const context = createInstrumentationContext(config);
  const { logging, tracing } = context.config;
  const { diagnostics = {} } = config;
  const policy = disclosure({
    sql: diagnostics.includeSql,
    parameters: diagnostics.includeParams,
    providerDetails: diagnostics.includeProviderDetails,
    callsite: diagnostics.includeCallsite,
  });
  if (tracing === undefined && logging === undefined)
    return extension(NAME, policy);
  return extension(
    NAME,
    unitPart((unit, next) => observe(context, unit, next)),
    policy
  );
}

/**
 * The containment the core no longer provides: `next()` runs exactly once,
 * whatever the presentation does, and nothing the presentation throws
 * reaches the call. The returned promise never rejects.
 */
function observe(
  context: InstrumentationContext,
  unit: Unit,
  next: () => Promise<UnitEnd>
): Promise<undefined> {
  let end: Promise<UnitEnd> | undefined;
  const once = (): Promise<UnitEnd> => {
    end ??= next();
    return end;
  };
  // What runs synchronously reads facts the library built, or an author's
  // notes, which are not read as hostile (D6): a presenter fails by its
  // promise.
  return Promise.resolve(present(context, unit, once))
    .then(ignore, ignore)
    .then(() => (end === undefined ? once().then(ignore) : undefined));
}

function traces(
  context: InstrumentationContext,
  name: VibORMSpanName
): context is InstrumentationContext & { readonly tracer: TracerWrapper } {
  return context.tracer?.traces(name) === true;
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
    traces(context, SPAN_EXECUTE)
  );
}

function present(
  context: InstrumentationContext,
  unit: Unit,
  next: () => Promise<UnitEnd>
): Promise<unknown> | undefined {
  switch (unit.kind) {
    case "operation":
      return presentOperation(context, unit, next);
    case "statement":
      return presentStatement(context, unit, next);
    case "transaction":
    case "savepoint":
    case "connection":
      return presentLifecycle(context, unit, next);
    // A batch has no span of its own: its members and statements do.
    case "batch":
      return undefined;
    default:
      return presentNoted(context, unit, next);
  }
}

/**
 * What every presenter does around its unit: `next()` inside the span
 * `options` names (none when `undefined`), `after` once the unit settled,
 * given the instant `next()` was called, then the span settled the way the
 * work settled: a failure the owner did not recover marks it failed, by the
 * error's class and code only.
 */
function spanned(
  context: InstrumentationContext,
  options: VibORMSpanOptions | undefined,
  unit: Unit,
  next: () => Promise<UnitEnd>,
  after?: (settled: UnitEnd, startedAt: number, span?: TracingSpan) => void
): Promise<unknown> {
  const settle = (span?: TracingSpan): Promise<void> => {
    const startedAt = Date.now();
    return next().then((settled) => {
      after?.(settled, startedAt, span);
      // What a failed span is settled with: the failure as it may be shown,
      // of which the span reads the class and code only.
      if (settled.status === "failure" && settled.recovered !== true)
        throw disclosed(failure(unit));
    });
  };
  return context.tracer && options
    ? context.tracer.startActiveSpan(options, settle)
    : settle();
}

function presentOperation(
  context: InstrumentationContext,
  unit: Unit,
  next: () => Promise<UnitEnd>
): Promise<unknown> {
  return spanned(
    context,
    traces(context, SPAN_OPERATION)
      ? createOperationSpanOptions(unit)
      : undefined,
    unit,
    next,
    (settled, startedAt) => {
      // A call's query and error logs are the library's account of its own
      // work: an extension's note on the call is logged at `cache` alone.
      for (const noted of notes(unit)) {
        const fact = noteOf(noted);
        if (fact?.log === "cache") log(context, unit, fact);
      }
      const error = failure(unit);
      // A failure a statement log presented is not presented again; every
      // operation whose own failure it is presents it, as before.
      if (
        settled.status === "failure" &&
        error instanceof Error &&
        logs(context, "error") &&
        !context.logged.has(origin(error))
      )
        context.logger?.log(
          createOperationErrorLogEvent(unit, error, startedAt, settled.duration)
        );
    }
  );
}

function presentStatement(
  context: InstrumentationContext,
  unit: Unit,
  next: () => Promise<UnitEnd>
): Promise<unknown> | undefined {
  const traced = traces(context, SPAN_EXECUTE);
  const queried = logs(context, "query");
  const erred = logs(context, "error");
  if (!(traced || queried || erred)) return undefined;
  // Read before the provider is reached: it may change what it was handed.
  const shown = disclosesParameters(context) ? parameters(unit) : undefined;
  const startedAt = Date.now();
  return spanned(
    context,
    traced
      ? createStatementSpanOptions(
          context.config.tracing,
          unit,
          text(unit),
          shown
        )
      : undefined,
    unit,
    next,
    ({ duration, recovered, status }) => {
      const error = failure(unit);
      const failed = status === "failure" && error instanceof Error;
      if (
        recovered === true ||
        !(failed ? erred : status === "success" && queried)
      )
        return;
      if (failed) context.logged.add(origin(error));
      context.logger?.log(
        createStatementLogEvent(
          context.config.logging,
          unit,
          startedAt,
          duration,
          shown,
          failed ? error : undefined
        )
      );
    }
  );
}

function presentLifecycle(
  context: InstrumentationContext,
  unit: Unit,
  next: () => Promise<UnitEnd>
): Promise<unknown> | undefined {
  const name =
    unit.kind !== "connection"
      ? SPAN_TRANSACTION
      : unit.operation === "$disconnect" || unit.operation === "disconnect"
        ? SPAN_DISCONNECT
        : SPAN_CONNECT;
  if (!traces(context, name)) return undefined;
  return spanned(context, createLifecycleSpanOptions(name, unit), unit, next);
}

/** Log what a note asks to, at its level, if that level is on. */
function log(
  context: InstrumentationContext,
  unit: Unit,
  noted: InstrumentationNote | undefined
): void {
  if (noted?.log !== undefined && logs(context, noted.log))
    context.logger?.log(presentNoteLog(unit, noted.log, noted));
}

/**
 * A unit of an extension's own kind, presented from what was noted on it:
 * the span its first note names as it starts, if a note may take that name,
 * the attributes noted later set on it at its end, and every log asked for.
 */
function presentNoted(
  context: InstrumentationContext,
  unit: Unit,
  next: () => Promise<UnitEnd>
): Promise<unknown> {
  const started = notes(unit).length;
  let span: (InstrumentationNote & { readonly span: string }) | undefined;
  for (const noted of notes(unit)) {
    const fact = noteOf(noted);
    if (span === undefined && fact?.span !== undefined)
      span = { ...fact, span: fact.span };
    log(context, unit, fact);
  }
  return spanned(
    context,
    span !== undefined && context.tracer !== undefined && tracesAs(span)
      ? createNotedSpanOptions(unit, span)
      : undefined,
    unit,
    next,
    (_settled, _startedAt, opened) => {
      for (const noted of notes(unit).slice(started)) {
        const fact = noteOf(noted);
        if (fact?.attributes !== undefined)
          setSpanAttributes(opened, notedAttributes(fact.attributes));
        log(context, unit, fact);
      }
    }
  );
}
