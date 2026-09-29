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

/**
 * OpenTelemetry types (the api itself is imported dynamically, and only when
 * no platform tracer is given)
 */
type OTelAPI = typeof import("@opentelemetry/api");
type Context = import("@opentelemetry/api").Context;
export type Span = import("@opentelemetry/api").Span;
type Tracer = import("@opentelemetry/api").Tracer;
type SpanKind = import("@opentelemetry/api").SpanKind;
type SpanOptions = import("@opentelemetry/api").SpanOptions;
type SpanStatusCode = import("@opentelemetry/api").SpanStatusCode;
type Attributes = import("@opentelemetry/api").Attributes;

/**
 * The @opentelemetry/api 1.x contract values of `SpanKind.INTERNAL` and
 * `SpanStatusCode.OK` / `SpanStatusCode.ERROR`. Plain numbers, so presenting a
 * span through a platform-provided tracer needs no api object.
 */
const SPAN_KIND_INTERNAL: SpanKind = 0;
const SPAN_STATUS_OK: SpanStatusCode = 1;
const SPAN_STATUS_ERROR: SpanStatusCode = 2;

// Package version for tracer identification
const TRACER_NAME = "viborm";
const TRACER_VERSION = VIBORM_VERSION;
const SHOULD_TRACE_SPAN = Symbol("viborm.shouldTraceSpan");
const tracerReadiness = new WeakMap<TracerWrapper, Promise<void>>();

/**
 * Extended span options with VibORM-specific attributes
 */
