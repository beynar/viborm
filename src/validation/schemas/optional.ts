import type {
  VibSchema,
  InferInput,
  InferOutput,
  ValidationResult,
} from "../types";
import { ok, createSchema } from "../helpers";

// =============================================================================
// Optional Schema
// =============================================================================

export interface OptionalSchema<
  TWrapped extends VibSchema<any, any>,
  TDefault = undefined,
  TInput = InferInput<TWrapped> | undefined,
  TOutput = TDefault extends undefined
    ? InferOutput<TWrapped> | undefined
    : InferOutput<TWrapped>
> extends VibSchema<TInput, TOutput> {
  readonly type: "optional";
  readonly wrapped: TWrapped;
  readonly default: TDefault;
}

// Compute output type based on default
type OptionalOutput<
  TWrapped extends VibSchema<any, any>,
  TDefault
> = TDefault extends undefined
  ? InferOutput<TWrapped> | undefined
  : InferOutput<TWrapped>;

/**
 * Create an optional schema that allows undefined values.
 * Optionally provide a default value for when undefined is received.
 *
 * @example
 * const optionalName = v.optional(v.string());
 * const nameWithDefault = v.optional(v.string(), "Unknown");
 */
export function optional<
  TWrapped extends VibSchema<any, any>,
  TDefault extends
    | InferOutput<TWrapped>
    | (() => InferOutput<TWrapped>)
    | undefined = undefined
>(
  wrapped: TWrapped,
  defaultValue?: TDefault
): OptionalSchema<TWrapped, TDefault> {
  // Cache validate function directly
  const validate = wrapped["~standard"].validate;

  const schema = createSchema(
    "optional",
    (value): ValidationResult<OptionalOutput<TWrapped, TDefault>> => {
      // Handle undefined - fast path
      if (value === undefined) {
        if (defaultValue !== undefined) {
          const resolved =
            typeof defaultValue === "function"
              ? (defaultValue as () => InferOutput<TWrapped>)()
              : defaultValue;
          return ok(resolved) as ValidationResult<
            OptionalOutput<TWrapped, TDefault>
          >;
        }
        return ok(undefined) as ValidationResult<
          OptionalOutput<TWrapped, TDefault>
        >;
      }

      // Delegate to wrapped schema (cast to our result type)
      return validate(value) as ValidationResult<
        OptionalOutput<TWrapped, TDefault>
      >;
    }
  ) as OptionalSchema<TWrapped, TDefault>;

  // Add references
  (schema as any).wrapped = wrapped;
  (schema as any).default = defaultValue;

  return schema;
}
