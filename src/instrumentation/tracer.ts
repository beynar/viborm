/**
 * Tracer Wrapper
 *
 * Wraps OpenTelemetry API with graceful fallback when not available.
 * Follows Drizzle's pattern: optional dependency, no-op when unavailable.
 */

import type { VibORMSpanName } from "./spans";
import {
	ATTR_DB_QUERY_PARAMETER_PREFIX,
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

// Package version for tracer identification
const TRACER_NAME = "viborm";
const TRACER_VERSION = "0.1.0";

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
	/** Include SQL query text in span attributes (default: true) */
	includeSql?: boolean | undefined;
	/** Include query parameters in span attributes (default: false) */
	includeParams?: boolean | undefined;
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
 *
 * All mutable state is scoped to this instance to support serverless environments.
 */
export function createTracerWrapper(
	config?: TracerWrapperConfig,
): TracerWrapper {
	const ignorePatterns = config?.ignoreSpanTypes ?? [];
	const includeSql = config?.includeSql ?? true; // SQL enabled by default
	const includeParams = config?.includeParams ?? false; // Params disabled by default

	// Instance-scoped state (not module-level) for serverless compatibility
	let otel: OTelAPI | null = null;
	let otelLoadAttempted = false;
	let tracer: Tracer | null = null;

	async function tryLoadOtel(): Promise<OTelAPI | null> {
		if (otelLoadAttempted) return otel;
		otelLoadAttempted = true;

		try {
			otel = await import("@opentelemetry/api");
			return otel;
		} catch (err: unknown) {
			const error = err as { code?: string };
			if (
				error.code === "MODULE_NOT_FOUND" ||
				error.code === "ERR_MODULE_NOT_FOUND"
			) {
				return null;
			}
			throw err;
		}
	}

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

		if (options.sql) {
			if (includeSql) {
				attrs[ATTR_DB_QUERY_TEXT] = options.sql.query;
			}
			if (includeParams && options.sql.params) {
				// Use individual parameter attributes per OTel spec
				// db.query.parameter.0, db.query.parameter.1, etc.
				for (let i = 0; i < options.sql.params.length; i++) {
					const value = options.sql.params[i];
					attrs[`${ATTR_DB_QUERY_PARAMETER_PREFIX}.${i}`] =
						typeof value === "string" ? value : JSON.stringify(value);
				}
			}
		}

		return attrs;
	}

	function getTracer(api: OTelAPI): Tracer {
		if (!tracer) {
			tracer = api.trace.getTracer(TRACER_NAME, TRACER_VERSION);
		}
		return tracer;
	}

	return {
		async startActiveSpan<T>(
			options: VibORMSpanOptions,
			fn: (span?: Span) => T | Promise<T>,
		): Promise<T> {
			const api = await tryLoadOtel();
			if (!api || shouldIgnoreSpan(options.name)) {
				return fn();
			}

			const attributes = buildAttributes(options, api);
			const kind = options.kind ?? api.SpanKind.INTERNAL;

			return getTracer(api).startActiveSpan(
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
			// Sync version requires OTel to be pre-loaded
			if (!otel || shouldIgnoreSpan(options.name)) {
				return fn();
			}

			const attributes = buildAttributes(options, otel);
			const kind = options.kind ?? otel.SpanKind.INTERNAL;

			return getTracer(otel).startActiveSpan(
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
			return otel !== null;
		},
	};
}
