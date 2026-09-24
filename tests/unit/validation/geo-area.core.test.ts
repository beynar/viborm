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

  test("judges a short ring by its length before any vertex", () => {
    const shortRing = {
      message: "A GeoPolygon ring needs at least 3 vertices",
      path: ["outer"],
    };
    expect(
      validateGeoPolygon({ outer: [point(0, 0), point(999, 0)] }).issues
    ).toEqual([shortRing]);
    expect(validateGeoPolygon({ outer: [point(0, 999)] }).issues).toEqual([
      shortRing,
    ]);
    expect(
      validateGeoPolygon({
        outer: [point(0, 0), point(1, 0), point(1, 1)],
        holes: [[point(0, 999)]],
      }).issues
    ).toEqual([{ ...shortRing, path: ["holes", 0] }]);
    expect(
      validateGeoPolygon({ outer: [point(0, 0), point(1, 0), point(999, 0)] })
        .issues
    ).toEqual([
      {
        message: "Longitude must be between -180 and 180",
        path: ["outer", 2, "longitude"],
      },
    ]);
  });

  test("spells an empty and an absent hole list as one validated polygon", () => {
    const outer = [point(0, 0), point(4, 0), point(4, 4), point(0, 4)];
    const expected = { value: { outer } };
    // Strict: no `holes` key at all, so both spellings are one argument and
    // one cache key.
    expect(validateGeoPolygon({ outer, holes: [] })).toStrictEqual(expected);
    expect(validateGeoPolygon({ outer })).toStrictEqual(expected);
    expect(validateGeoPolygon({ outer, holes: undefined })).toStrictEqual(
      expected
    );
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

  test("walks the ring shape before any geometry", () => {
    const square = [point(0, 0), point(4, 0), point(4, 4), point(0, 4)];
    const vertices = "A GeoPolygon ring needs at least 3 vertices";

    expect(validateGeoPolygon({ outer: [point(0, 0), point(1, 0)] })).toEqual({
      issues: [{ message: vertices, path: ["outer"] }],
    });
    expect(
      validateGeoPolygon({ outer: square, holes: [[point(1, 1), point(2, 1)]] })
    ).toEqual({ issues: [{ message: vertices, path: ["holes", 0] }] });
    // A bowtie with an out-of-range vertex reports the walker's message.
    expect(
      validateGeoPolygon({
        outer: [point(0, 0), point(1, 1), point(0, 1), point(1, 91)],
      })
    ).toEqual({
      issues: [
        {
          message: "Latitude must be between -90 and 90",
          path: ["outer", 3, "latitude"],
        },
      ],
    });
  });

  /**
   * The polygons PostGIS and MySQL answer silently but wrongly, differently,
   * or on an unstated reading (the probe in CHANGELOG "Geo"); PostGIS raises
   * only for the exactly-180-degree edge. Each is refused at admission with
   * its path.
   */
  const square = [point(0, 0), point(4, 0), point(4, 4), point(0, 4)];
  const wide = [point(0, 0), point(10, 0), point(10, 10), point(0, 10)];
  const selfIntersect = "A GeoPolygon ring cannot self-intersect";
  const zeroArea = "A GeoPolygon ring must have non-zero area";
  const edge180 = "A GeoPolygon edge cannot span exactly 180 degrees";
  const poleVertex = "A GeoPolygon ring cannot contain a pole";
  const aroundPole = "A GeoPolygon cannot contain a pole";
  const halfGlobe = "A GeoPolygon must cover less than half the globe";
  const holeOutside = "A GeoPolygon hole must be inside its outer ring";
  const holesOverlap = "GeoPolygon holes cannot overlap";
  test.each([
    {
      name: "a bowtie",
      polygon: { outer: [point(0, 0), point(1, 1), point(0, 1), point(1, 0)] },
      issue: { message: selfIntersect, path: ["outer"] },
    },
    {
      name: "a bowtie hole",
      polygon: {
        outer: square,
        holes: [[point(1, 1), point(2, 2), point(1, 2), point(2, 1)]],
      },
      issue: { message: selfIntersect, path: ["holes", 0] },
    },
    {
      name: "a ring touching itself at a repeated vertex",
      polygon: { outer: [point(0, 0), point(1, 0), point(1, 1), point(1, 0)] },
      issue: { message: selfIntersect, path: ["outer"] },
    },
    {
      name: "a collinear ring",
      polygon: { outer: [point(0, 0), point(1, 0), point(2, 0)] },
      issue: { message: zeroArea, path: ["outer"] },
    },
    {
      name: "a ring of two distinct vertices",
      polygon: { outer: [point(0, 0), point(1, 0), point(0, 0)] },
      issue: { message: zeroArea, path: ["outer"] },
    },
    {
      name: "a ring of one distinct vertex",
      polygon: { outer: [point(1, 1), point(1, 1), point(1, 1)] },
      issue: { message: zeroArea, path: ["outer"] },
    },
    {
      name: "a 180-degree edge",
      polygon: { outer: [point(0, 0), point(180, 0), point(1, 1)] },
      issue: { message: edge180, path: ["outer", 1] },
    },
    {
      name: "a 180-degree closing edge",
      polygon: { outer: [point(0, 0), point(1, 1), point(180, 0)] },
      issue: { message: edge180, path: ["outer", 0] },
    },
    {
      name: "a 180-degree hole edge",
      polygon: {
        outer: square,
        holes: [[point(1, 1), point(2, 1), point(-178, 2)]],
      },
      issue: { message: edge180, path: ["holes", 0, 2] },
    },
    {
      name: "a north pole vertex",
      polygon: { outer: [point(10, 80), point(0, 90), point(-10, 80)] },
      issue: { message: poleVertex, path: ["outer", 1] },
    },
    {
      name: "a south pole vertex",
      polygon: { outer: [point(-10, -80), point(0, -90), point(10, -80)] },
      issue: { message: poleVertex, path: ["outer", 1] },
    },
    {
      name: "a ring winding around a pole",
      polygon: { outer: [point(-120, 80), point(0, 80), point(120, 80)] },
      issue: { message: aroundPole, path: ["outer"] },
    },
    {
      name: "half the globe",
      polygon: {
        outer: [
          point(-170, -80),
          point(0, -80),
          point(170, -80),
          point(170, 80),
          point(0, 80),
          point(-170, 80),
        ],
      },
      issue: { message: halfGlobe, path: ["outer"] },
    },
    {
      name: "a hole outside",
      polygon: {
        outer: square,
        holes: [[point(5, 5), point(6, 6), point(6, 5)]],
      },
      issue: { message: holeOutside, path: ["holes", 0] },
    },
    {
      name: "a hole crossing the outer ring",
      polygon: {
        outer: square,
        holes: [[point(3, 3), point(3, 5), point(5, 5), point(5, 3)]],
      },
      issue: { message: holeOutside, path: ["holes", 0] },
    },
    {
      name: "a hole bridging a notch between two outer vertices",
      polygon: {
        outer: [
          point(0, 0),
          point(4, 0),
          point(4, 2),
          point(2, 2),
          point(2, 4),
          point(0, 4),
        ],
        holes: [[point(1, 1), point(4, 2), point(2, 4)]],
      },
      issue: { message: holeOutside, path: ["holes", 0] },
    },
    {
      // Every piece's midpoint is inside; only the crossings show the escape.
      name: "a hole whose edges cross an outer notch",
      polygon: {
        outer: [
          point(0, 0),
          point(4, 0),
          point(4, 4),
          point(2.2, 4),
          point(2, 2),
          point(1.8, 4),
          point(0, 4),
        ],
        holes: [[point(0.5, 3), point(3, 3.5), point(3.9, 3)]],
      },
      issue: { message: holeOutside, path: ["holes", 0] },
    },
    {
      name: "overlapping holes",
      polygon: {
        outer: [point(0, 0), point(6, 0), point(6, 6), point(0, 6)],
        holes: [
          [point(1, 1), point(1, 4), point(4, 4), point(4, 1)],
          [point(3, 3), point(3, 5), point(5, 5), point(5, 3)],
        ],
      },
      issue: { message: holesOverlap, path: ["holes", 1] },
    },
    {
      name: "a hole nested in a hole",
      polygon: {
        outer: wide,
        holes: [
          [point(2, 2), point(2, 5), point(5, 5), point(5, 2)],
          [point(3, 3), point(3, 4), point(4, 4), point(4, 3)],
        ],
      },
      issue: { message: holesOverlap, path: ["holes", 1] },
    },
    {
      name: "a hole enclosing a hole",
      polygon: {
        outer: wide,
        holes: [
          [point(3, 3), point(3, 4), point(4, 4), point(4, 3)],
          [point(2, 2), point(2, 5), point(5, 5), point(5, 2)],
        ],
      },
      issue: { message: holesOverlap, path: ["holes", 1] },
    },
    {
      // No edge crosses: the second hole enters the first through two corners.
      name: "holes overlapping through shared corners",
      polygon: {
        outer: wide,
        holes: [
          [point(1, 1), point(1, 3), point(3, 3), point(3, 1)],
          [point(4, 4), point(2, 2), point(3, 1)],
        ],
      },
      issue: { message: holesOverlap, path: ["holes", 1] },
    },
    {
      name: "the same hole twice",
      polygon: {
        outer: wide,
        holes: [
          [point(2, 2), point(2, 5), point(5, 5), point(5, 2)],
          [point(5, 2), point(2, 2), point(2, 5), point(5, 5)],
        ],
      },
      issue: { message: holesOverlap, path: ["holes", 1] },
    },
  ])("refuses $name", ({ polygon, issue }) => {
    expect(validateGeoPolygon(polygon)).toEqual({ issues: [issue] });
  });

  /**
   * The polygons both databases answered as "inside the outer ring and in no
   * hole": a repeated consecutive vertex is a zero-length edge, and a hole may
   * touch the outer ring or another hole at a point or along an edge.
   */
  test.each([
    {
      name: "a closed ring",
      polygon: { outer: [point(0, 0), point(1, 0), point(1, 1), point(0, 0)] },
    },
    {
      name: "a repeated consecutive vertex",
      polygon: {
        outer: [point(0, 0), point(1, 0), point(1, 0), point(1, 1)],
      },
    },
    {
      name: "a hole touching the outer ring at one point",
      polygon: {
        outer: square,
        holes: [[point(0, 1), point(1, 2), point(1, 1)]],
      },
    },
    {
      name: "a hole along an outer edge",
      polygon: {
        outer: square,
        holes: [[point(0, 1), point(0, 2), point(1, 2), point(1, 1)]],
      },
    },
    {
      name: "a hole touching the outer ring at three points",
      polygon: {
        outer: square,
        holes: [[point(0, 2), point(2, 4), point(4, 2)]],
      },
    },
    {
      name: "holes touching at one point",
      polygon: {
        outer: wide,
        holes: [
          [point(1, 1), point(1, 3), point(3, 3), point(3, 1)],
          [point(3, 3), point(3, 5), point(5, 5), point(5, 3)],
        ],
      },
    },
    {
      name: "holes sharing an edge",
      polygon: {
        outer: wide,
        holes: [
          [point(1, 1), point(1, 3), point(3, 3), point(3, 1)],
          [point(3, 1), point(3, 3), point(5, 3), point(5, 1)],
        ],
      },
    },
    {
      name: "an antimeridian hole in an antimeridian polygon",
      polygon: {
        outer: [
          point(170, -10),
          point(-170, -10),
          point(-170, 10),
          point(170, 10),
        ],
        // Unwrapped from -175, the hole lies a whole turn west of the outer.
        holes: [
          [point(-175, 5), point(-175, -5), point(175, -5), point(175, 5)],
        ],
      },
    },
  ])("admits $name as written", ({ polygon }) => {
    expect(validateGeoPolygon(polygon)).toEqual({ value: polygon });
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
