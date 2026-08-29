import { PostgresAdapter } from "@adapters/databases/postgres/postgres-adapter";
import { QueryEngineError } from "@errors";
import { parseResult } from "@query-engine/result/ResultParser";
import {
  DISTANCE_RESULT_KEY,
  POLYMORPHIC_RESULT_STATE_KEY,
  POLYMORPHIC_RESULT_STATE_LINKED,
} from "@query-engine/result-aliases";
import { s } from "@schema";
import { parserFor, prepareSchema } from "@tests/fixtures/query-scope";
import { describe, expect, test } from "vitest";

const vectorParserModels = {
  doc: s.model({
    id: s.string().id(),
    embedding: s.vector().dimension(3),
  }),
  place: s.model({
    id: s.string().id(),
    location: s.point(),
    optionalLocation: s.point().nullable(),
  }),
};

prepareSchema(vectorParserModels);

const geoDistanceModels = (() => {
  const trip = s.model({
    id: s.string().id(),
    stops: s.toMany(() => stop),
  });
  const stop = s.model({
    id: s.string().id(),
    tripId: s.string(),
    location: s.point(),
    optionalLocation: s.point().nullable(),
    trip: s
      .toOne(() => trip)
      .fields("tripId")
      .references("id"),
  });
  const article = s.model({
    id: s.string().id(),
    location: s.point(),
    markers: s.toMany(() => marker).name("distanceTarget"),
  });
  const video = s.model({
    id: s.string().id(),
    location: s.point(),
    markers: s.toMany(() => marker).name("distanceTarget"),
  });
  const marker = s.model({
    id: s.string().id(),
    target: s
      .toOne({ article: () => article, video: () => video })
      .name("distanceTarget"),
  });
  return { article, marker, stop, trip, video };
})();

prepareSchema(geoDistanceModels);

const VECTOR_SELECT_ARGS = {
  select: {
    embedding: { _distance: { to: [1, 0, 0], metric: "l2" } },
  },
};

describe("Vector distance result parsing", () => {
  test("parses selected distance numeric strings as numbers", () => {
    const ctx = parserFor(new PostgresAdapter(), vectorParserModels.doc);

    const rows = parseResult<Array<{ _distance: number }>>(
      ctx,
      "findMany",
      [{ [DISTANCE_RESULT_KEY]: "0.25" }],
      VECTOR_SELECT_ARGS
    );

    expect(rows[0]?._distance).toBe(0.25);
    expect(typeof rows[0]?._distance).toBe("number");
  });

  test("throws when selected distance is not numeric", () => {
    const ctx = parserFor(new PostgresAdapter(), vectorParserModels.doc);

    expect(() =>
      parseResult(
        ctx,
        "findMany",
        [{ [DISTANCE_RESULT_KEY]: "not-a-number" }],
        VECTOR_SELECT_ARGS
      )
    ).toThrow("Cannot parse distance result");
  });

  test("parses safe bigint distances without losing identity", () => {
    const ctx = parserFor(new PostgresAdapter(), vectorParserModels.doc);

    const rows = parseResult<Array<{ _distance: number }>>(
      ctx,
      "findMany",
      [{ [DISTANCE_RESULT_KEY]: 2n }],
      VECTOR_SELECT_ARGS
    );

    expect(rows[0]?._distance).toBe(2);
  });

  test("rejects bigint distances that cannot be represented exactly", () => {
    const ctx = parserFor(new PostgresAdapter(), vectorParserModels.doc);

    let caught: unknown;
    try {
      parseResult(
        ctx,
        "findMany",
        [{ [DISTANCE_RESULT_KEY]: 9_007_199_254_740_993n }],
        VECTOR_SELECT_ARGS
      );
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(QueryEngineError);
    expect(caught).toMatchObject({
      meta: { driver: "query-engine", operation: "findMany" },
    });
  });
});

describe("GeoPoint distance result parsing", () => {
  const target = { longitude: 2.3522, latitude: 48.8566 };

  test("accepts null only for a nullable point source", () => {
    const ctx = parserFor(
      new PostgresAdapter("public", true),
      vectorParserModels.place
    );
    const nullable = parseResult<Array<{ _distance: number | null }>>(
      ctx,
      "findMany",
      [{ [DISTANCE_RESULT_KEY]: null }],
      {
        select: {
          optionalLocation: { _distance: { to: target } },
        },
      }
    );
    expect(nullable).toEqual([{ _distance: null }]);

    expect(() =>
      parseResult(ctx, "findMany", [{ [DISTANCE_RESULT_KEY]: null }], {
        select: { location: { _distance: { to: target } } },
      })
    ).toThrow("Cannot parse distance result");
  });

  test("projects distance through nested, variant, and returning result shapes", () => {
    const tripParser = parserFor(
      new PostgresAdapter("public", true),
      geoDistanceModels.trip
    );
    expect(
      parseResult(
        tripParser,
        "findMany",
        [{ stops: [{ [DISTANCE_RESULT_KEY]: "12.5" }] }],
        {
          select: {
            stops: {
              select: { location: { _distance: { to: target } } },
            },
          },
        }
      )
    ).toEqual([{ stops: [{ _distance: 12.5 }] }]);

    expect(
      parseResult(
        tripParser,
        "findMany",
        [{ stops: [{ [DISTANCE_RESULT_KEY]: null }] }],
        {
          select: {
            stops: {
              select: {
                optionalLocation: { _distance: { to: target } },
              },
            },
          },
        }
      )
    ).toEqual([{ stops: [{ _distance: null }] }]);

    const markerParser = parserFor(
      new PostgresAdapter("public", true),
      geoDistanceModels.marker
    );
    expect(
      parseResult(
        markerParser,
        "findMany",
        [
          {
            target: {
              [POLYMORPHIC_RESULT_STATE_KEY]: POLYMORPHIC_RESULT_STATE_LINKED,
              type: "article",
              data: { [DISTANCE_RESULT_KEY]: "9" },
            },
          },
        ],
        {
          select: {
            target: {
              article: {
                select: { location: { _distance: { to: target } } },
              },
              video: {
                select: { location: { _distance: { to: target } } },
              },
            },
          },
        }
      )
    ).toEqual([{ target: { type: "article", data: { _distance: 9 } } }]);

    expect(
      parseResult(
        tripParser,
        "create",
        [{ stops: [{ [DISTANCE_RESULT_KEY]: "0" }] }],
        {
          select: {
            stops: {
              select: { location: { _distance: { to: target } } },
            },
          },
        }
      )
    ).toEqual({ stops: [{ _distance: 0 }] });
  });
});
