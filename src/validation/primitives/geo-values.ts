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
