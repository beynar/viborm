import { inferred } from "../inferred";
import type { VibSchema, InferInput, InferOutput, ThunkCast } from "../types";
import { ok, createSchema, validateSchema } from "../helpers";

// =============================================================================
// Optional Schema
// =============================================================================

export interface OptionalSchema<
  TWrapped extends VibSchema<any, any> | ThunkCast<any, any>,
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
 * Create an optional schema that allows undefined values.
 * Optionally provide a default value for when undefined is received.
 * Supports thunks for circular references.
 *
 * @example
 * const optionalName = v.optional(v.string());
 * const nameWithDefault = v.optional(v.string(), "Unknown");
 * const optionalSelf = v.optional(() => selfSchema); // Thunk
 */
export function optional<
  TWrapped extends VibSchema<any, any> | ThunkCast<any, any>,
  TDefault extends
    | InferOutput<TWrapped>
    | (() => InferOutput<TWrapped>)
    | undefined = undefined
>(
  wrapped: TWrapped,
  defaultValue?: TDefault
): OptionalSchema<TWrapped, TDefault> {
  // Cache resolved schema
  let resolvedWrapped: VibSchema<any, any> | undefined;

  const schema = createSchema("optional", (value) => {
    // Handle undefined
    if (value === undefined) {
      if (defaultValue !== undefined) {
        const resolved =
          typeof defaultValue === "function"
            ? (defaultValue as () => InferOutput<TWrapped>)()
            : defaultValue;
        return ok(resolved);
      }
      return ok(undefined);
    }

    // Resolve thunk on first use
    if (!resolvedWrapped) {
      resolvedWrapped = resolveWrapped(wrapped);
    }

    // Delegate to wrapped schema
    return validateSchema(resolvedWrapped, value);
  }) as OptionalSchema<TWrapped, TDefault>;

  // Add references
  (schema as any).wrapped = wrapped;
  (schema as any).default = defaultValue;

  return schema;
}
