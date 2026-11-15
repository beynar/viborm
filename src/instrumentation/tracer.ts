/**
 * Tracer Wrapper
 *
 * Presents spans through a tracer the application hands over (a platform such
 * as Cloudflare Workers supplies its own), or else through an auto-detected
 * OpenTelemetry API with graceful fallback when it is not available.
 * Follows Drizzle's pattern: optional dependency, the callback run alone when
 * unavailable. Without tracing configured there is no wrapper at all.
 */

import { VIBORM_VERSION } from "../version";
import type { VibORMSpanName } from "./spans";
import type { SpanTracer, TracingSpan } from "./types";

/**
 * OpenTelemetry types (the api itself is imported dynamically, and only when
 * no tracer is handed over)
 */
type OTelAPI = typeof import("@opentelemetry/api");
type Context = import("@opentelemetry/api").Context;
type Span = import("@opentelemetry/api").Span;
type Tracer = import("@opentelemetry/api").Tracer;

/** Span attributes as VibORM presents them. */
export type SpanAttributes = Record<string, string | number | boolean>;

/** Where a settled span's status codes are read: the api's own enum. */
interface StatusCodes {
  readonly SpanStatusCode: { readonly OK: number; readonly ERROR: number };
}

/**
 * The @opentelemetry/api 1.x contract values of `SpanStatusCode.OK` and
 * `.ERROR`, for spans a handed tracer creates: no api object is loaded there.
 */
const API_CONTRACT_CODES: StatusCodes = {
  SpanStatusCode: { OK: 1, ERROR: 2 },
};

// Package version for tracer identification
const TRACER_NAME = "viborm";
const TRACER_VERSION = VIBORM_VERSION;
/**
 * Every span VibORM has settled, whichever operation settled it: a span a
 * tracer hands to two operations, or to a callback re-entered from another
 * span's `end()`, is ended once.
 */
const settledSpans = new WeakSet<TracingSpan>();

/**
 * Extended span options with VibORM-specific attributes
 */
export interface VibORMSpanOptions {
  /** Span name: one of the predefined constants, or one a note names. */
  name: string;
  /** Its attributes, already disclosed as the presentation decided */
  attributes?: SpanAttributes | undefined;
  /**
   * Start a new root span (not child of current context). A handed tracer
   * takes no parent: its span nests under the active span.
   */
  root?: boolean | undefined;
}

/**
 * Configuration for tracer wrapper
 */
export interface TracerWrapperConfig {
  /** Span names to ignore */
  ignoreSpanTypes?: ReadonlyArray<string | RegExp> | undefined;
  /**
   * A handed tracer. When given, spans start through its two-argument
   * `startActiveSpan` and `@opentelemetry/api` is never imported.
   */
  tracer?: SpanTracer | undefined;
}

/**
 * Tracer wrapper interface
 *
 * Safe to call whether OTel is loaded or not: when it is not available, the
 * callback runs directly, without a span.
 */
export interface TracerWrapper {
  /**
   * Start an active span and execute callback within it.
   * When OTel unavailable, executes callback directly.
   */
  startActiveSpan<T>(
    options: VibORMSpanOptions,
    fn: (span?: TracingSpan) => T | Promise<T>
  ): Promise<T>;

  /** Whether a span of this name is presented (`ignoreSpanTypes` names it not). */
  traces(name: VibORMSpanName): boolean;
}

/**
 * Create a tracer wrapper instance
 *
 * All mutable state is scoped to this instance to support serverless environments.
 * With `config.tracer` the wrapper presents spans through that tracer and never
 * imports `@opentelemetry/api`; without it, the api is auto-detected.
 */
export function createTracerWrapper(
  config: TracerWrapperConfig = {}
): TracerWrapper {
  const { tracer: handed } = config;
  const ignorePatterns = Object.freeze(
    (config.ignoreSpanTypes ?? []).map((pattern) =>
      typeof pattern === "string"
        ? pattern
        : new RegExp(pattern.source, pattern.flags)
    )
  );

  function traces(name: string): boolean {
    return !ignorePatterns.some((pattern) => {
      if (typeof pattern === "string") return pattern === name;
      return new RegExp(pattern.source, pattern.flags).test(name);
    });
  }

  // The auto-detected api, instance-scoped for serverless compatibility:
  // `undefined` until its import settled, `null` when it is not available.
  let otel: OTelAPI | null | undefined;
  let tracer: Tracer | undefined;
  // Eagerly load OTel on tracer creation, unless a tracer is handed over.
  const otelReady =
    handed === undefined
      ? import("@opentelemetry/api").then(
          (api) => {
            otel = api;
          },
          () => {
            otel = null;
          }
        )
      : undefined;

  return Object.freeze({
    traces,
    async startActiveSpan<T>(
      options: VibORMSpanOptions,
      fn: (span?: TracingSpan) => T | Promise<T>
    ): Promise<T> {
      // A handed tracer: spans through the two-argument
      // `startActiveSpan(name, fn)` both OpenTelemetry and the Cloudflare
      // Workers runtime implement. Attributes are set on the span it hands
      // `fn`; the span nests under the active one (no kind, no root).
      if (handed !== undefined) {
        if (!traces(options.name)) return fn();
        return runOnce(fn, API_CONTRACT_CODES, (run) =>
          handed.startActiveSpan(options.name, (span) => {
            setSpanAttributes(span, options.attributes ?? {});
            return run(span);
          })
        );
      }
      // The global provider of the auto-detected api: the first span waits
      // for its import, later ones start synchronously.
      if (otel === undefined) await otelReady;
      if (!(otel && traces(options.name))) return fn();

      let span: Span;
      let contextWithSpan: Context;
      try {
        const attributes = { ...options.attributes };
        const kind = otel.SpanKind.INTERNAL;
        const parentContext = options.root
          ? otel.ROOT_CONTEXT
          : otel.context.active();
        tracer ??= otel.trace.getTracer(TRACER_NAME, TRACER_VERSION);
        span = tracer.startSpan(
          options.name,
          { kind, attributes },
          parentContext
        );
        contextWithSpan = otel.trace.setSpan(parentContext, span);
      } catch {
        return fn();
      }
      const api = otel;
      return runOnce(
        fn,
        api,
        (run) => api.context.with(contextWithSpan, () => run(span)),
        span
      );
    },
  });
}

