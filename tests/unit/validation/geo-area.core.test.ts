import { type GeoPoint, parse } from "@validation";
import {
  GEO_POINT_EARTH_RADIUS_METERS,
  geoAreaSchema,
  geoBoundsForDistance,
  validateGeoArea,
  validateGeoBounds,
  validateGeoPolygon,
} from "@validation/primitives/geo-area-codec";
import { describe, expect, test } from "vitest";

const point = (longitude: number, latitude: number): GeoPoint => ({
  longitude,
  latitude,
});

function includes(
  bounds: ReturnType<typeof geoBoundsForDistance>,
  candidate: GeoPoint
): boolean {
  const inLatitude =
    candidate.latitude >= bounds.south && candidate.latitude <= bounds.north;
  const inLongitude =
    bounds.west === -180 && bounds.east === 180
      ? true
      : bounds.west > bounds.east
        ? candidate.longitude >= bounds.west ||
          candidate.longitude <= bounds.east
        : candidate.longitude >= bounds.west &&
          candidate.longitude <= bounds.east;
  return inLatitude && inLongitude;
}

function destination(
  origin: GeoPoint,
  bearing: number,
  meters: number
): GeoPoint {
  const latitude = (origin.latitude * Math.PI) / 180;
  const longitude = (origin.longitude * Math.PI) / 180;
  const angle = meters / GEO_POINT_EARTH_RADIUS_METERS;
  const resultLatitude = Math.asin(
    Math.sin(latitude) * Math.cos(angle) +
      Math.cos(latitude) * Math.sin(angle) * Math.cos(bearing)
  );
  const resultLongitude =
    longitude +
    Math.atan2(
      Math.sin(bearing) * Math.sin(angle) * Math.cos(latitude),
      Math.cos(angle) - Math.sin(latitude) * Math.sin(resultLatitude)
    );
  const longitudeDegrees = (resultLongitude * 180) / Math.PI;
  const canonicalLongitude =
    ((((longitudeDegrees + 180) % 360) + 360) % 360) - 180;
  return point(
    canonicalLongitude === -180 ? 180 : canonicalLongitude,
    (resultLatitude * 180) / Math.PI
  );
}

