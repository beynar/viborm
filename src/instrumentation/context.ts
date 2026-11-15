/**
 * Instrumentation Context
 *
 * Combines tracer and logger into a single context passed through layers.
 */

import type { DiagnosticDisclosure } from "@errors";
import { createLogger, type Logger } from "./logger";
import { createTracerWrapper, type TracerWrapper } from "./tracer";
import type {
  InstrumentationConfig,
  LoggingConfig,
  TracingConfig,
} from "./types";

/** Combined instrumentation context */
export interface InstrumentationContext {
  /** Immutable configuration snapshot resolved at the public boundary. */
  config: ResolvedInstrumentationConfig;
  /** Tracer wrapper (if tracing enabled) */
  tracer?: TracerWrapper | undefined;
  /** Logger (if logging enabled) */
  logger?: Logger | undefined;
}

interface ResolvedInstrumentationConfig {
  readonly diagnostics: Required<DiagnosticDisclosure>;
  readonly logging?: true | Readonly<LoggingConfig> | undefined;
  readonly tracing?: true | Readonly<TracingConfig> | undefined;
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
  const snapshot = snapshotInstrumentationConfig(config);
  const context: InstrumentationContext = { config: snapshot };

  // Create tracer if tracing is configured
  if (snapshot.tracing) {
    const tracingConfig = snapshot.tracing === true ? {} : snapshot.tracing;
    context.tracer = createTracerWrapper({
      includeSql: tracingConfig.includeSql,
      includeParams: tracingConfig.includeParams,
      ignoreSpanTypes: tracingConfig.ignoreSpanTypes,
      tracer: tracingConfig.tracer,
    });
  }

  // Create logger if logging is configured
  if (snapshot.logging) {
    const loggingConfig: LoggingConfig =
      snapshot.logging === true ? { all: true } : snapshot.logging;
    context.logger = createLogger(loggingConfig);
  }

  return Object.freeze(context);
}

/**
 * The configuration as it is when the extension is built: what the caller
 * changes in its object later changes nothing. Its type is its guard; the
 * flags are read as booleans, `true` alone enabling one.
 */
function snapshotInstrumentationConfig({
  diagnostics,
  tracing,
  logging,
}: InstrumentationConfig): ResolvedInstrumentationConfig {
  return Object.freeze({
    diagnostics: snapshotDisclosure(diagnostics),
    tracing:
      tracing === true || tracing === undefined
        ? tracing
        : snapshotTracingConfig(tracing),
    logging:
      logging === true || logging === undefined
        ? logging
        : snapshotLoggingConfig(logging),
  });
}

function snapshotDisclosure(
  value: DiagnosticDisclosure | undefined
): Required<DiagnosticDisclosure> {
  return Object.freeze({
    includeParams: value?.includeParams === true,
    includeSql: value?.includeSql === true,
    includeProviderDetails: value?.includeProviderDetails === true,
    includeCallsite: value?.includeCallsite === true,
  });
}

function snapshotTracingConfig({
  includeParams,
  includeSql,
  ignoreSpanTypes,
  tracer,
}: TracingConfig): TracingConfig {
  return Object.freeze({
    includeParams: includeParams === true,
    includeSql: includeSql === true,
    ...(ignoreSpanTypes?.length ? { ignoreSpanTypes } : {}),
    ...(tracer === undefined ? {} : { tracer }),
  });
}

function snapshotLoggingConfig({
  all,
  cache,
  error,
  query,
  includeParams,
  includeSql,
}: LoggingConfig): LoggingConfig | undefined {
  if (!(all || cache || error || query)) return undefined;
  return Object.freeze({
    includeParams: includeParams === true,
    includeSql: includeSql === true,
    all,
    cache,
    error,
    query,
  });
}
