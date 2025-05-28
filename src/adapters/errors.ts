// Error classes for BaseORM adapters

import type {
  ConnectionError as IConnectionError,
  QueryError as IQueryError,
  ValidationError as IValidationError,
  SchemaError as ISchemaError,
} from "./types.js";

export abstract class BaseAdapterError extends Error {
  abstract readonly type: string;
  abstract readonly code: string;
  public readonly timestamp: Date;
  public readonly context?: Record<string, unknown>;
  public readonly cause?: Error;

  constructor(
    message: string,
    context?: Record<string, unknown>,
    cause?: Error
  ) {
    super(message);
    this.name = this.constructor.name;
    this.timestamp = new Date();
    if (context !== undefined) {
      this.context = context;
    }
    if (cause !== undefined) {
      this.cause = cause;
    }

    // Maintain proper stack trace
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, this.constructor);
    }
  }

  toJSON() {
    return {
      type: this.type,
      code: this.code,
      message: this.message,
      timestamp: this.timestamp,
      context: this.context,
      stack: this.stack,
    };
  }
}

export class ConnectionError
  extends BaseAdapterError
  implements IConnectionError
{
  readonly type = "connection" as const;
  public readonly code: string;

  constructor(
    code: string,
    message: string,
    context?: Record<string, unknown>,
    cause?: Error
  ) {
    super(message, context, cause);
    this.code = code;
  }

  static connectionTimeout(timeoutMs: number, host: string) {
    return new ConnectionError(
      "CONNECTION_TIMEOUT",
      `Connection timeout after ${timeoutMs}ms`,
      { timeoutMs, host }
    );
  }

  static authenticationFailed(host: string, username: string) {
    return new ConnectionError(
      "AUTHENTICATION_FAILED",
      "Database authentication failed",
      { host, username }
    );
  }

  static hostUnreachable(host: string, port: number) {
    return new ConnectionError(
      "HOST_UNREACHABLE",
      `Cannot reach database host ${host}:${port}`,
      { host, port }
    );
  }

  static poolExhausted(maxConnections: number) {
    return new ConnectionError(
      "POOL_EXHAUSTED",
      `Connection pool exhausted (max: ${maxConnections})`,
      { maxConnections }
    );
  }

  static sslRequired(host: string) {
    return new ConnectionError(
      "SSL_REQUIRED",
      "SSL connection required but not configured",
      { host }
    );
  }
}

export class QueryError extends BaseAdapterError implements IQueryError {
  readonly type = "query" as const;
  public readonly code: string;
  public readonly query?: string;
  public readonly parameters?: unknown[];

  constructor(
    code: string,
    message: string,
    query?: string,
    parameters?: unknown[],
    context?: Record<string, unknown>,
    cause?: Error
  ) {
    super(message, context, cause);
    this.code = code;
    if (query !== undefined) {
      this.query = query;
    }
    if (parameters !== undefined) {
      this.parameters = parameters;
    }
  }

  static syntaxError(message: string, query: string, parameters?: unknown[]) {
    return new QueryError(
      "SYNTAX_ERROR",
      `SQL syntax error: ${message}`,
      query,
      parameters
    );
  }

  static constraintViolation(
    constraint: string,
    query: string,
    parameters?: unknown[]
  ) {
    return new QueryError(
      "CONSTRAINT_VIOLATION",
      `Constraint violation: ${constraint}`,
      query,
      parameters,
      { constraint }
    );
  }

  static foreignKeyViolation(
    table: string,
    column: string,
    query: string,
    parameters?: unknown[]
  ) {
    return new QueryError(
      "FOREIGN_KEY_VIOLATION",
      `Foreign key constraint violation on ${table}.${column}`,
      query,
      parameters,
      { table, column }
    );
  }

  static uniqueViolation(
    table: string,
    columns: string[],
    query: string,
    parameters?: unknown[]
  ) {
    return new QueryError(
      "UNIQUE_VIOLATION",
      `Unique constraint violation on ${table}(${columns.join(", ")})`,
      query,
      parameters,
      { table, columns }
    );
  }

