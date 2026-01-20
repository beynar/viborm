/**
 * Structured Logger
 *
 * Provides pretty console output or custom callbacks per log level.
 */

import type { VibORMError } from "@errors";
import type { Operation } from "../query-engine/types";
import type {
  LogEvent,
  LoggingConfig,
  LogLevel,
  LogLevelHandler,
} from "./types";

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

/**
 * ANSI color codes for pretty output
 */
const colors = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  cyan: "\x1b[36m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  magenta: "\x1b[35m",
  blue: "\x1b[34m",
} as const;

const backgrounds = {
  bgRed: (...args: string[]) => `\x1b[41m${args.join(" ")}\x1b[0m`,
  bgGreen: (...args: string[]) => `\x1b[42m${args.join(" ")}\x1b[0m`,
  bgYellow: (...args: string[]) => `\x1b[43m${args.join(" ")}\x1b[0m`,
  bgBlue: (...args: string[]) => `\x1b[44m${args.join(" ")}\x1b[0m`,
};

/**
 * Format duration with color based on speed
 */
function formatDuration(ms: number | undefined): string {
  if (ms === undefined) return "";
  const color = ms < 10 ? colors.green : ms < 100 ? colors.yellow : colors.red;
  return `${color}${ms}ms${colors.reset}`;
}

/**
 * Default pretty console formatter
 */
function prettyLog(event: LogEvent): void {
  const time = `${colors.dim}${event.timestamp.toISOString()}${colors.reset}`;
  const duration = formatDuration(event.duration);

  switch (event.level) {
    case "query": {
      const target = event.model
        ? `${colors.cyan}${event.model}${colors.reset}.${colors.magenta}${event.operation}${colors.reset}`
        : `${colors.magenta}${event.operation ?? "query"}${colors.reset}`;
      const prefix = `${backgrounds.bgBlue(`${colors.blue}[QUERY]${colors.reset}`)}`;
      const parts = [prefix, time, target, duration].filter(Boolean);
      console.log(parts.join(" "));
      if (event.sql) {
        console.log(`  ${colors.dim}${event.sql}${colors.reset}`);
      }
      if (event.params?.length) {
        console.log(
          `  ${colors.dim}params: ${JSON.stringify(event.params)}${colors.reset}`
        );
      }
      break;
    }
    case "cache": {
      const prefix = `${backgrounds.bgGreen(`${colors.green}[CACHE]${colors.reset}`)}`;
      const meta = event.meta as
        | { event?: string; status?: string; key?: string }
        | undefined;
      const cacheEvent = meta?.event ?? "unknown";
      const status = meta?.status ? `(${meta.status})` : "";
      const key = meta?.key ? `${colors.dim}${meta.key}${colors.reset}` : "";
      console.log(
        prefix,
        time,
        `${colors.magenta}${cacheEvent}${colors.reset}`,
        status,
        key
      );
      break;
    }
    case "warning": {
      const prefix = `${colors.yellow}${backgrounds.bgYellow("[WARN]")}${colors.reset}`;
      const target = event.model
        ? `${colors.cyan}${event.model}${colors.reset}`
        : "";
      console.warn(prefix, time, target, event.meta ?? "");
      break;
    }
    case "error": {
      const prefix = `${colors.red}${backgrounds.bgRed("[ERROR]")}${colors.reset}`;
      const target = event.model
        ? `${colors.cyan}${event.model}${colors.reset}.${colors.magenta}${event.operation}${colors.reset}`
        : "";
      console.error(`\x1b[41m${prefix}\x1b[0m`, time, target, duration);
      if (event.error) {
        console.error(`  ${colors.red}${event.error.message}${colors.reset}`);
      }
      if (event.sql) {
        console.error(`  ${colors.dim}${event.sql}${colors.reset}`);
      }
      break;
    }
    default: {
      //
    }
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
  switch (level) {
    case "query":
      return config.query ?? config.all;
    case "cache":
      return config.cache ?? config.all;
    case "warning":
      return config.warning ?? config.all;
    case "error":
      return config.error ?? config.all;
    default: {
      //
    }
  }
}

/**
 * Create a logger instance from config
 */
export function createLogger(config: LoggingConfig): Logger {
  const includeSql = config.includeSql ?? true; // SQL enabled by default
  const includeParams = config.includeParams ?? false; // Params disabled by default

  function sanitizeEvent(event: LogEvent): LogEvent {
    const result = {
      ...event,
      sql: includeSql ? event.sql : undefined,
      params: includeParams ? event.params : undefined,
    };

    return result;
  }

  function emit(event: LogEvent): void {
    const handler = getHandler(config, event.level);
    if (!handler) return;

    const sanitized = sanitizeEvent(event);

    // Create the default logger function to pass to callbacks
    const defaultLog = () => prettyLog(sanitized);

    if (handler === true) {
      prettyLog(sanitized);
    } else {
      handler(sanitized, defaultLog);
    }
  }

  return {
    log(event: LogEvent): void {
      emit(event);
    },

    query(event: Omit<LogEvent, "level">): void {
      emit({ ...event, level: "query" });
    },

    cache(event: Omit<LogEvent, "level">): void {
      emit({ ...event, level: "cache" });
    },

    warn(event: Omit<LogEvent, "level">): void {
      emit({ ...event, level: "warning" });
    },

    error(event: Omit<LogEvent, "level">): void {
      emit({ ...event, level: "error" });
    },

    isLevelEnabled(level: LogLevel): boolean {
      return getHandler(config, level) !== undefined;
    },
  };
}

/**
 * Helper to create a query log event
 */
export function createQueryLogEvent(params: {
  model?: string | undefined;
  operation?: Operation | undefined;
  duration?: number | undefined;
  sql?: string | undefined;
  sqlParams?: unknown[] | undefined;
  meta?: Record<string, unknown> | undefined;
}): Omit<LogEvent, "level"> {
  return {
    timestamp: new Date(),
    model: params.model,
    operation: params.operation,
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
  operation?: Operation | undefined;
  duration?: number | undefined;
  meta?: Record<string, unknown> | undefined;
}): Omit<LogEvent, "level"> {
  return {
    timestamp: new Date(),
    error: params.error,
    model: params.model,
    operation: params.operation,
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
      key: params.key,
      status: params.status,
    },
  };
}
