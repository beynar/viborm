// Schema Validator

import type { Model } from "../model";
import { allRules } from "./rules";
import type {
  Schema,
  ValidationContext,
  ValidationError,
  ValidationResult,
  ValidationRule,
} from "./types";

/** Build context once, use everywhere */
function buildContext(schema: Schema): ValidationContext {
  const modelToName = new Map<Model<any>, string>();
  const tableToModels = new Map<string, string[]>();

  for (const [name, model] of schema) {
    modelToName.set(model, name);
    const tableName = model["~"].state.tableName ?? name;
    if (!tableToModels.has(tableName)) {
      tableToModels.set(tableName, []);
    }
    tableToModels.get(tableName)!.push(name);
  }

  return { schema, modelToName, tableToModels };
}

export class SchemaValidator {
  private readonly schema: Schema = new Map();

  /** Register a model with a name */
  register(name: string, model: Model<any>): this {
    this.schema.set(name, model);
    return this;
  }

  /** Register multiple models */
  registerAll(models: Record<string, Model<any>>): this {
    for (const [name, model] of Object.entries(models)) {
      this.schema.set(name, model);
    }
    return this;
  }

  /** Validate all registered models */
  validate(rules: ValidationRule[] = allRules): ValidationResult {
    const errors: ValidationError[] = [];
    const warnings: ValidationError[] = [];

    // Build context once (O(n) models)
    const ctx = buildContext(this.schema);

    // Check table name uniqueness using pre-built map
    for (const [tableName, models] of ctx.tableToModels) {
      if (models.length > 1) {
        errors.push({
          code: "M004",
          message: `Table name '${tableName}' used by multiple models: ${models.join(", ")}`,
          severity: "error",
        });
      }
    }

    // Run all rules on each model
    for (const [modelName, model] of this.schema) {
      for (const rule of rules) {
        const results = rule(this.schema, modelName, model, ctx);
        for (const result of results) {
          if (result.severity === "error") {
            errors.push(result);
          } else {
            warnings.push(result);
          }
        }
      }
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings,
    };
  }

  /** Validate and throw if invalid */
  validateOrThrow(rules?: ValidationRule[]): void {
    const result = this.validate(rules);
    if (!result.valid) {
      const messages = result.errors.map((e) => `[${e.code}] ${e.message}`);
      throw new Error(`Schema validation failed:\n${messages.join("\n")}`);
    }
  }
}

/** Validate a schema object directly */
export function validateSchema(
  models: Record<string, Model<any>>,
  rules?: ValidationRule[]
): ValidationResult {
  return new SchemaValidator().registerAll(models).validate(rules);
}

/** Validate or throw */
export function validateSchemaOrThrow(
  models: Record<string, Model<any>>,
  rules?: ValidationRule[]
): void {
  new SchemaValidator().registerAll(models).validateOrThrow(rules);
}
