/**
 * Structured Logger
 *
 * Provides pretty console output or custom callbacks per log level.
 */

import {
  type DiagnosticDisclosure,
  sanitizeAllowedRecord,
  sanitizeDiagnosticParameters,
  sanitizeErrorForLogging,
  type VibORMError,
} from "@errors";
import { isString } from "@validation/value-guards";
import type { Operation } from "../query-engine/types";
import type {
  LogEvent,
  LoggingConfig,
  LogLevel,
  LogLevelHandler,
} from "./types";

// `deprecation` and `notice` carry ORM-authored notice text (constant wording
// around schema and driver names, never user data or query text), so they are
// disclosed on the warning channel unconditionally.
const LOG_META_KEYS = new Set(["deprecation", "event", "notice", "status"]);

/** The log event metadata a logger may present: known keys and values only. */
export function sanitizeLogMetadata(
  value: Record<string, unknown>,
  disclosure?: DiagnosticDisclosure
): Record<string, unknown> {
  return sanitizeAllowedRecord(value, LOG_META_KEYS, disclosure, true);
}

/**
 * Logger interface for internal use
 */
export interface Logger {
  /** Log an event with explicit level */
  log(event: LogEvent): void;
  /** Log a query event */
  query(event: Omit<LogEvent, "level">): void;
  /** Log a cache event */
  cache(event: Omit<LogEvent, "level">): void;
  /** Log a warning event */
  warn(event: Omit<LogEvent, "level">): void;
  /** Log an error event */
  error(event: Omit<LogEvent, "level">): void;
  /** Check if a specific level is enabled */
  isLevelEnabled(level: LogLevel): boolean;
}

/** Console output stays plain in terminals, captured logs and edge runtimes. */
function prettyLog(event: LogEvent): void {
  const time = event.timestamp.toISOString();
  const duration = event.duration === undefined ? "" : `${event.duration}ms`;
  const target = event.model
    ? [event.model, event.operation].filter(Boolean).join(".")
    : (event.operation ?? "");

  // biome-ignore lint/style/useDefaultSwitchClause: LogLevel makes this switch exhaustive.
  switch (event.level) {
    case "query":
      console.log(
        ["[QUERY]", time, target || "query", duration].filter(Boolean).join(" ")
      );
      if (event.sql) console.log(`  ${event.sql}`);
      if (event.params?.length)
        console.log(`  params: ${JSON.stringify(event.params)}`);
      break;
    case "cache":
      console.log(
        "[CACHE]",
        time,
        isString(event.meta?.event) ? event.meta.event : "unknown",
        isString(event.meta?.status) ? `(${event.meta.status})` : ""
      );
      break;
    case "warning":
      console.warn("[WARN]", time, target, formatDiagnostic(event.meta));
      break;
    case "error":
      console.error("[ERROR]", time, target, duration);
      if (event.error) console.error(`  ${event.error.message}`);
      if (event.sql) console.error(`  ${event.sql}`);
      break;
  }
}

function formatDiagnostic(value: unknown): string {
  return value === undefined ? "" : String(JSON.stringify(value));
}

/**
 * Get the handler for a specific level from config
 * Falls back to `all` handler if specific level is not defined
 */
function getHandler(
  config: LoggingConfig,
  level: LogLevel
): LogLevelHandler | undefined {
  const specific = config[level];
  if (specific !== undefined) return specific;
  return config.all;
}

/**
 * Create a logger instance from config
 */
export function createLogger(config: LoggingConfig): Logger {
  const disclosure = Object.freeze({
    includeParams: config.includeParams === true,
    includeSql: config.includeSql === true,
  });
  const handlers: Readonly<Record<LogLevel, LogLevelHandler | undefined>> =
    Object.freeze({
      cache: getHandler(config, "cache"),
      error: getHandler(config, "error"),
      query: getHandler(config, "query"),
      warning: getHandler(config, "warning"),
    });

  function sanitizeEvent(
    event: LogEvent | Omit<LogEvent, "level">,
    level: LogLevel
  ): LogEvent {
    const sanitizedParams =
      disclosure.includeParams && event.params
        ? sanitizeDiagnosticParameters(event.params, disclosure)
        : undefined;
    return {
      level,
      timestamp: event.timestamp,
      duration: event.duration,
      model: event.model,
      operation: event.operation,
      correlationId: event.correlationId,
      sql: disclosure.includeSql ? event.sql : undefined,
      params: sanitizedParams,
      error: event.error
        ? sanitizeErrorForLogging(event.error, disclosure)
        : undefined,
      meta: event.meta
        ? sanitizeLogMetadata(event.meta, disclosure)
        : undefined,
    };
  }

  function emit(
    event: LogEvent | Omit<LogEvent, "level">,
    level: LogLevel
  ): void {
    try {
      const handler = handlers[level];
      if (!handler) return;
      const sanitized = sanitizeEvent(event, level);
      const defaultLog = () => {
        try {
          prettyLog(sanitized);
        } catch {
          // Console output remains observational even when invoked later.
        }
      };
      if (handler === true) {
        defaultLog();
      } else {
        Promise.resolve(handler(sanitized, defaultLog)).catch(() => undefined);
      }
    } catch {
      // Logging is observational and cannot alter application behavior.
    }
  }

  return Object.freeze({
    log(event: LogEvent): void {
      emit(event, event.level);
    },

    query(event: Omit<LogEvent, "level">): void {
      emit(event, "query");
    },

    cache(event: Omit<LogEvent, "level">): void {
      emit(event, "cache");
    },

    warn(event: Omit<LogEvent, "level">): void {
      emit(event, "warning");
    },

    error(event: Omit<LogEvent, "level">): void {
      emit(event, "error");
    },

    isLevelEnabled(level: LogLevel): boolean {
      return handlers[level] !== undefined;
    },
  });
}

/**
 * Helper to create a query log event
 */
export function createQueryLogEvent(params: {
  model?: string | undefined;
  operation?: Operation | string | undefined;
  correlationId?: string | undefined;
  duration?: number | undefined;
  sql?: string | undefined;
  sqlParams?: unknown[] | undefined;
  meta?: Record<string, unknown> | undefined;
}): Omit<LogEvent, "level"> {
  return {
    timestamp: new Date(),
    model: params.model,
    operation: params.operation,
    correlationId: params.correlationId,
    duration: params.duration,
    sql: params.sql,
    params: params.sqlParams,
    meta: params.meta,
  };
}

/**
 * Helper to create an error log event
 */
export function createErrorLogEvent(params: {
  error: Error | VibORMError;
  model?: string | undefined;
  operation?: Operation | string | undefined;
  correlationId?: string | undefined;
  duration?: number | undefined;
  meta?: Record<string, unknown> | undefined;
}): Omit<LogEvent, "level"> {
  return {
    timestamp: new Date(),
    error: params.error,
    model: params.model,
    operation: params.operation,
    correlationId: params.correlationId,
    duration: params.duration,
    meta: params.meta,
  };
}

/**
 * Cache event types
 */
export type CacheEventType = "hit" | "miss" | "revalidate";

/**
 * Helper to create a cache log event
 */
export function createCacheLogEvent(params: {
  event: CacheEventType;
  key: string;
  status?: string | undefined;
  error?: Error | undefined;
}): Omit<LogEvent, "level"> {
  return {
    timestamp: new Date(),
    error: params.error,
    meta: {
      event: params.event,
      status: params.status,
    },
  };
}
