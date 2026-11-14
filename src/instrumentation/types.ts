/**
 * Instrumentation Types
 *
 * Configuration interfaces for OpenTelemetry tracing and structured logging.
 */

import type { DiagnosticDisclosure, VibORMError } from "@errors";

/**
 * Log levels for the logging callback
 */
export type LogLevel = "query" | "cache" | "error";

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
  operation?: string | undefined;
  /** Correlation identifier supplied for this execution */
  correlationId?: string | undefined;
  /** Error if applicable */
  error?: VibORMError | Error | undefined;
  /** SQL query (only if includeSql is enabled) */
  sql?: string | undefined;
  /** Query parameters (only if includeParams is enabled) */
  params?: unknown[] | undefined;
  /** Additional metadata */
  meta?: Record<string, unknown> | undefined;
}

/**
 * A fact an extension notes on a unit (`note`) for the instrumentation to
 * present. It presents what it finds, whoever noted it:
 *
 * - On a unit of an extension's own kind (`work`), a note that names a
 *   `span` when the unit starts (`work`'s `note`) traces the unit as that
 *   span, a root one if `root`, with the `db.*` attributes of `database`,
 *   the call's correlation and `attributes`. `attributes` noted later are set
 *   on it when the unit ends. An attribute given `undefined` is left out,
 *   the correlation's included. The names of a call's own spans
 *   (`viborm.operation`, `viborm.execute`, `viborm.transaction`,
 *   `viborm.connect`, `viborm.disconnect`) are the library's: a note naming
 *   one leaves its unit without a span, except `viborm.operation` as a root
 *   span. An attribute under `db.query.` (statement text, summary,
 *   parameters) is the library's too, and dropped.
 * - On a unit of an extension's own kind, a note that names a `log` level is
 *   logged at that level, when the unit starts if it is there by then, else
 *   when it ends: at `at`, naming `model` and `operation` (the unit's own by
 *   default), with `error` and `meta` presented as every log's are. On a
 *   call's own `operation` unit, only a `cache` log is: its `query` and
 *   `error` logs are the library's account of the call.
 */
export interface InstrumentationNote {
  readonly span?: string | undefined;
  readonly root?: boolean | undefined;
  readonly database?:
    | {
        readonly dialect: string;
        readonly driverName: string;
        readonly namespace?: string | undefined;
      }
    | undefined;
  readonly attributes?:
    | Readonly<Record<string, string | number | boolean | undefined>>
    | undefined;
  readonly log?: LogLevel | undefined;
  readonly at?: number | undefined;
  readonly model?: string | undefined;
  readonly operation?: string | undefined;
  readonly error?: unknown;
  readonly meta?: Readonly<Record<string, unknown>> | undefined;
}

/**
 * Logging callback function signature
 * @param event - The log event
 * @param log - Call this to invoke the default pretty logger
 */
export type LogCallback = (
  event: LogEvent,
  log: () => void
) => void | Promise<void>;

/**
 * Tracing configuration options
 */
export interface TracingConfig {
  /**
   * Include SQL query text in spans.
   * @default false
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
  ignoreSpanTypes?: ReadonlyArray<string | RegExp> | undefined;

  /**
   * The tracer to present spans through, for a runtime that supplies its own:
   * Cloudflare Workers' `tracing` (from `cloudflare:workers`, or `ctx.tracing`)
   * or an OpenTelemetry `Tracer`. When given, VibORM never imports
   * `@opentelemetry/api` itself; when omitted, it auto-detects the api.
   */
  tracer?: SpanTracer | undefined;
}

/**
 * The span members VibORM uses on a span a handed tracer creates. An
 * OpenTelemetry `Span` and the Cloudflare Workers runtime span both have
 * `setAttribute` and `end`; `setStatus` and `recordException` are used when
 * the span has them (the Workers span has no `setStatus`).
 */
export interface TracingSpan {
  setAttribute(key: string, value: string | number | boolean): unknown;
  end(): unknown;
  setStatus?(status: { code: number; message?: string }): unknown;
  recordException?(exception: Error): unknown;
}

/**
 * A tracer VibORM can present spans through: the two-argument
 * `startActiveSpan(name, fn)` that an OpenTelemetry `Tracer` and Cloudflare
 * Workers' `tracing` both implement. The span is active while `fn` runs;
 * VibORM ends it when the operation settles.
 */
export interface SpanTracer {
  startActiveSpan<T>(name: string, fn: (span: TracingSpan) => T): T;
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
 *   // cache: omitted = disabled
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
   * Cache log handler.
   * Emitted for cache operations (hit, miss, revalidate).
   */
  cache?: LogLevelHandler | undefined;

  /**
   * Error log handler.
   * Emitted when operations fail.
   */
  error?: LogLevelHandler | undefined;

  /**
   * Include SQL query text in log events.
   * @default false
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
   * Control SQL and parameter disclosure on thrown/serialized errors.
   * This policy is independent from logging and tracing disclosure.
   * Both fields default to false.
   */
  diagnostics?: DiagnosticDisclosure | undefined;

  /**
   * Enable OpenTelemetry tracing.
   * - `true` enables with private defaults (includeSql: false, includeParams: false)
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

type NoExtraInstrumentationKeys<Given, Allowed> = Given extends object
  ? Record<Exclude<keyof Given, keyof Allowed>, never>
  : unknown;

/** Exact public instrumentation input, including each nested configuration bag. */
export type ExactInstrumentationConfig<Given> = NoExtraInstrumentationKeys<
  Given,
  InstrumentationConfig
> & {
  [Key in keyof Given]: Key extends "tracing"
    ? NoExtraInstrumentationKeys<Given[Key], TracingConfig>
    : Key extends "logging"
      ? NoExtraInstrumentationKeys<Given[Key], LoggingConfig>
      : Key extends "diagnostics"
        ? NoExtraInstrumentationKeys<Given[Key], DiagnosticDisclosure>
        : unknown;
};
