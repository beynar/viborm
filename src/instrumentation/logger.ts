/**
 * Structured Logger
 *
 * Provides pretty console output or custom callbacks per log level.
 */

import type { VibORMError } from "../errors";
import type { Operation } from "../query-engine/types";
import type {
	LogCallback,
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
} as const;

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
			const parts = [time, target, duration].filter(Boolean);
			console.log(parts.join(" "));
			if (event.sql) {
				console.log(`  ${colors.dim}${event.sql}${colors.reset}`);
			}
			if (event.params?.length) {
				console.log(
					`  ${colors.dim}params: ${JSON.stringify(event.params)}${colors.reset}`,
				);
			}
			break;
		}
		case "warning": {
			const prefix = `${colors.yellow}WARN${colors.reset}`;
			const target = event.model
				? `${colors.cyan}${event.model}${colors.reset}`
				: "";
			console.warn(time, prefix, target, event.meta ?? "");
			break;
		}
		case "error": {
			const prefix = `${colors.red}ERROR${colors.reset}`;
			const target = event.model
				? `${colors.cyan}${event.model}${colors.reset}.${colors.magenta}${event.operation}${colors.reset}`
				: "";
			console.error(time, prefix, target, duration);
			if (event.error) {
				console.error(`  ${colors.red}${event.error.message}${colors.reset}`);
			}
			if (event.sql) {
				console.error(`  ${colors.dim}${event.sql}${colors.reset}`);
			}
			break;
		}
	}
}

/**
 * Get the handler for a specific level from config
 * Falls back to `all` handler if specific level is not defined
 */
function getHandler(
	config: LoggingConfig,
	level: LogLevel,
): LogLevelHandler | undefined {
	switch (level) {
		case "query":
			return config.query ?? config.all;
		case "warning":
			return config.warning ?? config.all;
		case "error":
			return config.error ?? config.all;
	}
}

/**
 * Create a logger instance from config
 */
export function createLogger(config: LoggingConfig): Logger {
	const includeSql = config.includeSql ?? true; // SQL enabled by default
	const includeParams = config.includeParams ?? false; // Params disabled by default

	function sanitizeEvent(event: LogEvent): LogEvent {
		const result = { ...event };

		// Strip SQL if not enabled
		if (!includeSql) {
			delete result.sql;
		}

		// Strip params if not enabled
		if (!includeParams) {
			delete result.params;
		}

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
	error: VibORMError;
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
