// Schema Validator

import type { Model } from "../model";
import { SchemaValidationError } from "./error";
import { allRules } from "./rules";
import { inverseOneToOneMustBeOptional } from "./rules/relation";
import type {
  Schema,
  SchemaValidationIssue,
  ValidationContext,
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

  return { modelToName, tableToModels };
}

export class SchemaValidator {
  private readonly schema: Schema = new Map();

  /** Register a model with a name */
  register(name: string, model: Model<any>): this {
    if (this.schema.has(name)) {
      throw new SchemaValidationError([
        {
          code: "M003",
          message: `Model name '${name}' is duplicated`,
          severity: "error",
          model: name,
        },
      ]);
    }
    this.schema.set(name, model);
    return this;
  }

  /** Register multiple models */
  registerAll(models: Record<string, Model<any>>): this {
    for (const [name, model] of Object.entries(models)) {
      this.register(name, model);
    }
    return this;
  }

  /** Validate all registered models */
  validate(rules: ValidationRule[] = allRules): ValidationResult {
    const errors: SchemaValidationIssue[] = [];
    const warnings: SchemaValidationIssue[] = [];

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
        let results: SchemaValidationIssue[];
        try {
          results = rule(this.schema, modelName, model, ctx);
        } catch (cause) {
          const message =
            cause instanceof Error ? cause.message : String(cause);
          throw new SchemaValidationError(
            [
              {
                code: "S001",
                message: `Schema rule '${rule.name || "anonymous"}' failed for '${modelName}': ${message}`,
                severity: "error",
                model: modelName,
              },
            ],
            cause instanceof Error ? { cause } : undefined
          );
        }
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
      throw new SchemaValidationError(result.errors);
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

/** Mandatory definition gate for the feature-owned private storage contract.
 * Ordinary schemas keep their current client-construction behavior. */
export function validatePolymorphicSchemaOrThrow(
  models: Record<string, Model<any>>
): void {
  if (!hasPolymorphicRelations(models)) return;
  new SchemaValidator().registerAll(models).validateOrThrow();
}

/** Validate the definition contracts that every query client relies on.
 * Polymorphic schemas need the complete graph validation that materializes
 * their private storage. Ordinary schemas need only the non-owning one-to-one
 * rule here; their remaining definition rules keep their existing explicit
 * validation boundary. */
export function validateClientSchemaOrThrow(
  models: Record<string, Model<any>>
): void {
  const validator = new SchemaValidator().registerAll(models);
  validator.validateOrThrow(
    hasPolymorphicRelations(models)
      ? undefined
      : [inverseOneToOneMustBeOptional]
  );
}

function hasPolymorphicRelations(models: Record<string, Model<any>>): boolean {
  return Object.values(models).some(
    (model) => Object.keys(model["~"].state.polymorphicRelations).length > 0
  );
}
