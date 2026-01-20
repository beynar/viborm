/**
 * Instrumentation Context
 *
 * Combines tracer and logger into a single context passed through layers.
 */

import { createLogger, type Logger } from "./logger";
import { createTracerWrapper, type TracerWrapper } from "./tracer";
import type { InstrumentationConfig } from "./types";

/**
 * Combined instrumentation context
 */
export interface InstrumentationContext {
  /** Original configuration */
  config: InstrumentationConfig;
  /** Tracer wrapper (if tracing enabled) */
  tracer?: TracerWrapper | undefined;
  /** Logger (if logging enabled) */
  logger?: Logger | undefined;
}

/**
 * Create instrumentation context from config
 *
 * @param config - Instrumentation configuration
 * @returns Combined context with tracer and logger
 */
export function createInstrumentationContext(
  config: InstrumentationConfig
): InstrumentationContext {
  const context: InstrumentationContext = { config };

  // Create tracer if tracing is configured (explicit opt-in)
  if (config.tracing) {
    const tracingConfig = config.tracing === true ? {} : config.tracing;
    context.tracer = createTracerWrapper({
      includeSql: tracingConfig.includeSql,
      includeParams: tracingConfig.includeParams,
      ignoreSpanTypes: tracingConfig.ignoreSpanTypes,
    });
  }

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
 */
export function hasActiveInstrumentation(
  context: InstrumentationContext | undefined
): boolean {
  if (!context) return false;
  return !!(context.tracer || context.logger);
}

/**
 * Check if tracing is active in context
 */
export function isTracingActive(
  context: InstrumentationContext | undefined
): boolean {
  return !!context?.tracer;
}

/**
 * Check if logging is active in context
 */
export function isLoggingActive(
  context: InstrumentationContext | undefined
): boolean {
  return !!context?.logger;
}
