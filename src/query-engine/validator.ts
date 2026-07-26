/**
 * Query Validator
 *
 * Single validator using model schemas.
 * Maps operation names to schema keys and validates input.
 */

import { ValidationError } from "@errors";
import type { Model } from "@schema/model";
import { parse, type SchemaRegistryLookup, type VibSchema } from "@validation";
import { assertPortablePrimaryKeyUpdateInput } from "./operations/mutation-identity";
import type { Operation } from "./types";

/**
 * Get the appropriate schema for an operation
 */
function getOperationSchema(
  schemaRegistry: SchemaRegistryLookup,
  model: Model<any>,
  operation: Operation
): VibSchema | undefined {
  const schemas = schemaRegistry.getModelSchemas(model);

  // Map operations to their schema locations
  switch (operation) {
    case "findFirst":
      return schemas.args.findFirst;
    case "findMany":
      return schemas.args.findMany;
    case "findUnique":
      return schemas.args.findUnique;
    case "create":
      return schemas.args.create;
    // `createManyAndReturn` / `updateManyAndReturn` are INTERNAL names for the
    // row-returning arm of `createMany` / `updateMany` (implicit returning: the
    // caller passed a `select`). They are not client operations and have no arg
    // schema of their own — the ONE public schema per family validates both arms,
    // `select` being optional in it.
    case "createMany":
    case "createManyAndReturn":
      return schemas.args.createMany;
    case "update":
      return schemas.args.update;
    case "updateMany":
    case "updateManyAndReturn":
      return schemas.args.updateMany;
    case "delete":
      return schemas.args.delete;
    case "deleteMany":
      return schemas.args.deleteMany;
    case "upsert":
      return schemas.args.upsert;
    case "count":
      return schemas.args.count;
    case "aggregate":
      return schemas.args.aggregate;
    case "groupBy":
      return schemas.args.groupBy;
    case "exist":
      // exist uses same schema as count but simpler
      return schemas.args.count;
    default:
      return undefined;
  }
}

/**
 * Validate operation input against model schema
 *
 * @param model - The model to validate against
 * @param operation - The operation being performed
 * @param input - The input to validate
 * @returns The validated input (with defaults applied)
 * @throws ValidationError if validation fails
 */
export function validate<T>(
  schemaRegistry: SchemaRegistryLookup,
  model: Model<any>,
  operation: Operation,
  input: unknown
): T {
  const schema = getOperationSchema(schemaRegistry, model, operation);

  if (!schema) {
    throw new ValidationError(operation, [
      {
        path: "operation",
        message: `Schema not found for operation: ${operation}`,
      },
    ]);
  }

  const result = parse(schema, input);

  if (result.issues) {
    const issues = result.issues.map((issue) => ({
      path: issue.path?.map(String).join(".") || "root",
      message: issue.message,
    }));
    throw new ValidationError(operation, issues);
  }

  assertPortablePrimaryKeyUpdateInput(model, operation, result.value);
  return result.value as T;
}

/**
 * Validate with optional - returns undefined instead of throwing for missing optional input
 */
export function validateOptional<T>(
  schemaRegistry: SchemaRegistryLookup,
  model: Model<any>,
  operation: Operation,
  input: unknown
): T | undefined {
  if (input === undefined || input === null) {
    return undefined;
  }
  return validate<T>(schemaRegistry, model, operation, input);
}
