import { createSchemaRegistry, type ModelSchemas } from "@validation";
import type { AnyModel } from "./model";

type Schema = Record<string, AnyModel>;

type SchemaProxy<S extends Schema> = {
  [K in keyof S]: ModelSchemas<S[K]>;
};

/**
 * Creates a registry-backed proxy to access model validation schemas.
 * Usage: `getSchemas(mySchema).user.core.where` → returns the where schema for the user model
 *
 * This is REGISTRY-ONLY construction — a schema surface without a client — and
 * plan §7.3 makes it one of the three effect-capable boundaries: the operation
 * schemas it returns decide which mutation verbs a caller may spell, which is a
 * topology answer. So it hydrates and runs the structural relation-definition
 * gate once, for its own lifecycle, exactly as client construction does.
 */
export const getSchemas = <S extends Schema>(schema: S): SchemaProxy<S> => {
  return createSchemaRegistry(schema).proxy;
};
