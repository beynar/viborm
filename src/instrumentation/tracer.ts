/**
 * Tracer Wrapper
 *
 * Presents spans through a tracer the application hands over (a platform such
 * as Cloudflare Workers supplies its own), or else through an auto-detected
 * OpenTelemetry API with graceful fallback when it is not available.
 * Follows Drizzle's pattern: optional dependency, no-op when unavailable.
 *
 * Key design: createTracerWrapper() ALWAYS returns a tracer - either a real
 * one (when OTel is available) or a no-op tracer. This eliminates the need
 * for conditional `if (tracer)` checks throughout the codebase.
 */

import { sanitizeDiagnosticParameters } from "@errors";
import { isString } from "@validation/value-guards";
import { VIBORM_VERSION } from "../version";
import {
  ATTR_DB_QUERY_PARAMETER_PREFIX,
  ATTR_DB_QUERY_TEXT,
  type VibORMSpanName,
} from "./spans";
import type { SpanTracer, TracingSpan } from "./types";

/**
 * OpenTelemetry types (the api itself is imported dynamically, and only when
 * no tracer is handed over)
 */
type OTelAPI = typeof import("@opentelemetry/api");
type Context = import("@opentelemetry/api").Context;
type Span = import("@opentelemetry/api").Span;
type Tracer = import("@opentelemetry/api").Tracer;
type SpanKind = import("@opentelemetry/api").SpanKind;

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
const SHOULD_TRACE_SPAN = Symbol("viborm.shouldTraceSpan");
const tracerReadiness = new WeakMap<TracerWrapper, Promise<void>>();
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
  /** Span name from the predefined constants */
  name: VibORMSpanName;
  /** Span kind (default: INTERNAL; a handed tracer takes no kind) */
  kind?: SpanKind | undefined;
  /** Additional attributes */
  attributes?: SpanAttributes | undefined;
  /** SQL info (only included if tracer config has includeSql enabled) */
  sql?: { query?: string; params?: unknown[] } | undefined;
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
  /** Include SQL query text in span attributes (default: false) */
  includeSql?: boolean | undefined;
  /** Include query parameters in span attributes (default: false) */
  includeParams?: boolean | undefined;
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
 * All methods are safe to call regardless of whether OTel is loaded.
 * When OTel is not available, methods execute callbacks directly without tracing.
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

  /**
   * Check if tracing is enabled (OTel loaded and configured)
   */
  isEnabled(): boolean;
}

/**
 * No-op tracer that passes through callbacks without creating spans.
 * Used when OpenTelemetry is not available.
 */
const noopTracer: TracerWrapper = {
  async startActiveSpan<T>(
    _options: VibORMSpanOptions,
    fn: (span?: TracingSpan) => T | Promise<T>
  ): Promise<T> {
    return fn();
  },

  isEnabled(): boolean {
    return false;
  },
};
Object.defineProperty(noopTracer, SHOULD_TRACE_SPAN, {
  value: () => false,
});
Object.freeze(noopTracer);

/**
 * Create a tracer wrapper instance
 *
 * All mutable state is scoped to this instance to support serverless environments.
 * Always returns a valid TracerWrapper - either a real tracer or the no-op tracer.
 * With `config.tracer` the wrapper presents spans through that tracer and never
 * imports `@opentelemetry/api`; without it, the api is auto-detected.
 */
