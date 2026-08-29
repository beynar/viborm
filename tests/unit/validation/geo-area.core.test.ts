import type { GeoPoint } from "@validation";
import {
  GEO_POINT_EARTH_RADIUS_METERS,
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

  test("requires the polygon outer ring and contains hostile inspection", () => {
    expect(validateGeoPolygon(null).issues).toBeDefined();
    expect(validateGeoPolygon({ holes: [] }).issues?.[0]?.message).toBe(
      "Expected GeoPolygon with outer and optional holes"
    );

    const inspectionTrap = new Proxy<GeoPoint[]>([], {
      ownKeys() {
        throw new Error("ownKeys trap");
      },
    });
    expect(
      validateGeoPolygon({ outer: inspectionTrap }).issues?.[0]?.message
    ).toBe("Could not inspect outer ring");
  });

  test("normalizes winding and keeps open rings", () => {
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
    expect(result.value.outer).toEqual([...clockwise].reverse());
    expect(result.value.holes?.[0]).toEqual(
      [...holeCounterClockwise].reverse()
    );
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

  test("refuses a ring that winds around a pole", () => {
    expect(
      validateGeoPolygon({
        outer: [point(-120, 80), point(0, 80), point(120, 80)],
      }).issues?.[0]?.message
    ).toBe("A GeoPolygon cannot contain a pole");
  });

  test("refuses a simple pole-free polygon that covers at least half the globe", () => {
    const result = validateGeoPolygon({
      outer: [
        point(-170, -80),
        point(0, -80),
        point(170, -80),
        point(170, 80),
        point(0, 80),
        point(-170, 80),
      ],
    });

    expect(result.issues?.[0]?.message).toBe(
      "A GeoPolygon must cover less than half the globe"
    );
  });

  test.each([
    { outer: [point(0, 0), point(1, 0)] },
    { outer: [point(0, 0), point(1, 0), point(0, 0)] },
    { outer: [point(0, 0), point(1, 0), point(1, 1), point(1, 0)] },
    { outer: [point(0, 0), point(1, 1), point(0, 1), point(1, 0)] },
    { outer: [point(0, 0), point(1, 0), point(2, 0)] },
    { outer: [point(0, 0), point(180, 0), point(1, 1)] },
    { outer: [point(-10, 80), point(0, 90), point(10, 80)] },
    { outer: [point(-10, -80), point(0, -90), point(10, -80)] },
    {
      outer: [point(0, 0), point(4, 0), point(4, 4), point(0, 4)],
      holes: [[point(5, 5), point(6, 5), point(6, 6)]],
    },
    {
      outer: [point(0, 0), point(4, 0), point(4, 4), point(0, 4)],
      holes: [[point(0, 1), point(1, 1), point(1, 2)]],
    },
    {
      outer: [point(0, 0), point(6, 0), point(6, 6), point(0, 6)],
      holes: [
        [point(1, 1), point(4, 1), point(4, 4), point(1, 4)],
        [point(3, 3), point(5, 3), point(5, 5), point(3, 5)],
      ],
    },
    {
      outer: [point(0, 0), point(10, 0), point(10, 10), point(0, 10)],
      holes: [
        [point(2, 2), point(5, 2), point(5, 5), point(2, 5)],
        [point(3, 3), point(4, 3), point(4, 4), point(3, 4)],
      ],
    },
    {
      outer: [point(0, 0), point(10, 0), point(10, 10), point(0, 10)],
      holes: [
        [point(3, 3), point(4, 3), point(4, 4), point(3, 4)],
        [point(2, 2), point(5, 2), point(5, 5), point(2, 5)],
      ],
    },
    {
      outer: [point(0, 0), point(4, 0), point(4, 4), point(0, 4)],
      holes: [[point(1, 1), point(2, 1)]],
    },
  ])("refuses invalid polygon topology %#", (polygon) => {
    expect(validateGeoPolygon(polygon).issues).toBeDefined();
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
      expect(() => validateGeoPolygon(polygon)).not.toThrow();
      expect(validateGeoPolygon(polygon).issues).toBeDefined();
    }
  });

  test("does not read an inherited member deleted after the dense-array snapshot", () => {
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

    expect(validateGeoPolygon({ outer: ring }).issues).toBeDefined();
    expect(inheritedReads).toBe(0);
  });
});
