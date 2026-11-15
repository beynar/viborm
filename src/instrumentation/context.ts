/**
 * Instrumentation Context
 *
 * Combines tracer and logger into a single context passed through layers.
 */

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
  readonly config: ResolvedInstrumentationConfig;
  /** Tracer wrapper (if tracing enabled) */
  readonly tracer: TracerWrapper | undefined;
  /** Logger (if logging enabled) */
  readonly logger: Logger | undefined;
  /** The origins of the failures already logged: one failure, one error log. */
  readonly logged: WeakSet<object>;
}

interface ResolvedInstrumentationConfig {
  readonly logging?: true | Readonly<LoggingConfig> | undefined;
  readonly tracing?: true | Readonly<TracingConfig> | undefined;
}

/**
 * Create instrumentation context from config: the configuration as it is
 * when the extension is built, so that what the caller changes in its object
 * later changes nothing. Its type is its guard; the flags are read as
 * booleans, `true` alone enabling one. `diagnostics` is not part of it: the
 * extension hands it to `disclosure`, which reads it once.
 */
export function createInstrumentationContext({
  tracing,
  logging,
}: InstrumentationConfig): InstrumentationContext {
  const config: ResolvedInstrumentationConfig = Object.freeze({
    tracing:
      tracing === true || tracing === undefined
        ? tracing
        : snapshotTracingConfig(tracing),
    logging:
      logging === true || logging === undefined
        ? logging
        : snapshotLoggingConfig(logging),
  });
  return Object.freeze({
    config,
    tracer:
      config.tracing &&
      createTracerWrapper(config.tracing === true ? {} : config.tracing),
    logger:
      config.logging &&
      createLogger(config.logging === true ? { all: true } : config.logging),
    logged: new WeakSet<object>(),
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
