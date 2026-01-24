/**
 * Instrumentation Exports
 *
 * OpenTelemetry tracing and structured logging configuration.
 * Import from "viborm/instrumentation"
 */

// Span names (for custom instrumentation)
// Attribute names (for custom instrumentation)
export {
  // Cache attributes
  ATTR_CACHE_DRIVER,
  ATTR_CACHE_KEY,
  ATTR_CACHE_RESULT,
  ATTR_CACHE_TTL,
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
  // OTel standard attributes
  ATTR_DB_SYSTEM,
  ATTR_ERROR_TYPE,
  ATTR_SERVER_ADDRESS,
  ATTR_SERVER_PORT,
  SPAN_BUILD,
  SPAN_CACHE_CLEAR,
  SPAN_CACHE_DELETE,
  SPAN_CACHE_GET,
  SPAN_CACHE_INVALIDATE,
  SPAN_CACHE_SET,
  SPAN_CONNECT,
  SPAN_DISCONNECT,
  SPAN_EXECUTE,
  SPAN_OPERATION,
  SPAN_PARSE,
  SPAN_TRANSACTION,
  SPAN_VALIDATE,
  type VibORMSpanName,
} from "./spans";
// Configuration types
export type {
  InstrumentationConfig,
  LogCallback,
  LogEvent,
  LoggingConfig,
  LogLevel,
  TracingConfig,
} from "./types";
