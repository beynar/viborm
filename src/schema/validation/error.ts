import { VibORMError, VibORMErrorCode } from "../../errors/base";
import type { SchemaValidationIssue } from "./types";

export class SchemaValidationError extends VibORMError {
  static override readonly diagnosticName = "SchemaValidationError";

  declare readonly code: typeof VibORMErrorCode.INVALID_INPUT;
  readonly issues: readonly SchemaValidationIssue[];

  constructor(
    issues: readonly SchemaValidationIssue[],
    options?: { cause?: Error | undefined }
  ) {
    const snapshot = Object.freeze(
      issues.map((issue) => Object.freeze({ ...issue }))
    );
    const messages = snapshot.map(
      (issue) => `[${issue.code}] ${issue.message}`
    );
    super(
      `Schema validation failed:\n${messages.join("\n")}`,
      VibORMErrorCode.INVALID_INPUT,
      options?.cause ? { cause: options.cause } : undefined
    );
    this.issues = snapshot;
  }

  override toJSON(): Record<string, unknown> {
    return { ...super.toJSON(), issues: this.issues };
  }
}

export function isSchemaValidationError(
  error: unknown
): error is SchemaValidationError {
  return error instanceof SchemaValidationError;
}
