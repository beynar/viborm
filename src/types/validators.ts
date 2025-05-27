// Validator Type Definitions
// Based on specifications: readme/6_validation.md and readme/1.2_field_class.md

import { StandardSchemaV1 } from "./standardSchema";

// Standard Schema interface for cross-library compatibility

// Validation result interface
export interface ValidationResult {
  valid: boolean;
  errors?: string[] | undefined;
}

// Field validator can be a function or Standard Schema
export type FieldValidator<T> =
  | ((value: T) => boolean | string | Promise<boolean | string>)
  | StandardSchemaV1<any, T>;

// Model validator can be a function or Standard Schema
export type ModelValidator<T> =
  | ((data: T) => boolean | string | Promise<boolean | string>)
  | StandardSchemaV1<T, T>;

// Relation validator
export type RelationValidator<T> =
  | ((data: T) => boolean | string | Promise<boolean | string>)
  | StandardSchemaV1<T, T>;

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
