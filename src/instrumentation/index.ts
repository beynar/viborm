/**
 * Instrumentation Module
 *
 * OpenTelemetry tracing and structured logging for VibORM.
 */

// Configuration types
export type {
	InstrumentationConfig,
	LogCallback,
	LogEvent,
	LoggingConfig,
	LogLevel,
	TracingConfig,
} from "./types";

// Span names and attributes
export {
	ATTR_DB_DRIVER,
	ATTR_DB_MODEL,
	ATTR_DB_NESTED_WRITES,
	ATTR_DB_OPERATION,
	ATTR_DB_QUERY_PARAMS,
	ATTR_DB_QUERY_TEXT,
	ATTR_DB_SYSTEM,
	SPAN_BUILD,
	SPAN_CONNECT,
	SPAN_DISCONNECT,
	SPAN_DRIVER_EXECUTE,
	SPAN_EXECUTE,
	SPAN_OPERATION,
	SPAN_PARSE,
	SPAN_TRANSACTION,
	SPAN_VALIDATE,
	type VibORMSpanName,
} from "./spans";

// Tracer wrapper
export {
	createTracerWrapper,
	type TracerWrapper,
	type TracerWrapperConfig,
	type VibORMSpanOptions,
} from "./tracer";

// Logger
export {
	createErrorLogEvent,
	createLogger,
	createQueryLogEvent,
	type Logger,
} from "./logger";

// Context (main entry point for internal use)
export {
	createInstrumentationContext,
	hasActiveInstrumentation,
	isLoggingActive,
	isTracingActive,
	type InstrumentationContext,
} from "./context";
