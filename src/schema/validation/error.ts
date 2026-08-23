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
    // `candidates` is the one array-valued field, so the snapshot freezes it
    // too: a shallow freeze would publish an immutable issue wrapping a
    // caller-mutable list.
    const snapshot = Object.freeze(
      issues.map((issue) =>
        Object.freeze(
          issue.candidates
            ? { ...issue, candidates: Object.freeze([...issue.candidates]) }
            : { ...issue }
        )
      )
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

/**
 * ONE reading of a value pulled out of a `catch`, shared by every gate boundary
 * that turns a throw into a diagnostic.
 *
 * The throwers this gate catches are all in-repo and all throw `Error`s — the
 * target once-cell normalizes before the resolver ever sees a getter's throw,
 * and the physical-name owner throws its own error type. Each catch site
 * spelling this narrowing itself made three owners for one rule and three arms
 * that no schema can reach; the narrowing lives here instead, where it is
 * witnessed directly.
 */
export function thrownAsError(thrown: unknown): Error {
  return thrown instanceof Error ? thrown : new Error(String(thrown));
}
