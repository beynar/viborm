import { PGliteDriver } from "@drivers/pglite";
import { s } from "@schema";
import {
  createClient,
  createModelFieldRefs,
  type GeoArea,
  type GeoPoint,
} from "@src/index";
import { v } from "@validation";
import { describe, expectTypeOf, test } from "vitest";

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends <
    Value,
  >() => Value extends Right ? 1 : 2
    ? true
    : false;
type Expect<Value extends true> = Value;

const paris: GeoPoint = { longitude: 2.3522, latitude: 48.8566 };
const bounds: GeoArea = {
  bounds: { south: 48, west: 1, north: 49, east: 3 },
};
const validNullableDistance = { to: paris, lte: 1 } as const;
const invalidNullableDistance = { to: null, lte: 1 } as const;
type ExpectedGeoArea =
  | {
      readonly bounds: {
        south: number;
        west: number;
        north: number;
        east: number;
      };
    }
  | {
      readonly polygon: {
        outer: readonly GeoPoint[];
        holes?: readonly (readonly GeoPoint[])[];
      };
    };
type _geoAreaIsExact = Expect<Equal<GeoArea, ExpectedGeoArea>>;
type _geoPointHasNoCartesianAlias = Expect<
  Equal<Extract<"x" | "y", keyof GeoPoint>, never>
>;
type _geoAreaHasNoGenericAlias = Expect<
  Equal<Extract<"box" | "circle" | "geometry", keyof GeoArea>, never>
>;
const place = s.model({
  id: s.string().id(),
  name: s.string(),
  location: s.point().nullable(),
});
const createPointClient = () =>
  createClient({ schema: { place }, driver: new PGliteDriver() });

const journey = s.model({
  id: s.string().id(),
  stops: s.toMany(() => stop),
});
const stop = s.model({
  id: s.string().id(),
  journeyId: s.string(),
  location: s.point(),
  optionalLocation: s.point().nullable(),
  journey: s
    .toOne(() => journey)
    .fields("journeyId")
    .references("id"),
});
const article = s.model({
  id: s.string().id(),
  location: s.point(),
  markers: s.toMany(() => marker).name("markedTarget"),
});
const video = s.model({
  id: s.string().id(),
  location: s.point(),
  markers: s.toMany(() => marker).name("markedTarget"),
});
const marker = s.model({
  id: s.string().id(),
  target: s
    .toOne({ article: () => article, video: () => video })
    .name("markedTarget"),
});

const createGraphClient = () =>
  createClient({
    schema: { article, journey, marker, stop, video },
    driver: new PGliteDriver(),
  });

const validPointCalls = () => {
  const client = createPointClient();
  s.point().nullable().default(paris).map("location");
  s.model({ id: s.string().id(), location: s.point() }).index(["location"], {
    type: "spatial",
  });
  client.place.findMany({
    where: {
      location: {
        equals: paris,
        distance: { to: paris, gte: 0, lte: 10_000 },
        within: bounds,
        not: { within: bounds },
      },
    },
    select: { location: { _distance: { to: paris } } },
    orderBy: {
      location: { _distance: { to: paris, sort: "asc" } },
    },
  });
  client.place.findMany({
    where: { location: { distance: validNullableDistance } },
  });
  client.place.create({
    data: { id: "place-1", name: "Paris", location: paris },
    select: { location: true },
  });
  client.place.update({
    where: { id: "place-1" },
    data: { location: { set: paris } },
    select: { location: true },
  });
  client.place.createMany({
    data: [{ id: "place-2", name: "London", location: paris }],
    select: { location: true },
  });
  client.place.updateMany({
    where: { location: { within: bounds } },
    data: { location: paris },
    select: { location: true },
  });
  client.place.upsert({
    where: { id: "place-3" },
    create: { id: "place-3", name: "Rome", location: paris },
    update: { location: paris },
    select: { location: true },
  });

  const graph = createGraphClient();
  graph.journey.create({
    data: {
      id: "journey-1",
      stops: {
        create: { id: "stop-1", location: paris },
      },
    },
    select: { stops: { select: { location: true } } },
  });
  graph.journey.update({
    where: { id: "journey-1" },
    data: {
      stops: {
        update: {
          where: { id: "stop-1" },
          data: { location: paris },
        },
      },
    },
    select: { stops: { select: { location: true } } },
  });
  graph.marker.create({
    data: {
      id: "marker-1",
      target: {
        create: {
          type: "article",
          data: { id: "article-1", location: paris },
        },
      },
    },
    select: {
      target: {
        article: { select: { location: true } },
        video: { select: { location: true } },
      },
    },
  });
};

