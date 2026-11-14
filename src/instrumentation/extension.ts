import { cacheFacts, cacheOutcomes } from "@cache/unit-facts";
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
  createCacheSpanOptions,
  createLifecycleSpanOptions,
  createOperationErrorLogEvent,
  createOperationSpanOptions,
  createStatementLogEvent,
  createStatementSpanOptions,
  presentCacheOutcome,
  presentTraceFailure,
  statementIndexOf,
} from "./presentation";
import {
  ATTR_CACHE_RESULT,
  SPAN_CONNECT,
  SPAN_DISCONNECT,
  SPAN_EXECUTE,
  SPAN_OPERATION,
  SPAN_TRANSACTION,
  type VibORMSpanName,
} from "./spans";
import {
  setSpanAttributes,
  shouldTraceSpan,
  type VibORMSpanOptions,
} from "./tracer";
import type {
  ExactInstrumentationConfig,
  InstrumentationConfig,
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
  const { diagnostics, logging, tracing } = context.config;
  const disclosed = disclosure({
    sql: diagnostics.includeSql,
    parameters: diagnostics.includeParams,
    providerDetails: diagnostics.includeProviderDetails,
    callsite: diagnostics.includeCallsite,
  });
  if (tracing === undefined && logging === undefined)
    return extension(NAME, disclosed);
  // The origins already logged: one failure, one error log.
  const logged = new WeakSet<object>();
  return extension(
    NAME,
    unitPart((unit, next) => observe(context, logged, unit, next)),
    disclosed
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
  let presented: unknown;
  try {
    presented = present(context, logged, unit, once);
  } catch {
    presented = undefined;
  }
  return Promise.resolve(presented)
    .then(ignore, ignore)
    .then(() => (end === undefined ? once().then(ignore) : undefined));
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
    case "cache":
      return presentCache(context, unit, next);
    // A batch has no span of its own: its members and statements do.
    default:
      return undefined;
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
    if (logs(context, "cache"))
      for (const outcome of cacheOutcomes(unit))
        context.logger?.cache(presentCacheOutcome(unit, outcome));
    const error = failure(unit);
    if (
      settled.status === "failure" &&
      error instanceof Error &&
      logs(context, "error")
    ) {
      // A failure a statement log presented is not presented again; every
      // operation whose own failure it is presents it, as before.
      const first = origin(error);
      if (!(typeof first === "object" && first !== null && logged.has(first)))
        context.logger?.error(
          createOperationErrorLogEvent(unit, error, startedAt, settled.duration)
        );
    }
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
          const first = origin(error);
          if (typeof first === "object" && first !== null) logged.add(first);
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

function presentCache(
  context: InstrumentationContext,
  unit: Unit,
  next: () => Promise<UnitEnd>
): Promise<unknown> {
  const traced = context.config.tracing !== undefined;
  const logged = logs(context, "cache");
  const facts = cacheFacts(unit);
  // A revalidation presents its start at the instant it is observed.
  if (logged && unit.operation === "revalidate")
    context.logger?.cache(
      presentCacheOutcome(unit, {
        event: "revalidate",
        status: "start",
        at: Date.now(),
      })
    );
  const settle = async (span?: TracingSpan): Promise<void> => {
    const end = next();
    await end;
    const settled = cacheFacts(unit);
    if (traced && settled?.result !== undefined)
      setSpanAttributes(span, { [ATTR_CACHE_RESULT]: settled.result });
    if (logged)
      for (const outcome of settled?.outcomes ?? [])
        context.logger?.cache(presentCacheOutcome(unit, outcome));
    return endWith(end, unit);
  };
  const options: VibORMSpanOptions | undefined =
    traced && facts !== undefined
      ? createCacheSpanOptions(unit, facts)
      : undefined;
  return options === undefined
    ? settle()
    : context.tracer.startActiveSpan(options, settle);
}