  static notNullViolation(
    table: string,
    column: string,
    query: string,
    parameters?: unknown[]
  ) {
    return new QueryError(
      "NOT_NULL_VIOLATION",
      `NOT NULL constraint violation on ${table}.${column}`,
      query,
      parameters,
      { table, column }
    );
  }

  static queryTimeout(
    timeoutMs: number,
    query: string,
    parameters?: unknown[]
  ) {
    return new QueryError(
      "QUERY_TIMEOUT",
      `Query timeout after ${timeoutMs}ms`,
      query,
      parameters,
      { timeoutMs }
    );
  }

  static tableNotFound(table: string, query: string, parameters?: unknown[]) {
    return new QueryError(
      "TABLE_NOT_FOUND",
      `Table '${table}' does not exist`,
      query,
      parameters,
      { table }
    );
  }

  static columnNotFound(
    column: string,
    table: string,
    query: string,
    parameters?: unknown[]
  ) {
    return new QueryError(
      "COLUMN_NOT_FOUND",
      `Column '${column}' does not exist in table '${table}'`,
      query,
      parameters,
      { column, table }
    );
  }
}

export class ValidationError
  extends BaseAdapterError
  implements IValidationError
{
  readonly type = "validation" as const;
  public readonly field: string;
  public readonly rule: string;
  public readonly value?: unknown;

  constructor(
    field: string,
    rule: string,
    message: string,
    value?: unknown,
    context?: Record<string, unknown>
  ) {
    super(message, context);
    this.field = field;
    this.rule = rule;
    if (value !== undefined) {
      this.value = value;
    }
  }

  get code(): string {
    return `VALIDATION_${this.rule.toUpperCase()}`;
  }

  static required(field: string) {
    return new ValidationError(
      field,
      "required",
      `Field '${field}' is required`,
      undefined
    );
  }

  static invalidType(
    field: string,
    expectedType: string,
    actualValue: unknown
  ) {
    return new ValidationError(
      field,
      "type",
      `Field '${field}' must be of type ${expectedType}`,
      actualValue,
      { expectedType, actualType: typeof actualValue }
    );
  }

  static invalidValue(
    field: string,
    rule: string,
    value: unknown,
    constraints?: Record<string, unknown>
  ) {
    return new ValidationError(
      field,
      rule,
      `Field '${field}' failed validation rule '${rule}'`,
      value,
      constraints
    );
  }
}

export class SchemaError extends BaseAdapterError implements ISchemaError {
  readonly type = "schema" as const;
  public readonly entity?: string;

  constructor(
    message: string,
    entity?: string,
    context?: Record<string, unknown>,
    cause?: Error
  ) {
    super(message, context, cause);
    if (entity !== undefined) {
      this.entity = entity;
    }
  }

  get code(): string {
    return "SCHEMA_ERROR";
  }

  static modelNotFound(modelName: string) {
    return new SchemaError(
      `Model '${modelName}' not found in schema`,
      modelName
    );
  }

  static fieldNotFound(fieldName: string, modelName: string) {
    return new SchemaError(
      `Field '${fieldName}' not found in model '${modelName}'`,
      modelName,
      { fieldName }
    );
  }

  static relationNotFound(relationName: string, modelName: string) {
    return new SchemaError(
      `Relation '${relationName}' not found in model '${modelName}'`,
      modelName,
      { relationName }
    );
  }

  static circularDependency(models: string[]) {
    return new SchemaError(
      `Circular dependency detected in models: ${models.join(" -> ")}`,
      undefined,
      { models }
    );
  }

  static invalidRelation(from: string, to: string, reason: string) {
    return new SchemaError(
      `Invalid relation from '${from}' to '${to}': ${reason}`,
      undefined,
      { from, to, reason }
    );
  }
}

