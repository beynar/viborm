import type { Schema } from "@client/types";

type SchemaProxy<S extends Schema> = {
  [K in keyof S]: S[K]["~"]["schemas"];
};

/**
 * Creates a recursive proxy to access model schemas.
 * Usage: `getSchemas(mySchema).user.where` → returns the where schema for the user model
 */
export const getSchemas = <S extends Schema>(schema: S): SchemaProxy<S> => {
  const createRecursiveProxy = (target: unknown): unknown => {
    if (target === null || typeof target !== "object") {
      return target;
    }

    return new Proxy(target as object, {
      get(proxyTarget, key) {
        if (typeof key !== "string") {
          throw new Error("Key must be a string");
        }
        const value = (proxyTarget as Record<string, unknown>)[key];
        return createRecursiveProxy(value);
      },
    });
  };

  return new Proxy({} as SchemaProxy<S>, {
    get(_target, modelName) {
      if (typeof modelName !== "string") {
        throw new Error("Model name must be a string");
      }
      const model = schema[modelName];
      if (!model) {
        throw new Error(`Model "${modelName}" not found in schema`);
      }
      return createRecursiveProxy(model["~"].schemas);
    },
  });
};