export interface VibORMSpanOptions {
  /** Span name from the predefined constants */
  name: VibORMSpanName;
  /** Span kind (default: INTERNAL) */
  kind?: SpanKind | undefined;
  /** Additional attributes */
  attributes?: Attributes | undefined;
  /** SQL info (only included if tracer config has includeSql enabled) */
  sql?: { query?: string; params?: unknown[] } | undefined;
  /** Start a new root span (not child of current context) */
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
   * A platform-provided tracer. When given, spans start through its
   * `startActiveSpan` and `@opentelemetry/api` is never imported.
   */
  tracer?: Tracer | undefined;
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
    fn: (span?: Span) => T | Promise<T>
  ): Promise<T>;

  /**
   * Synchronous version for non-async operations.
   * When OTel unavailable, executes callback directly.
   */
  startActiveSpanSync<T>(options: VibORMSpanOptions, fn: (span?: Span) => T): T;

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
    fn: (span?: Span) => T | Promise<T>
  ): Promise<T> {
    return fn();
  },

  startActiveSpanSync<T>(
    _options: VibORMSpanOptions,
    fn: (span?: Span) => T
  ): T {
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

  function buildAttributes(options: VibORMSpanOptions): Attributes {
    const attrs: Attributes = { ...options.attributes };

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

  /** Spans through a tracer the platform or application already holds. */
  function presentThrough(platformTracer: Tracer): TracerWrapper {
    const spanOptions = (options: VibORMSpanOptions): SpanOptions => ({
      kind: options.kind ?? SPAN_KIND_INTERNAL,
      root: options.root === true,
      attributes: buildAttributes(options),
    });
    return {
      async startActiveSpan<T>(
        options: VibORMSpanOptions,
        fn: (span?: Span) => T | Promise<T>
      ): Promise<T> {
        if (shouldIgnoreSpan(options.name)) return fn();
        const executeOnce = createAsyncExecution(fn);
        try {
          Promise.resolve(
            platformTracer.startActiveSpan(
              options.name,
              spanOptions(options),
              (span: Span) => executeOnce(span)
            )
          ).catch(() => undefined);
        } catch {
          // The operation promise below remains authoritative.
        }
        // Without a callback from the tracer, the operation runs unspanned.
        return executeOnce();
      },

      startActiveSpanSync<T>(
        options: VibORMSpanOptions,
        fn: (span?: Span) => T
      ): T {
        if (shouldIgnoreSpan(options.name)) return fn();
        const executeOnce = createSyncExecution(fn);
        try {
          platformTracer.startActiveSpan(
            options.name,
            spanOptions(options),
            (span: Span) => executeOnce(span)
          );
        } catch {
          // The operation outcome below remains authoritative.
        }
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
        fn: (span?: Span) => T | Promise<T>
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
          const kind = options.kind ?? SPAN_KIND_INTERNAL;
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

        const executeOnce = createAsyncExecution(fn);
        try {
          Promise.resolve(
            otel.context.with(contextWithSpan, () => executeOnce(span))
          ).catch(() => undefined);
        } catch {
          // The operation promise below remains authoritative.
        }
        return executeOnce(span);
      },

      startActiveSpanSync<T>(
        options: VibORMSpanOptions,
        fn: (span?: Span) => T
      ): T {
        // Sync version requires OTel to be pre-loaded
        if (!otel || shouldIgnoreSpan(options.name)) {
          return fn();
        }

        let span: Span;
        let contextWithSpan: Context;
        try {
          const attributes = buildAttributes(options);
          const kind = options.kind ?? SPAN_KIND_INTERNAL;
          const activeContext = otel.context.active();
          span = getTracer(otel).startSpan(
            options.name,
            { kind, attributes },
            activeContext
          );
          contextWithSpan = otel.trace.setSpan(activeContext, span);
        } catch {
          return fn();
        }

        const executeOnce = createSyncExecution(fn);
        try {
          otel.context.with(contextWithSpan, () => executeOnce(span));
        } catch {
          // The operation outcome below remains authoritative.
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
 * context manager that calls back twice, re-entrantly, or never cannot repeat
 * or skip the operation: a later call returns the one execution, and the
 * caller's own final call starts it (unspanned) when nothing called back. The
 * span's status, exception and end are set on the span the run received.
 */
function createAsyncExecution<T>(
  fn: (span?: Span) => T | Promise<T>
): (span?: Span) => Promise<T> {
  let execution: Promise<T> | undefined;
  let executing = false;
  return (span?: Span): Promise<T> => {
    if (execution) return execution;
    if (executing) return Promise.reject(createTraceError());
    executing = true;
    try {
      execution = new Promise<T>((resolve, reject) => {
        try {
          Promise.resolve(fn(span)).then(
            (result) => {
              endSpan(span, false);
              resolve(result);
            },
            (error) => {
              endSpan(span, true);
              reject(error);
            }
          );
        } catch (error) {
          endSpan(span, true);
          reject(error);
        }
      });
      return execution;
    } finally {
      executing = false;
    }
  };
}

/** The synchronous twin of `createAsyncExecution`: one run, one outcome. */
function createSyncExecution<T>(fn: (span?: Span) => T): (span?: Span) => T {
  let outcome:
    | { kind: "pending" }
    | { kind: "running" }
    | { kind: "success"; value: T }
    | { kind: "failure"; error: unknown } = { kind: "pending" };
  return (span?: Span): T => {
    if (outcome.kind === "running") throw createTraceError();
    if (outcome.kind === "failure") throw outcome.error;
    if (outcome.kind === "success") return outcome.value;
    outcome = { kind: "running" };
    try {
      const value = fn(span);
      outcome = { kind: "success", value };
      endSpan(span, false);
      return value;
    } catch (error) {
      outcome = { kind: "failure", error };
      endSpan(span, true);
      throw error;
    }
  };
}

/** Settle the span the operation ran in; span failures never reach it. */
function endSpan(span: Span | undefined, failed: boolean): void {
  if (failed) {
    safely(() =>
      span?.setStatus({ code: SPAN_STATUS_ERROR, message: "Operation failed" })
    );
    safely(() => span?.recordException(createTraceError()));
  } else {
    safely(() => span?.setStatus({ code: SPAN_STATUS_OK }));
  }
  safely(() => span?.end());
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

function safely(action: () => void): void {
  try {
    action();
  } catch {
    // Instrumentation must never change the operation outcome.
  }
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
