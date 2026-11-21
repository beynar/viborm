/**
 * How SurrealQL lands an exact decimal on its field's scale, in a module of
 * its own: a read's average and a write's product are quantized with it, and
 * so is an aggregated view's average, which the migrations write without
 * importing the driver or its SDK.
 */

import { type Sql, sql } from "@sql";

/** An exact decimal lands back on its scale, ties to even as `numeric` does here. */
export function quantized(
  state: { readonly decimal?: { readonly scale: number } } | undefined,
  value: Sql
): Sql {
  const scale = state?.decimal?.scale;
  if (scale === undefined) return value;
  const factor = sql.raw(`1${"0".repeat(scale)}dec`);
  return sql`(math::round(${value} * ${factor}) / ${factor})`;
}
