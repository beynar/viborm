/**
 * The coordinate domain every geographic value shares: EPSG:4326 degrees,
 * longitude first. The codecs, the JSON Schema projection, and the SQLite
 * CHECK read these same constants.
 */
export const GEO_POINT_KEYS = ["longitude", "latitude"] as const;
export const GEO_LONGITUDE_MIN = -180;
export const GEO_LONGITUDE_MAX = 180;
export const GEO_LATITUDE_MIN = -90;
export const GEO_LATITUDE_MAX = 90;
export const GEO_BOUNDS_KEYS = ["south", "west", "north", "east"] as const;
export const GEO_POLYGON_MIN_RING_POINTS = 3;

/** The sole public value represented by an `s.point()` field. */
export interface GeoPoint {
  longitude: number;
  latitude: number;
}

/** One inclusive latitude/longitude rectangle. */
export interface GeoBounds {
  south: number;
  west: number;
  north: number;
  east: number;
}

/** One simple geographic polygon with optional holes. */
export interface GeoPolygon {
  outer: readonly GeoPoint[];
  holes?: readonly (readonly GeoPoint[])[];
}

/** The two query-only geographic area forms. */
export type GeoArea =
  | { readonly bounds: GeoBounds }
  | { readonly polygon: GeoPolygon };
