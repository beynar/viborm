import type { Operation } from "../query-engine/types";
import { VibORMError, VibORMErrorCode, type VibORMErrorMeta } from "./base";

/**
 * Validation issue details
 */
export interface ValidationIssue {
  path: string;
  message: string;
}

/**
 * Input validation errors
 */
export class ValidationError extends VibORMError {
  /** Validation issues */
  readonly issues: ValidationIssue[];
  /** Operation that failed validation */
  readonly operation: Operation;

  constructor(
    operation: Operation,
    issues: ValidationIssue[],
    options?: { meta?: VibORMErrorMeta }
  ) {
    const issuesSummary =
      issues.length === 1
        ? issues[0]!.message
        : `${issues.length} validation errors`;
    super(
      `Validation failed for ${operation}: ${issuesSummary}`,
      VibORMErrorCode.VALIDATION_FAILED,
      {
        meta: { ...options?.meta, operation },
      }
    );
    this.name = "ValidationError";
    this.issues = issues;
    this.operation = operation;
  }
}

/**
 * Type guard for validation errors
 */
export function isValidationError(error: unknown): error is ValidationError {
  return error instanceof ValidationError;
}
