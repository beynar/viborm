import type {
  ObjectOptions,
  ObjectSchema,
} from "@validation/primitives/object";

/**
 * `createMany` / `updateMany` return their affected rows straight out of the
 * write statement — `RETURNING` on a capable driver, capture-and-refetch on a
 * non-returning one. Neither shape can join a relation into that row set, so
 * `include` is refused at the parse boundary with a message that names the
 * alternative instead of the bare strict-object "Unknown key: include".
 *
 * This is the SAME restriction the removed `createManyAndReturn` /
 * `updateManyAndReturn` operations carried; the implicit-returning surface keeps
 * it, it just says so out loud now.
 */
export const rejectInclude = <
  TEntries,
  TOpts extends ObjectOptions | undefined,
>(
  schema: ObjectSchema<TEntries, TOpts>,
  operation: string
): ObjectSchema<TEntries, TOpts> => {
  const error = {
    issues: [
      {
        message: `'include' is not supported on '${operation}': its rows are returned by the write statement itself, so relations cannot be joined in. Use 'select' with scalar fields and read relations in a separate query.`,
      },
    ],
  };
  const standard = schema["~standard"];
  const validate: typeof standard.validate = (value) => {
    if (hasInclude(value)) return error;
    return standard.validate(value);
  };

  return {
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
};

const hasInclude = (value: unknown): boolean => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.hasOwn(value, "include");
};
