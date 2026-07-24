import { QueryEngineError } from "../types";

/** Normalize groupBy fields and reject duplicate output columns. */
export function getGroupByFields(value: unknown): string[] {
  const fields = Array.isArray(value)
    ? value.filter((field): field is string => typeof field === "string")
    : typeof value === "string"
      ? [value]
      : [];
  const uniqueFields = new Set(fields);
  if (uniqueFields.size !== fields.length) {
    throw new QueryEngineError(
      "GroupBy operation does not allow duplicate fields in 'by'"
    );
  }
  return fields;
}