export function createTracerWrapper(
  config?: TracerWrapperConfig
): TracerWrapper {
  const ignorePatterns = Object.freeze(
    (config?.ignoreSpanTypes ?? []).map((pattern) =>
      isString(pattern) ? pattern : new RegExp(pattern.source, pattern.flags)
    )
  );
  const includeSql = config?.includeSql === true;
  const includeParams = config?.includeParams === true;

  function shouldIgnoreSpan(name: string): boolean {
    return ignorePatterns.some((pattern) => {
      if (isString(pattern)) return pattern === name;
      return new RegExp(pattern.source, pattern.flags).test(name);
    });
  }

  function buildAttributes(options: VibORMSpanOptions): SpanAttributes {
    const attrs: SpanAttributes = { ...options.attributes };

    if (options.sql) {
      if (includeSql && options.sql.query !== undefined) {
        attrs[ATTR_DB_QUERY_TEXT] = options.sql.query;
      }
      if (includeParams && options.sql.params) {
        const sanitizedParams = sanitizeDiagnosticParameters(
          options.sql.params,
          {
            includeParams: true,
            includeSql,
          }
        );
        // Use individual parameter attributes per OTel spec
        // db.query.parameter.0, db.query.parameter.1, etc.
        for (let i = 0; i < sanitizedParams.length; i++) {
          const value = sanitizedParams[i];
          attrs[`${ATTR_DB_QUERY_PARAMETER_PREFIX}.${i}`] =
            formatSanitizedSpanParameter(value);
        }
      }
    }

    return attrs;
  }

  /**
   * Spans through a tracer the platform or application already holds, by the
   * two-argument `startActiveSpan(name, fn)` both OpenTelemetry and the
   * Cloudflare Workers runtime implement. Attributes are set on the span it
   * hands `fn`; the span nests under the active one (no kind, no root).
   */
  function presentThrough(platformTracer: SpanTracer): TracerWrapper {
    return {
      async startActiveSpan<T>(
        options: VibORMSpanOptions,
        fn: (span?: TracingSpan) => T | Promise<T>
      ): Promise<T> {
        if (shouldIgnoreSpan(options.name)) return fn();
        const executeOnce = createExecution(fn, API_CONTRACT_CODES);
        try {
          const attributes = buildAttributes(options);
          Promise.resolve(
            platformTracer.startActiveSpan(options.name, (span) => {
              setSpanAttributes(span, attributes);
              return executeOnce(span);
            })
          ).catch(() => undefined);
        } catch {
          // The operation promise below remains authoritative.
        }
        // Without a callback from the tracer, the operation runs unspanned.
        return executeOnce();
      },

      isEnabled(): boolean {
        return true;
      },
    };
  }

  /** Spans through the global provider of an auto-detected OTel api. */
  function autoDetect(): TracerWrapper {
    // Instance-scoped state (not module-level) for serverless compatibility
    let otel: OTelAPI | null = null;
    let tracer: Tracer | null = null;
    let otelLoaded = false;

    async function tryLoadOtel(): Promise<OTelAPI | null> {
      try {
        otel = await import("@opentelemetry/api");
        return otel;
      } catch {
        return null;
      }
    }

    function getTracer(api: OTelAPI): Tracer {
      if (!tracer) {
        tracer = api.trace.getTracer(TRACER_NAME, TRACER_VERSION);
      }
      return tracer;
    }

    // Eagerly load OTel on first tracer creation
    const otelReady = tryLoadOtel().then((api) => {
      otelLoaded = true;
      return api;
    });

    const wrapper: TracerWrapper = {
      async startActiveSpan<T>(
        options: VibORMSpanOptions,
        fn: (span?: TracingSpan) => T | Promise<T>
      ): Promise<T> {
        // Wait for initial load only on first call, then otel is cached
        if (!otelLoaded) await otelReady;
        if (!otel || shouldIgnoreSpan(options.name)) {
          return fn();
        }

        let span: Span;
        let contextWithSpan: Context;
        try {
          const attributes = buildAttributes(options);
          const kind = options.kind ?? otel.SpanKind.INTERNAL;
          const parentContext = options.root
            ? otel.ROOT_CONTEXT
            : otel.context.active();
          span = getTracer(otel).startSpan(
            options.name,
            { kind, attributes },
            parentContext
          );
          contextWithSpan = otel.trace.setSpan(parentContext, span);
        } catch {
          return fn();
        }

        const executeOnce = createExecution(fn, otel);
        try {
          Promise.resolve(
            otel.context.with(contextWithSpan, () => executeOnce(span))
          ).catch(() => undefined);
        } catch {
          // The operation promise below remains authoritative.
        }
        return executeOnce(span);
      },

      isEnabled(): boolean {
        return otel !== null;
      },
    };
    const readiness = otelReady.then(() => undefined);
    tracerReadiness.set(wrapper, readiness);
    readiness.then(() => tracerReadiness.delete(wrapper));
    return wrapper;
  }

  const platformTracer = config?.tracer;
  const wrapper =
    platformTracer === undefined
      ? autoDetect()
      : presentThrough(platformTracer);
  Object.defineProperty(wrapper, SHOULD_TRACE_SPAN, {
    value: (name: VibORMSpanName) => !shouldIgnoreSpan(name),
  });
  return Object.freeze(wrapper);
}

/**
 * The application callback of one span attempt, run exactly once. A tracer or
 * context manager that calls back twice, re-entrantly, late, or never cannot
 * repeat or skip the operation: a later call returns the one execution, and
 * the caller's own final call starts it (unspanned) when nothing called back.
 * Every span any call brings is settled with that run's outcome, unless an
 * earlier settlement already ended it: the run's own span, and a second or
 * late one a hostile tracer hands over.
 */
function createExecution<T>(
  fn: (span?: TracingSpan) => T | Promise<T>,
  codes: StatusCodes
): (span?: TracingSpan) => Promise<T> {
  const spans = new Set<TracingSpan>();
  let failed: boolean | undefined;
  const settle = (outcome: boolean): void => {
    failed = outcome;
    for (const span of spans) endSpan(span, outcome, codes);
  };
  let execution: Promise<T> | undefined;
  let executing = false;
  return (span?: TracingSpan): Promise<T> => {
    if (span !== undefined) {
      spans.add(span);
      if (failed !== undefined) endSpan(span, failed, codes);
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
              settle(true);
              reject(error);
            }
          );
        } catch (error) {
          settle(true);
          reject(error);
        }
      });
      return execution;
    } finally {
      executing = false;
    }
  };
}

/**
 * Settle a span the operation ran in, once; span failures never reach it.
 * Status codes are read from `codes` at settlement, and a span without
 * `setStatus` or `recordException` (the Workers runtime span) is still ended.
 */
function endSpan(span: TracingSpan, failed: boolean, codes: StatusCodes): void {
  if (settledSpans.has(span)) return;
  settledSpans.add(span);
  if (failed) {
    safely(() =>
      span.setStatus?.({
        code: codes.SpanStatusCode.ERROR,
        message: "Operation failed",
      })
    );
    safely(() => span.recordException?.(createTraceError()));
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

/** Return this wrapper's outstanding one-shot OTel readiness, if any. */
export function prewarmTracer(tracer: TracerWrapper): void | Promise<void> {
  return tracerReadiness.get(tracer);
}

export function shouldTraceSpan(
  tracer: TracerWrapper,
  name: VibORMSpanName
): boolean {
  try {
    const shouldTrace = Reflect.get(tracer, SHOULD_TRACE_SPAN);
    return typeof shouldTrace !== "function" || shouldTrace(name) !== false;
  } catch {
    return true;
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

function formatSanitizedSpanParameter(value: unknown): string {
  if (isString(value)) return value;
  return String(JSON.stringify(value));
}

/**
 * Get the no-op tracer instance.
 * Use this when you need a tracer that does nothing but still
 * implements the TracerWrapper interface.
 */
export function getNoopTracer(): TracerWrapper {
  return noopTracer;
}
