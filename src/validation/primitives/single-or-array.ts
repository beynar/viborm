// Single or Array Schema
// Accepts either a single value or an array of values, normalizes to array

import type { VibSchema } from "../types";
import { array } from "./array";
import { coerce } from "./transform";
import { union } from "./union";

export type SingleOrArraySchema<S extends VibSchema> = ReturnType<
  typeof singleOrArray<S>
>;

/**
 * Creates a schema that accepts either a single value or an array of values.
 * Single values are coerced to a single-element array for consistent output.
 *
 * @example
 * const schema = v.singleOrArray(v.string());
 * // Accepts: "foo" -> ["foo"]
 * // Accepts: ["foo", "bar"] -> ["foo", "bar"]
 */
export const singleOrArray = <S extends VibSchema>(schema: S) => {
  return union([
    coerce(schema, (v: S[" vibInferred"]["1"]) => [v]),
    array(schema),
  ]);
};
