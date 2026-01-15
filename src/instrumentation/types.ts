/**
 * Instrumentation Types
 *
 * Configuration interfaces for OpenTelemetry tracing and structured logging.
 */

import type { VibORMError } from "../errors";
import type { Operation } from "../query-engine/types";

/**
 * Log levels for the logging callback
 */
export type LogLevel = "query" | "warning" | "error";

/**
 * Log event payload passed to the logging callback
 */
export interface LogEvent {
  /** Log level */
  level: LogLevel;
  /** Timestamp of the event */
  timestamp: Date;
  /** Duration in milliseconds (for query events) */
  duration?: number | undefined;
  /** Model name */
  model?: string | undefined;
  /** Operation being performed */
  operation?: Operation | undefined;
  /** Error if applicable */
  error?: VibORMError | Error | undefined;
  /** SQL query (only if includeSql is enabled) */
  sql?: string | undefined;
  /** Query parameters (only if includeSql is enabled) */
  params?: unknown[] | undefined;
  /** Additional metadata */
  meta?: Record<string, unknown> | undefined;
}

/**
 * Logging callback function signature
 * @param event - The log event
 * @param log - Call this to invoke the default pretty logger
 */
export type LogCallback = (event: LogEvent, log: () => void) => void;

/**
 * Tracing configuration options
 */
export interface TracingConfig {
  /**
   * Include SQL query text in spans.
   * @default true
   */
  includeSql?: boolean | undefined;

  /**
   * Include query parameters in spans.
   * WARNING: May expose sensitive data. Use only in development/staging.
   * @default false
   */
  includeParams?: boolean | undefined;

  /**
   * Span names to ignore (string or regex patterns)
   * Similar to Prisma's ignoreSpanTypes
   */
  ignoreSpanTypes?: Array<string | RegExp> | undefined;
}

/**
 * Handler for a log level: true for default console output, or a custom callback
 */
export type LogLevelHandler = true | LogCallback;

/**
 * Logging configuration options
 *
 * Each log level can be:
 * - `true` to use the default pretty console output
 * - A callback function for custom handling (receives event and default logger)
 * - Omitted/undefined to disable that level
 *
 * Use `all` as a catch-all for all log levels.
 *
 * @example
 * ```typescript
 * logging: {
 *   query: true,                        // Pretty console output
 *   error: (event, log) => {
 *     errorTracker.capture(event.error);
 *     log();                            // Also use default logger
 *   },
 *   // warning: omitted = disabled
 * }
 * ```
 */
export interface LoggingConfig {
  /**
   * Catch-all handler for all log levels.
   * Applied when a specific level handler is not defined.
   */
  all?: LogLevelHandler | undefined;

  /**
   * Query log handler.
   * Emitted for every database query.
   */
  query?: LogLevelHandler | undefined;

  /**
   * Warning log handler.
   * Emitted for non-fatal issues.
   */
  warning?: LogLevelHandler | undefined;

  /**
   * Error log handler.
   * Emitted when operations fail.
   */
  error?: LogLevelHandler | undefined;

  /**
   * Include SQL query text in log events.
   * @default true
   */
  includeSql?: boolean | undefined;

  /**
   * Include query parameters in log events.
   * WARNING: May expose sensitive data. Use only in development/staging.
   * @default false
   */
  includeParams?: boolean | undefined;
}

/**
 * Main instrumentation configuration
 */
export interface InstrumentationConfig {
  /**
   * Enable OpenTelemetry tracing.
   * - `true` enables with defaults (includeSql: true, includeParams: false)
   * - Object for custom configuration
   */
  tracing?: true | TracingConfig | undefined;

  /**
   * Enable structured logging.
   * - `true` enables pretty console output for all levels
   * - Object for custom configuration
   */
  logging?: true | LoggingConfig | undefined;
}
