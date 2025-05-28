// Validator Type Definitions
// Based on specifications: readme/6_validation.md and readme/1.2_field_class.md

import type { StandardSchemaV1 as StandardSchemaInternal } from "./standardSchema"; // Import for internal use
export type { StandardSchemaV1 } from "./standardSchema"; // Re-export for external use

// Validation result interface (defined in StandardSchemaV1.Result)
export interface ValidationResult<T> {
  valid: boolean;
  errors?: string[] | undefined; // Simplified error reporting for now
  output?: T | undefined;
}

// Field validator accepts only Standard Schema
export type FieldValidator<T> = StandardSchemaInternal<any, T>; // Input can be any, output is T

// Model validator can be a function or Standard Schema
export type ModelValidator<T> =
  | ((data: T) => boolean | string | Promise<boolean | string>)
  | StandardSchemaInternal<T, T>;

// Relation validator
export type RelationValidator<T> =
  | ((data: T) => boolean | string | Promise<boolean | string>)
  | StandardSchemaInternal<T, T>;

// Validation error types
export class ValidationError extends Error {
  constructor(
    message: string,
    public field?: string,
    public errors?: string[]
  ) {
    super(message);
    this.name = "ValidationError";
  }
}

// Validation context for complex scenarios
export interface ValidationContext {
  field?: string;
  model?: string;
  path?: string[];
  value?: any;
}

// Validator utilities
export type ValidatorFunction<T> = (
  value: T,
  context?: ValidationContext
) => boolean | string | Promise<boolean | string>;

// Composable validator type
export interface ComposableValidator<T> {
  validate: ValidatorFunction<T>;
  and: (other: ComposableValidator<T>) => ComposableValidator<T>;
  or: (other: ComposableValidator<T>) => ComposableValidator<T>;
}
