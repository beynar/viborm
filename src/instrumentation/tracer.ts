/**
 * Tracer Wrapper
 *
 * Wraps OpenTelemetry API with graceful fallback when not available.
 * Follows Drizzle's pattern: optional dependency, no-op when unavailable.
 *
 * Key design: createTracerWrapper() ALWAYS returns a tracer - either a real
 * one (when OTel is available) or a no-op tracer. This eliminates the need
 * for conditional `if (tracer)` checks throughout the codebase.
 */

import { sanitizeDiagnosticParameters } from "@errors";
import { VIBORM_VERSION } from "../version";
import {
  ATTR_DB_QUERY_PARAMETER_PREFIX,
  ATTR_DB_QUERY_TEXT,
  type VibORMSpanName,
} from "./spans";

/**
 * OpenTelemetry types (imported dynamically)
 */
type OTelAPI = typeof import("@opentelemetry/api");
type Context = import("@opentelemetry/api").Context;
export type Span = import("@opentelemetry/api").Span;
type Tracer = import("@opentelemetry/api").Tracer;
type SpanKind = import("@opentelemetry/api").SpanKind;
type Attributes = import("@opentelemetry/api").Attributes;

// Package version for tracer identification
const TRACER_NAME = "viborm";
const TRACER_VERSION = VIBORM_VERSION;

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
  ignoreSpanTypes?: Array<string | RegExp> | undefined;
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

class TrustedTracerWrapper implements TracerWrapper {
  readonly #delegate: TracerWrapper;

  constructor(delegate: TracerWrapper) {
    this.#delegate = delegate;
    Object.freeze(this);
  }

  static hasBrand(value: TracerWrapper): boolean {
    return #delegate in value;
  }

  startActiveSpan<T>(
    options: VibORMSpanOptions,
    fn: (span?: Span) => T | Promise<T>
  ): Promise<T> {
    return this.#delegate.startActiveSpan(options, fn);
  }

  startActiveSpanSync<T>(
    options: VibORMSpanOptions,
    fn: (span?: Span) => T
  ): T {
    return this.#delegate.startActiveSpanSync(options, fn);
  }

  isEnabled(): boolean {
    return this.#delegate.isEnabled();
  }
}
Object.defineProperty(TrustedTracerWrapper.prototype, "constructor", {
  configurable: false,
  enumerable: false,
  value: undefined,
  writable: false,
});
Object.freeze(TrustedTracerWrapper.prototype);
Object.freeze(TrustedTracerWrapper);

/**
 * No-op tracer that passes through callbacks without creating spans.
 * Used when OpenTelemetry is not available.
 */
const noopTracer: TracerWrapper = new TrustedTracerWrapper({
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
});

/**
 * Create a tracer wrapper instance
 *
 * All mutable state is scoped to this instance to support serverless environments.
 * Always returns a valid TracerWrapper - either a real tracer or the no-op tracer.
 */
