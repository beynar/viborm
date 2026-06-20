import { createSchemaRegistry, type ModelSchemas } from "@validation";
import type { AnyModel } from "./model";

type Schema = Record<string, AnyModel>;

type SchemaProxy<S extends Schema> = {
  [K in keyof S]: ModelSchemas<S[K]>;
};

/**
 * Creates a registry-backed proxy to access model validation schemas.
 * Usage: `getSchemas(mySchema).user.core.where` → returns the where schema for the user model
 */
export const getSchemas = <S extends Schema>(schema: S): SchemaProxy<S> => {
  return createSchemaRegistry(schema).proxy;
};
