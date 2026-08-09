import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { ObjectOptions, ObjectSchema } from "../primitives/object";
import v from "../primitives/v";
import type { InferInput, InferOutput } from "../types";
import { isRecord } from "../value-guards";

type MutationKey<T> = Extract<keyof T, string>;

type InactiveMutationValue<T> = false extends T ? false : never;

type EmptyMutation<T> = {
  [Key in MutationKey<T>]?: InactiveMutationValue<T[Key]>;
};

type MutationArm<T, Active extends MutationKey<T>> = {
  [Key in Active]-?: Exclude<T[Key], undefined>;
} & {
  [Key in Exclude<MutationKey<T>, Active>]?: InactiveMutationValue<T[Key]>;
};

type AtMostOneMutation<T> =
  | EmptyMutation<T>
  | {
      [Key in MutationKey<T>]: MutationArm<T, Key>;
    }[MutationKey<T>];

type VacateThenSupplyMutation<
  T,
  Vacate extends string,
  Supply extends string,
> = Exclude<Vacate | Supply, MutationKey<T>> extends never
  ? MutationArm<T, Extract<Vacate | Supply, MutationKey<T>>>
  : never;

type ChildHeldReplacementMutation<T> =
  | VacateThenSupplyMutation<T, "disconnect", "connectOrCreate">
  | VacateThenSupplyMutation<T, "disconnect", "connect">
  | VacateThenSupplyMutation<T, "disconnect", "create">
  | VacateThenSupplyMutation<T, "delete", "connect">
  | VacateThenSupplyMutation<T, "delete", "create">;

type ToOneMutationInputValue<
  T,
  AllowVacateThenSupply extends boolean,
> = T extends object
  ?
      | AtMostOneMutation<T>
      | (AllowVacateThenSupply extends true
          ? ChildHeldReplacementMutation<T>
          : never)
  : T;

type BaseObjectSchema<
  Entries,
  Options extends ObjectOptions | undefined,
> = ObjectSchema<Entries, Options>;

type ToOneMutationInput<
  Entries,
  Options extends ObjectOptions | undefined,
  AllowVacateThenSupply extends boolean,
> = ToOneMutationInputValue<
  InferInput<BaseObjectSchema<Entries, Options>>,
  AllowVacateThenSupply
>;

type ToOneMutationOutput<
  Entries,
  Options extends ObjectOptions | undefined,
> = InferOutput<BaseObjectSchema<Entries, Options>>;

/** A to-one mutation object with its allowed active-operation lattice. */
export interface ToOneMutationSchema<
  Entries extends object,
  Options extends ObjectOptions | undefined = undefined,
  AllowVacateThenSupply extends boolean = false,
> extends ObjectSchema<
    Entries,
    Options,
    ToOneMutationInput<Entries, Options, AllowVacateThenSupply>,
    ToOneMutationOutput<Entries, Options>
  > {}

function isVacateThenSupply(active: readonly string[]): boolean {
  if (active.length !== 2) return false;
  const has = (key: string) => active.includes(key);
  return (
    (has("disconnect") &&
      (has("connectOrCreate") || has("connect") || has("create"))) ||
    (has("delete") && (has("connect") || has("create")))
  );
}

function enforceAtMostOneMutation<Output>(
  result: StandardSchemaV1.Result<Output>,
  operationKeys: readonly string[],
  allowVacateThenSupply: boolean
): StandardSchemaV1.Result<Output> {
  if (result.issues) return result;
  const output = result.value;
  if (!isRecord(output)) return result;

  const active: string[] = [];
  for (const key of operationKeys) {
    const value = output[key];
    if (value !== undefined && value !== false) active.push(key);
  }
  if (
    active.length <= 1 ||
    (allowVacateThenSupply && isVacateThenSupply(active))
  ) {
    return result;
  }
  return {
    issues: [
      {
        message: `Unsupported to-one operation combination: ${active.join(", ")}`,
      },
    ],
  };
}

/**
 * Validate the underlying object once, then enforce to-one operation
 * compatibility on its canonical output. `false` remains a no-op for boolean
 * mutation verbs.
 */
export function toOneMutationSchema<
  Entries extends object,
  const Options extends ObjectOptions | undefined = undefined,
  const AllowVacateThenSupply extends boolean = false,
>(
  entries: Entries,
  options?: Options,
  allowVacateThenSupply?: AllowVacateThenSupply
): ToOneMutationSchema<Entries, Options, AllowVacateThenSupply> {
  const schema = v.object(entries, options);
  const operationKeys = Object.keys(entries);
  const validate = schema["~standard"].validate;
  const wrappedValidate: typeof validate = (value, validationOptions) =>
    enforceAtMostOneMutation(
      validate(value, validationOptions),
      operationKeys,
      allowVacateThenSupply === true
    );
  Object.defineProperty(schema["~standard"], "validate", {
    value: wrappedValidate,
    configurable: true,
    enumerable: true,
    writable: true,
  });

  return schema as ToOneMutationSchema<Entries, Options, AllowVacateThenSupply>;
}
