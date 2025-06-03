import { BuilderContext } from "../types";

/**
 * Query Parser Error System
 *
 * This module provides a comprehensive error handling system for the query parser.
 * It defines specific error types, provides helpful error messages, and includes
 * context information for debugging and user feedback.
 *
 * ERROR CATEGORIES:
 * - Schema errors: Model, field, or relation not found
 * - Validation errors: Invalid data or operation parameters
 * - Type errors: Type mismatches or invalid type operations
 * - Security errors: Potentially dangerous operations
 * - Performance errors: Operations that could cause performance issues
 * - Configuration errors: Invalid configuration or setup
 *
 * FEATURES:
 * - Detailed error messages with suggestions
 * - Context information for debugging
 * - Error codes for programmatic handling
 * - Stack trace preservation
 * - Internationalization support (future)
 * - Error aggregation and reporting
 *
 * ARCHITECTURE:
 * - Hierarchical error types for specific handling
 * - Context-aware error messages
 * - Extensible error system for custom errors
 * - Integration with validation system
 * - Proper error propagation and handling
 */

/**
 * Base QueryParserError class
 *
 * All query parser errors extend this base class
 */
export abstract class QueryParserError extends Error {
  abstract readonly code: string;
  abstract readonly category: ErrorCategory;

  public readonly context?: BuilderContext | undefined;
  public readonly component?: string | undefined;
  public readonly suggestions: string[] = [];
  public readonly timestamp: Date;

  constructor(
    message: string,
    context?: BuilderContext | undefined,
    component?: string | undefined,
    suggestions: string[] = []
  ) {
    super(message);
    this.name = this.constructor.name;
    this.context = context;
    this.component = component;
    this.suggestions = suggestions;
    this.timestamp = new Date();

    // Maintain proper stack trace
    if (
      "captureStackTrace" in Error &&
      Error.captureStackTrace &&
      typeof Error.captureStackTrace === "function"
    ) {
      Error.captureStackTrace(this, this.constructor);
    }
  }

  /**
   * Get formatted error message with context
   */
  getFormattedMessage(): string {
    let message = this.message;

    if (this.context) {
      message += `\n  Model: ${this.context.model.name}`;
      message += `\n  Operation: ${this.context.baseOperation}`;
      if (this.context.field) {
        message += `\n  Field: [field object]`;
      }
      if (this.context.relation) {
        message += `\n  Relation: [relation object]`;
      }
    }

    if (this.component) {
      message += `\n  Component: ${this.component}`;
    }

    if (this.suggestions.length > 0) {
      message += `\n\nSuggestions:`;
      this.suggestions.forEach((suggestion, index) => {
        message += `\n  ${index + 1}. ${suggestion}`;
      });
    }

    return message;
  }

  /**
   * Convert error to JSON for logging/reporting
   */
  toJSON(): object {
    return {
      name: this.name,
      code: this.code,
      category: this.category,
      message: this.message,
      context: this.context
        ? {
            model: this.context.model.name,
            operation: this.context.baseOperation,
            field: this.context.field ? "[field object]" : undefined,
            relation: this.context.relation ? "[relation object]" : undefined,
            alias: this.context.alias,
          }
        : undefined,
      component: this.component,
      suggestions: this.suggestions,
      timestamp: this.timestamp.toISOString(),
    };
  }
}

/**
 * Error categories for classification
 */
export enum ErrorCategory {
  SCHEMA = "SCHEMA",
  VALIDATION = "VALIDATION",
  TYPE = "TYPE",
  SECURITY = "SECURITY",
  PERFORMANCE = "PERFORMANCE",
  CONFIGURATION = "CONFIGURATION",
  INTERNAL = "INTERNAL",
}

/**
 * Schema-related errors
 */
export abstract class SchemaError extends QueryParserError {
  override readonly category = ErrorCategory.SCHEMA;
  abstract override readonly code: string;
}

export class ModelNotFoundError extends SchemaError {
  readonly code = "MODEL_NOT_FOUND";

  constructor(modelName: string, context?: BuilderContext, component?: string) {
    super(`Model '${modelName}' not found`, context, component, [
      `Check if the model name is spelled correctly`,
      `Ensure the model is properly defined in your schema`,
      `Verify the model is exported and accessible`,
    ]);
  }
}

export class FieldNotFoundError extends SchemaError {
  readonly code = "FIELD_NOT_FOUND";

  constructor(
    fieldName: string,
    modelName: string,
    context?: BuilderContext,
    component?: string
  ) {
    super(
      `Field '${fieldName}' not found on model '${modelName}'`,
      context,
      component,
      [
        `Check if the field name is spelled correctly`,
        `Verify the field is defined in the model schema`,
        `Use 'select' or 'include' to specify which fields to retrieve`,
      ]
    );
  }
}

export class RelationNotFoundError extends SchemaError {
  readonly code = "RELATION_NOT_FOUND";

