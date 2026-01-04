// Schema Validation Types

import type { Model } from "../model";

export type Severity = "error" | "warning";

export interface ValidationError {
  code: string;
  message: string;
  severity: Severity;
  model?: string;
  field?: string;
  relation?: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
  warnings: ValidationError[];
}

export type Schema = Map<string, Model<any>>;

/** Pre-computed lookup tables for O(1) model resolution */
export interface ValidationContext {
  schema: Schema;
  /** Model instance → model name (O(1) lookup instead of O(n) search) */
  modelToName: Map<Model<any>, string>;
  /** Table name → model names (for uniqueness checks) */
  tableToModels: Map<string, string[]>;
}

export type ValidationRule = (
  schema: Schema,
  modelName: string,
  model: Model<any>,
  ctx?: ValidationContext
) => ValidationError[];
