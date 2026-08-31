import type { AnyDriver } from "@drivers";
import { NestedWriteError, QueryEngineError } from "@errors";
import { createQueryScope } from "@query-engine/context/query-scope";
import { createModelRegistry, QueryEngine } from "@query-engine/query-engine";
import { s } from "@schema";
import type { AnyModel } from "@schema/model";
import { prepareBulkPolymorphicConnects } from "@src/query-engine/write-engine/bulk-polymorphic-connect";
import { ManyAndReturnOperation } from "@src/query-engine/write-engine/ManyAndReturnOperation";
import { planningKey } from "@src/query-engine/write-engine/Part";
import { StepScope } from "@src/query-engine/write-engine/StepScope";
import { PlanningDriver } from "@tests/fixtures/drivers/planning";
import { prepareSchema } from "@tests/fixtures/query-scope";
import { createSchemaRegistry } from "@validation";
import { describe, expect, test } from "vitest";

const schema = (() => {
  const article = s
    .model({
      id: s.int().id(),
      slug: s.string().unique(),
      title: s.string(),
    })
    .map("bulk_poly_articles");
  const clip = s
    .model({ id: s.int().id(), title: s.string() })
    .map("bulk_poly_clips");
  const card = s
    .model({
      id: s.string().id(),
      label: s.string(),
      subject: s
        .toOne(
          { article: () => article, clip: () => clip },
          {
            values: {
              article: "bulk.article.v1",
              clip: "bulk.clip.v1",
            },
          }
        )
        .optional(),
    })
    .map("bulk_poly_cards");
  return { article, clip, card };
})();

const collectionSchema = (() => {
  const owner = s.model({
    id: s.string().id(),
    subject: s
      .toOne(
        { article: () => member },
        { values: { article: "bulk.row.article.v1" } }
      )
      .optional(),
    items: s.toMany(
      { article: () => member },
      { values: { article: "bulk.collection.article.v1" } }
    ),
  });
  const member = s.model({ id: s.int().id(), title: s.string() });
  return { owner, member };
})();

prepareSchema(schema);
prepareSchema(collectionSchema);

class BatchPlanningDriver extends PlanningDriver {
  constructor() {
    super("postgresql", {
      supportsTransactions: false,
      supportsBatch: true,
    });
  }
}

function engineFor(
  driver: AnyDriver,
  models: Record<string, AnyModel> = schema
): QueryEngine {
  return new QueryEngine(
    driver,
    createModelRegistry(models, createSchemaRegistry(models))
  );
}

function operation(
  driver: AnyDriver,
  data: readonly Record<string, unknown>[]
) {
  return new ManyAndReturnOperation(
    engineFor(driver),
    schema.card,
    "createManyAndReturn",
    {
      data,
      select: { id: true, label: true },
    }
  );
}

function knownRows(
  current: ManyAndReturnOperation,
  rows: readonly Record<string, unknown>[]
): Record<string, unknown> {
  return Object.fromEntries(
    current.planning().steps.map((step) => [planningKey(step.id, "rows"), rows])
  );
}

describe("grouped polymorphic createMany connects", () => {
  test("groups by variant, deduplicates probes, and restores storage per input row", () => {
    const current = operation(new PlanningDriver("postgresql"), [
      { id: "plain", label: "plain" },
      {
        id: "article-1",
        label: "article one",
        subject: {
          connect: { type: "article", where: { slug: "article-a" } },
        },
      },
      {
        id: "article-2",
        label: "article two",
        subject: {
          connect: { type: "article", where: { slug: "article-a" } },
        },
      },
      {
        id: "clip-1",
        label: "clip one",
        subject: { connect: { type: "clip", where: { id: 20 } } },
      },
    ]);
    const planning = current.planning();

    expect(planning.steps).toHaveLength(2);
    expect(
      planning.steps.flatMap((step) =>
        "statement" in step ? step.statement.values : []
      )
    ).toEqual(expect.arrayContaining(["article-a", 20]));
    expect(
      planning.steps
        .flatMap((step) => ("statement" in step ? step.statement.values : []))
        .filter((value) => value === "article-a")
    ).toHaveLength(1);

    const compiled = current.compile(
      knownRows(current, [
        { id: 10, slug: "article-a" },
        { id: 20, slug: "unused" },
      ])
    );
    expect(compiled.steps.every((step) => step.kind === "write")).toBe(true);
    const values = compiled.steps.flatMap((step) =>
      "statement" in step ? step.statement.values : []
    );
    expect(values.filter((value) => value === "bulk.article.v1")).toHaveLength(
      2
    );
    expect(values).toContain("bulk.clip.v1");
    expect(values.filter((value) => value === 10)).toHaveLength(2);
    expect(values).toContain(20);
  });

  test("batch mode guards every resolved target before the grouped insert", () => {
    const current = operation(new BatchPlanningDriver(), [
      {
        id: "article-1",
        label: "article one",
        subject: {
          connect: { type: "article", where: { slug: "article-a" } },
        },
      },
    ]);
    const compiled = current.compile(
      knownRows(current, [{ id: 10, slug: "article-a" }])
    );

    expect(compiled.steps.map((step) => step.kind)).toEqual(["guard", "write"]);
    const guard = compiled.steps[0];
    if (!guard || guard.kind !== "guard") {
      throw new Error("expected a target-presence guard");
    }
    expect(guard.premise.statement.values).toEqual(
      expect.arrayContaining(["article-a", 10])
    );
  });

  test("fails closed when the probe result is missing or does not match", () => {
    const current = operation(new PlanningDriver("postgresql"), [
      {
        id: "article-1",
        label: "article one",
        subject: {
          connect: { type: "article", where: { slug: "article-a" } },
        },
      },
    ]);

    expect(() => current.compile({})).toThrow(QueryEngineError);
    expect(() =>
      current.compile(knownRows(current, [{ id: 10, slug: "another" }]))
    ).toThrow(NestedWriteError);
  });
});

describe("coverage low value", () => {
  test("the direct bulk seam rejects a collection carrier", () => {
    const queryEngine = engineFor(
      new PlanningDriver("postgresql"),
      collectionSchema
    );
    expect(() =>
      prepareBulkPolymorphicConnects(
        queryEngine,
        createQueryScope(queryEngine, collectionSchema.owner),
        [
          {
            id: "owner-1",
            subject: {
              connect: { type: "article", where: { id: 1 } },
            },
            items: {
              connect: [{ type: "article", where: { id: 1 } }],
            },
          },
        ],
        new StepScope(),
        true
      )
    ).toThrow(/is a collection/);
  });
});