describe("GeoArea validation boundary", () => {
  test("builds conservative spherical-cap bounds without false negatives", () => {
    expect(geoBoundsForDistance(point(12, 34), 0)).toEqual({
      south: 34,
      west: 12,
      north: 34,
      east: 12,
    });
    expect(geoBoundsForDistance(point(179, 0), 500_000).west).toBeGreaterThan(
      geoBoundsForDistance(point(179, 0), 500_000).east
    );
    expect(geoBoundsForDistance(point(0, 89), 500_000)).toMatchObject({
      west: -180,
      east: 180,
      north: 90,
    });
    expect(
      geoBoundsForDistance(point(0, 0), Math.PI * GEO_POINT_EARTH_RADIUS_METERS)
    ).toEqual({ south: -90, west: -180, north: 90, east: 180 });

    let seed = 1_592_594_996;
    const random = () => {
      seed =
        (Math.imul(seed, 1_664_525) + 1_013_904_223 + 4_294_967_296) %
        4_294_967_296;
      return seed / 4_294_967_296;
    };
    for (let index = 0; index < 500; index += 1) {
      const origin = point(random() * 360 - 180, random() * 178 - 89);
      const radius = random() * Math.PI * GEO_POINT_EARTH_RADIUS_METERS;
      const candidate = destination(
        origin,
        random() * Math.PI * 2,
        radius * random()
      );
      expect(includes(geoBoundsForDistance(origin, radius), candidate)).toBe(
        true
      );
    }
  });

  test("accepts ordinary, antimeridian, and whole-world inclusive bounds", () => {
    for (const bounds of [
      { south: -10, west: -20, north: 10, east: 20 },
      { south: -10, west: 170, north: 10, east: -170 },
      { south: -90, west: -180, north: 90, east: 180 },
    ]) {
      const result = validateGeoArea({ bounds });
      expect(result.issues).toBeUndefined();
      if (!result.issues) {
        expect(result.value).toEqual({ bounds });
        expect(result.value).not.toBe(bounds);
      }
    }
    expect(
      validateGeoBounds({ south: -0, west: -0, north: -0, east: -0 })
    ).toEqual({ value: { south: 0, west: 0, north: 0, east: 0 } });
  });

  test.each([
    { south: 10, west: 0, north: -10, east: 1 },
    { south: -91, west: 0, north: 0, east: 1 },
    { south: "0", west: 0, north: 1, east: 1 },
    { south: 0, west: 0, north: "1", east: 1 },
    { south: 0, west: -181, north: 1, east: 1 },
    { south: 0, west: 0, north: 1, east: Number.NaN },
    { south: 0, west: 0, north: 1, east: 2, extra: true },
  ])("refuses invalid bounds %#", (bounds) => {
    expect(validateGeoBounds(bounds).issues).toBeDefined();
  });

  test("discriminates GeoArea exactly", () => {
    const bounds = { south: 0, west: 0, north: 1, east: 1 };
    const polygon = { outer: [point(0, 0), point(1, 0), point(1, 1)] };
    for (const invalid of [
      null,
      {},
      { bounds, polygon },
      { bounds, extra: true },
      { type: "Polygon", coordinates: [] },
    ]) {
      expect(validateGeoArea(invalid).issues).toBeDefined();
    }

    expect(validateGeoArea({ polygon }).issues).toBeUndefined();
    expect(
      validateGeoArea({ polygon: { outer: [point(0, 0), point(1, 0)] } }).issues
    ).toBeDefined();
  });

  test("reads bounds and areas as ordinary records", () => {
    const bounds = { south: 0, west: 0, north: 1, east: 1 };
    const polygon = { outer: [point(0, 0), point(1, 0), point(1, 1)] };
    const exactlyOne = [
      { message: "Expected GeoArea with exactly one of bounds or polygon" },
    ];

    expect(validateGeoArea({ bounds: { ...bounds, nort: 1 } }).issues).toEqual([
      { message: "Unknown key: nort", path: ["bounds", "nort"] },
    ]);
    expect(validateGeoArea({ bounds, extra: true }).issues).toEqual([
      { message: "Unknown key: extra", path: ["extra"] },
    ]);
    expect(validateGeoArea(null).issues).toEqual([
      { message: "Expected object" },
    ]);
    expect(validateGeoBounds({ ...bounds, south: "0" }).issues).toEqual([
      { message: "Expected finite number", path: ["south"] },
    ]);
    expect(validateGeoBounds({ ...bounds, south: -91 }).issues).toEqual([
      { message: "Latitude must be between -90 and 90", path: ["south"] },
    ]);
    expect(validateGeoBounds({ ...bounds, west: -181 }).issues).toEqual([
      { message: "Longitude must be between -180 and 180", path: ["west"] },
    ]);
    // Kept: an inverted rectangle would silently match nothing downstream.
    expect(validateGeoBounds({ ...bounds, south: 2 }).issues).toEqual([
      {
        message: "GeoBounds south must be less than or equal to north",
        path: ["south"],
      },
    ]);
    // Kept: the builder branches on one variant and must see exactly one.
    expect(validateGeoArea({ bounds, polygon }).issues).toEqual(exactlyOne);
    expect(validateGeoArea({}).issues).toEqual(exactlyOne);
    // The walker reads an explicit undefined as an absent key.
    expect(validateGeoArea({ bounds: undefined, polygon })).toEqual({
      value: { polygon },
    });
  });

  test("requires the polygon outer ring and contains hostile inspection", () => {
    expect(validateGeoPolygon(null).issues).toBeDefined();
    expect(validateGeoPolygon({ holes: [] }).issues).toEqual([
      { message: "Missing required field: outer", path: ["outer"] },
    ]);

    const inspectionTrap = new Proxy<GeoPoint[]>([], {
      ownKeys() {
        throw new Error("ownKeys trap");
      },
    });
    // An array read by index never lists its keys: the trap is not reached,
    // so the ring reads as empty and fails the vertex minimum.
    expect(validateGeoPolygon({ outer: inspectionTrap }).issues).toEqual([
      {
        message: "A GeoPolygon ring needs at least 3 vertices",
        path: ["outer"],
      },
    ]);
  });

  test("keeps the input winding and open rings", () => {
    const clockwise = [point(0, 0), point(0, 4), point(4, 4), point(4, 0)];
    const holeCounterClockwise = [
      point(1, 1),
      point(3, 1),
      point(3, 3),
      point(1, 3),
    ];
    const result = validateGeoPolygon({
      outer: clockwise,
      holes: [holeCounterClockwise],
    });
    expect(result.issues).toBeUndefined();
    if (result.issues) return;
    // PostGIS geography and MySQL SRID 4326 decide the interior; VibORM
    // emits the rings as given.
    expect(result.value.outer).toEqual(clockwise);
    expect(result.value.holes?.[0]).toEqual(holeCounterClockwise);
    expect(result.value.outer).not.toBe(clockwise);
  });

  test("refuses explicit null holes after reading the property once", () => {
    let reads = 0;
    const polygon = Object.defineProperties(
      {},
      {
        outer: {
          enumerable: true,
          value: [point(0, 0), point(1, 0), point(1, 1)],
        },
        holes: {
          enumerable: true,
          get() {
            reads += 1;
            return null;
          },
        },
      }
    );

    expect(validateGeoPolygon(polygon).issues).toBeDefined();
    expect(reads).toBe(1);
  });

  test("unwraps a valid antimeridian polygon", () => {
    for (const outer of [
      [point(170, -10), point(-170, -10), point(-170, 10), point(170, 10)],
      [point(-170, -10), point(170, -10), point(170, 10), point(-170, 10)],
    ]) {
      expect(validateGeoPolygon({ outer }).issues).toBeUndefined();
    }
  });

  test("owns the ring shape and leaves geometry to the database", () => {
    const square = [point(0, 0), point(4, 0), point(4, 4), point(0, 4)];
    const vertices = "A GeoPolygon ring needs at least 3 vertices";

    expect(validateGeoPolygon({ outer: [point(0, 0), point(1, 0)] })).toEqual({
      issues: [{ message: vertices, path: ["outer"] }],
    });
    expect(
      validateGeoPolygon({ outer: square, holes: [[point(1, 1), point(2, 1)]] })
    ).toEqual({ issues: [{ message: vertices, path: ["holes", 0] }] });
    expect(
      validateGeoPolygon({ outer: [point(0, 0), point(1, 0), point(1, 91)] })
    ).toEqual({
      issues: [
        {
          message: "Latitude must be between -90 and 90",
          path: ["outer", 2, "latitude"],
        },
      ],
    });
    // A self-intersecting ring is shape-valid; PostGIS and MySQL decide it.
    // The former refusals reach SQL in geopoint-sql.core.test.ts.
    expect(
      validateGeoPolygon({
        outer: [point(0, 0), point(1, 1), point(0, 1), point(1, 0)],
      }).issues
    ).toBeUndefined();
  });

  test("contains hostile ring and property access", () => {
    const throwingPoint = Object.defineProperties(
      {},
      {
        longitude: {
          enumerable: true,
          get() {
            throw new Error("longitude trap");
          },
        },
        latitude: { enumerable: true, value: 0 },
      }
    );
    const sparse = new Array<GeoPoint>(3);
    sparse[0] = point(0, 0);
    sparse[2] = point(1, 1);
    const disguisedSparse = new Array<GeoPoint>(3);
    disguisedSparse[0] = point(0, 0);
    disguisedSparse[2] = point(1, 1);
    Object.defineProperty(disguisedSparse, "extra", {
      enumerable: true,
      value: true,
    });
    const throwingRing = [point(0, 0), point(1, 0), point(1, 1)];
    Object.defineProperty(throwingRing, 1, {
      enumerable: true,
      get() {
        throw new Error("member trap");
      },
    });
    for (const polygon of [
      { outer: [throwingPoint, point(1, 0), point(1, 1)] },
      { outer: sparse },
      { outer: disguisedSparse },
      { outer: throwingRing },
    ]) {
      expect(() => parse(geoAreaSchema(), { polygon })).not.toThrow();
      expect(parse(geoAreaSchema(), { polygon }).issues).toBeDefined();
    }
  });

  test("reads a ring by index, as every array operand is read", () => {
    let inheritedReads = 0;
    const inherited = Object.create(Array.prototype, {
      1: {
        get() {
          inheritedReads += 1;
          return point(1, 0);
        },
      },
    });
    const ring = [point(0, 0), point(1, 0), point(1, 1)];
    Object.setPrototypeOf(ring, inherited);
    Object.defineProperty(ring, 0, {
      configurable: true,
      enumerable: true,
      get() {
        Reflect.deleteProperty(ring, "1");
        return point(0, 0);
      },
    });

    expect(validateGeoPolygon({ outer: ring })).toEqual({
      value: { outer: [point(0, 0), point(1, 0), point(1, 1)] },
    });
    expect(inheritedReads).toBe(1);
  });
});
