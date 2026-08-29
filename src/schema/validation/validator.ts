// Schema Validator
//
// TWO layers, one boundary. The mandatory relation-definition gate
// (`./relation-resolution`) decides every structural topology fact and runs at
// every effect-capable boundary; the rule list beside it carries advice about
// how a schema is spelled. `skipValidation` may drop the advice. It cannot drop
// the gate: no query or migration is allowed to guess an edge.

import type { Model } from "../model";
import { preflightModelRegistrationIdentity } from "../registration-preflight";
import { SchemaValidationError } from "./error";
import {
  type RelationResolution,
  type ResolvedRelationIndex,
  resolveSchemaRelations,
} from "./relation-resolution";
import { allRules } from "./rules";
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
  /** One resolution per validator lifecycle: the gate runs once per schema. */
  private resolution: RelationResolution | undefined;

  /** Register a model with a name */
  register(name: string, model: Model<any>): this {
    const registered = this.schema.get(name);
    if (registered) {
      if (registered === model) {
        this.resolution = undefined;
        return this;
      }
      throw validationError([
        {
          code: "M003",
          message: `Model name '${name}' is duplicated`,
          severity: "error",
          model: name,
        },
      ]);
    }
    this.schema.set(name, model);
    this.resolution = undefined;
    return this;
  }

  /** Register multiple models */
  registerAll(models: Record<string, Model<any>>): this {
    for (const [name, model] of Object.entries(models)) {
      this.register(name, model);
    }
    return this;
  }

  /**
   * Resolve the relation graph. The successful arm is the one trusted topology
   * view; the failure arm carries the issues and, for a thrown lazy getter, the
   * terminal's own settled `Error`.
   */
  resolve(): RelationResolution {
    if (this.resolution) return this.resolution;
    const identityIssue = preflightModelRegistrationIdentity(this.schema);
    this.resolution = identityIssue
      ? { ok: false, issues: [identityIssue] }
      : resolveSchemaRelations(this.schema, buildContext(this.schema));
    return this.resolution;
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

    // The gate reports on every schema, valid or not: a successful resolution
    // still carries the advisories its subowners produced.
    const resolution = this.resolve();
    for (const issue of resolution.issues) {
      (issue.severity === "error" ? errors : warnings).push(issue);
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
      const resolution = this.resolve();
      throw validationError(
        result.errors,
        resolution.ok ? undefined : resolution.cause
      );
    }
  }
}

/** Validate a schema object directly */
export function validateSchema(
  models: Record<string, Model<any>>
): ValidationResult {
  return new SchemaValidator().registerAll(models).validate();
}

/**
 * Validate or throw — the structural gate plus the advisory rules, resolved
 * exactly once. The resolved index is an internal execution capability, not a
 * public validation result.
 */
export function validateSchemaOrThrow(
  models: Record<string, Model<any>>
): void {
  validateResolvedSchemaOrThrow(models);
}

/** Internal validation boundary that also publishes the trusted topology. */
export function validateResolvedSchemaOrThrow(
  models: Record<string, Model<any>>,
  rules?: ValidationRule[]
): ResolvedRelationIndex {
  const validator = new SchemaValidator().registerAll(models);
  validator.validateOrThrow(rules);
  return publish(validator);
}

/**
 * The mandatory structural gate, for every boundary that can produce effects:
 * client construction, standalone registry construction, and migration
 * serialization/generation/push — including `push({ skipValidation: true })`,
 * which may skip advice but never this.
 *
 * Returns the one trusted index. The caller owns it for its own lifecycle and
 * passes it on by identity rather than copying it.
 */
export function resolveSchemaOrThrow(
  models: Record<string, Model<any>>
): ResolvedRelationIndex {
  return publish(new SchemaValidator().registerAll(models));
}

/**
 * Validate the definition contracts every query client relies on: the mandatory
 * structural gate plus the schema-wide model-identity checks a client needs to
 * address a model at all (duplicate model name, duplicate table), resolved
 * exactly once.
 *
 * The EMPTY rule list is the whole difference between this boundary and
 * `validateSchemaOrThrow`, and it is deliberate. §7.3 requires structural
 * resolution here and says advisory rules "may remain optional"; advice about
 * how a schema is SPELLED — a missing id, a reserved model name, an index
 * shape — belongs to the boundary that writes DDL. Running it here would refuse
 * schemas a client has always built, which is a verdict change §9.4 does not
 * enumerate.
 */
export function validateClientSchemaOrThrow(
  models: Record<string, Model<any>>
): ResolvedRelationIndex {
  return validateResolvedSchemaOrThrow(models, []);
}

function publish(validator: SchemaValidator): ResolvedRelationIndex {
  const resolution = validator.resolve();
  if (resolution.ok) return resolution.index;
  throw validationError(
    resolution.issues.filter((issue) => issue.severity === "error"),
    resolution.cause
  );
}

/** One construction path for every thrown schema-validation result. */
function validationError(
  issues: readonly SchemaValidationIssue[],
  cause?: Error
): SchemaValidationError {
  return new SchemaValidationError(issues, cause ? { cause } : undefined);
}
