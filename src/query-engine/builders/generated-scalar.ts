import type { Scalar } from "@schema/scalars";

export function isMissingGeneratedIncrement(
  field: Scalar | undefined,
  value: unknown
): boolean {
  const state = field?.["~"].state;
  if (state?.autoGenerate?.kind !== "increment") {
    return false;
  }

  return value === undefined;
}

/**
 * Values omitted from an INSERT so the database can supply them. Ordinary
 * scalar defaults are application values after validation and must remain in
 * the row; only an absent increment value is database-owned.
 */
export function shouldOmitInsertValue(
  field: Scalar | undefined,
  value: unknown
): boolean {
  return value === undefined || isMissingGeneratedIncrement(field, value);
}
