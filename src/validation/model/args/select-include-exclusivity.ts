import type {
  ObjectOptions,
  ObjectSchema,
} from "@validation/primitives/object";

const SELECT_INCLUDE_EXCLUSIVITY_ERROR = {
  issues: [
    {
      message:
        "Mutually exclusive fields cannot be used together: select, include",
    },
  ],
};

const hasSelectAndInclude = (value: unknown): boolean => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  return Object.hasOwn(value, "select") && Object.hasOwn(value, "include");
};

export const rejectSelectInclude = <
  TEntries,
  TOpts extends ObjectOptions | undefined,
>(
  schema: ObjectSchema<TEntries, TOpts>
): ObjectSchema<TEntries, TOpts> => {
  const standard = schema["~standard"];
  const validate: typeof standard.validate = (value) => {
    if (hasSelectAndInclude(value)) {
      return SELECT_INCLUDE_EXCLUSIVITY_ERROR;
    }
    return standard.validate(value);
  };

  const wrappedSchema: ObjectSchema<TEntries, TOpts> = {
    ...schema,
    parse: validate,
    "~standard": {
      version: standard.version,
      vendor: standard.vendor,
      validate,
      get types() {
        return standard.types;
      },
      get jsonSchema() {
        return standard.jsonSchema;
      },
    },
  };

  return wrappedSchema;
};
