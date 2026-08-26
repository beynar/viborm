/**
 * Instrumentation Module
 *
 * OpenTelemetry tracing and structured logging for VibORM.
 */

// Context (main entry point for internal use)
export {
  createInstrumentationContext,
  hasActiveInstrumentation,
  type InstrumentationContext,
  isLoggingActive,
  isTracingActive,
} from "./context";
export { instrumentation } from "./extension";
// Logger
export {
  type CacheEventType,
  createCacheLogEvent,
  createErrorLogEvent,
  createLogger,
  createQueryLogEvent,
  type Logger,
} from "./logger";
// Performance tracker
export {
  createPerfTracker,
  formatPerfReport,
  noopTracker,
  type PerfEntry,
  type PerfEntryReport,
  type PerfReport,
  type PerfTracker,
} from "./perf-tracker";
// Span names and attributes
export {
  ATTR_CACHE_DRIVER,
  ATTR_CACHE_KEY,
  ATTR_CACHE_RESULT,
  ATTR_CACHE_TTL,
  // OTel standard attributes
  ATTR_DB_BATCH_SIZE,
  ATTR_DB_COLLECTION,
  // VibORM custom attributes
  ATTR_DB_DRIVER,
  ATTR_DB_NAMESPACE,
  ATTR_DB_OPERATION_NAME,
  ATTR_DB_QUERY_PARAMETER_PREFIX,
  ATTR_DB_QUERY_SUMMARY,
  ATTR_DB_QUERY_TEXT,
  ATTR_DB_ROWS_RETURNED,
  ATTR_DB_SYSTEM,
  ATTR_ERROR_TYPE,
  ATTR_SERVER_ADDRESS,
  ATTR_SERVER_PORT,
  ATTR_VIBORM_CORRELATION_ID,
  ATTR_VIBORM_WRITE_ATOMICITY,
  ATTR_VIBORM_WRITE_COMMIT_OUTCOME,
  ATTR_VIBORM_WRITE_COMMITTED_SEGMENTS,
  ATTR_VIBORM_WRITE_COMMITTED_WRITE_MEMBERS,
  ATTR_VIBORM_WRITE_COMPLETED_MEMBERS,
  ATTR_VIBORM_WRITE_MEMBER_PATH,
  ATTR_VIBORM_WRITE_STATEMENT_COUNT,
  // Span names
  SPAN_BUILD,
  SPAN_CACHE_CLEAR,
  SPAN_CACHE_DELETE,
  // Cache spans and attributes
  SPAN_CACHE_GET,
  SPAN_CACHE_INVALIDATE,
  SPAN_CACHE_SET,
  SPAN_CONNECT,
  SPAN_DISCONNECT,
  SPAN_EXECUTE,
  SPAN_OPERATION,
  SPAN_PARSE,
  SPAN_RECORD_SERIES_SEGMENT,
  SPAN_TRANSACTION,
  SPAN_VALIDATE,
  type VibORMSpanName,
} from "./spans";
// Tracer wrapper
export {
  createTracerWrapper,
  getNoopTracer,
  type TracerWrapper,
  type TracerWrapperConfig,
  type VibORMSpanOptions,
} from "./tracer";
// Configuration types
export type {
  ExactInstrumentationConfig,
  InstrumentationConfig,
  LogCallback,
  LogEvent,
  LoggingConfig,
  LogLevel,
  TracingConfig,
} from "./types";
