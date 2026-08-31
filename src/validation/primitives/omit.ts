import { type ObjectSchema, object } from "./object";
import type { V } from "./v";

/**
 * Create a new object schema with specific keys omitted.
 *
 * @param schema - The source object schema
 * @param keys - Array of keys to omit from the schema
 * @returns A new object schema without the specified keys
 *
 * @example
 * const user = v.object({
 *   id: v.string(),
 *   name: v.string(),
 *   password: v.string(),
 * });
 *
 * const publicUser = v.omit(user, ['password']);
 * // { id?: string; name?: string }
 */
export function omit<
  TSchema extends ObjectSchema<any, any>,
  const TKeys extends readonly (keyof TSchema["entries"])[] | undefined,
>(schema: TSchema, keys: TKeys): V.Omit<TSchema, TKeys> {
  return object(schema.entries, {
    ...(schema.options || {}),
    omit: keys,
  }) as V.Omit<TSchema, TKeys>;
}
