import { buildSchema, ok } from "../helpers";
import type {
  ComputeInput,
  ComputeOutput,
  ScalarOptions,
  VibSchema,
} from "../types";

// =============================================================================
// Instance Schema (for class instances like Uint8Array, Buffer, etc.)
// =============================================================================

export interface InstanceSchema<
  TClass extends abstract new (
    ...args: any
  ) => any,
  TInput = InstanceType<TClass>,
  TOutput = InstanceType<TClass>,
> extends VibSchema<TInput, TOutput> {
  readonly type: "instance";
}

/**
 * Create an instance schema for validating class instances.
 *
 * @example
 * const buffer = v.instance(Uint8Array);
 * const blob = v.union([v.instance(Uint8Array), v.instance(Buffer)]);
 */
export function instance<
  TClass extends abstract new (
    ...args: any
  ) => any,
  const Opts extends
    | ScalarOptions<InstanceType<TClass>, any>
    | undefined = undefined,
>(
  classConstructor: TClass,
  options?: Opts
): InstanceSchema<
  TClass,
  ComputeInput<InstanceType<TClass>, Opts>,
  ComputeOutput<InstanceType<TClass>, Opts>
> {
  // Pre-compute error for fast path
  const typeName = classConstructor.name || "instance";
  const errorResult = Object.freeze({
    issues: Object.freeze([Object.freeze({ message: `Expected ${typeName}` })]),
  });

  // Create base validator
  const baseValidate = (value: unknown) =>
    value instanceof classConstructor
      ? ok(value as InstanceType<TClass>)
      : errorResult;

  return buildSchema("instance", baseValidate, options, {
    ctor: classConstructor,
  }) as InstanceSchema<
    TClass,
    ComputeInput<InstanceType<TClass>, Opts>,
    ComputeOutput<InstanceType<TClass>, Opts>
  >;
}
