import type { Cast, ThunkCast, VibSchema } from "../types";
import { type ObjectOptions, type ObjectSchema, object } from "./object";

// =============================================================================
// Path Utilities for Nested Object Access
// =============================================================================

/**
 * Gets the value at a dot path in an object type.
 * Supports nested paths like "create.name" or "create.friends".
 */
type PathValue<T, P extends string> = P extends `${infer Key}.${infer Rest}`
  ? Key extends keyof T
    ? T[Key] extends Record<string, any>
      ? PathValue<T[Key], Rest>
      : never
    : never
  : P extends keyof T
    ? T[P]
    : never;

/**
 * Recursively extracts all dot paths that lead to VibSchema or ThunkCast instances.
 * Returns a union of all valid paths (e.g., "create" | "create.name").
 * Limited to 5 levels of nesting to avoid infinite recursion.
 */
type PathsToSchemas<
  T extends string,
  Prefix extends string = "",
  Depth extends readonly unknown[] = [],
> = Depth["length"] extends 5
  ? never
  : // Check if T is a VibSchema
    T extends VibSchema<any, any>
    ? Prefix
    : // Check if T is a ThunkCast (function returning Cast)
      T extends ThunkCast<any, any>
      ? Prefix
      : T extends () => Cast<any, any>
        ? Prefix
        : // Otherwise recurse into object properties
          T extends Record<string, any>
          ? {
              [K in keyof T]: K extends string
                ? PathsToSchemas<
                    T[K],
                    Prefix extends "" ? K : `${Prefix}.${K}`,
                    [...Depth, unknown]
                  >
                : never;
            }[keyof T]
          : never;

/**
 * Normalize a schema entry to VibSchema.
 * Handles both direct VibSchema and ThunkCast (unwrapping the thunk's return type).
 */
type NormalizeSchemaEntry<T> =
  T extends VibSchema<infer I, infer O>
    ? VibSchema<I, O>
    : T extends ThunkCast<infer I, infer O>
      ? VibSchema<I, O>
      : T extends () => Cast<infer I, infer O>
        ? VibSchema<I, O>
        : never;

/**
 * Gets the schema type at a specific path for a specific key.
 * Handles both VibSchema and ThunkCast entries.
 */
type SchemaAtPath<
  TObject extends Record<string, any>,
  TPath extends string,
  K extends keyof TObject,
> = NormalizeSchemaEntry<PathValue<TObject[K], TPath>>;

/**
 * Extracts all valid paths that lead to schemas from all keys in the object.
 */
export type AllPathsToSchemas<TObject extends Record<string, any>> = {
  [K in keyof TObject]: K extends string ? PathsToSchemas<TObject[K]> : never;
}[keyof TObject];

// =============================================================================
// FromObject Schema Types
// =============================================================================

/**
 * Options for fromObject schemas (same as ObjectOptions).
 */
export type FromObjectOptions<T = unknown> = ObjectOptions<T>;

/**
 * Compute the entries type from an object and path.
 */
type ComputeEntries<
  TObject extends Record<string, any>,
  TPath extends string,
> = {
  [K in keyof TObject]: SchemaAtPath<TObject, TPath, K>;
};

/**
 * FromObject schema type (alias for ObjectSchema with computed entries).
 */
export type FromObjectSchema<
  TEntries,
  TOpts extends FromObjectOptions | undefined = undefined,
  TInput = unknown,
  TOutput = unknown,
> = ObjectSchema<TEntries, TOpts>;

// =============================================================================
// FromObject Schema Implementation
// =============================================================================

/**
 * Runtime helper to get a nested value by dot path.
 */
function getNestedValue(obj: any, path: string): any {
  const parts = path.split(".");
  let current = obj;
  for (const part of parts) {
    if (current === null || current === undefined) {
      return undefined;
    }
    current = current[part];
  }
  return current;
}

/**
 * Extract entries from an object using a dot path.
 */
function extractEntries<TObject extends Record<string, any>>(
  object: TObject,
  path: string
): Record<string, VibSchema<any, any>> {
  const result: Record<string, VibSchema<any, any>> = {};
  for (const key in object) {
    const value = getNestedValue(object[key], path);
    if (value !== undefined) {
      result[key] = value;
    }
  }
  return result;
}

/**
 * Creates an object schema by extracting schemas from a record using a dot path.
 * This is a convenient way to build an object schema from a record with proper type inference.
 *
 * @param sourceObject - Source object containing nested schemas
 * @param path - Dot path to extract schemas (e.g., "create", "filter.where")
 * @param options - Schema options (same as object schema)
 *
 * @example
 * // Given a record of models with nested schemas:
 * const models = {
 *   user: { create: v.string(), update: v.string() },
 *   post: { create: v.number(), update: v.number() },
 * };
 *
 * // Extract all "create" schemas into a single object schema:
 * const createSchema = fromObject(models, "create");
 * // Validates: { user: string, post: number }
 *
 * // With options:
 * const optionalSchema = fromObject(models, "create", { optional: true });
 * // Validates: { user: string, post: number } | undefined
 *
 * @example
 * // Nested paths work too:
 * const nestedModels = {
 *   user: { schemas: { create: v.string() } },
 *   post: { schemas: { create: v.number() } },
 * };
 * const nestedSchema = fromObject(nestedModels, "schemas.create");
 * // Validates: { user: string, post: number }
 */
export function fromObject<
  TObject extends Record<string, any>,
  TPath extends string,
  // TPath extends AllPathsToSchemas<TObject>,
  const TOpts extends FromObjectOptions | undefined = undefined,
>(
  sourceObject: TObject,
  path: TPath,
  options?: TOpts
): ObjectSchema<ComputeEntries<TObject, TPath>, TOpts> {
  // Extract entries from the source object at the given path
  const entries = extractEntries(sourceObject, path);

  // Delegate to the existing object schema builder
  return object(entries, options) as ObjectSchema<
    ComputeEntries<TObject, TPath>,
    TOpts
  >;
}

export type { ComputeEntries as ComputeEntriesFromObject };
