import { PGliteDriver } from "@drivers/pglite";
import { createModelRegistry, QueryEngine } from "@query-engine/query-engine";
import { hydrateSchemaNames, s } from "@schema";
import { validateSchemaOrThrow } from "@schema/validation";
import { createSchemaRegistry } from "@validation";
import { expect, test } from "vitest";
import { CreateOperation } from "@src/query-engine/write-engine/CreateOperation";
import type {
  OperationFragment,
  PlanningFragment,
  StatementStep,
} from "@src/query-engine/write-engine/OperationFragment";
import { BatchOnlyPGliteDriver } from "@tests/fixtures/drivers/pglite";

const polymorphicPlanSchema = (() => {
  const author = s.model({
    id: s.int().id(),
    name: s.string(),
    comments: s.oneToMany(() => comment),
  });
  const post = s.model({ id: s.int().id(), title: s.string() });
  const video = s.model({ id: s.int().id(), title: s.string() });
  const comment = s.model({
    id: s.int().id(),
    body: s.string(),
    authorId: s.int(),
    author: s
      .manyToOne(() => author)
      .fields("authorId")
      .references("id"),
    primary: s
      .polymorphic(
        { post: () => post, video: () => video },
        { values: { post: "primary.post.v1", video: "primary.video.v1" } }
      )
      .optional(),
    secondary: s
      .polymorphic(
        { post: () => post, video: () => video },
        {
          values: {
            post: "secondary.post.v1",
            video: "secondary.video.v1",
          },
        }
      )
      .optional(),
  });
  return { author, post, video, comment };
})();

hydrateSchemaNames(polymorphicPlanSchema);
validateSchemaOrThrow(polymorphicPlanSchema);

function ids(fragment: PlanningFragment | OperationFragment): string[] {
  return fragment.steps.map((step) => step.id);
}

function statement(
  fragment: PlanningFragment | OperationFragment,
  id: string
): StatementStep {
  const step = fragment.steps.find((candidate) => candidate.id === id);
  if (!step || step.kind === "guard") {
    throw new Error(`Expected statement '${id}'.`);
  }
  return step;
}

test("two same-target polymorphic fields preserve ordered steps and root pairs", () => {
  const driver = new BatchOnlyPGliteDriver();
  const registry = createSchemaRegistry(polymorphicPlanSchema);
  const args = {
    data: {
      id: 1,
      body: "ordered",
      author: { connect: { id: 10 } },
      primary: { connect: { type: "post", where: { id: 10 } } },
      secondary: { connect: { type: "post", where: { id: 11 } } },
    },
    select: { id: true },
  };
  const engine = new QueryEngine(
    driver,
    createModelRegistry(
      polymorphicPlanSchema,
      registry
    )
  );
  const operation = new CreateOperation(
    engine,
    polymorphicPlanSchema.comment,
    args
  );

  const planning = operation.planning();
  expect(ids(planning)).toEqual([
    "author.find",
    "post.find",
    "post.find#1",
  ]);
  const compiled = operation.compile({
    "author.find.rows": [{ id: 10 }],
    "post.find.rows": [{ id: 10 }],
    "post.find#1.rows": [{ id: 11 }],
  });
  expect(ids(compiled)).toEqual([
    "author.guard.exists",
    "post.guard.exists",
    "post.guard.exists#1",
    "comment.create",
    "comment.select",
  ]);

  const prepared = new PGliteDriver()._prepare(
    statement(compiled, "comment.create").statement
  );
  expect(prepared.sql).toBe(
    'INSERT INTO "comment" ("id", "body", "authorId", "primary_type", "primary_id", "secondary_type", "secondary_id") VALUES ($1, $2, CAST($3 AS INTEGER), $4, CAST($5 AS INTEGER), $6, CAST($7 AS INTEGER))'
  );
  expect(prepared.params).toEqual([
    1,
    "ordered",
    10,
    "primary.post.v1",
    10,
    "secondary.post.v1",
    11,
  ]);
});
