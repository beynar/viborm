import type { DatabaseAdapter, GeoPointSql } from "@adapters/database-adapter";
import { FeatureNotSupportedError } from "@errors";
import { type Sql, sql } from "@sql";
import type { GeoArea } from "@validation/primitives/geo-area-codec";
import type { GeoPoint } from "@validation/primitives/geo-point-codec";
import type { QueryScope } from "../types";

export function requireGeoPointSql(
  adapter: DatabaseAdapter,
  operation: string
): GeoPointSql {
  const geoPoint = adapter.geoPoint;
  if (geoPoint) return geoPoint;
  throw new FeatureNotSupportedError(
    "point",
    operation,
    "GeoPoint requires a provider with its physical point tier enabled."
  );
}

/** Lower one already-validated logical point through the adapter's sole seam. */
export function buildGeoPointValue(
  adapter: DatabaseAdapter,
  value: unknown
): Sql {
  return buildCanonicalGeoPointValue(adapter, trustedGeoPoint(value));
}

/** Lower the canonical value already produced by the one GeoPoint codec. */
export function buildCanonicalGeoPointValue(
  adapter: DatabaseAdapter,
  point: GeoPoint
): Sql {
  return requireGeoPointSql(adapter, "value").value(
    sql`${point.longitude}`,
    sql`${point.latitude}`
  );
}

export function buildGeoPointEquality(
  ctx: QueryScope,
  column: Sql,
  value: unknown
): Sql {
  const point = trustedGeoPoint(value);
  return requireGeoPointSql(ctx.adapter, "equals").equals(column, point);
}

export function buildGeoPointWithin(
  ctx: QueryScope,
  column: Sql,
  value: unknown
): Sql {
  const area = trustedGeoArea(value);
  const geoPoint = requireGeoPointSql(ctx.adapter, "within");
  if ("bounds" in area) {
    return geoPoint.withinBounds(column, area.bounds);
  }
  if (geoPoint.withinPolygon) {
    return geoPoint.withinPolygon(column, area.polygon);
  }
  throw new FeatureNotSupportedError(
    "point",
    "within polygon",
    "GeoPoint polygon filtering is not supported by this provider."
  );
}

/** Reattach the operation schema's erased output type without re-validating it. */
export function trustedGeoPoint(value: unknown): GeoPoint {
  return value as GeoPoint;
}

/** Reattach the operation schema's erased output type without re-validating it. */
function trustedGeoArea(value: unknown): GeoArea {
  return value as GeoArea;
}
