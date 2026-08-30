/**
 * Where the query engine reads a datetime field's DECLARED NATIVE FORM.
 *
 * One accessor, because value lowering and result decoding ask the same
 * question of the same schema fact and a column written in one physical
 * vocabulary must be read in that same one. The declaration itself is
 * dialect-specific text (`SQLITE.DATETIME.INTEGER`, `PG.DATETIME.TIMESTAMPTZ`),
 * and this file does not interpret it: it hands the adapter the declaration and
 * the adapter alone spells the physical encoding.
 */

import type { Scalar } from "@schema/scalars/base";
import type { NativeType } from "@schema/scalars/native-types";

/**
 * The native type a datetime COLUMN declares, or `undefined` when the field is
 * not a datetime, declares nothing, or is a LIST.
 *
 * A list answers `undefined` because its members live inside the dialect's own
 * container — JSON on the dialects that have no array type — and the container
 * owns their spelling. The declared native type describes the column, and a
 * column holding a container is not holding one instant.
 */
export function dateTimeNativeTypeOf(
  scalar: Scalar | undefined
): NativeType | undefined {
  const state = scalar?.["~"].state;
  if (state?.type !== "datetime" || state.array === true) return undefined;
  return scalar?.["~"].nativeType;
}