  constructor(
    relationName: string,
    modelName: string,
    context?: BuilderContext,
    component?: string
  ) {
    super(
      `Relation '${relationName}' not found on model '${modelName}'`,
      context,
      component,
      [
        `Check if the relation name is spelled correctly`,
        `Verify the relation is defined in the model schema`,
        `Ensure both sides of the relation are properly configured`,
      ]
    );
  }
}

/**
 * Validation-related errors
 */
export abstract class ValidationError extends QueryParserError {
  override readonly category = ErrorCategory.VALIDATION;
  abstract override readonly code: string;
}

export class InvalidOperationError extends ValidationError {
  readonly code = "INVALID_OPERATION";

  constructor(
    operation: string,
    reason: string,
    context?: BuilderContext,
    component?: string
  ) {
    super(`Invalid operation '${operation}': ${reason}`, context, component, [
      `Check the operation documentation for valid usage`,
      `Verify the operation is supported for this model`,
      `Ensure all required parameters are provided`,
    ]);
  }
}

export class InvalidPayloadError extends ValidationError {
  readonly code = "INVALID_PAYLOAD";

  constructor(
    reason: string,
    context?: BuilderContext,
    component?: string,
    suggestions: string[] = []
  ) {
    super(
      `Invalid payload: ${reason}`,
      context,
      component,
      suggestions.length > 0
        ? suggestions
        : [
            `Check the payload structure against the expected format`,
            `Ensure all required fields are provided`,
            `Verify field types match the schema definition`,
          ]
    );
  }
}

export class InvalidFilterError extends ValidationError {
  readonly code = "INVALID_FILTER";

  constructor(
    fieldName: string,
    filterType: string,
    reason: string,
    context?: BuilderContext,
    component?: string
  ) {
    super(
      `Invalid filter on field '${fieldName}' with type '${filterType}': ${reason}`,
      context,
      component,
      [
        `Check if the filter operation is supported for this field type`,
        `Verify the filter value is of the correct type`,
        `Consult the documentation for supported filter operations`,
      ]
    );
  }
}

/**
 * Type-related errors
 */
export abstract class TypeError extends QueryParserError {
  override readonly category = ErrorCategory.TYPE;
  abstract override readonly code: string;
}

export class TypeMismatchError extends TypeError {
  readonly code = "TYPE_MISMATCH";

  constructor(
    expected: string,
    actual: string,
    fieldName?: string,
    context?: BuilderContext,
    component?: string
  ) {
    const field = fieldName ? ` for field '${fieldName}'` : "";
    super(
      `Type mismatch${field}: expected '${expected}', got '${actual}'`,
      context,
      component,
      [
        `Ensure the value type matches the field definition`,
        `Check for proper type conversion if needed`,
        `Verify the schema definition is correct`,
      ]
    );
  }
}

export class UnsupportedTypeOperationError extends TypeError {
  readonly code = "UNSUPPORTED_TYPE_OPERATION";

  constructor(
    operation: string,
    fieldType: string,
    context?: BuilderContext,
    component?: string
  ) {
    super(
      `Operation '${operation}' is not supported for field type '${fieldType}'`,
      context,
      component,
      [
        `Check the documentation for supported operations on this field type`,
        `Consider using a different operation or field type`,
        `Verify the field type is correctly defined`,
      ]
    );
  }
}

/**
 * Security-related errors
 */
export abstract class SecurityError extends QueryParserError {
  override readonly category = ErrorCategory.SECURITY;
  abstract override readonly code: string;
}

export class DangerousOperationError extends SecurityError {
  readonly code = "DANGEROUS_OPERATION";

  constructor(
    operation: string,
    reason: string,
    context?: BuilderContext,
    component?: string
  ) {
    super(
      `Dangerous operation '${operation}' blocked: ${reason}`,
      context,
      component,
      [
        `Use more specific conditions to limit the operation scope`,
        `Consider if this operation is really necessary`,
        `Add appropriate WHERE conditions to prevent unintended effects`,
      ]
    );
  }
}

export class SqlInjectionError extends SecurityError {
  readonly code = "SQL_INJECTION_DETECTED";

  constructor(
    suspiciousInput: string,
    context?: BuilderContext,
    component?: string
  ) {
    super(
      `Potential SQL injection detected in input: ${suspiciousInput}`,
      context,
      component,
      [
        `Use parameterized queries instead of string concatenation`,
        `Validate and sanitize all user inputs`,
        `Use the ORM's built-in filtering methods`,
      ]
    );
  }
}

/**
 * Performance-related errors
 */
export abstract class PerformanceError extends QueryParserError {
  override readonly category = ErrorCategory.PERFORMANCE;
  abstract override readonly code: string;
}

export class ExpensiveOperationWarning extends PerformanceError {
  readonly code = "EXPENSIVE_OPERATION";

  constructor(
    operation: string,
    reason: string,
    context?: BuilderContext,
    component?: string
  ) {
    super(
      `Potentially expensive operation '${operation}': ${reason}`,
      context,
      component,
      [
        `Consider adding appropriate indexes`,
        `Use pagination to limit result sets`,
        `Add more specific WHERE conditions`,
        `Consider caching for frequently accessed data`,
      ]
    );
  }
}

