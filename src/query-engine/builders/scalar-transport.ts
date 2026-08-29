import type { DatabaseAdapter } from "@adapters/database-adapter";
import type { Scalar } from "@schema/scalars/base";
import type { Sql } from "@sql";
import {
  decimalDescriptorOfState,
  decimalListDescriptorOfState,
} from "./decimal-field";
import { requireGeoPointSql } from "./geo-point-builder";

/** Preserve one logical scalar until its descriptor-aware decoder sees it. */
export function projectScalarForTransport(
  adapter: DatabaseAdapter,
  scalar: Scalar | undefined,
  expression: Sql
): Sql {
  const state = scalar?.["~"].state;
  if (decimalListDescriptorOfState(state)) {
    return adapter.arrays.decimalProjection(expression);
  }
  if (state?.type === "point") {
    const geoPoint = requireGeoPointSql(adapter, "projection");
    const projected = adapter.json.objectFromColumns([
      ["longitude", geoPoint.longitude(expression)],
      ["latitude", geoPoint.latitude(expression)],
    ]);
    return state.nullable === true
      ? adapter.expressions.caseWhen(
          [
            {
              when: adapter.operators.isNull(expression),
              then: adapter.literals.null(),
            },
          ],
          projected
        )
      : projected;
  }
  return decimalDescriptorOfState(state)
    ? adapter.expressions.cast(expression, "text")
    : expression;
}
