/**
 * Structured Logger
 *
 * Provides pretty console output or custom callbacks per log level.
 */

import type {
  LogEvent,
  LoggingConfig,
  LogLevel,
  LogLevelHandler,
} from "./types";

// The words a log's `meta` may carry, and the values `event` and `status`
// take: a note's other keys and values are left out, whoever noted them, so
// no note can bring statement text or a parameter into a log. `deprecation`
// and `notice` carry notice text, constant wording an extension writes.
const EVENTS: ReadonlySet<unknown> = new Set([
  "bypass",
  "hit",
  "miss",
  "revalidate",
]);
const STATUSES: ReadonlySet<unknown> = new Set([
  "cache-set-failed",
  "error",
  "fresh",
  "stale",
  "start",
  "success",
]);

/** The log metadata a logger presents: known keys and values only. */
export function presentLogMetadata(
  meta: Readonly<Record<string, unknown>>
): Record<string, unknown> {
  const { deprecation, event, notice, status } = meta;
  return {
    ...(typeof deprecation === "string" ? { deprecation } : {}),
    ...(EVENTS.has(event) ? { event } : {}),
    ...(typeof notice === "string" ? { notice } : {}),
    ...(STATUSES.has(status) ? { status } : {}),
  };
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
        typeof event.meta?.event === "string" ? event.meta.event : "unknown",
        typeof event.meta?.status === "string" ? `(${event.meta.status})` : ""
      );
      break;
    case "error":
      console.error("[ERROR]", time, target, duration);
      if (event.error) console.error(`  ${event.error.message}`);
      if (event.sql) console.error(`  ${event.sql}`);
      break;
  }
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
  const handlers: Readonly<Record<LogLevel, LogLevelHandler | undefined>> =
    Object.freeze({
      cache: getHandler(config, "cache"),
      error: getHandler(config, "error"),
      query: getHandler(config, "query"),
    });

  // The presentation made every field safe to show (`disclosed`, the
  // `parameters` snapshot, `presentLogMetadata`) and left out what the
  // logging channel does not disclose: an event is handed on as it is made.
  function eventAt(
    event: LogEvent | Omit<LogEvent, "level">,
    level: LogLevel
  ): LogEvent {
    return {
      level,
      timestamp: event.timestamp,
      duration: event.duration,
      model: event.model,
      operation: event.operation,
      correlationId: event.correlationId,
      sql: event.sql,
      params: event.params,
      error: event.error,
      meta: event.meta,
    };
  }

  function emit(
    event: LogEvent | Omit<LogEvent, "level">,
    level: LogLevel
  ): void {
    try {
      const handler = handlers[level];
      if (!handler) return;
      const presented = eventAt(event, level);
      const defaultLog = () => {
        try {
          prettyLog(presented);
        } catch {
          // Console output remains observational even when invoked later.
        }
      };
      if (handler === true) {
        defaultLog();
      } else {
        Promise.resolve(handler(presented, defaultLog)).catch(() => undefined);
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

    error(event: Omit<LogEvent, "level">): void {
      emit(event, "error");
    },

    isLevelEnabled(level: LogLevel): boolean {
      return handlers[level] !== undefined;
    },
  });
}