export class QueryComplexityError extends PerformanceError {
  readonly code = "QUERY_TOO_COMPLEX";

  constructor(
    complexity: number,
    maxComplexity: number,
    context?: BuilderContext,
    component?: string
  ) {
    super(
      `Query complexity (${complexity}) exceeds maximum allowed (${maxComplexity})`,
      context,
      component,
      [
        `Reduce the number of nested relations`,
        `Use pagination to limit result sets`,
        `Split complex queries into smaller ones`,
        `Consider using aggregation instead of deep nesting`,
      ]
    );
  }
}

/**
 * Configuration-related errors
 */
export abstract class ConfigurationError extends QueryParserError {
  override readonly category = ErrorCategory.CONFIGURATION;
  abstract override readonly code: string;
}

export class InvalidConfigurationError extends ConfigurationError {
  readonly code = "INVALID_CONFIGURATION";

  constructor(
    configKey: string,
    reason: string,
    context?: BuilderContext,
    component?: string
  ) {
    super(
      `Invalid configuration for '${configKey}': ${reason}`,
      context,
      component,
      [
        `Check the configuration documentation`,
        `Verify the configuration value type and format`,
        `Ensure all required configuration is provided`,
      ]
    );
  }
}

/**
 * Internal errors (should not normally occur)
 */
export abstract class InternalError extends QueryParserError {
  override readonly category = ErrorCategory.INTERNAL;
  abstract override readonly code: string;
}

export class NotImplementedError extends InternalError {
  readonly code = "NOT_IMPLEMENTED";

  constructor(feature: string, context?: BuilderContext, component?: string) {
    super(`Feature '${feature}' is not yet implemented`, context, component, [
      `This feature is planned for a future release`,
      `Consider using an alternative approach`,
      `Check the roadmap for implementation timeline`,
    ]);
  }
}

export class UnexpectedError extends InternalError {
  readonly code = "UNEXPECTED_ERROR";

  constructor(reason: string, context?: BuilderContext, component?: string) {
    super(`Unexpected error: ${reason}`, context, component, [
      `This appears to be an internal error`,
      `Please report this issue with the full error details`,
      `Try simplifying the query to isolate the problem`,
    ]);
  }
}

/**
 * Error factory for creating specific errors
 */
export class QueryErrorFactory {
  static modelNotFound(
    modelName: string,
    context?: BuilderContext,
    component?: string
  ): ModelNotFoundError {
    return new ModelNotFoundError(modelName, context, component);
  }

  static fieldNotFound(
    fieldName: string,
    modelName: string,
    context?: BuilderContext,
    component?: string
  ): FieldNotFoundError {
    return new FieldNotFoundError(fieldName, modelName, context, component);
  }

  static relationNotFound(
    relationName: string,
    modelName: string,
    context?: BuilderContext,
    component?: string
  ): RelationNotFoundError {
    return new RelationNotFoundError(
      relationName,
      modelName,
      context,
      component
    );
  }

  static invalidOperation(
    operation: string,
    reason: string,
    context?: BuilderContext,
    component?: string
  ): InvalidOperationError {
    return new InvalidOperationError(operation, reason, context, component);
  }

  static invalidPayload(
    reason: string,
    context?: BuilderContext,
    component?: string,
    suggestions?: string[]
  ): InvalidPayloadError {
    return new InvalidPayloadError(reason, context, component, suggestions);
  }

  static typeMismatch(
    expected: string,
    actual: string,
    fieldName?: string,
    context?: BuilderContext,
    component?: string
  ): TypeMismatchError {
    return new TypeMismatchError(
      expected,
      actual,
      fieldName,
      context,
      component
    );
  }

  static notImplemented(
    feature: string,
    context?: BuilderContext,
    component?: string
  ): NotImplementedError {
    return new NotImplementedError(feature, context, component);
  }
}

/**
 * Error aggregator for collecting multiple errors
 */
export class ErrorAggregator {
  private errors: QueryParserError[] = [];
  private warnings: QueryParserError[] = [];

  addError(error: QueryParserError): void {
    if (error.category === ErrorCategory.PERFORMANCE) {
      this.warnings.push(error);
    } else {
      this.errors.push(error);
    }
  }

  hasErrors(): boolean {
    return this.errors.length > 0;
  }

  hasWarnings(): boolean {
    return this.warnings.length > 0;
  }

  getErrors(): QueryParserError[] {
    return [...this.errors];
  }

  getWarnings(): QueryParserError[] {
    return [...this.warnings];
  }

  getAllIssues(): QueryParserError[] {
    return [...this.errors, ...this.warnings];
  }

  clear(): void {
    this.errors = [];
    this.warnings = [];
  }

  throwIfErrors(): void {
    if (this.hasErrors()) {
      const primaryError = this.errors[0]!;
      if (this.errors.length > 1) {
        primaryError.message += ` (and ${
          this.errors.length - 1
        } other error(s))`;
      }
      throw primaryError;
    }
  }
}
