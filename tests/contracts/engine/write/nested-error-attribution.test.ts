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
   * THE LIMIT THAT WENT AWAY, pinned as the fact that replaced it.
   *
   * This cell recorded the retired engine's measured limit: a scalar-only create
   * projection let `CreateOperation.buildTreeFold` merge the root INSERT and every
   * child arm into ONE data-modifying-CTE statement on a PostgreSQL-family
   * adapter, so there was no nested statement to attribute and the merged
   * statement kept the OPERATION's model (`author`) beside the child's table.
   * The cell's own closing line predicted the day this expectation would go red.
   *
   * D-15 retired that machinery whole: Raptor 3 ports only the scalar RETURNING
   * fold, never the CTE tree fold, so the child arm is its own compiled statement
   * on every projection. The attribution below is therefore the STATEMENT SHAPE
   * too — `model: "post"` is only reachable when the child INSERT is a statement
   * of its own carrying its own `context.model` (`driver-error-context.ts`
   * `buildMeta`); a merged statement could not produce it. Attribution no longer
   * depends on the projection: this scalar-only create and the `include` create
   * above now answer identically, and the provider evidence beside the model is
   * unchanged in both.
   */
  // D-15: pinned the retired CTE tree fold's merged-statement attribution
  // (`model: "author"`); Raptor 3 emits the child arm as its own statement.
  test("a tree the retired engine folded into ONE statement names the child model", async () => {
    const client = await seed();

    const error = await client.author
      .create({
        data: { id: "a3", posts: { create: { id: "p6", slug: "taken" } } },
      })
      .catch((reason: unknown) => reason);

    expect(uniqueViolation(error)).toEqual({
      model: "post",
      ...POST_SLUG_VIOLATION,
    });
  });
});
