import { isError } from "../errors/diagnostic-safety";
import { sanitizeErrorCause } from "../errors/diagnostics";
import type { ValidationFailure } from "./types";

const PARSE_FAILURE_CAUSE = Symbol("viborm.validation.parseFailureCause");

/** Contain a thrown validator value while retaining sanitized cause evidence. */
export function validationFailureFromThrown(cause: unknown): ValidationFailure {
  const error = isError(cause)
    ? cause
    : new Error("A non-Error value was thrown.", { cause });
  const failure: ValidationFailure = {
    issues: [{ message: "Schema validation failed unexpectedly" }],
  };
  Object.defineProperty(failure, PARSE_FAILURE_CAUSE, {
    value: sanitizeErrorCause(error),
  });
  return failure;
}

/** Read the sanitized cause retained by the public parse boundary, if any. */
export function readValidationFailureCause(value: unknown): Error | undefined {
  try {
    if (typeof value !== "object" || value === null) return undefined;
    const cause = Reflect.get(value, PARSE_FAILURE_CAUSE);
    return isError(cause) ? cause : undefined;
  } catch {
    return undefined;
  }
}