// Error factory for database-specific error mapping
export class DatabaseErrorMapper {
  static mapPostgresError(
    error: Error,
    query?: string,
    parameters?: unknown[]
  ): BaseAdapterError {
    const pgError = error as any;
    const code = pgError.code;
    const message = pgError.message || error.message;

    switch (code) {
      case "08006": // connection_failure
      case "08001": // sqlclient_unable_to_establish_sqlconnection
        return new ConnectionError(
          "CONNECTION_FAILED",
          message,
          { pgCode: code },
          error
        );

      case "28000": // invalid_authorization_specification
      case "28P01": // invalid_password
        return new ConnectionError(
          "AUTHENTICATION_FAILED",
          message,
          { pgCode: code },
          error
        );

      case "42P01": // undefined_table
        return QueryError.tableNotFound(
          pgError.table || "unknown",
          query || "",
          parameters
        );

      case "42703": // undefined_column
        return QueryError.columnNotFound(
          pgError.column || "unknown",
          pgError.table || "unknown",
          query || "",
          parameters
        );

      case "23505": // unique_violation
        return QueryError.uniqueViolation(
          pgError.table || "unknown",
          [pgError.column || "unknown"],
          query || "",
          parameters
        );

      case "23503": // foreign_key_violation
        return QueryError.foreignKeyViolation(
          pgError.table || "unknown",
          pgError.column || "unknown",
          query || "",
          parameters
        );

      case "23502": // not_null_violation
        return QueryError.notNullViolation(
          pgError.table || "unknown",
          pgError.column || "unknown",
          query || "",
          parameters
        );

      case "42601": // syntax_error
        return QueryError.syntaxError(message, query || "", parameters);

      default:
        return new QueryError(
          "UNKNOWN_ERROR",
          message,
          query,
          parameters,
          { pgCode: code },
          error
        );
    }
  }

  static mapMySqlError(
    error: Error,
    query?: string,
    parameters?: unknown[]
  ): BaseAdapterError {
    const mysqlError = error as any;
    const code = mysqlError.code;
    const errno = mysqlError.errno;
    const message = mysqlError.message || error.message;

    switch (code) {
      case "ECONNREFUSED":
      case "ENOTFOUND":
      case "ETIMEDOUT":
        return new ConnectionError(
          "CONNECTION_FAILED",
          message,
          { mysqlCode: code },
          error
        );

      case "ER_ACCESS_DENIED_ERROR":
        return new ConnectionError(
          "AUTHENTICATION_FAILED",
          message,
          { mysqlCode: code },
          error
        );

      case "ER_NO_SUCH_TABLE":
        return QueryError.tableNotFound(
          mysqlError.table || "unknown",
          query || "",
          parameters
        );

      case "ER_BAD_FIELD_ERROR":
        return QueryError.columnNotFound(
          "unknown",
          "unknown",
          query || "",
          parameters
        );

      case "ER_DUP_ENTRY":
        return QueryError.uniqueViolation(
          "unknown",
          ["unknown"],
          query || "",
          parameters
        );

      case "ER_NO_REFERENCED_ROW_2":
        return QueryError.foreignKeyViolation(
          "unknown",
          "unknown",
          query || "",
          parameters
        );

      case "ER_BAD_NULL_ERROR":
        return QueryError.notNullViolation(
          "unknown",
          "unknown",
          query || "",
          parameters
        );

      case "ER_PARSE_ERROR":
        return QueryError.syntaxError(message, query || "", parameters);

      default:
        return new QueryError(
          "UNKNOWN_ERROR",
          message,
          query,
          parameters,
          { mysqlCode: code, errno },
          error
        );
    }
  }
}

// Utility function to check if an error is an adapter error
export function isAdapterError(error: unknown): error is BaseAdapterError {
  return error instanceof BaseAdapterError;
}

export function isConnectionError(error: unknown): error is ConnectionError {
  return error instanceof ConnectionError;
}

export function isQueryError(error: unknown): error is QueryError {
  return error instanceof QueryError;
}

export function isValidationError(error: unknown): error is ValidationError {
  return error instanceof ValidationError;
}

export function isSchemaError(error: unknown): error is SchemaError {
  return error instanceof SchemaError;
}
