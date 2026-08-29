/** The schema-bind refusal for a provider with no physical GeoPoint protocol. */

import type { DatabaseAdapter } from "@adapters/database-adapter";
import { ClientInitializationError } from "@errors";
import type { AnyModel } from "@schema/model";
import type { Scalar } from "@schema/scalars/base";

export function assertGeoPointFieldsFitAdapter(
  schema: Record<string, AnyModel>,
  adapter: DatabaseAdapter
): void {
  if (adapter.geoPoint !== undefined) return;
  for (const [modelName, model] of Object.entries(schema)) {
    const scalars: Record<string, Scalar> = model["~"].state.scalars;
    for (const [fieldName, scalar] of Object.entries(scalars)) {
      if (scalar["~"].state.type !== "point") continue;
      throw new ClientInitializationError(
        `GeoPoint field '${modelName}.${fieldName}' cannot be stored by this driver because its adapter has no GeoPoint protocol.`
      );
    }
  }
}
