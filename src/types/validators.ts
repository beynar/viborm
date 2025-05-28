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
