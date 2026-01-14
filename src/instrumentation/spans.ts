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
 * Semantic attribute keys following OpenTelemetry conventions
 * @see https://opentelemetry.io/docs/specs/semconv/database/
 */
export const ATTR_DB_SYSTEM = "db.system.name";
export const ATTR_DB_QUERY_TEXT = "db.query.text";
export const ATTR_DB_QUERY_PARAMS = "db.query.params";
export const ATTR_VIBORM_MODEL = "viborm.model";
export const ATTR_VIBORM_OPERATION = "viborm.operation";
export const ATTR_VIBORM_NESTED_WRITES = "viborm.nested_writes";
