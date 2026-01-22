/**
 * Instrumentation Context
 *
 * Combines tracer and logger into a single context passed through layers.
 * The tracer is ALWAYS present (using no-op when tracing is not configured),
 * eliminating the need for conditional `if (tracer)` checks.
 */

import { createLogger, type Logger } from "./logger";
import {
  createTracerWrapper,
  getNoopTracer,
  type TracerWrapper,
} from "./tracer";
import type { InstrumentationConfig } from "./types";

/**
 * Combined instrumentation context
 *
 * Note: `tracer` is always defined - it's either a real tracer or a no-op tracer.
 * This allows code to unconditionally call tracer methods without null checks.
 */
export interface InstrumentationContext {
  /** Original configuration */
  config: InstrumentationConfig;
  /** Tracer wrapper - always present (no-op if tracing not configured) */
  tracer: TracerWrapper;
  /** Logger (if logging enabled) */
  logger?: Logger | undefined;
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
  // Create tracer - either real (if tracing configured) or no-op
  let tracer: TracerWrapper;
  if (config.tracing) {
    const tracingConfig = config.tracing === true ? {} : config.tracing;
    tracer = createTracerWrapper({
      includeSql: tracingConfig.includeSql,
      includeParams: tracingConfig.includeParams,
      ignoreSpanTypes: tracingConfig.ignoreSpanTypes,
    });
  } else {
    tracer = getNoopTracer();
  }

  const context: InstrumentationContext = { config, tracer };

  // Create logger if logging is configured
  if (config.logging) {
    const loggingConfig =
      config.logging === true ? { all: true as const } : config.logging;
    context.logger = createLogger(loggingConfig);
  }

  return context;
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