const invalidPointCalls = () => {
  const client = createPointClient();
  // @ts-expect-error - the ORM GeoPoint factory has no argument
  s.point(undefined);
  // @ts-expect-error - GeoPoint has no array modifier
  s.point().array();
  // @ts-expect-error - GeoPoint has no ID modifier
  s.point().id();
  // @ts-expect-error - GeoPoint has no unique modifier
  s.point().unique();
  // @ts-expect-error - GeoPoint has no custom-schema modifier
  s.point().schema(v.point());
  // @ts-expect-error - an ordinary index cannot contain a GeoPoint
  place.index(["location"]);
  // @ts-expect-error - a nullable GeoPoint cannot be spatially indexed
  place.index(["location"], { type: "spatial" });
  // @ts-expect-error - GeoPoint has no compound-key role
  place.id(["id", "location"]);
  // @ts-expect-error - GeoPoint has no compound-unique role
  place.unique(["id", "location"]);

  const refs = createModelFieldRefs("place", place);
  // @ts-expect-error - GeoPoint has no field-reference token
  refs.location;

  client.place.findMany({
    // @ts-expect-error - GeoPoint has no ordinary scalar order
    orderBy: { name: "asc", location: "asc" },
  });
  client.place.findMany({
    // @ts-expect-error - GeoPoint has no distinct role
    distinct: ["id", "location"],
  });
  client.place.groupBy({
    // @ts-expect-error - GeoPoint has no groupBy role
    by: ["id", "location"],
  });
  client.place.aggregate({
    // @ts-expect-error - GeoPoint has no min/max aggregate role
    _min: { name: true, location: true },
  });
  client.place.findMany({
    where: {
      location: {
        // @ts-expect-error - a nullable field still needs a non-null distance target
        distance: { to: null, lte: 1 },
      },
    },
  });
  client.place.findMany({
    where: {
      location: {
        // @ts-expect-error - the non-fresh target bag retains the same refusal
        distance: invalidNullableDistance,
      },
    },
  });

  client.place.findMany({
    where: {
      location: {
        equals: paris,
        // @ts-expect-error - recursive `not` owns the inverse of `within`
        notWithin: bounds,
      },
    },
  });
  client.place.findMany({
    where: {
      location: {
        equals: paris,
        // @ts-expect-error - recursive `not` owns the inverse distance spelling
        notNear: { to: paris, lte: 1000 },
      },
    },
  });
  client.place.findMany({
    where: {
      location: {
        equals: paris,
        // @ts-expect-error - `not: { within: ... }` owns outside membership
        outside: bounds,
      },
    },
  });
  client.place.findMany({
    where: {
      location: {
        equals: paris,
        // @ts-expect-error - `distance.gt` owns farther-than filtering
        far: { to: paris, gt: 1000 },
      },
    },
  });
  client.place.findMany({
    where: {
      location: {
        equals: paris,
        // @ts-expect-error - sibling distance comparisons own a distance band
        between: { to: paris, gte: 1000, lte: 2000 },
      },
    },
  });
  client.place.findMany({
    where: {
      location: {
        equals: paris,
        // @ts-expect-error - point/area intersection is named `within`
        intersects: bounds,
      },
    },
  });
  client.place.findMany({
    where: {
      location: {
        equals: paris,
        // @ts-expect-error - the stored point does not contain an area
        contains: bounds,
      },
    },
  });
  client.place.findMany({
    where: {
      location: {
        equals: paris,
        // @ts-expect-error - GeoPoint V1 has no generic topology language
        crosses: bounds,
      },
    },
  });
  client.place.findMany({
    where: {
      location: {
        equals: paris,
        // @ts-expect-error - GeoPoint V1 has no generic topology language
        overlaps: bounds,
      },
    },
  });
  client.place.findMany({
    where: {
      location: {
        equals: paris,
        // @ts-expect-error - inclusive boundary membership is named `within`
        touches: bounds,
      },
    },
  });
  client.place.findMany({
    where: {
      location: {
        equals: paris,
        // @ts-expect-error - inclusive point-in-area membership is named `within`
        covers: bounds,
      },
    },
  });

  for (const retired of [
    { equals: paris, notWithin: bounds },
    { equals: paris, notNear: { to: paris, lte: 1000 } },
    { equals: paris, outside: bounds },
    { equals: paris, far: { to: paris, gt: 1000 } },
    { equals: paris, between: { to: paris, gte: 1000, lte: 2000 } },
    { equals: paris, intersects: bounds },
    { equals: paris, contains: bounds },
    { equals: paris, crosses: bounds },
    { equals: paris, overlaps: bounds },
    { equals: paris, touches: bounds },
    { equals: paris, covers: bounds },
  ] as const) {
    client.place.findMany({
      where: {
        // @ts-expect-error - non-fresh point filters keep the exact operator set
        location: retired,
      },
    });
  }

  client.place.create({
    data: {
      id: "bad-point",
      name: "Bad point",
      // @ts-expect-error - a fresh point refuses a typo beside both real keys
      location: { longitude: 2, latitude: 48, latitdue: 48 },
    },
  });
  const nonFreshPoint = { longitude: 2, latitude: 48, latitdue: 48 };
  client.place.create({
    data: {
      id: "bad-non-fresh-point",
      name: "Bad point",
      // @ts-expect-error - a non-fresh point keeps the exact value boundary
      location: nonFreshPoint,
    },
  });
  const graph = createGraphClient();
  // Intentional compiling frontier pins: sealing a non-fresh GeoPoint one
  // relation deeper measured 15,906,084 instantiations against the 15,636,075
  // gate. This is the repository's documented depth-three boundary; the strict
  // nested operation schemas own these refusals at runtime.
  graph.journey.create({
    data: {
      id: "bad-nested-write",
      stops: { create: { id: "bad-stop", location: nonFreshPoint } },
    },
  });
  graph.journey.findMany({
    where: {
      stops: { some: { location: { equals: nonFreshPoint } } },
    },
  });
  graph.marker.create({
    data: {
      id: "bad-variant-write",
      target: {
        create: {
          type: "article",
          data: { id: "bad-article", location: nonFreshPoint },
        },
      },
    },
  });
  graph.marker.findMany({
    where: {
      target: {
        type: "article",
        is: { location: { equals: nonFreshPoint } },
      },
    },
  });
  const nestedArea = {
    bounds: { south: 48, west: 1, north: 49, east: 3, nort: 49 },
  };
  graph.journey.findMany({
    where: {
      stops: { some: { location: { within: nestedArea } } },
    },
  });
  graph.marker.findMany({
    where: {
      target: {
        type: "article",
        is: { location: { within: nestedArea } },
      },
    },
  });
  client.place.findMany({
    where: {
      location: {
        within: {
          bounds: {
            south: 48,
            west: 1,
            north: 49,
            east: 3,
            // @ts-expect-error - a fresh area refuses a typo beside every real bound
            nort: 49,
          },
        },
      },
    },
  });
  client.place.findMany({
    where: {
      location: {
        within: {
          // @ts-expect-error - a GeoArea has exactly one discriminating arm
          bounds: { south: 48, west: 1, north: 49, east: 3 },
          // @ts-expect-error - neither arm remains valid when both are present
          polygon: {
            outer: [
              { longitude: 1, latitude: 48 },
              { longitude: 3, latitude: 48 },
              { longitude: 2, latitude: 49 },
            ],
          },
        },
      },
    },
  });
  const nonFreshDualArea = {
    bounds: { south: 48, west: 1, north: 49, east: 3 },
    polygon: {
      outer: [
        { longitude: 1, latitude: 48 },
        { longitude: 3, latitude: 48 },
        { longitude: 2, latitude: 49 },
      ],
    },
  };
  client.place.findMany({
    where: {
      location: {
        // @ts-expect-error - a non-fresh GeoArea also has exactly one arm
        within: nonFreshDualArea,
      },
    },
  });
  const nonFreshArea = {
    bounds: { south: 48, west: 1, north: 49, east: 3, nort: 49 },
  };
  client.place.findMany({
    where: {
      location: {
        // @ts-expect-error - a non-fresh area retains exact discrimination
        within: nonFreshArea,
      },
    },
  });
};

