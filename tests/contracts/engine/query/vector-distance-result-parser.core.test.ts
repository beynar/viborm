import { PostgresAdapter } from "@adapters/databases/postgres/postgres-adapter";
import { QueryEngineError } from "@errors";
import { parseResult } from "@query-engine/result/ResultParser";
import { VECTOR_DISTANCE_RESULT_KEY } from "@query-engine/result-aliases";
import { s } from "@schema";
import { parserFor, prepareSchema } from "@tests/fixtures/query-scope";
import { describe, expect, test } from "vitest";

const vectorParserModels = {
  doc: s.model({
    id: s.string().id(),
    embedding: s.vector().dimension(3),
  }),
};

prepareSchema(vectorParserModels);

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
      [{ [VECTOR_DISTANCE_RESULT_KEY]: "0.25" }],
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
        [{ [VECTOR_DISTANCE_RESULT_KEY]: "not-a-number" }],
        VECTOR_SELECT_ARGS
      )
    ).toThrow("Cannot parse vector distance result.");
  });

  test("parses safe bigint distances without losing identity", () => {
    const ctx = parserFor(new PostgresAdapter(), vectorParserModels.doc);

    const rows = parseResult<Array<{ _distance: number }>>(
      ctx,
      "findMany",
      [{ [VECTOR_DISTANCE_RESULT_KEY]: 2n }],
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
        [{ [VECTOR_DISTANCE_RESULT_KEY]: 9_007_199_254_740_993n }],
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
