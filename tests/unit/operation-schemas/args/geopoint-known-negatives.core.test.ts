import { s } from "@schema";
import { createSchemaRegistry, parse } from "@validation";
import { describe, expect, test } from "vitest";

const place = s.model({
  id: s.string().id(),
  name: s.string(),
  score: s.int(),
  location: s.point(),
});

const schemas = createSchemaRegistry({ place }).proxy.place;

const journey = s.model({
  id: s.string().id(),
  stops: s.toMany(() => stop),
});
const stop = s.model({
  id: s.string().id(),
  journeyId: s.string(),
  location: s.point(),
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
const graphSchemas = createSchemaRegistry({
  article,
  journey,
  marker,
  stop,
  video,
}).proxy;

const firstMessage = (issues: readonly { message: string }[] | undefined) =>
  issues?.[0]?.message;

describe("GeoPoint retained negative operation keys", () => {
  test("accepts distance projection and ordering on a point", () => {
    expect(
      parse(schemas.core.select, {
        location: {
          _distance: { to: { longitude: 2.3522, latitude: 48.8566 } },
        },
      }).issues
    ).toBeUndefined();
    expect(
      parse(schemas.core.orderBy, {
        location: {
          _distance: {
            to: { longitude: 2.3522, latitude: 48.8566 },
            sort: "desc",
          },
        },
      }).issues
    ).toBeUndefined();
  });

  for (const retired of [
    "notWithin",
    "notNear",
    "outside",
    "far",
    "between",
    "intersects",
    "contains",
    "crosses",
    "overlaps",
    "touches",
    "covers",
  ] as const) {
    test(`refuses the retired '${retired}' point operator beside equals`, () => {
      const result = parse(schemas.core.where, {
        location: {
          equals: { longitude: 2.3522, latitude: 48.8566 },
          [retired]: { bounds: { south: 48, west: 1, north: 49, east: 3 } },
        },
      });

      expect(firstMessage(result.issues)).toContain(`Unknown key: ${retired}`);
    });
  }

  for (const aggregate of ["_avg", "_sum", "_min", "_max"] as const) {
    test(`${aggregate} refuses a point beside an ordinary scalar`, () => {
      const control =
        aggregate === "_avg" || aggregate === "_sum" ? "score" : "name";
      const result = parse(schemas.args.aggregate, {
        [aggregate]: { [control]: true, location: true },
      });

      expect(firstMessage(result.issues)).toContain(
        `A GeoPoint cannot be projected by '${aggregate}'; use a distance projection or '_count'.`
      );
    });

    test(`groupBy ${aggregate} ordering refuses a point`, () => {
      const control =
        aggregate === "_avg" || aggregate === "_sum" ? "score" : "name";
      const result = parse(schemas.args.groupBy, {
        by: ["name"],
        orderBy: { [aggregate]: { [control]: "asc", location: "desc" } },
      });

      expect(firstMessage(result.issues)).toContain(
        `A GeoPoint cannot be ordered by '${aggregate}'; use '_distance' or '_count'.`
      );
    });
  }

  test("having refuses a point beside an ordinary scalar", () => {
    const result = parse(schemas.args.groupBy, {
      by: ["name"],
      having: {
        name: { equals: "Paris" },
        location: { equals: { longitude: 2.3522, latitude: 48.8566 } },
      },
    });

    expect(firstMessage(result.issues)).toBe(
      "A GeoPoint cannot be used in 'having'."
    );
  });

  test("count remains valid for a point", () => {
    const result = parse(schemas.args.aggregate, {
      _count: { location: true },
    });

    expect(result.issues).toBeUndefined();
  });

  test("ordinary nested create refuses a non-fresh point typo", () => {
    const invalidPoint = { longitude: 2, latitude: 48, latitdue: 48 };
    const result = parse(graphSchemas.journey.args.create, {
      data: {
        id: "journey-1",
        stops: { create: { id: "stop-1", location: invalidPoint } },
      },
    });

    expect(firstMessage(result.issues)).toContain(
      "Expected GeoPoint with exactly longitude and latitude"
    );
  });

  test("ordinary nested filter refuses a non-fresh point typo", () => {
    const invalidPoint = { longitude: 2, latitude: 48, latitdue: 48 };
    const result = parse(graphSchemas.journey.args.findMany, {
      where: {
        stops: { some: { location: { equals: invalidPoint } } },
      },
    });

    expect(firstMessage(result.issues)).toContain(
      "Expected GeoPoint with exactly longitude and latitude"
    );
  });

  test("variant nested create refuses a non-fresh point typo", () => {
    const invalidPoint = { longitude: 2, latitude: 48, latitdue: 48 };
    const result = parse(graphSchemas.marker.args.create, {
      data: {
        id: "marker-1",
        target: {
          create: {
            type: "article",
            data: { id: "article-1", location: invalidPoint },
          },
        },
      },
    });

    expect(firstMessage(result.issues)).toContain(
      "Expected GeoPoint with exactly longitude and latitude"
    );
  });

  test("variant nested filter refuses a non-fresh point typo", () => {
    const invalidPoint = { longitude: 2, latitude: 48, latitdue: 48 };
    const result = parse(graphSchemas.marker.args.findMany, {
      where: {
        target: {
          type: "article",
          is: { location: { equals: invalidPoint } },
        },
      },
    });

    expect(firstMessage(result.issues)).toContain(
      "Expected GeoPoint with exactly longitude and latitude"
    );
  });

  test("ordinary nested filter refuses a non-fresh area typo", () => {
    const invalidArea = {
      bounds: { south: 48, west: 1, north: 49, east: 3, nort: 49 },
    };
    const result = parse(graphSchemas.journey.args.findMany, {
      where: {
        stops: { some: { location: { within: invalidArea } } },
      },
    });

    expect(firstMessage(result.issues)).toContain(
      "Expected GeoBounds with exactly south and west and north and east"
    );
  });

  test("variant nested filter refuses a non-fresh area typo", () => {
    const invalidArea = {
      bounds: { south: 48, west: 1, north: 49, east: 3, nort: 49 },
    };
    const result = parse(graphSchemas.marker.args.findMany, {
      where: {
        target: {
          type: "article",
          is: { location: { within: invalidArea } },
        },
      },
    });

    expect(firstMessage(result.issues)).toContain(
      "Expected GeoBounds with exactly south and west and north and east"
    );
  });
});
