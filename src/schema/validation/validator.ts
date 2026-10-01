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
import {
  memberNamesAreNotReserved,
  publicSelectorNamesAreUnambiguous,
} from "./rules/model";
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

/**
 * The public validator: every advisory rule unless told otherwise. Client
 * construction does not use it; {@link resolveSchemaOrThrow} runs only the
 * selector rules, so a client bundle does not carry the advisory ones.
 */
export class SchemaValidator {
  readonly #schema: Schema = new Map();
  /** One resolution per validator lifecycle: the gate runs once per schema. */
  #resolution: RelationResolution | undefined;

  /** Register a model with a name */
  register(name: string, model: Model<any>): this {
    const registered = this.#schema.get(name);
    if (registered) {
      if (registered === model) {
        this.#resolution = undefined;
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
    this.#schema.set(name, model);
    this.#resolution = undefined;
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
    this.#resolution ??= resolveRegistered(
      this.#schema,
      buildContext(this.#schema)
    );
    return this.#resolution;
  }

  /** Validate all registered models */
  validate(rules: ValidationRule[] = allRules): ValidationResult {
    const errors: SchemaValidationIssue[] = [];
    const warnings: SchemaValidationIssue[] = [];
    for (const issue of schemaIssues(
      this.#schema,
      buildContext(this.#schema),
      this.resolve(),
      rules
    )) {
      (issue.severity === "error" ? errors : warnings).push(issue);
    }
    return {
      valid: errors.length === 0,
      errors,
      warnings,
    };
  }

  /**
   * Validate and throw if invalid; a valid schema publishes the one trusted
   * topology. `validate` already reports every resolution issue by severity,
   * so validity and a successful resolution are one fact stated here once.
   */
  validateOrThrow(rules: ValidationRule[] = allRules): ResolvedRelationIndex {
    const result = this.validate(rules);
    const resolution = this.resolve();
    if (result.valid && resolution.ok) return resolution.index;
    throw validationError(
      result.errors,
      resolution.ok ? undefined : resolution.cause
    );
  }
}

/** The identity preflight, then the relation gate. */
function resolveRegistered(
  schema: Schema,
  ctx: ValidationContext
): RelationResolution {
  const identityIssue = preflightModelRegistrationIdentity(schema);
  return identityIssue
    ? { ok: false, issues: [identityIssue] }
    : resolveSchemaRelations(schema, ctx);
}

/**
 * Every issue a schema carries, in report order: shared tables, then the gate's
 * own issues — it reports on every schema, valid or not, since a successful
 * resolution still carries the advisories its subowners produced — then every
 * rule on every model. A throwing rule is S001.
 */
function schemaIssues(
  schema: Schema,
  ctx: ValidationContext,
  resolution: RelationResolution,
  rules: readonly ValidationRule[]
): SchemaValidationIssue[] {
  const issues: SchemaValidationIssue[] = [];
  for (const [tableName, models] of ctx.tableToModels) {
    if (models.length > 1) issues.push(sharedTableIssue(tableName, models));
  }
  for (const issue of resolution.issues) issues.push(issue);
  for (const [modelName, model] of schema) {
    for (const rule of rules) {
      let results: SchemaValidationIssue[];
      try {
        results = rule(schema, modelName, model, ctx);
      } catch (cause) {
        throw ruleFailure(rule, modelName, cause);
      }
      for (const result of results) issues.push(result);
    }
  }
  return issues;
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
  validateResolvedSchemaOrThrow(models, allRules);
}

/** Internal validation boundary that also publishes the trusted topology. */
export function validateResolvedSchemaOrThrow(
  models: Record<string, Model<any>>,
  rules: ValidationRule[]
): ResolvedRelationIndex {
  return new SchemaValidator().registerAll(models).validateOrThrow(rules);
}

/**
 * The rules every effect-capable boundary runs beside the relation gate: each
 * gives one admitted selector one meaning — a compound selector never reuses a
 * member name (I006), and no member takes an output key a selection
 * reserves, `_count` or `_distance` (F010).
 */
const SELECTOR_RULES: ValidationRule[] = [
  publicSelectorNamesAreUnambiguous,
  memberNamesAreNotReserved,
];

/**
 * The mandatory structural gate, for every boundary that can produce effects:
 * client construction, standalone registry construction, and migration
 * serialization/generation/push — including `push({ skipValidation: true })`,
 * which may skip advice but never this.
 *
 * It validates the definition contracts every query client relies on: the
 * relation gate plus the schema-wide model-identity checks a client needs to
 * address a model at all (one schema key per model object, no shared table)
 * and the selector rules, resolved exactly once. Advisory rules about how a
 * schema is spelled — a missing id, a reserved model name, an index shape —
 * remain at the boundary that writes DDL. Public selector ambiguity is
 * structural: every client operation relies on one stable meaning for each
 * admitted selector. Only errors are collected: no caller of this gate reads
 * an advisory.
 *
 * Returns the one trusted index. The caller owns it for its own lifecycle and
 * passes it on by identity rather than copying it.
 */
export function resolveSchemaOrThrow(
  models: Record<string, Model<any>>
): ResolvedRelationIndex {
  // `Object.entries` keys are unique, so no name can be registered twice.
  const schema: Schema = new Map(Object.entries(models));
  const ctx = buildContext(schema);
  const resolution = resolveRegistered(schema, ctx);
  const errors = schemaIssues(schema, ctx, resolution, SELECTOR_RULES).filter(
    (issue) => issue.severity === "error"
  );
  if (errors.length === 0 && resolution.ok) return resolution.index;
  throw validationError(errors, resolution.ok ? undefined : resolution.cause);
}

/**
 * The client gate for a schema `viborm check` already validated: relation
 * resolution only, because the engine needs its topology. The identity,
 * table-name, selector-name and cycle checks are the check command's.
 */
export function resolveCheckedSchemaOrThrow(
  models: Record<string, Model<any>>
): ResolvedRelationIndex {
  const schema: Schema = new Map(Object.entries(models));
  const resolution = resolveSchemaRelations(schema, buildContext(schema), true);
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

/** M004, built only when two models share a table. */
function sharedTableIssue(
  tableName: string,
  models: readonly string[]
): SchemaValidationIssue {
  return {
    code: "M004",
    message: `Table name '${tableName}' used by multiple models: ${models.join(", ")}`,
    severity: "error",
  };
}

/** A rule that threw, reported as the schema error it is. */
function ruleFailure(
  rule: ValidationRule,
  modelName: string,
  cause: unknown
): SchemaValidationError {
  const message = cause instanceof Error ? cause.message : String(cause);
  return new SchemaValidationError(
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
