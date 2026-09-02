import { createModelRegistry, QueryEngine } from "@query-engine/query-engine";
import { s } from "@schema";
import type {
  OperationFragment,
  WriteStep,
} from "@src/query-engine/write-engine/OperationFragment";
import { planningKey } from "@src/query-engine/write-engine/Part";
import { UpdateOperation } from "@src/query-engine/write-engine/UpdateOperation";
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
    .map("relation_coverage_article");
  const video = s
    .model({
      id: s.int().id(),
      slug: s.string().unique(),
      title: s.string(),
    })
    .map("relation_coverage_video");
  const comment = s
    .model({
      id: s.string().id(),
      body: s.string(),
      subject: s
        .toOne(
          { article: () => article, video: () => video },
          {
            values: {
              article: "relation.coverage.article.v1",
              video: "relation.coverage.video.v1",
            },
          }
        )
        .optional(),
    })
    .map("relation_coverage_comment");
  return { article, comment, video };
})();

prepareSchema(schema);

function operation(subject: Record<string, unknown>): UpdateOperation {
  const driver = new PlanningDriver("postgresql");
  const engine = new QueryEngine(
    driver,
    createModelRegistry(schema, createSchemaRegistry(schema))
  );
  return new UpdateOperation(engine, schema.comment, {
    where: { id: "comment-1" },
    data: { subject },
    select: { id: true },
  });
}

function knownFor(
  current: UpdateOperation,
  targetRows: readonly Record<string, unknown>[],
  root: Record<string, unknown> = {
    id: "comment-1",
    body: "before",
    subject_type: "relation.coverage.article.v1",
    subject_id: 1,
  }
): Record<string, unknown> {
  return Object.fromEntries(
    current
      .planning()
      .steps.map((step) => [
        planningKey(step.id, "rows"),
        step.id === "comment.locate" ? [root] : targetRows,
      ])
  );
}

function writes(fragment: OperationFragment): readonly WriteStep[] {
  return fragment.steps.filter(
    (step): step is WriteStep => step.kind === "write"
  );
}

function ids(fragment: OperationFragment): string[] {
  return fragment.steps.map((step) => step.id);
}

function sqlText(step: WriteStep): string {
  return step.statement.strings.join("?");
}

describe("record compiler direct-polymorphic upsert coverage", () => {
  test("the same-type found arm updates the selected target by captured row key", () => {
    const current = operation({
      upsert: {
        type: "article",
        create: { id: 2, slug: "unused", title: "unused" },
        update: { title: "after" },
      },
    });
    const compiled = current.compile(
      knownFor(current, [{ id: 1, slug: "current", title: "before" }])
    );

    expect(ids(compiled)).toContain("article.update");
    expect(ids(compiled)).not.toContain("article.create");
    const update = writes(compiled).find(
      (step) => step.id === "article.update"
    );
    if (!update) throw new Error("expected the polymorphic update arm");
    expect(sqlText(update)).toContain(
      'UPDATE "public"."relation_coverage_article"'
    );
    expect(update.statement.values).toEqual(
      expect.arrayContaining(["after", 1])
    );
  });

  test("a different-type empty probe creates the requested target and rewrites both storage columns", () => {
    const current = operation({
      upsert: {
        type: "video",
        create: { id: 7, slug: "replacement", title: "replacement" },
        update: { title: "unused" },
      },
    });
    const compiled = current.compile(knownFor(current, []));

    expect(ids(compiled)).toContain("video.create");
    expect(ids(compiled)).not.toContain("video.update");
    const rootUpdate = writes(compiled).find(
      (step) => step.id === "comment.update"
    );
    if (!rootUpdate) throw new Error("expected the polymorphic storage update");
    expect(sqlText(rootUpdate)).toContain('"subject_type" = ?');
    expect(sqlText(rootUpdate)).toContain('"subject_id" = CAST(? AS INTEGER)');
    expect(rootUpdate.statement.values).toEqual(
      expect.arrayContaining(["relation.coverage.video.v1", 7, "comment-1"])
    );
  });

  test("an empty update arm still keeps the found target and compiles no target write", () => {
    const current = operation({
      upsert: {
        type: "article",
        create: { id: 2, slug: "unused", title: "unused" },
        update: {},
      },
    });
    const compiled = current.compile(
      knownFor(current, [{ id: 1, slug: "current", title: "before" }])
    );

    expect(ids(compiled)).not.toContain("article.create");
    expect(ids(compiled)).not.toContain("article.update");
    expect(
      writes(compiled).filter((step) => step.id.startsWith("article."))
    ).toEqual([]);
  });
});

describe("record compiler direct-polymorphic supplier coverage", () => {
  test("connectOrCreate adopts the captured variant target", () => {
    const current = operation({
      connectOrCreate: {
        type: "video",
        where: { slug: "existing" },
        create: { id: 7, slug: "existing", title: "unused" },
      },
    });
    const compiled = current.compile(
      knownFor(current, [{ id: 8, slug: "existing", title: "existing" }])
    );

    expect(ids(compiled)).not.toContain("video.create");
    const rootUpdate = writes(compiled).find(
      (step) => step.id === "comment.update"
    );
    if (!rootUpdate) throw new Error("expected the polymorphic storage update");
    expect(rootUpdate.statement.values).toEqual(
      expect.arrayContaining(["relation.coverage.video.v1", 8])
    );
  });

  test("connectOrCreate compiles its create subtree after an empty probe", () => {
    const current = operation({
      connectOrCreate: {
        type: "video",
        where: { slug: "missing" },
        create: { id: 9, slug: "missing", title: "created" },
      },
    });
    const compiled = current.compile(knownFor(current, []));

    expect(ids(compiled)).toContain("video.create");
    expect(ids(compiled)).toContain("comment.update");
  });
});
