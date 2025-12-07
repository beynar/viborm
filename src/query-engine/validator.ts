/**
 * Query Validator
 *
 * Single validator using model schemas.
 * Maps operation names to schema keys and validates input.
 */

import { type } from "arktype";
import type { Model } from "@schema/model";
import type { TypedModelSchemas } from "@schema/model/runtime";
import { Operation, ValidationError } from "./types";

/**
 * Map operation names to schema keys in TypedModelSchemas
 */
const schemaKeyMap: Record<Operation, keyof TypedModelSchemas<any>> = {
  findFirst: "findFirst",
  findMany: "findMany",
  findUnique: "findUnique",
  create: "createArgs",
  createMany: "createArgs",
  update: "updateArgs",
  updateMany: "updateManyArgs",
  delete: "deleteArgs",
  deleteMany: "deleteManyArgs",
  upsert: "upsertArgs",
  count: "count",
  aggregate: "aggregate",
  groupBy: "groupBy",
  exist: "exist",
};

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
  input: unknown
): T {
  const schemaKey = schemaKeyMap[operation];
  const schema = model["~"].schemas[schemaKey];

  if (!schema) {
    throw new ValidationError(
      operation,
      `Schema not found for operation: ${operation}`
    );
  }

  const result = schema(input);

  // ArkType returns the data directly if valid, or a type.errors object if invalid
  if (result instanceof type.errors) {
    throw new ValidationError(operation, result.summary);
  }

  return result as T;
}

/**
 * Validate with optional - returns undefined instead of throwing for missing optional input
 */
export function validateOptional<T>(
  model: Model<any>,
  operation: Operation,
  input: unknown
): T | undefined {
  if (input === undefined || input === null) {
    return undefined;
  }
  return validate<T>(model, operation, input);
}

