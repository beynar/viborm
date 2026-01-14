/**
 * Structured Logger
 *
 * Wraps the user-provided logging callback with level filtering.
 */

import type { VibORMError } from "../errors";
import type { Operation } from "../query-engine/types";
import type { LogCallback, LogEvent, LoggingConfig, LogLevel } from "./types";

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
 * Create a logger instance from config
 */
export function createLogger(config: LoggingConfig): Logger {
	const enabledLevels: Set<LogLevel> =
		config.levels === "all"
			? new Set(["query", "warning", "error"])
			: new Set(config.levels);

	const includeSql = config.includeSql ?? false;

	function shouldLog(level: LogLevel): boolean {
		return enabledLevels.has(level);
	}

	function sanitizeEvent(event: LogEvent): LogEvent {
		// Strip SQL if not enabled
		if (!includeSql) {
			const { sql, params, ...rest } = event;
			return rest as LogEvent;
		}
		return event;
	}

	return {
		log(event: LogEvent): void {
			if (shouldLog(event.level)) {
				config.callback(sanitizeEvent(event));
			}
		},

		query(event: Omit<LogEvent, "level">): void {
			this.log({ ...event, level: "query" });
		},

		warn(event: Omit<LogEvent, "level">): void {
			this.log({ ...event, level: "warning" });
		},

		error(event: Omit<LogEvent, "level">): void {
			this.log({ ...event, level: "error" });
		},

		isLevelEnabled(level: LogLevel): boolean {
			return shouldLog(level);
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
