import { UniqueConstraintError } from "@errors";
import { s } from "@schema";
import { usePGliteSchemaFamily } from "@tests/fixtures/drivers/pglite";
import { describe, expect, test } from "vitest";

/**
 * WHICH MODEL a nested statement's provider failure names (upstream Prisma
 * #29628).
 *
 * The provider already reports the exact table and constraint it refused. What
 * was missing beside them was the public model: every statement of one operation
 * — child subtrees included — executed under the operation's own attribution, so
 * a child's unique violation arrived as `{ model: "author", table: "post" }`. A
 * compiled statement now carries the model whose rows it addresses, and the
 * executor derives that statement's execution context from it, so the driver
 * normalizes the failure against the model the provider was talking about.
 *
 * Table and constraint are asserted beside the model in every case: the model is
 * the value that moved, and it must move WITHOUT disturbing the provider
 * evidence it sits next to.
 */
const attributionSchema = (() => {
  const author = s
    .model({
      id: s.string().id(),
      posts: s.toMany(() => post),
    })
    .map("nested_attribution_authors");
  const post = s
    .model({
      id: s.string().id(),
      slug: s.string().unique(),
      authorId: s.string(),
      author: s
        .toOne(() => author)
        .fields("authorId")
        .references("id"),
      tags: s.toMany(() => tag),
    })
    .map("nested_attribution_posts");
  const tag = s
    .model({
      id: s.string().id(),
      label: s.string().unique(),
      postId: s.string(),
      post: s
        .toOne(() => post)
        .fields("postId")
        .references("id"),
    })
    .map("nested_attribution_tags");
  return { author, post, tag };
})();

const POST_SLUG_VIOLATION = {
  table: "nested_attribution_posts",
  constraint: "nested_attribution_posts_slug_key",
};

function uniqueViolation(error: unknown) {
  if (!(error instanceof UniqueConstraintError)) {
    throw new Error(
      `Expected a UniqueConstraintError, received ${String(error)}`
    );
  }
  const { model, table, constraint } = error.meta;
  return { model, table, constraint };
}

describe("nested statement error attribution", () => {
  const family = usePGliteSchemaFamily(attributionSchema);

  async function seed() {
    const { client } = family();
    await client.author.create({ data: { id: "a1" } });
    await client.post.create({
      data: { id: "p1", slug: "taken", authorId: "a1" },
    });
    await client.post.create({
      data: { id: "p2", slug: "free", authorId: "a1" },
    });
    await client.tag.create({ data: { id: "t1", label: "dup", postId: "p1" } });
    return client;
  }

  test("a root write's own violation still names the root model", async () => {
    const client = await seed();

    const error = await client.post
      .create({ data: { id: "p9", slug: "taken", authorId: "a1" } })
      .catch((reason: unknown) => reason);

    expect(uniqueViolation(error)).toEqual({
      model: "post",
      ...POST_SLUG_VIOLATION,
    });
  });

  test("a nested create names the child it created", async () => {
    const client = await seed();

    const error = await client.author
      .update({
        where: { id: "a1" },
        data: { posts: { create: { id: "p3", slug: "taken" } } },
      })
      .catch((reason: unknown) => reason);

    expect(uniqueViolation(error)).toEqual({
      model: "post",
      ...POST_SLUG_VIOLATION,
    });
  });

  test("a nested update names the child it updated", async () => {
    const client = await seed();

    const error = await client.author
      .update({
        where: { id: "a1" },
        data: {
          posts: { update: { where: { id: "p2" }, data: { slug: "taken" } } },
        },
      })
      .catch((reason: unknown) => reason);

    expect(uniqueViolation(error)).toEqual({
      model: "post",
      ...POST_SLUG_VIOLATION,
    });
  });

  test("two levels down, the LEAF model is the one that answers", async () => {
    const client = await seed();

    const error = await client.author
      .update({
        where: { id: "a1" },
        data: {
          posts: {
            create: {
              id: "p4",
              slug: "fresh",
              tags: { create: { id: "t2", label: "dup" } },
            },
          },
        },
      })
      .catch((reason: unknown) => reason);

    expect(uniqueViolation(error)).toEqual({
      model: "tag",
      table: "nested_attribution_tags",
      constraint: "nested_attribution_tags_label_key",
    });
  });

  test("a create root reaches its child the same way once it emits one", async () => {
    const client = await seed();

    // A relation projection declines the create-tree fold pinned below, so the
    // child INSERT is its own statement and carries its own attribution.
    const error = await client.author
      .create({
        data: { id: "a2", posts: { create: { id: "p5", slug: "taken" } } },
        include: { posts: true },
      })
      .catch((reason: unknown) => reason);

    expect(uniqueViolation(error)).toEqual({
      model: "post",
      ...POST_SLUG_VIOLATION,
    });
  });

  /**
   * THE MEASURED LIMIT, pinned rather than asserted away.
   *
   * A scalar-only create projection lets `CreateOperation.buildTreeFold` merge
   * the root INSERT and every child arm into ONE data-modifying-CTE statement on
   * a PostgreSQL-family adapter. There is then no nested statement to attribute:
   * one statement writes both tables, and the only thing that could tell the arms
   * apart afterwards is the provider's own table text — which physical names and
   * namespaces make an unsound basis for choosing a model. So the merged
   * statement keeps the operation's attribution, and the provider evidence beside
   * it stays exact.
   *
   * The day a merged statement can carry per-arm attribution, this expectation
   * goes red and the pin is deleted.
   */
  test("a tree folded into ONE statement keeps the operation's model", async () => {
    const client = await seed();

    const error = await client.author
      .create({
        data: { id: "a3", posts: { create: { id: "p6", slug: "taken" } } },
      })
      .catch((reason: unknown) => reason);

    expect(uniqueViolation(error)).toEqual({
      model: "author",
      ...POST_SLUG_VIOLATION,
    });
  });
});
