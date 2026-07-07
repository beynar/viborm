import { PostgresAdapter } from "@adapters/databases/postgres/postgres-adapter";
import {
  createModelRegistry,
  createQueryContext,
  parseResult,
} from "@query-engine";
import { s } from "@schema";
import { createSchemaRegistry } from "@validation";
import { describe, expect, test } from "vitest";

const vectorParserModels = {
  doc: s.model({
    id: s.string().id(),
    embedding: s.vector().dimension(3),
  }),
};

const vectorParserRegistry = createModelRegistry(
  vectorParserModels,
  createSchemaRegistry(vectorParserModels)
);

describe("Vector distance result parsing", () => {
  test("parses selected distance numeric strings as numbers", () => {
    const ctx = createQueryContext(
      new PostgresAdapter(),
      vectorParserModels.doc,
      vectorParserRegistry
    );

    const rows = parseResult<Array<{ _distance: number }>>(ctx, "findMany", [
      { _distance: "0.25" },
    ]);

    expect(rows[0]?._distance).toBe(0.25);
    expect(typeof rows[0]?._distance).toBe("number");
  });

  test("throws when selected distance is not numeric", () => {
    const ctx = createQueryContext(
      new PostgresAdapter(),
      vectorParserModels.doc,
      vectorParserRegistry
    );

    expect(() =>
      parseResult(ctx, "findMany", [{ _distance: "not-a-number" }])
    ).toThrow("Cannot parse vector distance result.");
  });
});
