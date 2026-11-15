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

// The words a log's `meta` may carry, and the values they take: a note's
// other keys and values are left out, whoever noted them, so no note can
// bring statement text or a parameter into a log.
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
  const { event, status } = meta;
  return {
    ...(EVENTS.has(event) ? { event } : {}),
    ...(STATUSES.has(status) ? { status } : {}),
  };
}

/**
 * Logger interface for internal use
 */
export interface Logger {
  /** Log an event at its level */
  log(event: LogEvent): void;
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
 * Create a logger instance from config: a level is handled by its own
 * handler, or else by `all`.
 */
export function createLogger(config: LoggingConfig): Logger {
  const handlerOf = (level: LogLevel): LogLevelHandler | undefined =>
    config[level] ?? config.all;

  return Object.freeze({
    log(event: LogEvent): void {
      try {
        const handler = handlerOf(event.level);
        if (!handler) return;
        // The presentation made every field safe to show (`disclosed`, the
        // `parameters` snapshot, `presentLogMetadata`) and left out what the
        // logging channel does not disclose: an event is handed on as it is
        // made, in one shape.
        const presented: LogEvent = {
          level: event.level,
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
          Promise.resolve(handler(presented, defaultLog)).catch(
            () => undefined
          );
        }
      } catch {
        // Logging is observational and cannot alter application behavior.
      }
    },

    isLevelEnabled(level: LogLevel): boolean {
      return handlerOf(level) !== undefined;
    },
  });
}
