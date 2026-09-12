import type { DatabaseAdapter } from "@adapters/database-adapter";
import type { Scalar } from "@schema/scalars/base";
import type { Sql } from "@sql";
import {
  decimalDescriptorOfState,
  decimalListDescriptorOfState,
} from "./decimal-field";
import { requireGeoPointSql } from "./geo-point-builder";
import type { IdColumn } from "./id-field";

/**
 * Preserve one logical scalar until its descriptor-aware decoder sees it.
 *
 * `idColumn` is the identifier domain and physical form of the field being
 * projected, which a foreign key DERIVES and therefore cannot be read off the
 * scalar alone; the caller holds the model and looks it up once per built
 * statement.
 */
export function projectScalarForTransport(
  adapter: DatabaseAdapter,
  scalar: Scalar | undefined,
  expression: Sql,
  idColumn?: IdColumn
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
  // A BYTE-stored identifier travels as lowercase hex, in a flat select exactly
  // as inside a JSON carrier. JSON cannot hold binary at all, so the carrier
  // has no choice; making the flat read take the same spelling is what keeps
  // ONE physical promise per column — the decoder reads the same text whether
  // the row came back from a top-level select or three levels inside an
  // `include`, and the nine drivers' nine binary shapes stop being a variable.
  // A `uuid` column and a text-stored domain already travel as text.
  if (idColumn?.representation === "bytes") {
    return adapter.expressions.blobToHex(expression);
  }
  return decimalDescriptorOfState(state)
    ? adapter.expressions.cast(expression, "text")
    : expression;
}
