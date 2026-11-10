import type { Scope } from "./api";

/** A relation link carries an object filter and a display label; the client validates the filter's fields. */
export function readScope(encoded: string | null): Scope | undefined {
  if (encoded === null) return undefined;
  const value: unknown = JSON.parse(encoded);
  if (
    typeof value !== "object" ||
    value === null ||
    !("where" in value) ||
    typeof value.where !== "object" ||
    value.where === null ||
    Array.isArray(value.where) ||
    !("label" in value) ||
    typeof value.label !== "string"
  )
    throw new Error("Invalid relation link");
  return {
    where: Object.fromEntries(Object.entries(value.where)),
    label: value.label,
  };
}
