// Schema Validation Types

import type { Model } from "../model";

export type Severity = "error" | "warning";

export interface SchemaValidationIssue {
  code: string;
  message: string;
  severity: Severity;
  model?: string;
  field?: string;
  relation?: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: SchemaValidationIssue[];
  warnings: SchemaValidationIssue[];
}

export type Schema = Map<string, Model<any>>;

/** Pre-computed lookup tables for O(1) model resolution */
export interface ValidationContext {
  /** Model instance → model name (O(1) lookup instead of O(n) search) */
  modelToName: Map<Model<any>, string>;
  /** Table name → model names (for uniqueness checks) */
  tableToModels: Map<string, string[]>;
}

export type ValidationRule = (
  schema: Schema,
  modelName: string,
  model: Model<any>,
  ctx: ValidationContext
) => SchemaValidationIssue[];
