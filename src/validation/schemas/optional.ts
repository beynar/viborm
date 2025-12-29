import type {
  VibSchema,
  ThunkCast,
  Cast,
  InferInput,
  InferOutput,
  ValidationResult,
} from "../types";
import { ok, createSchema } from "../helpers";

// =============================================================================
// Optional Schema
// =============================================================================

/**
 * Schema or thunk that can be wrapped with optional.
 */
export type WrappableSchema =
  | VibSchema<any, any>
  | ThunkCast<any, any>
  | (() => Cast<any, any>);

/**
 * Unwrap a schema or thunk to get the underlying schema type.
 */
type UnwrapSchema<T> = T extends VibSchema<any, any>
  ? T
  : T extends ThunkCast<infer I, infer O>
  ? VibSchema<I, O>
  : T extends () => Cast<infer I, infer O>
  ? VibSchema<I, O>
  : never;

export interface OptionalSchema<
  TWrapped extends WrappableSchema,
  TDefault = undefined,
  TInput = InferInput<UnwrapSchema<TWrapped>> | undefined,
  TOutput = TDefault extends undefined
    ? InferOutput<UnwrapSchema<TWrapped>> | undefined
    : InferOutput<UnwrapSchema<TWrapped>>
> extends VibSchema<TInput, TOutput> {
  readonly type: "optional";
  readonly wrapped: TWrapped;
  readonly default: TDefault;
}

// Compute output type based on default
type OptionalOutput<
  TWrapped extends WrappableSchema,
  TDefault
> = TDefault extends undefined
  ? InferOutput<UnwrapSchema<TWrapped>> | undefined
  : InferOutput<UnwrapSchema<TWrapped>>;

/**
 * Create an optional schema that allows undefined values.
 * Supports both direct schemas and thunks (for circular references).
 * Optionally provide a default value for when undefined is received.
 *
 * @example
 * const optionalName = v.optional(v.string());
 * const nameWithDefault = v.optional(v.string(), "Unknown");
 *
 * // With thunks (circular references)
 * const node = v.object({ child: v.optional(() => node) });
 */
export function optional<
  TWrapped extends WrappableSchema,
  TDefault extends
    | InferOutput<UnwrapSchema<TWrapped>>
    | (() => InferOutput<UnwrapSchema<TWrapped>>)
    | undefined = undefined
>(
  wrapped: TWrapped,
  defaultValue?: TDefault
): OptionalSchema<TWrapped, TDefault> {
  // Check if wrapped is a thunk (function) or direct schema
  const isThunk = typeof wrapped === "function" && !("~standard" in wrapped);

  // Lazy resolution for thunks
  let resolvedSchema: VibSchema<any, any> | null = null;
  let cachedValidate: ((value: unknown) => any) | null = null;

  const getValidate = () => {
    if (cachedValidate) return cachedValidate;

    if (isThunk) {
      // Resolve thunk lazily
      resolvedSchema = (wrapped as () => VibSchema<any, any>)();
      cachedValidate = resolvedSchema["~standard"].validate;
    } else {
      // Direct schema - cache immediately
      cachedValidate = (wrapped as VibSchema<any, any>)["~standard"].validate;
    }

    return cachedValidate;
  };

  // If not a thunk, cache validate immediately for performance
  if (!isThunk) {
    cachedValidate = (wrapped as VibSchema<any, any>)["~standard"].validate;
  }

  const schema = createSchema(
    "optional",
    (value): ValidationResult<OptionalOutput<TWrapped, TDefault>> => {
      // Handle undefined - fast path
      if (value === undefined) {
        if (defaultValue !== undefined) {
          const resolved =
            typeof defaultValue === "function"
              ? (defaultValue as () => InferOutput<UnwrapSchema<TWrapped>>)()
              : defaultValue;
          return ok(resolved) as ValidationResult<
            OptionalOutput<TWrapped, TDefault>
          >;
        }
        return ok(undefined) as ValidationResult<
          OptionalOutput<TWrapped, TDefault>
        >;
      }

      // Delegate to wrapped schema (resolve thunk if needed)
      const validate = getValidate();
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
