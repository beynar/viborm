// How this module reaches the builders.
//
// An interpreter enters them dynamically: the typed overloads describe what a
// human WRITES — a literal getter, literal variant keys, a literal modifier
// name — and a declaration assembled from data satisfies none of them
// statically. The two entries here are the whole of that.
//
// `ScalarType` (the state vocabulary) and the `s.*` factory names disagree in
// two places for historical reasons — `bigint`/`bigInt` and `datetime`/
// `dateTime` — so ONE record states the correspondence and the type system
// keeps it exhaustive. `enum` is absent because its factory takes the values
// its type carries, so it has its own construction site.

import {
  bigInt,
  blob,
  boolean,
  date,
  dateTime,
  decimal,
  int,
  json,
  number,
  point,
  string,
  time,
  vector,
} from "@schema/scalars";
import type { Scalar } from "@schema/scalars/base";
import type { ScalarType } from "@schema/scalars/common";
import type { NativeType } from "@schema/scalars/native-types";

export type ScalarFactory = (native?: NativeType) => Scalar;

export const SCALAR_FACTORIES: Record<
  Exclude<ScalarType, "enum">,
  ScalarFactory
> = {
  string,
  int,
  number,
  decimal,
  boolean,
  datetime: dateTime,
  date,
  time,
  bigint: bigInt,
  json,
  blob,
  vector,
  point,
};

/** Every `type` a scalar field node may declare. */
export const SCALAR_TYPE_NAMES: ReadonlySet<string> = new Set([
  ...Object.keys(SCALAR_FACTORIES),
  "enum",
]);

/**
 * One builder method, reached by name.
 *
 * The class surface is the only table of which modifiers a scalar type has, so
 * an absent method is exactly what "this type has no such modifier" means —
 * both when the interpreter is asked to apply one and when the serializer asks
 * whether a state difference was even spellable.
 */
export function builderMethod(
  owner: object,
  name: string
): ((...args: any[]) => any) | undefined {
  const candidate = Reflect.get(owner, name);
  return typeof candidate === "function" ? candidate : undefined;
}