/**
 * The application callback of one span attempt, run exactly once: `start`
 * asks the tracer for a span and hands it `run`, and the final call here
 * returns the one execution, or starts it (with `span`, if any) when nothing
 * called back. A tracer or context manager that calls back twice,
 * re-entrantly, late, or never, or that throws, cannot repeat or skip the
 * operation, nor change its outcome. Every span any call brings is settled
 * with that run's outcome, unless an earlier settlement already ended it: the
 * run's own span, and a second or late one a hostile tracer hands over.
 */
function runOnce<T>(
  fn: (span?: TracingSpan) => T | Promise<T>,
  codes: StatusCodes,
  start: (run: (span?: TracingSpan) => Promise<T>) => unknown,
  span?: TracingSpan
): Promise<T> {
  const spans = new Set<TracingSpan>();
  let failed: boolean | undefined;
  let failure: unknown;
  const settle = (outcome: boolean, error?: unknown): void => {
    failed = outcome;
    failure = error;
    for (const span of spans) endSpan(span, outcome, codes, error);
  };
  let execution: Promise<T> | undefined;
  let executing = false;
  const run = (span?: TracingSpan): Promise<T> => {
    if (span !== undefined) {
      spans.add(span);
      if (failed !== undefined) endSpan(span, failed, codes, failure);
    }
    if (execution) return execution;
    if (executing) return Promise.reject(createTraceError());
    executing = true;
    try {
      execution = new Promise<T>((resolve, reject) => {
        try {
          Promise.resolve(fn(span)).then(
            (result) => {
              settle(false);
              resolve(result);
            },
            (error) => {
              settle(true, error);
              reject(error);
            }
          );
        } catch (error) {
          settle(true, error);
          reject(error);
        }
      });
      return execution;
    } finally {
      executing = false;
    }
  };
  try {
    Promise.resolve(start(run)).catch(ignoreRejection);
  } catch {
    // The operation promise below remains authoritative.
  }
  return run(span);
}

/**
 * Settle a span the operation ran in, once; span failures never reach it.
 * Status codes are read from `codes` at settlement, and a span without
 * `setStatus` or `recordException` (the Workers runtime span) is still ended.
 */
function endSpan(
  span: TracingSpan,
  failed: boolean,
  codes: StatusCodes,
  failure?: unknown
): void {
  if (settledSpans.has(span)) return;
  settledSpans.add(span);
  if (failed) {
    // What the instrumentation throws to fail a span is a `disclosed` copy
    // of the failure; anything else is an `Error` of the package.
    const shown: {
      readonly name?: unknown;
      readonly code?: unknown;
      readonly meta?: { readonly providerSqlState?: unknown };
    } = failure instanceof Error ? failure : {};
    const name = typeof shown.name === "string" ? shown.name : "Error";
    safely(() => span.setAttribute("error.type", name));
    // A code of the library's own errors only: a failure of another origin
    // is shown as a plain `Error`, and what it calls a code may be a value.
    const { code } = shown;
    if (typeof code === "string" && name !== "Error")
      safely(() => span.setAttribute("viborm.error.code", code));
    const sqlState = shown.meta?.providerSqlState;
    if (typeof sqlState === "string")
      safely(() => span.setAttribute("db.response.sqlstate", sqlState));
    safely(() =>
      span.setStatus?.({
        code: codes.SpanStatusCode.ERROR,
        message: "Operation failed",
      })
    );
    const exception = createTraceError();
    exception.name = name;
    safely(() => span.recordException?.(exception));
  } else {
    safely(() => span.setStatus?.({ code: codes.SpanStatusCode.OK }));
  }
  safely(() => span.end());
}

/** Set VibORM's attributes one key at a time, each contained. */
export function setSpanAttributes(
  span: TracingSpan | undefined,
  attributes: SpanAttributes
): void {
  for (const [key, value] of Object.entries(attributes)) {
    safely(() => span?.setAttribute(key, value));
  }
}

/**
 * Run one span call; neither its throw nor a rejection of the thenable it
 * returns reaches the operation, which never waits for it. Only a thenable
 * is handed a rejection handler, through its own `then`: a synchronous span
 * call allocates nothing.
 */
function safely(action: () => unknown): void {
  try {
    const result = action();
    // A thenable may be a function as well as an object.
    const then: unknown =
      (typeof result === "object" && result !== null) ||
      typeof result === "function"
        ? Reflect.get(result, "then")
        : undefined;
    if (typeof then === "function") {
      Reflect.apply(then, result, [undefined, ignoreRejection]);
    }
  } catch {
    // Instrumentation must never change the operation outcome.
  }
}

function ignoreRejection(): void {
  // A span call's rejection is consumed, never presented.
}

function createTraceError(): Error {
  const error = new Error("Operation failed");
  error.stack = undefined;
  return error;
}
