import { createModelRegistry, QueryEngine } from "@query-engine/query-engine";
import { s } from "@schema";
import type {
  OperationFragment,
  ReadStep,
  WriteStep,
} from "@src/query-engine/write-engine/OperationFragment";
import { planningKey } from "@src/query-engine/write-engine/Part";
import { UpdateOperation } from "@src/query-engine/write-engine/UpdateOperation";
import { PlanningDriver } from "@tests/fixtures/drivers/planning";
import { prepareSchema } from "@tests/fixtures/query-scope";
import { createSchemaRegistry } from "@validation";
import { describe, expect, test } from "vitest";

const schema = (() => {
  const author = s
    .model({
      id: s.int().id(),
      name: s.string(),
      posts: s.toMany(() => post),
      tags: s.toMany(() => tag).through("relation_coverage_author_tag"),
    })
    .map("relation_coverage_author");
  const post = s
    .model({
      id: s.int().id(),
      title: s.string(),
      published: s.boolean(),
      authorId: s.int().nullable(),
      author: s
        .toOne(() => author)
        .fields("authorId")
        .references("id"),
    })
    .map("relation_coverage_post");
  const tag = s
    .model({
      id: s.int().id(),
      label: s.string(),
      authors: s.toMany(() => author),
    })
    .map("relation_coverage_tag");
  return { author, post, tag };
})();

prepareSchema(schema);

function operation(data: Record<string, unknown>): UpdateOperation {
  const driver = new PlanningDriver("postgresql");
  const engine = new QueryEngine(
    driver,
    createModelRegistry(schema, createSchemaRegistry(schema))
  );
  return new UpdateOperation(engine, schema.author, {
    where: { id: 1 },
    data,
    select: { id: true },
  });
}

function knownFor(
  current: UpdateOperation,
  relationRows: readonly Record<string, unknown>[]
): Record<string, unknown> {
  return Object.fromEntries(
    current
      .planning()
      .steps.map((step) => [
        planningKey(step.id, "rows"),
        step.id === "author.locate"
          ? [{ id: 1, name: "author" }]
          : relationRows,
      ])
  );
}

function writes(fragment: OperationFragment): readonly WriteStep[] {
  return fragment.steps.filter(
    (step): step is WriteStep => step.kind === "write"
  );
}

function sqlText(step: ReadStep | WriteStep): string {
  return step.statement.strings.join("?");
}

describe("ordinary relation link coverage", () => {
  test("folds same-shaped connects into one probe and one membership update", () => {
    const current = operation({
      posts: { connect: [{ id: 10 }, { id: 11 }, { id: 10 }] },
    });
    const relationReads = current
      .planning()
      .steps.filter(
        (step): step is ReadStep =>
          step.kind === "read" && step.id.startsWith("post.")
      );

    expect(relationReads).toHaveLength(1);
    expect(sqlText(relationReads[0]!)).toContain(" IN (");

    const compiled = current.compile(
      knownFor(current, [
        { id: 10, title: "ten", published: false, authorId: null },
        { id: 11, title: "eleven", published: false, authorId: null },
      ])
    );
    const linkWrites = writes(compiled).filter((step) =>
      step.id.startsWith("post.connect")
    );

    expect(linkWrites).toHaveLength(1);
    expect(sqlText(linkWrites[0]!)).toContain(" IN (");
    expect(linkWrites[0]?.statement.values).toEqual(
      expect.arrayContaining([1, 10, 11])
    );
  });

  test("a grouped probe still fails when fewer distinct targets were captured", () => {
    const current = operation({
      posts: { connect: [{ id: 10 }, { id: 11 }] },
    });

    expect(() =>
      current.compile(
        knownFor(current, [
          { id: 10, title: "ten", published: false, authorId: null },
        ])
      )
    ).toThrow("Cannot connect relation 'posts': target record was not found.");
  });
});

describe("junction relation target coverage", () => {
  test("updateMany emits one correlated target update when no nested series is needed", () => {
    const current = operation({
      tags: {
        updateMany: {
          where: { label: { contains: "before" } },
          data: { label: "after" },
        },
      },
    });
    const compiled = current.compile(knownFor(current, []));
    const targetUpdates = writes(compiled).filter((step) =>
      sqlText(step).includes('UPDATE "public"."relation_coverage_tag"')
    );

    expect(targetUpdates).toHaveLength(1);
    expect(targetUpdates[0]?.statement.values).toEqual(
      expect.arrayContaining(["after", "before", 1])
    );
  });

  test("deleteMany consumes the captured connected set before deleting memberships and targets", () => {
    const current = operation({
      tags: { deleteMany: { label: { startsWith: "stale" } } },
    });
    const compiled = current.compile(
      knownFor(current, [
        { id: 20, label: "stale-a" },
        { id: 21, label: "stale-b" },
      ])
    );
    const relationWrites = writes(compiled).filter((step) =>
      step.id.startsWith("tag.")
    );

    expect(relationWrites.map((step) => step.id)).toEqual([
      "tag.junction.delete",
      "tag.deleteMany",
    ]);
    expect(sqlText(relationWrites[0]!)).toContain(
      'DELETE FROM "public"."relation_coverage_author_tag"'
    );
    expect(sqlText(relationWrites[1]!)).toContain(
      'DELETE FROM "public"."relation_coverage_tag"'
    );
  });

  test("a correlated upsert updates a captured member without replaying its create arm", () => {
    const current = operation({
      tags: {
        upsert: {
          where: { id: 20 },
          create: { id: 20, label: "unused" },
          update: { label: "updated" },
        },
      },
    });
    const compiled = current.compile(
      knownFor(current, [{ id: 20, label: "before" }])
    );
    const relationWrites = writes(compiled).filter((step) =>
      step.id.startsWith("tag.")
    );

    expect(relationWrites.some((step) => step.id === "tag.update")).toBe(true);
    expect(relationWrites.some((step) => step.id === "tag.create")).toBe(false);
    expect(
      relationWrites.some((step) => step.id.includes("junction.insert"))
    ).toBe(false);
  });
});
