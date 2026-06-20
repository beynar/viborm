// Shorthand Coercion Schemas
// Utilities for coercing simple values to structured objects

import type { VibSchema } from "../types";
import { coerce } from "./transform";

/**
 * Coerces a value to a filter object with `equals` key.
 * Used for shorthand filter syntax: `"value"` -> `{ equals: "value" }`
 */
export const shorthandFilter = <S extends VibSchema>(schema: S) =>
  coerce(schema, (val: S[" vibInferred"]["1"]) => ({ equals: val }));

/**
 * Coerces a value to an update object with `set` key.
 * Used for shorthand update syntax: `"value"` -> `{ set: "value" }`
 */
export const shorthandUpdate = <S extends VibSchema>(schema: S) =>
  coerce(schema, (val: S[" vibInferred"]["1"]) => ({ set: val }));

/**
 * Coerces a single value to an array.
 * Used for shorthand array syntax: `"value"` -> `["value"]`
 */
export const shorthandArray = <S extends VibSchema>(schema: S) =>
  coerce(
    schema,
    (val: S[" vibInferred"]["1"]) => [val] as [S[" vibInferred"]["1"]]
  );
