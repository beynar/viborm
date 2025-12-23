import { inferred } from "../inferred";
import type { VibSchema, ScalarOptions, ComputeInput, ComputeOutput } from "../types";
import { applyOptions, fail, ok, createSchema } from "../helpers";

// =============================================================================
// Instance Schema (for class instances like Uint8Array, Buffer, etc.)
// =============================================================================

export interface InstanceSchema<
  TClass extends abstract new (...args: any) => any,
  TInput = InstanceType<TClass>,
  TOutput = InstanceType<TClass>
> extends VibSchema<TInput, TOutput> {
  readonly type: "instance";
  readonly class: TClass;
}

/**
 * Create a validator for class instances.
 */
function createInstanceValidator<TClass extends abstract new (...args: any) => any>(
  classConstructor: TClass
) {
  return (value: unknown) => {
    if (!(value instanceof classConstructor)) {
      const expected = classConstructor.name || "instance";
      return fail(`Expected ${expected}, received ${typeof value}`);
    }
    return ok(value as InstanceType<TClass>);
  };
}

/**
 * Create an instance schema for validating class instances.
 * 
 * @example
 * const buffer = v.instance(Uint8Array);
 * const blob = v.union([v.instance(Uint8Array), v.instance(Buffer)]);
 */
export function instance<
  TClass extends abstract new (...args: any) => any,
  const Opts extends ScalarOptions<InstanceType<TClass>, any> | undefined = undefined
>(
  classConstructor: TClass,
  options?: Opts
): InstanceSchema<
  TClass,
  ComputeInput<InstanceType<TClass>, Opts>,
  ComputeOutput<InstanceType<TClass>, Opts>
> {
  const validate = createInstanceValidator(classConstructor);
  const schema = createSchema("instance", (value) =>
    applyOptions(value, validate, options, classConstructor.name || "instance")
  ) as InstanceSchema<
    TClass,
    ComputeInput<InstanceType<TClass>, Opts>,
    ComputeOutput<InstanceType<TClass>, Opts>
  >;

  // Add class reference
  (schema as any).class = classConstructor;

  return schema;
}

