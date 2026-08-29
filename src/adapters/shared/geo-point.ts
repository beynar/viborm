import type { GeoPointSql } from "@adapters/database-adapter";
import { type Sql, sql } from "@sql";
import type {
  GeoBounds,
  GeoPolygon,
} from "@validation/primitives/geo-area-codec";

type CoordinateOperations = {
  readonly and: (...conditions: Sql[]) => Sql;
  readonly or: (...conditions: Sql[]) => Sql;
  readonly eq: (left: Sql, right: Sql) => Sql;
  readonly gte: (left: Sql, right: Sql) => Sql;
  readonly lte: (left: Sql, right: Sql) => Sql;
};

type IndexableBounds = (point: Sql, bounds: GeoBounds) => Sql | undefined;

/**
 * Coordinate equality and inclusive bounds are one logical contract on every
 * provider. Only coordinate extraction differs, so this is their single owner.
 */
export function createGeoPointCoordinatePredicates(
  longitude: GeoPointSql["longitude"],
  latitude: GeoPointSql["latitude"],
  operators: CoordinateOperations,
  indexableBounds?: IndexableBounds
): Pick<GeoPointSql, "equals" | "withinBounds"> {
  return {
    equals(point, expected) {
      const pointLongitude = longitude(point);
      let longitudeCondition = operators.eq(
        pointLongitude,
        sql`${expected.longitude}`
      );
      // -180 and +180 are one canonical meridian. Storage written outside the
      // ORM may still contain the physical -180 spelling that the value codec
      // presents as +180.
      if (expected.longitude === 180) {
        longitudeCondition = operators.or(
          longitudeCondition,
          operators.eq(pointLongitude, sql`${-180}`)
        );
      }
      return operators.and(
        longitudeCondition,
        operators.eq(latitude(point), sql`${expected.latitude}`)
      );
    },
    withinBounds(point, bounds) {
      const pointLongitude = longitude(point);
      const latitudeCondition = operators.and(
        operators.gte(latitude(point), sql`${bounds.south}`),
        operators.lte(latitude(point), sql`${bounds.north}`)
      );

      let exactCondition: Sql;
      if (bounds.west === -180 && bounds.east === 180) {
        exactCondition = latitudeCondition;
      } else {
        const westArm = operators.gte(pointLongitude, sql`${bounds.west}`);
        const eastArm = operators.lte(pointLongitude, sql`${bounds.east}`);
        let longitudeCondition =
          bounds.west > bounds.east
            ? operators.or(westArm, eastArm)
            : operators.and(westArm, eastArm);

        // GeoPoint canonicalizes -180 to +180. A normal interval whose western
        // boundary is -180 still contains that one physical meridian.
        if (bounds.west === -180 && bounds.east < 180) {
          longitudeCondition = operators.or(
            longitudeCondition,
            operators.eq(pointLongitude, sql`${180}`)
          );
        }
        // The inverse endpoint is the same canonical meridian: an external
        // writer may have stored -180 while the logical interval ends at +180.
        if (bounds.east === 180 && bounds.west > -180) {
          longitudeCondition = operators.or(
            longitudeCondition,
            operators.eq(pointLongitude, sql`${-180}`)
          );
        }
        exactCondition = operators.and(latitudeCondition, longitudeCondition);
      }
      const indexCondition = indexableBounds?.(point, bounds);
      return indexCondition
        ? operators.and(indexCondition, exactCondition)
        : exactCondition;
    },
  };
}

/**
 * GeoJSON rectangles safe to use only as conservative spatial-index probes.
 * Empty means the exact coordinate predicate is the only portable shape for
 * this boundary (world, pole, zero-area, or the canonical -180 meridian case).
 */
export function geoBoundsIndexPolygons(bounds: GeoBounds): readonly string[] {
  if (
    bounds.south === -90 ||
    bounds.north === 90 ||
    bounds.south === bounds.north ||
    bounds.west === bounds.east ||
    bounds.west > bounds.east ||
    bounds.west === -180 ||
    bounds.east === 180
  ) {
    return [];
  }
  return [
    boundsPolygonJson(bounds.west, bounds.east, bounds.south, bounds.north),
  ];
}

function boundsPolygonJson(
  west: number,
  east: number,
  south: number,
  north: number
): string {
  return JSON.stringify({
    type: "Polygon",
    coordinates: [
      [
        [west, south],
        [east, south],
        [east, north],
        [west, north],
        [west, south],
      ],
    ],
  });
}

/** One bound GeoJSON document; callers never contribute SQL or WKT text. */
export function geoPolygonJson(polygon: GeoPolygon): string {
  const rings: number[][][] = [closedRing(polygon.outer)];
  if (polygon.holes) {
    for (const hole of polygon.holes) rings.push(closedRing(hole));
  }
  return JSON.stringify({ type: "Polygon", coordinates: rings });
}

function closedRing(ring: GeoPolygon["outer"]): number[][] {
  const result = new Array<number[]>(ring.length + 1);
  for (let index = 0; index < ring.length; index += 1) {
    const point = ring[index]!;
    result[index] = [point.longitude, point.latitude];
  }
  const first = ring[0]!;
  result[ring.length] = [first.longitude, first.latitude];
  return result;
}
