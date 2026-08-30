import type { DateTimePhysicalForm } from "@validation/primitives/datetime-physical-codec";
import type { NativeType } from "../native-types";

/**
 * The physical vocabulary SQLite assigns to one DateTime native declaration.
 *
 * A missing declaration, a declaration for another dialect, and explicit TEXT
 * all use SQLite's default timestamp text. INTEGER is epoch milliseconds and
 * REAL is a Julian day. Schema validation, query lowering, result parsing, and
 * migration defaults consume this same interpretation.
 */
export function sqliteDateTimePhysicalForm(
  nativeType: NativeType | undefined
): DateTimePhysicalForm {
  if (nativeType?.db !== "sqlite") return "text";
  if (nativeType.type === "INTEGER") return "epochMillis";
  return nativeType.type === "REAL" ? "julianDay" : "text";
}
