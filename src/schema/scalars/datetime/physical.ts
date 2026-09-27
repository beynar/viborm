import type { DateTimePhysicalForm } from "@validation/primitives/datetime-physical-codec";
import { type NativeTypeDeclaration, nativeTypeFor } from "../native-types";

/**
 * The physical vocabulary SQLite assigns to one DateTime native declaration.
 *
 * A missing declaration, a declaration that selects nothing on SQLite, and
 * explicit TEXT all use SQLite's default timestamp text. INTEGER is epoch milliseconds and
 * REAL is a Julian day. Schema validation, query lowering, result parsing, and
 * migration defaults consume this same interpretation.
 */
export function sqliteDateTimePhysicalForm(
  declaration: NativeTypeDeclaration | undefined
): DateTimePhysicalForm {
  const nativeType = nativeTypeFor(declaration, "sqlite");
  if (nativeType === undefined) return "text";
  if (nativeType.type === "INTEGER") return "epochMillis";
  return nativeType.type === "REAL" ? "julianDay" : "text";
}
