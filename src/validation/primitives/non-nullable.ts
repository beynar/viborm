import type {
  InferInput,
  InferOutput,
  ValidationResult,
  VibSchema,
} from "../types";
import { createSchema, fail } from "./helpers";

// =============================================================================
// Non-nullable Schema
// =============================================================================

export interface NonNullableSchema<
  TWrapped extends VibSchema<any, any>,
  TInput = NonNullable<InferInput<TWrapped>>,
  TOutput = NonNullable<InferOutput<TWrapped>>,
> extends VibSchema<TInput, TOutput> {
  readonly type: "nonNullable";
  readonly wrapped: TWrapped;
}

/**
 * `wrapped` without its `null`: a nullable field's schema in a position where
 * `null` names nothing, such as a unique selector (a unique index admits any
 * number of NULLs). `null` is refused with `message`; every other value is
 * `wrapped`'s to judge.
 */
export function nonNullable<TWrapped extends VibSchema<any, any>>(
  wrapped: TWrapped,
  message: string
): NonNullableSchema<TWrapped> {
  const validate = wrapped["~standard"].validate;
  const schema = createSchema(
    "nonNullable",
    (value): ValidationResult<NonNullable<InferOutput<TWrapped>>> =>
      value === null
        ? fail(message)
        : (validate(value) as ValidationResult<
            NonNullable<InferOutput<TWrapped>>
          >)
  ) as NonNullableSchema<TWrapped>;
  (schema as { wrapped: TWrapped }).wrapped = wrapped;
  return schema;
}
