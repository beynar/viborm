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
   * The polygons with no single meaning on the great-circle reading: a ring
   * crossing, touching or retracing itself, zero area, a hole not strictly
   * inside, touching or overlapping holes, a vertex too near a pole, an edge
   * too nearly antipodal to fix its circle. Each is refused at admission with
   * its path.
   */
  const square = [point(0, 0), point(4, 0), point(4, 4), point(0, 4)];
  const wide = [point(0, 0), point(10, 0), point(10, 10), point(0, 10)];
  const selfIntersect = "A GeoPolygon ring cannot self-intersect";
  const zeroArea = "A GeoPolygon ring must have non-zero area";
  const edge180 = "A GeoPolygon edge cannot span exactly 180 degrees";
  const poleVertex =
    "A GeoPolygon vertex must be at least 1e-4 degrees from a pole";
  const aroundPole = "A GeoPolygon cannot contain a pole";
  const nearAntipode =
    "A GeoPolygon edge cannot join vertices within 0.01 degrees of antipodal";
  // A square `side` degrees on each side, from (longitude, latitude).
  const tiny = (longitude: number, latitude: number, side: number) => [
    point(longitude, latitude),
    point(longitude + side, latitude),
    point(longitude + side, latitude + side),
    point(longitude, latitude + side),
  ];
  // A ring from latitude 70 to `top`, 240 degrees of longitude wide.
  const nearPole = (top: number) => [
    ...[0, 48, 96, 144, -168, -120].map((longitude) => point(longitude, 70)),
    ...[-120, -168, 144, 96, 48, 0].map((longitude) => point(longitude, top)),
  ];
  const holeOutside =
    "A GeoPolygon hole must be strictly inside its outer ring";
  const holesOverlap = "GeoPolygon holes cannot touch or overlap";
  // PostGIS reads an edge as a great-circle arc, MySQL within 0.0005 degrees
  // of it on this box (the ellipsoid's path): the south edge of this
  // box bows north to about latitude 40.105 at longitude 5, its north edge to
  // about 50.10.
  const box = [point(0, 40), point(10, 40), point(10, 50), point(0, 50)];
  const turn = (longitude: number) =>
    longitude > 180 ? longitude - 360 : longitude;
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
      // The hole lies between the crossing arcs from where the second one
      // starts, so the sweep first compares them when the hole leaves it,
      // at longitude 3.
      name: "a bowtie whose crossing arcs a hole keeps apart in the sweep",
      polygon: {
        outer: [point(1, 2), point(10, 8), point(10, 2), point(1.5, 8)],
        holes: [
          [point(1.4, 4.5), point(3, 4.5), point(3, 5.5), point(1.4, 5.5)],
        ],
      },
      issue: { message: selfIntersect, path: ["outer"] },
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
      // Every edge is shorter than VibORM's 1e-9-degree resolution, a
      // repeated vertex: the ring has one distinct vertex.
      name: "a square 5e-10 degrees across",
      polygon: { outer: tiny(10, 60, 5e-10) },
      issue: { message: zeroArea, path: ["outer"] },
    },
    {
      // A plain start × end loses the direction of a 1e-7-degree arc there.
      name: "a 1e-7-degree bowtie in a larger ring",
      polygon: {
        outer: [
          point(9.999, 44.999),
          point(10.001, 44.999),
          point(10, 45),
          point(10.000_000_1, 45.000_000_1),
          point(10.000_000_1, 45),
          point(10, 45.000_000_1),
          point(10.001, 45.001),
          point(9.999, 45.001),
        ],
      },
      issue: { message: selfIntersect, path: ["outer"] },
    },
    {
      name: "a vertex on a meridian edge",
      polygon: {
        outer: [
          point(0, 0),
          point(0, 4),
          point(3, 4),
          point(0, 2),
          point(3, 0),
        ],
      },
      issue: { message: selfIntersect, path: ["outer"] },
    },
    {
      name: "a ring doubling back along an edge",
      polygon: {
        outer: [
          point(1, 2),
          point(0, 1),
          point(1, 0),
          point(2, 0),
          point(1, 0),
          point(2, 1),
        ],
      },
      issue: { message: selfIntersect, path: ["outer"] },
    },
    {
      name: "a 180-degree edge",
      polygon: { outer: [point(0, 0), point(180, 0), point(1, 1)] },
      issue: { message: edge180, path: ["outer", 1] },
    },
    {
      // Over the pole: the two databases answered (0, 80) differently.
      name: "a 180-degree closing edge",
      polygon: { outer: [point(0, 80), point(90, 70), point(180, 80)] },
      issue: { message: edge180, path: ["outer", 0] },
    },
    {
      name: "a 180-degree edge over the pole",
      polygon: { outer: [point(0, 10), point(180, 10), point(90, -10)] },
      issue: { message: edge180, path: ["outer", 1] },
    },
    {
      // 1e-6 degrees from antipodal, the edge's circle turns by about 3e-6
      // degrees with the last digit of a coordinate.
      name: "a nearly antipodal edge",
      polygon: {
        outer: [point(0, 10), point(179.999_999, -10), point(90, 40)],
      },
      issue: { message: nearAntipode, path: ["outer", 1] },
    },
    {
      name: "an edge 0.009 degrees short of antipodal",
      polygon: { outer: [point(0, 0), point(179.991, 0), point(90, 30)] },
      issue: { message: nearAntipode, path: ["outer", 1] },
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
      // MySQL matched (30, 70) and (30, 0) and missed (30, -70), inside;
      // PostGIS answered all three correctly.
      name: "an edge between two vertices 1e-7 degrees from the south pole",
      polygon: {
        outer: [
          point(-60, -89.999_999_9),
          point(0, -89.999_999_9),
          point(60, -89.999_999_9),
          point(120, -89.999_999_9),
          point(120, -60),
          point(60, -60),
          point(0, -60),
          point(-60, -60),
        ],
      },
      issue: { message: poleVertex, path: ["outer", 0] },
    },
    {
      // PostGIS matched (30.37, 0.11) and (30.37, -19.89), 70 degrees from
      // the ring; MySQL did not.
      name: "an edge between two vertices 1e-6 degrees from the north pole",
      polygon: { outer: nearPole(89.999_999) },
      issue: { message: poleVertex, path: ["outer", 6] },
    },
    {
      name: "a ring winding around a pole",
      polygon: { outer: [point(-120, 80), point(0, 80), point(120, 80)] },
      issue: { message: aroundPole, path: ["outer"] },
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
      // The meridian from (-110, 30) to the north pole meets no edge; the
      // band's edges across longitude 70 lie on its great circle's far half.
      name: "a hole north of a band that crosses its antimeridian",
      polygon: {
        outer: [
          point(-130, -40),
          point(-80, -40),
          point(-30, -40),
          point(20, -40),
          point(80, -40),
          point(80, -20),
          point(20, -20),
          point(-30, -20),
          point(-80, -20),
          point(-130, -20),
        ],
        holes: [
          [point(-110, 30), point(-110, 31), point(-109, 31), point(-109, 30)],
        ],
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
    {
      // Longitudes 0 to 400 along a band: 0 to 40 is covered twice.
      name: "a ring past a whole turn over itself",
      polygon: {
        outer: [
          point(0, 0),
          point(80, 0),
          point(160, 0),
          point(-120, 0),
          point(-40, 0),
          point(40, 0),
          point(40, 2),
          point(-40, 2),
          point(-120, 2),
          point(160, 2),
          point(80, 2),
          point(0, 2),
        ],
      },
      issue: { message: selfIntersect, path: ["outer"] },
    },
    {
      name: "a hole touching the outer ring at one point",
      polygon: {
        outer: square,
        holes: [[point(0, 1), point(1, 2), point(1, 1)]],
      },
      issue: { message: holeOutside, path: ["holes", 0] },
    },
    {
      name: "a hole along an outer edge",
      polygon: {
        outer: square,
        holes: [[point(0, 1), point(0, 2), point(1, 2), point(1, 1)]],
      },
      issue: { message: holeOutside, path: ["holes", 0] },
    },
    {
      name: "a hole touching the outer ring at three points",
      polygon: {
        outer: square,
        holes: [[point(0, 2), point(2, 4), point(4, 2)]],
      },
      issue: { message: holeOutside, path: ["holes", 0] },
    },
    {
      name: "a hole equal to its outer ring",
      polygon: { outer: square, holes: [square] },
      issue: { message: holeOutside, path: ["holes", 0] },
    },
    {
      // PostGIS matched (5, 40.05) and (5, 40.08), MySQL did not.
      name: "a hole touching a parallel edge in the plane",
      polygon: {
        outer: box,
        holes: [[point(5, 40), point(4, 45), point(6, 45)]],
      },
      issue: { message: holeOutside, path: ["holes", 0] },
    },
    {
      name: "a hole inside the plane's edge but outside the great-circle arc",
      polygon: {
        outer: box,
        holes: [[point(5, 40.05), point(4, 45), point(6, 45)]],
      },
      issue: { message: holeOutside, path: ["holes", 0] },
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
      issue: { message: holesOverlap, path: ["holes", 1] },
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
      issue: { message: holesOverlap, path: ["holes", 1] },
    },
    {
      // PostGIS matched (5, 44.01) to (5, 44.03), in both holes; MySQL did not.
      name: "a hole touching another's parallel edge in the plane",
      polygon: {
        outer: box,
        holes: [
          [point(2, 42), point(2, 44), point(8, 44), point(8, 42)],
          [point(5, 44), point(4, 46), point(6, 46)],
        ],
      },
      issue: { message: holesOverlap, path: ["holes", 1] },
    },
  ])("refuses $name", ({ polygon, issue }) => {
    expect(validateGeoPolygon(polygon)).toEqual({ issues: [issue] });
  });

  /**
   * Polygons with one meaning on the great-circle reading, admitted as
   * written even where a database reads them differently (point.mdx, "How
   * each database reads a polygon"): a repeated consecutive vertex is a
   * zero-length edge, a hole may sit between an edge's straight line and its
   * arc, a ring may go past a whole turn beside itself, edges may be long and
   * rings continent-sized or tiny.
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
      name: "a hole beyond the plane's north edge, inside its great-circle arc",
      polygon: {
        outer: box,
        holes: [[point(5, 50.05), point(6, 49), point(4, 49)]],
      },
    },
    {
      name: "a hole just inside the great-circle south edge",
      polygon: {
        outer: box,
        holes: [[point(5, 40.2), point(4, 45), point(6, 45)]],
      },
    },
    {
      // Longitudes 0 to 400, rising: 0 to 40 is crossed twice, apart.
      name: "a band past a whole turn beside itself",
      polygon: {
        outer: [
          ...Array.from({ length: 21 }, (_, step) =>
            point(turn(step * 20), 10 + step / 2)
          ),
          ...Array.from({ length: 21 }, (_, step) =>
            point(turn(400 - step * 20), 22 - step / 2)
          ),
        ],
      },
    },
    {
      // Most of the outer ring's vertices lie far from the hole.
      name: "a hole across a 300-degree band",
      polygon: {
        outer: [
          ...Array.from({ length: 21 }, (_, step) => point(step / 2, 20)),
          point(60, 20),
          point(120, 20),
          point(179.5, 20),
          point(-120, 20),
          point(-60, 20),
          point(-60, 40),
          point(-120, 40),
          point(179.5, 40),
          point(120, 40),
          point(60, 40),
          ...Array.from({ length: 21 }, (_, step) => point(10 - step / 2, 40)),
        ],
        holes: [
          [point(-110, 28), point(-110, 32), point(-100, 32), point(-100, 28)],
        ],
      },
    },
    {
      // On the equator and the 0 meridian, not across them: PostGIS widens its
      // box to a pole only past zero, and answered every point correctly.
      name: "a triangle touching the equator and the 0 meridian",
      polygon: { outer: [point(0, 0), point(100, 0), point(50, 50)] },
    },
    {
      name: "edges between vertices 1e-4 degrees from the north pole",
      polygon: { outer: nearPole(89.9999) },
    },
    {
      // MySQL's ellipsoid edge leaves the arc by about 0.46 degrees here.
      name: "a 151-degree edge",
      polygon: { outer: [point(0, 0), point(151, 0), point(75, 20)] },
    },
    {
      name: "an edge 0.011 degrees short of antipodal",
      polygon: { outer: [point(0, 0), point(179.989, 0), point(90, 30)] },
    },
    {
      // True area 11.18 steradians, beyond half the globe: PostGIS matched
      // the whole globe, MySQL the band.
      name: "the tropics band",
      polygon: {
        outer: [
          point(-170, -30),
          point(0, -30),
          point(170, -30),
          point(170, 30),
          point(0, 30),
          point(-170, 30),
        ],
      },
    },
    {
      // Each 175-degree edge straddles the great circle of the one across
      // the band, which it meets only at the antipode of their meeting.
      name: "a band with two long edges on each side",
      polygon: {
        outer: [
          point(0, -30),
          point(175, -30),
          point(-10, -30),
          point(-10, 30),
          point(175, 30),
          point(0, 30),
        ],
      },
    },
    {
      name: "a band from 180 to 0 through -90",
      polygon: {
        outer: [
          point(180, -40),
          point(-90, -40),
          point(0, -40),
          point(0, 40),
          point(-90, 40),
          point(180, 40),
        ],
      },
    },
    {
      // 27% of half the globe; PostGIS read it inside out, MySQL did not.
      name: "a ring across all three planes",
      polygon: {
        outer: [
          point(8.655_273, -4.888_118),
          point(9.783_711, -16.851_44),
          point(-9.977_974, -5.122_148),
          point(-43.180_112, 0.414_428),
          point(-57.786_262, -12.058_979),
          point(-44.864_831, -32.086_311),
          point(-14.135_991, -40.606_621),
          point(7.226_503, -34.495_989),
          point(9.873_38, -44.518_988),
          point(37.572_842, -71.070_42),
          point(102.183_743, -63.731_592),
          point(92.037_682, -46.942_718),
          point(50.468_332, -31.985_418),
          point(31.937_986, -23.462_884),
          point(31.748_745, -18.138_909),
          point(51.595_083, 4.804_735),
          point(54.301_739, 29.233_064),
          point(40.878_021, 45.271_161),
          point(14.791_082, 25.676_286),
        ],
      },
    },
    {
      // Both databases answered 600 of 600 points correctly in 5 rotations.
      name: "the Pacific",
      polygon: {
        outer: [
          point(120, -50),
          point(150, -55),
          point(-170, -60),
          point(-130, -60),
          point(-90, -55),
          point(-75, -40),
          point(-80, -5),
          point(-105, 20),
          point(-125, 45),
          point(-150, 58),
          point(175, 55),
          point(145, 40),
          point(125, 20),
          point(115, 0),
          point(115, -25),
        ],
      },
    },
    {
      // The meridian from the first hole's first vertex grazes the second
      // hole's vertex at 0.4, whose arcs both lie west of it.
      name: "holes where one grazes the other's meridian at a vertex",
      polygon: {
        outer: wide,
        holes: [
          [point(0.4, 1), point(0.6, 0.5), point(0.2, 0.5)],
          [point(0.4, 3), point(0.1, 2.5), point(0.1, 3.5)],
        ],
      },
    },
    {
      // Both holes reach west to longitude 2, where the sweep first meets
      // them; the northern one must be placed first.
      name: "holes side by side on one meridian",
      polygon: {
        outer: wide,
        holes: [
          [point(2, 2), point(2, 3), point(3, 3), point(3, 2)],
          [point(2, 4), point(2, 5), point(3, 5), point(3, 4)],
        ],
      },
    },
    {
      // On longitude 2 the second hole lies between the first hole's two
      // points there: the first is placed from its northern point.
      name: "a hole in another hole's notch, both reaching west to one meridian",
      polygon: {
        outer: wide,
        holes: [
          [point(2, 2), point(4, 4), point(2, 6), point(5, 6), point(5, 2)],
          [point(2, 4), point(3, 4.3), point(3, 3.7)],
        ],
      },
    },
    // MySQL answers points within about 1e-6 degrees of a vertex unlike the
    // sphere, so it misplaces points in rings this small; VibORM judges them
    // down to its 1e-9-degree resolution, at every latitude.
    {
      name: "a square 1e-5 degrees across on the equator",
      polygon: { outer: tiny(10, 0, 1e-5) },
    },
    {
      name: "a square 1e-5 degrees across at latitude 60",
      polygon: { outer: tiny(10, 60, 1e-5) },
    },
    {
      name: "a square 1e-5 degrees across at latitude 89.9",
      polygon: { outer: tiny(-120, 89.9, 1e-5) },
    },
    {
      name: "a square 1e-8 degrees across",
      polygon: { outer: tiny(10, 60, 1e-8) },
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
        // Both rings cross the antimeridian.
        holes: [
          [point(-175, 5), point(-175, -5), point(175, -5), point(175, 5)],
        ],
      },
    },
  ])("admits $name as written", ({ polygon }) => {
    expect(validateGeoPolygon(polygon)).toEqual({ value: polygon });
  });

  test("admits a 40,000-vertex star with 50 holes in near-linear time", () => {
    // Most spokes' boxes overlap each other and reach toward every hole:
    // comparing boxes took 7 s on a 20,000-vertex star, 98 s on that star
    // with these holes and 33 s on this star alone; the sweep takes under
    // 0.1 s. The bound leaves a slow machine a wide margin, a quadratic
    // pass none.
    const spokes = 40_000;
    const outer = Array.from({ length: spokes }, (_, index) => {
      const angle = (2 * Math.PI * index) / spokes;
      const radius = index % 2 === 1 ? 0.5 : 20;
      return point(radius * Math.cos(angle), radius * Math.sin(angle));
    });
    const holes = Array.from({ length: 50 }, (_, index) =>
      Array.from({ length: 8 }, (__, step) => {
        const angle = (-2 * Math.PI * step) / 8;
        return point(
          Math.cos(index) * 0.2 + 0.001 * Math.cos(angle),
          Math.sin(index) * 0.2 + 0.001 * Math.sin(angle)
        );
      })
    );
    const started = performance.now();
    const result = validateGeoPolygon({ outer, holes });
    const elapsed = performance.now() - started;
    expect(result.issues).toBeUndefined();
    expect(elapsed).toBeLessThan(2000);
  });

  test("admits 10,000 holes in near-linear time", () => {
    // Testing each hole against the outer ring and every earlier hole took
    // 7 s here; the sweep places every hole in one pass, in under 0.1 s.
    const outer = Array.from({ length: 64 }, (_, index) => {
      const angle = (2 * Math.PI * index) / 64;
      return point(12.8 * Math.cos(angle), 12.8 * Math.sin(angle));
    });
    const holes = Array.from({ length: 10_000 }, (_, index) => {
      const longitude = -9 + 0.18 * Math.floor(index / 100);
      const latitude = -9 + 0.18 * (index % 100);
      return [
        point(longitude, latitude),
        point(longitude, latitude + 0.1),
        point(longitude + 0.1, latitude + 0.1),
        point(longitude + 0.1, latitude),
      ];
    });
    const started = performance.now();
    const result = validateGeoPolygon({ outer, holes });
    const elapsed = performance.now() - started;
    expect(result.issues).toBeUndefined();
    expect(elapsed).toBeLessThan(2000);
  });

  test("admits strips chosen against predictable skip-list heights in near-linear time", () => {
    // The sweep's order is a skip list. Its heights once came from Park and
    // Miller's generator at a fixed seed, which anyone can replay: a strip
    // runs to longitude 0.1, and so stays in the sweep, exactly when both of
    // its arcs drew height 1, so the long-lived arcs were the ones every
    // search walks one by one. That took 8 s here and 44 s at twice the
    // strips, against 0.1 s for the same strips chosen at random; heights
    // the input cannot know take 0.1 s for both.
    const strips = 20_000;
    let seed = 1;
    const heights = Array.from({ length: 2 * strips + 2 }, () => {
      seed = (seed * 16_807) % 2_147_483_647;
      return 1 + Math.floor(-Math.log2(seed / 2_147_483_647));
    });
    const outer = [
      point(-0.01, -0.6),
      point(0.11, -0.6),
      point(0.11, 0.6),
      point(-0.01, 0.6),
    ];
    const holes = Array.from({ length: strips }, (_, index) => {
      const west = index * (0.1 / strips);
      const south = -0.5 + index / strips;
      const north = south + 0.3 / strips;
      const lasting =
        heights[2 + 2 * index] === 1 && heights[3 + 2 * index] === 1;
      const east = lasting ? 0.1 : west + 0.05 / strips;
      return [
        point(west, south),
        point(east, south),
        point(east, north),
        point(west, north),
      ];
    });
    const started = performance.now();
    const result = validateGeoPolygon({ outer, holes });
    const elapsed = performance.now() - started;
    expect(result.issues).toBeUndefined();
    expect(elapsed).toBeLessThan(2000);
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
