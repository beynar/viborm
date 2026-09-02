import { TransactionError } from "@errors";
import { createQueryScope } from "@query-engine/context/query-scope";
import { createModelRegistry, QueryEngine } from "@query-engine/query-engine";
import { hydrateSchemaNames, s } from "@schema";
import { sql } from "@sql";
import {
  createDataUniqueWhere,
  noAtomicSubstrateError,
  projectionReadsAnyTable,
  sameScalarValue,
  setCanFireReferentialAction,
} from "@src/query-engine/write-engine/shared";
import { PlanningDriver } from "@tests/fixtures/drivers/planning";
import { createSchemaRegistry } from "@validation";
import { describe, expect, test } from "vitest";

const author = s
  .model({
    id: s.string().id(),
    name: s.string(),
    articles: s.toMany(() => article),
  })
  .map("write_shared_coverage_authors");

const article = s
  .model({
    id: s.string().id(),
    title: s.string(),
    authorId: s.string(),
    author: s
      .toOne(() => author)
      .fields("authorId")
      .references("id"),
  })
  .map("write_shared_coverage_articles");

const clip = s
  .model({ id: s.string().id(), title: s.string() })
  .map("write_shared_coverage_clips");

const gallery = s
  .model({
    id: s.string().id(),
    subject: s
      .toOne(
        { article: () => article, clip: () => clip },
        {
          values: {
            article: "write-shared.article.v1",
            clip: "write-shared.clip.v1",
          },
        }
      )
      .optional(),
    items: s.toMany(
      { article: () => article, clip: () => clip },
      {
        values: {
          article: "write-shared.article.v1",
          clip: "write-shared.clip.v1",
        },
      }
    ),
  })
  .map("write_shared_coverage_galleries");

const locator = s
  .model({
    id: s.int().id(),
    email: s.string().unique(),
    region: s.string(),
    code: s.string(),
  })
  .unique(["region", "code"], { name: "regionCode" })
  .map("write_shared_coverage_locators");

const schema = { author, article, clip, gallery, locator };
hydrateSchemaNames(schema);

function engine(): QueryEngine {
  const driver = new PlanningDriver("postgresql");
  return new QueryEngine(
    driver,
    createModelRegistry(schema, createSchemaRegistry(schema))
  );
}

describe("write-fold projection reachability", () => {
  const authorTable = new Set(["write_shared_coverage_authors"]);

  test("row-held tagged predicates reach tables through is and isNot", () => {
    const queryEngine = engine();
    const scope = createQueryScope(queryEngine, gallery);

    expect(
      projectionReadsAnyTable(
        scope,
        { subject: { type: "article", is: { author: true } } },
        undefined,
        authorTable
      )
    ).toBe(true);
    expect(
      projectionReadsAnyTable(
        scope,
        undefined,
        { subject: { type: "article", isNot: { author: null } } },
        authorTable
      )
    ).toBe(true);
    expect(
      projectionReadsAnyTable(
        scope,
        { subject: { type: "unknown", is: { author: true } } },
        undefined,
        authorTable
      )
    ).toBe(false);
  });

  test("collection quantifiers inspect their selected variant target", () => {
    const queryEngine = engine();
    const scope = createQueryScope(queryEngine, gallery);

    for (const quantifier of ["some", "every", "none"] as const) {
      expect(
        projectionReadsAnyTable(
          scope,
          {
            items: {
              [quantifier]: {
                type: "article",
                is: { author: { name: { equals: "Ada" } } },
              },
            },
          },
          undefined,
          authorTable
        )
      ).toBe(true);
    }
  });

  test("flat and envelope variant projections traverse nested relation reads", () => {
    const queryEngine = engine();
    const scope = createQueryScope(queryEngine, gallery);

    expect(
      projectionReadsAnyTable(
        scope,
        { subject: { article: { include: { author: true } } } },
        undefined,
        authorTable
      )
    ).toBe(true);
    expect(
      projectionReadsAnyTable(
        scope,
        undefined,
        {
          items: {
            variants: { article: { select: { author: true } } },
          },
        },
        authorTable
      )
    ).toBe(true);
  });

  test("false, undefined, and unrelated variant leaves do not invent a read", () => {
    const queryEngine = engine();
    const scope = createQueryScope(queryEngine, gallery);

    expect(
      projectionReadsAnyTable(
        scope,
        { subject: false, items: undefined },
        undefined,
        authorTable
      )
    ).toBe(false);
    expect(
      projectionReadsAnyTable(
        scope,
        { subject: { clip: { select: { title: true } } } },
        undefined,
        authorTable
      )
    ).toBe(false);
  });
});

describe("write identity and referential-action helpers", () => {
  test("a complete scalar or compound unique is the create arm locator", () => {
    expect(
      createDataUniqueWhere(locator, {
        email: "exact@example.test",
        region: "eu",
        code: "one",
      })
    ).toEqual({ email: "exact@example.test" });
    expect(
      createDataUniqueWhere(
        locator,
        { region: "eu", code: "one" },
        new Set(["region", "code"])
      )
    ).toEqual({ regionCode: { region: "eu", code: "one" } });
  });

  test("a partial or non-literal compound unique cannot locate a fresh row", () => {
    expect(
      createDataUniqueWhere(
        locator,
        { region: "eu", code: "one" },
        new Set(["code"])
      )
    ).toBeUndefined();
    expect(
      createDataUniqueWhere(
        locator,
        { region: sql`upper(${"eu"})`, code: "one" },
        new Set(["region", "code"])
      )
    ).toBeUndefined();
    expect(
      createDataUniqueWhere(
        locator,
        { region: null, code: "one" },
        new Set(["region", "code"])
      )
    ).toBeUndefined();
  });

  test("referenced-key writes decline mutation folds while ordinary fields do not", () => {
    engine();
    expect(setCanFireReferentialAction(author, { id: "changed" })).toBe(true);
    expect(setCanFireReferentialAction(author, { name: "changed" })).toBe(
      false
    );
  });

  test("same-value transitions compare scalar values and Date instants", () => {
    expect(sameScalarValue("stable", "stable")).toBe(true);
    expect(sameScalarValue("stable", "changed")).toBe(false);
    expect(
      sameScalarValue(
        new Date("2025-01-01T00:00:00.000Z"),
        new Date("2025-01-01T00:00:00.000Z")
      )
    ).toBe(true);
    expect(
      sameScalarValue(
        new Date("2025-01-01T00:00:00.000Z"),
        new Date("2025-01-01T00:00:00.001Z")
      )
    ).toBe(false);
  });

  test("the no-substrate error preserves driver and operation attribution", () => {
    const error = noAtomicSubstrateError("planning-none", "upsert");

    expect(error).toBeInstanceOf(TransactionError);
    expect(error).toMatchObject({
      message:
        "Driver 'planning-none' supports neither transactions nor atomic batch execution.",
      meta: { driver: "planning-none", operation: "upsert" },
    });
  });
});

describe("coverage low value", () => {
  test("cross-type numeric comparison documents the parse-inaccessible branch", () => {
    expect(sameScalarValue(42, 42n)).toBe(true);
    expect(sameScalarValue(42, 43n)).toBe(false);
    expect(sameScalarValue("42", 42n)).toBe(false);
  });

  test("structured and array values are not addressable scalar locators", () => {
    expect(
      createDataUniqueWhere(locator, { email: ["not", "scalar"] })
    ).toBeUndefined();
    expect(
      createDataUniqueWhere(locator, { email: { nested: "not scalar" } })
    ).toBeUndefined();
  });
});