const nullableDistance = async () => {
  const client = createPointClient();
  const rows = await client.place.findMany({
    select: { location: { _distance: { to: paris } } },
  });
  return rows[0]?._distance;
};

const relationDistanceShapes = async () => {
  const client = createGraphClient();
  const nested = await client.journey.findMany({
    select: {
      stops: {
        select: { location: { _distance: { to: paris } } },
      },
    },
  });
  expectTypeOf(nested[0]?.stops[0]?._distance).toEqualTypeOf<
    number | undefined
  >();

  const nullableNested = await client.journey.findMany({
    select: {
      stops: {
        select: { optionalLocation: { _distance: { to: paris } } },
      },
    },
  });
  expectTypeOf(nullableNested[0]?.stops[0]?._distance).toEqualTypeOf<
    number | null | undefined
  >();

  const variant = await client.marker.findMany({
    select: {
      target: {
        article: {
          select: { location: { _distance: { to: paris } } },
        },
        video: {
          select: { location: { _distance: { to: paris } } },
        },
      },
    },
  });
  const target = variant[0]?.target;
  if (target?.type === "article" || target?.type === "video") {
    expectTypeOf(target.data._distance).toEqualTypeOf<number>();
  }

  const returning = await client.journey.create({
    data: {
      id: "journey-distance",
      stops: {
        create: {
          id: "stop-distance",
          location: paris,
          optionalLocation: null,
        },
      },
    },
    select: {
      stops: {
        select: { location: { _distance: { to: paris } } },
      },
    },
  });
  expectTypeOf(returning.stops[0]?._distance).toEqualTypeOf<
    number | undefined
  >();
};

describe("public GeoPoint surface", () => {
  test("the probes enter through the public builder and client", () => {
    expectTypeOf(validPointCalls).toBeFunction();
    expectTypeOf(invalidPointCalls).toBeFunction();
    expectTypeOf(relationDistanceShapes).toBeFunction();
    expectTypeOf<ReturnType<typeof nullableDistance>>().toEqualTypeOf<
      Promise<number | null | undefined>
    >();
    expectTypeOf<GeoPoint>().toEqualTypeOf<{
      longitude: number;
      latitude: number;
    }>();
  });
});
