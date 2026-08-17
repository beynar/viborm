import type {
  ObjectOptions,
  ObjectSchema,
} from "@validation/primitives/object";
import { isRecord } from "@validation/value-guards";

const SELECT_INCLUDE_EXCLUSIVITY_ERROR = {
  issues: [
    {
      message:
        "Mutually exclusive fields cannot be used together: select, include",
    },
  ],
};

/**
 * Both projections are present only when both carry a VALUE.
 *
 * Reading key PRESENCE instead refused the spread-an-optional idiom the whole
 * client surface is documented to accept — `{ ...(sel && { select: sel }),
 * ...(inc && { include: inc }) }` spelled out, or a helper forwarding two
 * optional props (`{ select: args.select, include: args.include }`) — because an
 * explicitly-`undefined` key is an ABSENT key at the parse boundary
 * (`src/validation/primitives/object.ts`). `withOmitProjection` uses the same
 * value-based presence rule when it decides whether an explicit select exists,
 * so a payload whose second projection is `undefined` names exactly one
 * projection and must be accepted.
 */
const hasSelectAndInclude = (value: unknown): boolean => {
  return (
    isRecord(value) && value.select !== undefined && value.include !== undefined
  );
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
