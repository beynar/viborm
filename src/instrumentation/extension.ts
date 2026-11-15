import type {
  AnyTarget,
  EmptyFacts,
  Extension,
  UnitContext as Unit,
  UnitOutcome as UnitEnd,
} from "@extensions/contract";
import { disclosure } from "@extensions/disclosure";
import { extension } from "@extensions/extension";
import { unit as unitPart } from "@extensions/unit";
import {
  failure,
  notes,
  origin,
  parameters,
  statements,
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
  presentTraceFailure,
  statementIndexOf,
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
import { setSpanAttributes, type TracerWrapper } from "./tracer";
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
  // The origins already logged: one failure, one error log.
  const logged = new WeakSet<object>();
  return extension(
    NAME,
    unitPart((unit, next) => observe(context, logged, unit, next)),
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
  logged: WeakSet<object>,
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
  return Promise.resolve(present(context, logged, unit, once))
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
  logged: WeakSet<object>,
  unit: Unit,
  next: () => Promise<UnitEnd>
): Promise<unknown> | undefined {
  switch (unit.kind) {
    case "operation":
      return presentOperation(context, logged, unit, next);
    case "statement":
      return presentStatement(context, logged, unit, next);
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
 * Settle a span the way the work settled: a failure the owner did not
 * recover marks it failed, by the error's class and code only.
 */
async function endWith(end: Promise<UnitEnd>, unit: Unit): Promise<void> {
  const settled = await end;
  if (settled.status === "failure" && settled.recovered !== true)
    throw presentTraceFailure(failure(unit));
}

function presentOperation(
  context: InstrumentationContext,
  logged: WeakSet<object>,
  unit: Unit,
  next: () => Promise<UnitEnd>
): Promise<unknown> {
  const settle = async (): Promise<void> => {
    const startedAt = Date.now();
    const end = next();
    const settled = await end;
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
      !logged.has(origin(error))
    )
      context.logger?.error(
        createOperationErrorLogEvent(unit, error, startedAt, settled.duration)
      );
    return endWith(end, unit);
  };
  return traces(context, SPAN_OPERATION)
    ? context.tracer.startActiveSpan(createOperationSpanOptions(unit), settle)
    : settle();
}

function presentStatement(
  context: InstrumentationContext,
  logged: WeakSet<object>,
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
  const settle = async (): Promise<void> => {
    const end = next();
    const settled = await end;
    if (settled.recovered !== true) {
      const error = failure(unit);
      if (settled.status === "failure" && error instanceof Error) {
        if (erred) {
          logged.add(origin(error));
          // A failure that names a native batch member is presented as it.
          const index = statementIndexOf(error);
          const member =
            index === undefined ? undefined : statements(unit)?.[index];
          context.logger?.error(
            createStatementLogEvent(
              context.config.logging,
              unit,
              startedAt,
              settled.duration,
              member?.sql ?? text(unit),
              // A batch's snapshot holds one list per member.
              member === undefined || index === undefined
                ? shown
                : batchMemberParameters(shown, index),
              member,
              error
            )
          );
        }
      } else if (settled.status === "success" && queried) {
        context.logger?.query(
          createStatementLogEvent(
            context.config.logging,
            unit,
            startedAt,
            settled.duration,
            text(unit),
            shown
          )
        );
      }
    }
    return endWith(end, unit);
  };
  return traced
    ? context.tracer.startActiveSpan(
        createStatementSpanOptions(
          context.config.tracing,
          unit,
          text(unit),
          shown
        ),
        settle
      )
    : settle();
}

function batchMemberParameters(
  shown: readonly unknown[] | undefined,
  index: number
): readonly unknown[] | undefined {
  const member = shown?.[index];
  return Array.isArray(member) ? member : undefined;
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
  return context.tracer.startActiveSpan(
    createLifecycleSpanOptions(name, unit),
    () => endWith(next(), unit)
  );
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
  const settle = async (opened?: TracingSpan): Promise<void> => {
    const end = next();
    await end;
    for (const noted of notes(unit).slice(started)) {
      const fact = noteOf(noted);
      if (fact?.attributes !== undefined)
        setSpanAttributes(opened, notedAttributes(fact.attributes));
      log(context, unit, fact);
    }
    return endWith(end, unit);
  };
  return span !== undefined && context.tracer !== undefined && tracesAs(span)
    ? context.tracer.startActiveSpan(createNotedSpanOptions(unit, span), settle)
    : settle();
}
