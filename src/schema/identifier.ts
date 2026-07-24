const VALID_SCHEMA_IDENTIFIER = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
const OBJECT_PROTOTYPE_PROPERTY_NAMES = new Set(
  Object.getOwnPropertyNames(Object.prototype)
);
export const MAX_SCHEMA_IDENTIFIER_BYTES = 63;

export function isValidSchemaIdentifier(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= MAX_SCHEMA_IDENTIFIER_BYTES &&
    VALID_SCHEMA_IDENTIFIER.test(value) &&
    !OBJECT_PROTOTYPE_PROPERTY_NAMES.has(value)
  );
}
