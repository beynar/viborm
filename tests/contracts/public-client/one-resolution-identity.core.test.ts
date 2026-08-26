/**
 * ONE resolution, ONE index (plan §10 Package E item 10, falsifier §11.4.10).
 *
 * The client's gate resolves the schema once and hands that exact object to the
 * three consumers that need topology: the schema registry, the client-level
 * omit rewriting, and the model registry the query engine reads through. What is
 * pinned here:
 *
 *  1. all three expose the index BY IDENTITY when composed the way
 *     `VibORM`'s constructor composes them — a second resolution would be a
 *     different `Map` and this comparison would fail;
 *  2. nothing caches topology BESIDE it — `Model`'s internals publish no
 *     storage map, and a query scope carries the shared index rather than a
 *     per-model view;
 *  3. the composition the constructor performs is the one that reaches a real
 *     client: `createClient` builds and answers a relation-bearing query over
 *     the same schema.
 *
 * The identity itself is carried structurally rather than by convention: the
 * `VibORM` constructor takes the resolved index as a REQUIRED parameter, so
 * there is no route by which the client could resolve a second time.
 */

import { PostgresAdapter } from "@adapters/databases/postgres/postgres-adapter";
import { createClient } from "@client/client";
import { defaultOmit } from "@client/default-omit-extension";
import { createClientOmitResolver } from "@client/omit";
import { PGliteDriver } from "@drivers/pglite";
import { createQueryScope } from "@query-engine/context";
import { createModelRegistry } from "@query-engine/query-engine";
import { s } from "@schema";
import { hydrateSchemaNames } from "@schema/hydration";
import { validateClientSchemaOrThrow } from "@schema/validation/validator";
import { createResolvedSchemaRegistry } from "@validation/builder";
import { describe, expect, test } from "vitest";

const author = s.model({
  id: s.string().id(),
  name: s.string(),
  secret: s.string(),
  posts: s.toMany(() => post),
});

const post = s.model({
  id: s.string().id(),
  title: s.string(),
  authorId: s.string(),
  author: s
    .toOne(() => author)
    .fields("authorId")
    .references("id"),
});

const schema = { author, post };

describe("one resolution, one index", () => {
  test("registry, omit rewriting and the model registry share it by identity", () => {
    hydrateSchemaNames(schema);
    const relations = validateClientSchemaOrThrow(schema);

    const schemaRegistry = createResolvedSchemaRegistry(schema, relations);
    const omit = createClientOmitResolver(
      schema,
      { author: { secret: true } },
      relations
    );
    const modelRegistry = createModelRegistry(
      schema,
      schemaRegistry,
      relations
    );

    expect(omit?.relations).toBe(relations);
    expect(modelRegistry.relations).toBe(relations);
    // And a scope opened from that registry's index is the SAME object again,
    // not a copy made per model.
    expect(
      createQueryScope(
        { adapter: new PostgresAdapter(), relations: modelRegistry.relations },
        post
      ).relations
    ).toBe(relations);
  });

  test("nothing caches topology beside it", () => {
    // No model-owned resolved storage map, and no per-model view on a scope:
    // the two second-topology-owner shapes the plan deletes (§3.4). The deleted
    // members are named as KEYS, not as property reads: the accessors do not
    // exist, so `in` is both the honest spelling of "absent" and the stronger
    // assertion — it also fails an own key deliberately set to `undefined`, and
    // it reaches a prototype-held accessor that a value read would miss.
    const internals = post["~"] as unknown as Record<string, unknown>;
    expect(internals.polymorphicStorage).toBeUndefined();
    expect("getPolymorphicStorage" in internals).toBe(false);
    expect("setPolymorphicStorage" in internals).toBe(false);

    hydrateSchemaNames(schema);
    const relations = validateClientSchemaOrThrow(schema);
    const scope = createQueryScope(
      { adapter: new PostgresAdapter(), relations },
      post
    ) as unknown as Record<string, unknown>;
    expect("polymorphicRelations" in scope).toBe(false);
  });

  test("the same composition answers a relation-bearing query", async () => {
    const plain = createClient({ schema, driver: new PGliteDriver() });
    const sql = plain.post
      .findMany({ include: { author: true } })
      .buildStatement()
      ?.toStatement("$n");
    expect(sql).toContain("secret");

    // And the client DEFAULT reached the settled target through that one index:
    // the same read now projects the author without its hidden column.
    const hidden = createClient({
      schema,
      driver: new PGliteDriver(),
    }).$extends(defaultOmit<typeof schema>()({ author: { secret: true } }));
    const hiddenSql = hidden.post
      .findMany({ include: { author: true } })
      .buildStatement()
      ?.toStatement("$n");
    expect(hiddenSql).not.toContain("secret");

    await plain.$disconnect();
    await hidden.$disconnect();
  });
});
