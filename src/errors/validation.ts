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

/** The boundary that rejected a value. */
export type ValidationErrorSource =
  | {
      readonly kind: "operation";
      readonly operation: Operation;
      readonly model?: string | undefined;
    }
  | {
      readonly kind: "registry";
      readonly model?: string | undefined;
      readonly property?: string | undefined;
    }
  | {
      readonly kind: "schema-builder";
      readonly builder: string;
      readonly path: string;
    }
  | {
      readonly kind: "json-schema";
      readonly target?: string | undefined;
      readonly schemaType?: string | undefined;
    };

export interface ValidationErrorOptions {
  cause?: Error | undefined;
  diagnostics?: DiagnosticDisclosure | undefined;
  meta?: VibORMErrorMeta | undefined;
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

  /** Operation failures use V4001; other validation boundaries use V4002. */
  declare readonly code:
    | typeof VibORMErrorCode.VALIDATION_FAILED
    | typeof VibORMErrorCode.INVALID_INPUT;

  /** Validation issues */
  readonly issues: ValidationIssue[];
  /** Boundary that rejected the value. */
  readonly source: ValidationErrorSource;
  /**
   * Operation that failed validation, in its CLIENT spelling — a bulk write
   * validated through its internal row-returning arm still reports the family
   * name the caller used (see {@link publicOperationName}).
   */
  readonly operation?: Operation | undefined;

  constructor(
    sourceOrOperation: Operation | ValidationErrorSource,
    issues: ValidationIssue[],
    options?: ValidationErrorOptions
  ) {
    const issuesSummary =
      issues.length === 1
        ? issues[0]!.message
        : `${issues.length} validation errors`;
    const source = normalizeSource(sourceOrOperation, options?.meta);
    const operation =
      source.kind === "operation" ? source.operation : undefined;
    const subject = validationSubject(source);
    super(
      `Validation failed for ${subject}: ${issuesSummary}`,
      operation
        ? VibORMErrorCode.VALIDATION_FAILED
        : VibORMErrorCode.INVALID_INPUT,
      {
        cause: options?.cause,
        diagnostics: options?.diagnostics,
        meta: operation
          ? { ...options?.meta, operation }
          : { ...options?.meta },
      }
    );
    this.issues = issues;
    this.source = source;
    this.operation = operation;
  }

  override toJSON(): Record<string, unknown> {
    return { ...super.toJSON(), source: this.source };
  }
}

function normalizeSource(
  sourceOrOperation: Operation | ValidationErrorSource,
  meta: VibORMErrorMeta | undefined
): ValidationErrorSource {
  if (typeof sourceOrOperation === "string") {
    const model = typeof meta?.model === "string" ? meta.model : undefined;
    return Object.freeze({
      kind: "operation",
      operation: publicOperationName(sourceOrOperation),
      ...(model ? { model } : {}),
    });
  }

  if (sourceOrOperation.kind === "operation") {
    return Object.freeze({
      ...sourceOrOperation,
      operation: publicOperationName(sourceOrOperation.operation),
    });
  }

  return Object.freeze({ ...sourceOrOperation });
}

function validationSubject(source: ValidationErrorSource): string {
  if (source.kind === "operation") return source.operation;
  if (source.kind === "registry") return "schema registry";
  if (source.kind === "schema-builder") return source.builder;
  return "JSON Schema";
}

/**
 * Type guard for validation errors
 */
export function isValidationError(error: unknown): error is ValidationError {
  return error instanceof ValidationError;
}
