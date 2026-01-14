/**
 * Tracer Wrapper
 *
 * Wraps OpenTelemetry API with graceful fallback when not available.
 * Follows Drizzle's pattern: optional dependency, no-op when unavailable.
 */

import type { VibORMSpanName } from "./spans";
import {
	ATTR_DB_QUERY_PARAMS,
	ATTR_DB_QUERY_TEXT,
} from "./spans";

/**
 * OpenTelemetry types (imported dynamically)
 */
type OTelAPI = typeof import("@opentelemetry/api");
type Span = import("@opentelemetry/api").Span;
type Tracer = import("@opentelemetry/api").Tracer;
type SpanKind = import("@opentelemetry/api").SpanKind;
type Attributes = import("@opentelemetry/api").Attributes;

// Dynamic import holder - starts undefined until first use
let otel: OTelAPI | undefined | null = undefined;
let cachedTracer: Tracer | undefined;

// Package version for tracer identification
const TRACER_NAME = "viborm";
const TRACER_VERSION = "0.1.0";

/**
 * Try to load OpenTelemetry API
 * Returns undefined if not available, null if load was attempted and failed
 */
async function tryLoadOtel(): Promise<OTelAPI | null> {
	// Already loaded or failed
	if (otel !== undefined) {
		return otel;
	}

	try {
		otel = await import("@opentelemetry/api");
		return otel;
	} catch (err: unknown) {
		const error = err as { code?: string };
		// Expected errors when module not installed
		if (
			error.code === "MODULE_NOT_FOUND" ||
			error.code === "ERR_MODULE_NOT_FOUND"
		) {
			otel = null;
			return null;
		}
		// Unexpected error - rethrow
		throw err;
	}
}

/**
 * Synchronously check if OpenTelemetry is available
 * Only returns true if OTel was previously loaded successfully
 */
function isOtelLoaded(): boolean {
	return otel !== undefined && otel !== null;
}

/**
 * Extended span options with VibORM-specific attributes
 */
export interface VibORMSpanOptions {
	/** Span name from the predefined constants */
	name: VibORMSpanName;
	/** Span kind (default: INTERNAL) */
	kind?: SpanKind | undefined;
	/** Additional attributes */
	attributes?: Attributes | undefined;
	/** SQL info (only included if tracer config has includeSql enabled) */
	sql?: { query: string; params?: unknown[] } | undefined;
}

/**
 * Configuration for tracer wrapper
 */
export interface TracerWrapperConfig {
	/** Include SQL in span attributes */
	includeSql?: boolean | undefined;
	/** Span names to ignore */
	ignoreSpanTypes?: Array<string | RegExp> | undefined;
}

/**
 * Tracer wrapper interface
 */
export interface TracerWrapper {
	/**
	 * Start an active span and execute callback within it
	 * Falls back to direct execution if OTel unavailable
	 */
	startActiveSpan<T>(
		options: VibORMSpanOptions,
		fn: (span?: Span) => T | Promise<T>,
	): Promise<T>;

	/**
	 * Synchronous version for non-async operations
	 * Only works if OTel was pre-loaded, otherwise no-op
	 */
	startActiveSpanSync<T>(
		options: VibORMSpanOptions,
		fn: (span?: Span) => T,
	): T;

	/**
	 * Check if tracing is enabled (OTel loaded and configured)
	 */
	isEnabled(): boolean;
}

/**
 * Create a tracer wrapper instance
 */
export function createTracerWrapper(
	config?: TracerWrapperConfig,
): TracerWrapper {
	const ignorePatterns = config?.ignoreSpanTypes ?? [];
	const includeSql = config?.includeSql ?? false;

	function shouldIgnoreSpan(name: string): boolean {
		return ignorePatterns.some((pattern) =>
			typeof pattern === "string" ? pattern === name : pattern.test(name),
		);
	}

	function buildAttributes(
		options: VibORMSpanOptions,
		api: OTelAPI,
	): Attributes {
		const attrs: Attributes = { ...options.attributes };

		// Only include SQL if explicitly enabled
		if (includeSql && options.sql) {
			attrs[ATTR_DB_QUERY_TEXT] = options.sql.query;
			if (options.sql.params) {
				attrs[ATTR_DB_QUERY_PARAMS] = JSON.stringify(options.sql.params);
			}
		}

		return attrs;
	}

	return {
		async startActiveSpan<T>(
			options: VibORMSpanOptions,
			fn: (span?: Span) => T | Promise<T>,
		): Promise<T> {
			const api = await tryLoadOtel();

			// No-op path: OTel not available
			if (!api) {
				return fn();
			}

			// Check if span should be ignored
			if (shouldIgnoreSpan(options.name)) {
				return fn();
			}

			// Get or create tracer
			if (!cachedTracer) {
				cachedTracer = api.trace.getTracer(TRACER_NAME, TRACER_VERSION);
			}

			const attributes = buildAttributes(options, api);
			const kind = options.kind ?? api.SpanKind.INTERNAL;

			return cachedTracer.startActiveSpan(
				options.name,
				{ kind, attributes },
				async (span) => {
					try {
						const result = await fn(span);
						span.setStatus({ code: api.SpanStatusCode.OK });
						return result;
					} catch (error) {
						span.setStatus({
							code: api.SpanStatusCode.ERROR,
							message: error instanceof Error ? error.message : "Unknown error",
						});
						if (error instanceof Error) {
							span.recordException(error);
						}
						throw error;
					} finally {
						span.end();
					}
				},
			);
		},

		startActiveSpanSync<T>(
			options: VibORMSpanOptions,
			fn: (span?: Span) => T,
		): T {
			// For sync operations, we can't await the dynamic import
			// This requires OTel to be pre-loaded or falls back to no-op
			if (!isOtelLoaded() || !otel) {
				return fn();
			}

			if (shouldIgnoreSpan(options.name)) {
				return fn();
			}

			if (!cachedTracer) {
				cachedTracer = otel.trace.getTracer(TRACER_NAME, TRACER_VERSION);
			}

			const attributes = buildAttributes(options, otel);
			const kind = options.kind ?? otel.SpanKind.INTERNAL;

			return cachedTracer.startActiveSpan(
				options.name,
				{ kind, attributes },
				(span) => {
					try {
						const result = fn(span);
						span.setStatus({ code: otel!.SpanStatusCode.OK });
						return result;
					} catch (error) {
						span.setStatus({
							code: otel!.SpanStatusCode.ERROR,
							message: error instanceof Error ? error.message : "Unknown error",
						});
						if (error instanceof Error) {
							span.recordException(error);
						}
						throw error;
					} finally {
						span.end();
					}
				},
			);
		},

		isEnabled(): boolean {
			return isOtelLoaded();
		},
	};
}
