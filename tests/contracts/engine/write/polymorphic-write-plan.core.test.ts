import { PostgresAdapter } from "@adapters/databases/postgres/postgres-adapter";
import { PGliteDriver } from "@drivers/pglite";
import {
  createQueryScope,
  getPolymorphicRelationInfo,
} from "@query-engine/context";
import { createModelRegistry, QueryEngine } from "@query-engine/query-engine";
import { hydrateSchemaNames, s } from "@schema";
import { validateSchemaOrThrow } from "@schema/validation";
import { resolvePolymorphicEdge } from "@src/query-engine/builders/polymorphic-relation";
import { CreateOperation } from "@src/query-engine/write-engine/CreateOperation";
import type {
  OperationFragment,
  PlanningFragment,
  StatementStep,
} from "@src/query-engine/write-engine/OperationFragment";
import { UpsertOperation } from "@src/query-engine/write-engine/UpsertOperation";
import { BatchOnlyPGliteDriver } from "@tests/fixtures/drivers/pglite";
import { createSchemaRegistry } from "@validation";
import { expect, test } from "vitest";

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
  if (!step || step.kind === "guard" || step.kind === "recordSeries") {
    throw new Error(`Expected statement '${id}'.`);
  }
  return step;
}

test("collection order is ordinary-then-polymorphic, NOT payload key order", () => {
  // The parsed relation collection groups every ordinary relation before every
  // polymorphic one, each bucket in payload key order. This payload spells the
  // polymorphic fields FIRST; the plan must still open with the ordinary
  // author.find. A collector that switched to raw payload order would emit
  // post.find before author.find and rename the duplicate suffix.
  const driver = new BatchOnlyPGliteDriver();
  const registry = createSchemaRegistry(polymorphicPlanSchema);
  const args = {
    data: {
      id: 1,
      body: "ordered",
      primary: { connect: { type: "post", where: { id: 10 } } },
      author: { connect: { id: 10 } },
      secondary: { connect: { type: "post", where: { id: 11 } } },
    },
    select: { id: true },
  };
  const engine = new QueryEngine(
    driver,
    createModelRegistry(polymorphicPlanSchema, registry)
  );
  const operation = new CreateOperation(
    engine,
    polymorphicPlanSchema.comment,
    args
  );

  expect(ids(operation.planning())).toEqual([
    "author.find",
    "post.find",
    "post.find#1",
  ]);
});

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
    createModelRegistry(polymorphicPlanSchema, registry)
  );
  const operation = new CreateOperation(
    engine,
    polymorphicPlanSchema.comment,
    args
  );

  const planning = operation.planning();
  expect(ids(planning)).toEqual(["author.find", "post.find", "post.find#1"]);
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

test("the direct polymorphic target boundary refuses at construction, eagerly", () => {
  // §6.1.4's boundary: resolvePolymorphicEdge answers at program construction,
  // for every polymorphic payload — INCLUDING an upsert arm execution never
  // takes. Both pins here are timing pins: no execution, no driver round trip.
  const scope = createQueryScope(
    new PostgresAdapter(),
    polymorphicPlanSchema.comment
  );
  const info = getPolymorphicRelationInfo(scope, "primary");
  if (!info) throw new Error("expected polymorphic relation info for primary");
  // The engine boundary owns this sentence; the validation layer refuses the
  // public spelling earlier, so this message is an internal contract.
  expect(() => resolvePolymorphicEdge(scope, info, "bogus")).toThrow(
    "Unknown polymorphic target 'bogus' for relation 'primary'."
  );

  // Public timing half: a malformed polymorphic envelope on the UPDATE arm of
  // an upsert refuses at construction even though no arm has been selected.
  const registry = createSchemaRegistry(polymorphicPlanSchema);
  const engine = new QueryEngine(
    new BatchOnlyPGliteDriver(),
    createModelRegistry(polymorphicPlanSchema, registry)
  );
  expect(() => {
    const operation = new UpsertOperation(
      engine,
      polymorphicPlanSchema.comment,
      {
        where: { id: 1 },
        create: { id: 1, body: "b", author: { connect: { id: 10 } } },
        update: {
          primary: { connect: { type: "bogus", where: { id: 10 } } },
        },
      }
    );
    operation.planning();
  }).toThrow(/Validation failed|Unknown polymorphic target/);
});

test("a tree carrying a direct-polymorphic create arm DECLINES the CTE fold", () => {
  // The fold's order-insensitivity claim was measured for ordinary FK arms
  // only. A polymorphic-storage create arm stays unclassified, so the tree
  // keeps its multi-statement shape — statement count is a pinned surface.
  const registry = createSchemaRegistry(polymorphicPlanSchema);
  const engine = new QueryEngine(
    new PGliteDriver(),
    createModelRegistry(polymorphicPlanSchema, registry)
  );
  const operation = new CreateOperation(engine, polymorphicPlanSchema.author, {
    data: {
      id: 5,
      name: "n",
      comments: {
        create: {
          id: 6,
          body: "b",
          primary: { create: { type: "post", data: { id: 7, title: "t" } } },
        },
      },
    },
    select: { id: true },
  });
  expect(ids(operation.planning())).toEqual([]);
  const compiled = operation.compile({});
  expect(ids(compiled)).toEqual([
    "author.create",
    "post.create",
    "comment.create",
    "author.select",
  ]);
});
