/**
 * Span Names
 *
 * Constants for OpenTelemetry span names following VibORM conventions.
 * Using a prefix pattern similar to Prisma (prisma:*) and Drizzle (drizzle.*).
 */

/**
 * Span name for high-level client operations
 * Created for each client method call (findMany, create, etc.)
 */
export const SPAN_OPERATION = "viborm.operation";

/**
 * Span name for input validation
 * Created during schema validation of operation arguments
 */
export const SPAN_VALIDATE = "viborm.validate";

/**
 * Span name for SQL building
 * Created during query construction
 */
export const SPAN_BUILD = "viborm.build";

/**
 * Span name for query execution (wrapper)
 * Created around the driver execution
 */
export const SPAN_EXECUTE = "viborm.execute";

/**
 * Span name for actual driver-level execution
 * Created for the actual database round-trip
 */
export const SPAN_DRIVER_EXECUTE = "viborm.driver.execute";

/**
 * Span name for result parsing
 * Created during result hydration
 */
export const SPAN_PARSE = "viborm.parse";

/**
 * Span name for transactions
 * Created around transaction boundaries
 */
export const SPAN_TRANSACTION = "viborm.transaction";

/**
 * Span name for connection establishment
 * Created during lazy connection initialization
 */
export const SPAN_CONNECT = "viborm.connect";

/**
 * Span name for connection teardown
 * Created during disconnect
 */
export const SPAN_DISCONNECT = "viborm.disconnect";

/**
 * Type for all valid span names
 */
export type VibORMSpanName =
	| typeof SPAN_OPERATION
	| typeof SPAN_VALIDATE
	| typeof SPAN_BUILD
	| typeof SPAN_EXECUTE
	| typeof SPAN_DRIVER_EXECUTE
	| typeof SPAN_PARSE
	| typeof SPAN_TRANSACTION
	| typeof SPAN_CONNECT
	| typeof SPAN_DISCONNECT;

/**
 * Semantic attribute keys for span attributes
 * Following OTel database semantic conventions where possible
 * @see https://opentelemetry.io/docs/specs/semconv/database/database-spans/
 */

// =============================================================================
// OTel Standard Attributes
// =============================================================================

/** Database system (postgresql, mysql, sqlite) - REQUIRED */
export const ATTR_DB_SYSTEM = "db.system.name";

/** Database name/schema - Conditionally required */
export const ATTR_DB_NAMESPACE = "db.namespace";

/** Table/collection name - Conditionally required */
export const ATTR_DB_COLLECTION = "db.collection.name";

/** Operation name (SELECT, INSERT, findMany, create) - Conditionally required */
export const ATTR_DB_OPERATION_NAME = "db.operation.name";

/** SQL query text - Recommended */
export const ATTR_DB_QUERY_TEXT = "db.query.text";

/** Low cardinality query summary - Recommended */
export const ATTR_DB_QUERY_SUMMARY = "db.query.summary";

/** Batch operation size - Recommended */
export const ATTR_DB_BATCH_SIZE = "db.operation.batch.size";

/** Database server host - Recommended */
export const ATTR_SERVER_ADDRESS = "server.address";

/** Database server port - Conditionally required */
export const ATTR_SERVER_PORT = "server.port";

/** Number of rows returned - Optional */
export const ATTR_DB_ROWS_RETURNED = "db.response.returned_rows";

/** Error type on failure - Conditionally required */
export const ATTR_ERROR_TYPE = "error.type";

// =============================================================================
// VibORM Custom Attributes
// =============================================================================

/** Driver name (postgres, pg, pglite, mysql2, better-sqlite3) */
export const ATTR_DB_DRIVER = "db.system.driver";

/**
 * Query parameter by key or index
 * Usage: `db.query.parameter.0`, `db.query.parameter.userId`
 */
export const ATTR_DB_QUERY_PARAMETER_PREFIX = "db.query.parameter";
