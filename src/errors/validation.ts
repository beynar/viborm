import type { Operation } from "../query-engine/types";
import { VibORMError, VibORMErrorCode, type VibORMErrorMeta } from "./base";
import type { DiagnosticDisclosure } from "./diagnostics";

/**
 * Validation issue details
 */
export interface ValidationIssue {
  path: string;
  message: string;
}

/**
 * The INTERNAL operation names that have no client spelling, mapped to the name
 * a caller can actually type.
 *
 * `createManyAndReturn` / `updateManyAndReturn` / `deleteManyAndReturn` name the
 * row-returning ARM of a bulk write inside the engine (maintainer decision D-1:
 * the public surface is `createMany` / `updateMany` / `deleteMany` with a
 * `select`). The client refuses those names outright — `pending-operation.ts`
 * answers `Unknown operation 'createManyAndReturn'` — so an error that named one
 * would send a caller to fix an operation the same client says does not exist.
 * Every user-facing name goes through {@link publicOperationName}; anything not
 * in this map is already its own public spelling.
 */
const PUBLIC_OPERATION_NAME: Readonly<Partial<Record<Operation, Operation>>> = {
  createManyAndReturn: "createMany",
  updateManyAndReturn: "updateMany",
  deleteManyAndReturn: "deleteMany",
};

/**
 * The client spelling of an operation — identity for every name a caller can
 * type, and the public family name for the three internal row-returning arms.
 */
export function publicOperationName(operation: Operation): Operation {
  return PUBLIC_OPERATION_NAME[operation] ?? operation;
}

/**
 * Input validation errors
 */
export class ValidationError extends VibORMError {
  static override readonly diagnosticName = "ValidationError";

  /** Validation issues */
  readonly issues: ValidationIssue[];
  /**
   * Operation that failed validation, in its CLIENT spelling — a bulk write
   * validated through its internal row-returning arm still reports the family
   * name the caller used (see {@link publicOperationName}).
   */
  readonly operation: Operation;

  constructor(
    operation: Operation,
    issues: ValidationIssue[],
    options?: {
      diagnostics?: DiagnosticDisclosure | undefined;
      meta?: VibORMErrorMeta;
    }
  ) {
    const issuesSummary =
      issues.length === 1
        ? issues[0]!.message
        : `${issues.length} validation errors`;
    const reported = publicOperationName(operation);
    super(
      `Validation failed for ${reported}: ${issuesSummary}`,
      VibORMErrorCode.VALIDATION_FAILED,
      {
        diagnostics: options?.diagnostics,
        meta: { ...options?.meta, operation: reported },
      }
    );
    this.issues = issues;
    this.operation = reported;
  }
}

/**
 * Type guard for validation errors
 */
export function isValidationError(error: unknown): error is ValidationError {
  return error instanceof ValidationError;
}
