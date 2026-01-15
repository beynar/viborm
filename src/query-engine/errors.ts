/**
 * Query Engine Error Utilities
 *
 * Centralized error factory for creating errors with consistent context.
 */

import type { Model } from "@schema/model";
import { NestedWriteError, QueryEngineError } from "../errors";
import type { QueryContext } from "./types";

/**
 * Get model name from model or context
 */
function getModelName(
  modelOrCtx: Model<any> | QueryContext | undefined
): string {
  if (!modelOrCtx) {
    return "unknown";
  }

  // Check if it's a QueryContext
  if ("model" in modelOrCtx && "adapter" in modelOrCtx) {
    const ctx = modelOrCtx as QueryContext;
    return ctx.model["~"].names.ts ?? "unknown";
  }

  // It's a Model
  const model = modelOrCtx as Model<any>;
  return model["~"].names.ts ?? "unknown";
}

/**
 * Create a NestedWriteError with model and relation context
 *
 * @param message - Error message
 * @param relation - Relation name that failed
 * @param modelOrCtx - Model or QueryContext for model name
 * @param cause - Original error if any
 * @returns NestedWriteError with full context
 */
export function createNestedWriteError(
  message: string,
  relation: string,
  modelOrCtx?: Model<any> | QueryContext,
  cause?: Error
): NestedWriteError {
  const modelName = getModelName(modelOrCtx);
  const fullMessage = `[${modelName}.${relation}] ${message}`;
  return new NestedWriteError(fullMessage, relation, {
    cause,
    meta: { model: modelName },
  });
}

/**
 * Create a QueryEngineError with model context
 *
 * @param message - Error message
 * @param modelOrCtx - Model or QueryContext for model name
 * @returns QueryEngineError with context
 */
export function createQueryError(
  message: string,
  modelOrCtx?: Model<any> | QueryContext
): QueryEngineError {
  const modelName = getModelName(modelOrCtx);
  if (modelName !== "unknown") {
    return new QueryEngineError(`[${modelName}] ${message}`, {
      meta: { model: modelName },
    });
  }
  return new QueryEngineError(message);
}

/**
 * Create error for missing required fields
 */
export function createMissingFieldError(
  fieldName: string,
  operation: string,
  modelOrCtx?: Model<any> | QueryContext
): QueryEngineError {
  const modelName = getModelName(modelOrCtx);
  return new QueryEngineError(
    `[${modelName}] Missing required field '${fieldName}' for ${operation} operation`,
    { meta: { model: modelName, field: fieldName, operation } }
  );
}

/**
 * Create error for invalid relation operation
 */
export function createInvalidRelationError(
  relation: string,
  operation: string,
  reason: string,
  modelOrCtx?: Model<any> | QueryContext
): NestedWriteError {
  const modelName = getModelName(modelOrCtx);
  return new NestedWriteError(
    `[${modelName}.${relation}] Invalid '${operation}' operation: ${reason}`,
    relation,
    { meta: { model: modelName, operation } }
  );
}