export function createTracerWrapper(
  config?: TracerWrapperConfig
): TracerWrapper {
  const ignorePatterns = snapshotIgnorePatterns(config);
  const includeSql = readTracerFlag(config, "includeSql");
  const includeParams = readTracerFlag(config, "includeParams");

  // Instance-scoped state (not module-level) for serverless compatibility
  let otel: OTelAPI | null = null;
  let otelLoadAttempted = false;
  let tracer: Tracer | null = null;

  async function tryLoadOtel(): Promise<OTelAPI | null> {
    if (otelLoadAttempted) return otel;
    otelLoadAttempted = true;

    try {
      otel = await import("@opentelemetry/api");
      return otel;
    } catch {
      return null;
    }
  }

  function shouldIgnoreSpan(name: string): boolean {
    try {
      return ignorePatterns.some((pattern) => {
        if (typeof pattern === "string") return pattern === name;
        return new RegExp(pattern.source, pattern.flags).test(name);
      });
    } catch {
      return false;
    }
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
        if (!Array.isArray(sanitizedParams)) return attrs;
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

  function getTracer(api: OTelAPI): Tracer {
    if (!tracer) {
      tracer = api.trace.getTracer(TRACER_NAME, TRACER_VERSION);
    }
    return tracer;
  }

  // Eagerly load OTel on first tracer creation
  const otelReady = tryLoadOtel();

  const wrapper: TracerWrapper = {
    async startActiveSpan<T>(
      options: VibORMSpanOptions,
      fn: (span?: Span) => T | Promise<T>
    ): Promise<T> {
      // Wait for initial load only on first call, then otel is cached
      try {
        if (!otel) await otelReady;
      } catch {
        return fn();
      }
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

      let execution: Promise<T> | undefined;
      const executeOnce = (): Promise<T> => {
        if (execution) return execution;
        let resolveExecution: ((value: T | PromiseLike<T>) => void) | undefined;
        let rejectExecution: ((reason?: unknown) => void) | undefined;
        execution = new Promise<T>((resolve, reject) => {
          resolveExecution = resolve;
          rejectExecution = reject;
        });
        try {
          Promise.resolve(fn(span)).then(
            (result) => {
              safely(() => span.setStatus({ code: otel!.SpanStatusCode.OK }));
              safely(() => span.end());
              resolveExecution?.(result);
            },
            (error) => {
              safely(() =>
                span.setStatus({
                  code: otel!.SpanStatusCode.ERROR,
                  message: "Operation failed",
                })
              );
              safely(() => span.recordException(createTraceError()));
              safely(() => span.end());
              rejectExecution?.(error);
            }
          );
        } catch (error) {
          safely(() =>
            span.setStatus({
              code: otel!.SpanStatusCode.ERROR,
              message: "Operation failed",
            })
          );
          safely(() => span.recordException(createTraceError()));
          safely(() => span.end());
          rejectExecution?.(error);
        }
        return execution;
      };

      try {
        Promise.resolve(otel.context.with(contextWithSpan, executeOnce)).catch(
          () => undefined
        );
      } catch {
        // The operation promise below remains authoritative.
      }
      return execution ?? executeOnce();
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
        const kind = options.kind ?? otel.SpanKind.INTERNAL;
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

      let outcome:
        | { kind: "pending" }
        | { kind: "running" }
        | { kind: "success"; value: T }
        | { kind: "failure"; error: unknown } = { kind: "pending" };
      const executeOnce = (): T => {
        if (outcome.kind === "running") throw createTraceError();
        if (outcome.kind === "failure") throw outcome.error;
        if (outcome.kind === "success") return outcome.value;
        outcome = { kind: "running" };
        try {
          const value = fn(span);
          outcome = { kind: "success", value };
          safely(() => span.setStatus({ code: otel!.SpanStatusCode.OK }));
          return value;
        } catch (error) {
          outcome = { kind: "failure", error };
          safely(() =>
            span.setStatus({
              code: otel!.SpanStatusCode.ERROR,
              message: "Operation failed",
            })
          );
          safely(() => span.recordException(createTraceError()));
          throw error;
        } finally {
          safely(() => span.end());
        }
      };

      try {
        otel.context.with(contextWithSpan, executeOnce);
      } catch {
        // The operation outcome below remains authoritative.
      }
      return executeOnce();
    },

    isEnabled(): boolean {
      return otel !== null;
    },
  };
  return new TrustedTracerWrapper(wrapper);
}

function snapshotIgnorePatterns(
  config: TracerWrapperConfig | undefined
): ReadonlyArray<string | RegExp> {
  let source: unknown;
  try {
    source = config?.ignoreSpanTypes;
  } catch {
    return Object.freeze([]);
  }
  if (!isArrayValue(source)) return Object.freeze([]);

  const patterns: Array<string | RegExp> = [];
  const lengthDescriptor = safeOwnDescriptor(source, "length");
  const sourceLength =
    lengthDescriptor &&
    "value" in lengthDescriptor &&
    typeof lengthDescriptor.value === "number" &&
    Number.isSafeInteger(lengthDescriptor.value) &&
    lengthDescriptor.value >= 0
      ? lengthDescriptor.value
      : 0;
  const length = Math.min(sourceLength, 128);
  for (let index = 0; index < length; index += 1) {
    const descriptor = safeOwnDescriptor(source, String(index));
    if (!(descriptor && "value" in descriptor)) continue;
    const pattern = descriptor.value;
    if (typeof pattern === "string") {
      patterns.push(pattern);
      continue;
    }
    try {
      if (pattern instanceof RegExp) {
        patterns.push(new RegExp(pattern.source, pattern.flags));
      }
    } catch {
      // Invalid caller-owned patterns are ignored at the config boundary.
    }
  }
  return Object.freeze(patterns);
}

function safeOwnDescriptor(
  value: object,
  key: PropertyKey
): PropertyDescriptor | undefined {
  try {
    return Reflect.getOwnPropertyDescriptor(value, key);
  } catch {
    return undefined;
  }
}

function isArrayValue(value: unknown): value is unknown[] {
  try {
    return Array.isArray(value);
  } catch {
    return false;
  }
}

function readTracerFlag(
  config: TracerWrapperConfig | undefined,
  key: "includeParams" | "includeSql"
): boolean {
  try {
    return config?.[key] === true;
  } catch {
    return false;
  }
}

export function isTrustedTracerWrapper(tracer: TracerWrapper): boolean {
  try {
    return TrustedTracerWrapper.hasBrand(tracer);
  } catch {
    return false;
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
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value) ?? "[Undefined]";
  } catch {
    return "[Unserializable]";
  }
}

/**
 * Get the no-op tracer instance.
 * Use this when you need a tracer that does nothing but still
 * implements the TracerWrapper interface.
 */
export function getNoopTracer(): TracerWrapper {
  return noopTracer;
}
