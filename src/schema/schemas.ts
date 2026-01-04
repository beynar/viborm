import { Schema } from "@client/types";

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
        if (typeof key !== "string") return undefined;
        const value = (proxyTarget as Record<string, unknown>)[key];
        return createRecursiveProxy(value);
      },
    });
  };

  return new Proxy({} as SchemaProxy<S>, {
    get(_target, modelName) {
      if (typeof modelName !== "string") return undefined;
      const model = schema[modelName];
      if (!model) return undefined;
      return createRecursiveProxy(model["~"].schemas);
    },
  });
};
