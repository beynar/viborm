/**
 * Query Validator
 *
 * Single validator using model schemas.
 * Maps operation names to schema keys and validates input.
 */

import { parse, type VibSchema } from "../validation";
import type { Model } from "@schema/model";
import { Operation, ValidationError } from "./types";

/**
 * Get the appropriate schema for an operation
 */
function getOperationSchema(
  model: Model<any>,
  operation: Operation,
): VibSchema | undefined {
  const schemas = model["~"].schemas;

  // Map operations to their schema locations
  switch (operation) {
    case "findFirst":
      return schemas.args?.findFirst;
    case "findMany":
      return schemas.args?.findMany;
    case "findUnique":
      return schemas.args?.findUnique;
    case "create":
      return schemas.args?.create;
    case "createMany":
      return schemas.args?.createMany;
    case "update":
      return schemas.args?.update;
    case "updateMany":
      return schemas.args?.updateMany;
    case "delete":
      return schemas.args?.delete;
    case "deleteMany":
      return schemas.args?.deleteMany;
    case "upsert":
      return schemas.args?.upsert;
    case "count":
      return schemas.args?.count;
    case "aggregate":
      return schemas.args?.aggregate;
    case "groupBy":
      return schemas.args?.groupBy;
    case "exist":
      // exist uses same schema as count but simpler
      return schemas.args?.count;
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
  model: Model<any>,
  operation: Operation,
  input: unknown,
): T {
  const schema = getOperationSchema(model, operation);

  if (!schema) {
    throw new ValidationError(
      operation,
      `Schema not found for operation: ${operation}`,
    );
  }

  const result = parse(schema, input);

  if (result.issues) {
    const issues = result.issues
      .map(
        (issue) =>
          `${issue.path?.map((p: any) => p.key).join(".") || "root"}: ${issue.message}`,
      )
      .join("; ");
    throw new ValidationError(operation, issues);
  }

  return result.value as T;
}

/**
 * Validate with optional - returns undefined instead of throwing for missing optional input
 */
export function validateOptional<T>(
  model: Model<any>,
  operation: Operation,
  input: unknown,
): T | undefined {
  if (input === undefined || input === null) {
    return undefined;
  }
  return validate<T>(model, operation, input);
}
