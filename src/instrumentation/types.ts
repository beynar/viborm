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
	error?: VibORMError | undefined;
	/** SQL query (only if includeSql is enabled) */
	sql?: string | undefined;
	/** Query parameters (only if includeSql is enabled) */
	params?: unknown[] | undefined;
	/** Additional metadata */
	meta?: Record<string, unknown> | undefined;
}

/**
 * Logging callback function signature
 */
export type LogCallback = (event: LogEvent) => void;

/**
 * Tracing configuration options
 */
export interface TracingConfig {
	/**
	 * Include SQL query in spans.
	 * WARNING: May expose sensitive data. Use only in development/staging.
	 * @default false
	 */
	includeSql?: boolean | undefined;

	/**
	 * Span names to ignore (string or regex patterns)
	 * Similar to Prisma's ignoreSpanTypes
	 */
	ignoreSpanTypes?: Array<string | RegExp> | undefined;
}

/**
 * Logging configuration options
 */
export interface LoggingConfig {
	/**
	 * Log levels to emit. 'all' enables all levels.
	 * @default ['error']
	 */
	levels: LogLevel[] | "all";

	/**
	 * Callback function to receive log events
	 */
	callback: LogCallback;

	/**
	 * Include SQL in log events (opt-in for security)
	 * @default false
	 */
	includeSql?: boolean | undefined;
}

/**
 * Main instrumentation configuration
 */
export interface InstrumentationConfig {
	/**
	 * Enable OpenTelemetry tracing (explicit opt-in)
	 */
	tracing?: TracingConfig | undefined;

	/**
	 * Enable structured logging
	 */
	logging?: LoggingConfig | undefined;
}
