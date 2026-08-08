/**
 * Instrumentation Context
 *
 * Combines tracer and logger into a single context passed through layers.
 * The tracer is ALWAYS present (using no-op when tracing is not configured),
 * eliminating the need for conditional `if (tracer)` checks.
 */

import type { ResolvedDiagnosticDisclosure } from "@errors";
import { isFunction, isString } from "@validation/value-guards";
import {
  isArrayValue,
  isRecord,
  safeArrayLength,
  safeOwnPropertyDescriptor,
  safeRead,
} from "../errors/diagnostic-safety";
import { createLogger, type Logger } from "./logger";
import {
  createTracerWrapper,
  getNoopTracer,
  type TracerWrapper,
} from "./tracer";
import type {
  InstrumentationConfig,
  LogCallback,
  LoggingConfig,
  LogLevelHandler,
  TracingConfig,
} from "./types";

/**
 * Combined instrumentation context
 *
 * Note: `tracer` is always defined - it's either a real tracer or a no-op tracer.
 * This allows code to unconditionally call tracer methods without null checks.
 */
export interface InstrumentationContext {
  /** Immutable configuration snapshot resolved at the public boundary. */
  config: ResolvedInstrumentationConfig;
  /** Tracer wrapper - always present (no-op if tracing not configured) */
  tracer: TracerWrapper;
  /** Logger (if logging enabled) */
  logger?: Logger | undefined;
}

interface ResolvedInstrumentationConfig {
  readonly diagnostics: ResolvedDiagnosticDisclosure;
  readonly logging?: true | Readonly<LoggingConfig> | undefined;
  readonly tracing?: true | Readonly<TracingConfig> | undefined;
}

/**
 * Create instrumentation context from config
 *
 * @param config - Instrumentation configuration
 * @returns Combined context with tracer (always present) and logger
 */
export function createInstrumentationContext(
  config: InstrumentationConfig
): InstrumentationContext {
  const snapshot = snapshotInstrumentationConfig(config);
  // Create tracer - either real (if tracing configured) or no-op
  let tracer: TracerWrapper;
  if (snapshot.tracing) {
    const tracingConfig = snapshot.tracing === true ? {} : snapshot.tracing;
    tracer = createTracerWrapper({
      includeSql: tracingConfig.includeSql,
      includeParams: tracingConfig.includeParams,
      ignoreSpanTypes: tracingConfig.ignoreSpanTypes,
    });
  } else {
    tracer = getNoopTracer();
  }

  const context: InstrumentationContext = { config: snapshot, tracer };

  // Create logger if logging is configured
  if (snapshot.logging) {
    const loggingConfig: LoggingConfig =
      snapshot.logging === true ? { all: true } : snapshot.logging;
    context.logger = createLogger(loggingConfig);
  }

  return Object.freeze(context);
}

function snapshotInstrumentationConfig(
  config: InstrumentationConfig
): ResolvedInstrumentationConfig {
  const diagnostics = snapshotDisclosure(safeRead(config, "diagnostics"));
  const tracingValue = safeRead(config, "tracing");
  const loggingValue = safeRead(config, "logging");
  const tracing =
    tracingValue === true
      ? true
      : isRecord(tracingValue)
        ? snapshotTracingConfig(tracingValue)
        : undefined;
  const logging =
    loggingValue === true
      ? true
      : isRecord(loggingValue)
        ? snapshotLoggingConfig(loggingValue)
        : undefined;
  return Object.freeze({ diagnostics, tracing, logging });
}

function snapshotDisclosure(value: unknown): ResolvedDiagnosticDisclosure {
  return Object.freeze({
    includeParams: isRecord(value) && safeRead(value, "includeParams") === true,
    includeSql: isRecord(value) && safeRead(value, "includeSql") === true,
  });
}

function snapshotTracingConfig(value: Record<string, unknown>): TracingConfig {
  const ignoreSpanTypes = snapshotIgnorePatterns(
    safeRead(value, "ignoreSpanTypes")
  );
  return Object.freeze({
    ...snapshotDisclosure(value),
    ...(ignoreSpanTypes.length > 0 ? { ignoreSpanTypes } : {}),
  });
}

function snapshotIgnorePatterns(
  value: unknown
): ReadonlyArray<string | RegExp> {
  if (!isArrayValue(value)) return Object.freeze([]);
  const patterns: Array<string | RegExp> = [];
  const length = Math.min(safeArrayLength(value), 128);
  for (let index = 0; index < length; index += 1) {
    const descriptor = safeOwnPropertyDescriptor(value, String(index));
    if (!(descriptor && "value" in descriptor)) continue;
    const pattern = descriptor.value;
    if (isString(pattern)) {
      patterns.push(pattern);
      continue;
    }
    try {
      if (pattern instanceof RegExp) {
        patterns.push(Object.freeze(new RegExp(pattern.source, pattern.flags)));
      }
    } catch {
      // Invalid caller-owned patterns are ignored at this boundary.
    }
  }
  return Object.freeze(patterns);
}

function snapshotLoggingConfig(
  value: Record<string, unknown>
): LoggingConfig | undefined {
  const all = readLogHandler(value, "all");
  const cache = readLogHandler(value, "cache");
  const error = readLogHandler(value, "error");
  const query = readLogHandler(value, "query");
  const warning = readLogHandler(value, "warning");
  if ([all, cache, error, query, warning].every((handler) => !handler)) {
    return undefined;
  }
  return Object.freeze({
    ...snapshotDisclosure(value),
    all,
    cache,
    error,
    query,
    warning,
  });
}

function readLogHandler(
  value: Record<string, unknown>,
  key: "all" | "cache" | "error" | "query" | "warning"
): LogLevelHandler | undefined {
  const handler = safeRead(value, key);
  return handler === true || isFunction<LogCallback>(handler)
    ? handler
    : undefined;
}

/**
 * Check if instrumentation context has any active features
 * (tracing is enabled OR logging is enabled)
 */
export function hasActiveInstrumentation(
  context: InstrumentationContext | undefined
): boolean {
  if (!context) return false;
  return context.tracer.isEnabled() || !!context.logger;
}

/**
 * Check if tracing is active in context
 */
export function isTracingActive(
  context: InstrumentationContext | undefined
): boolean {
  return context?.tracer.isEnabled() ?? false;
}

/**
 * Check if logging is active in context
 */
export function isLoggingActive(
  context: InstrumentationContext | undefined
): boolean {
  return !!context?.logger;
}
