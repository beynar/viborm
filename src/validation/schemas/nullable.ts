import { inferred } from "../inferred";
import type { VibSchema, InferInput, InferOutput, ThunkCast } from "../types";
import { ok, createSchema, validateSchema } from "../helpers";

// =============================================================================
// Nullable Schema
// =============================================================================

export interface NullableSchema<
  TWrapped extends VibSchema<any, any> | ThunkCast<any, any>,
  TDefault = undefined,
  TInput = InferInput<TWrapped> | null,
  TOutput = TDefault extends undefined
    ? InferOutput<TWrapped> | null
    : InferOutput<TWrapped>
> extends VibSchema<TInput, TOutput> {
  readonly type: "nullable";
  readonly wrapped: TWrapped;
  readonly default: TDefault;
}

/**
 * Resolve a thunk or return the schema directly.
 */
function resolveWrapped<T extends VibSchema<any, any> | ThunkCast<any, any>>(
  wrapped: T
): VibSchema<any, any> {
  if (typeof wrapped === "function") {
    return wrapped() as VibSchema<any, any>;
  }
  return wrapped;
}

/**
 * Create a nullable schema that allows null values.
 * Optionally provide a default value for when null is received.
 * Supports thunks for circular references.
 *
 * @example
 * const nullableName = v.nullable(v.string());
 * const nameWithDefault = v.nullable(v.string(), "Unknown");
 * const nullableSelf = v.nullable(() => selfSchema); // Thunk
 */
export function nullable<
  TWrapped extends VibSchema<any, any> | ThunkCast<any, any>,
  TDefault extends
    | InferOutput<TWrapped>
    | (() => InferOutput<TWrapped>)
    | undefined = undefined
>(
  wrapped: TWrapped,
  defaultValue?: TDefault
): NullableSchema<TWrapped, TDefault> {
  // Cache resolved schema
  let resolvedWrapped: VibSchema<any, any> | undefined;

  const schema = createSchema("nullable", (value) => {
    // Handle null
    if (value === null) {
      if (defaultValue !== undefined) {
        const resolved =
          typeof defaultValue === "function"
            ? (defaultValue as () => InferOutput<TWrapped>)()
            : defaultValue;
        return ok(resolved);
      }
      return ok(null);
    }

    // Resolve thunk on first use
    if (!resolvedWrapped) {
      resolvedWrapped = resolveWrapped(wrapped);
    }

    // Delegate to wrapped schema
    return validateSchema(resolvedWrapped, value);
  }) as NullableSchema<TWrapped, TDefault>;

  // Add references
  (schema as any).wrapped = wrapped;
  (schema as any).default = defaultValue;

  return schema;
}
