import { createClient } from "@client/client";
import type { BatchQuery, QueryResult } from "@drivers";
import { PGliteDriver } from "@drivers/pglite";
import type { PGlite, Transaction } from "@electric-sql/pglite";
import { push } from "@migrations";
import { hydrateSchemaNames, s } from "@schema";
import { describe, expect, test } from "vitest";

/**
 * E2-U3 — **a junction edge beside a non-cascade one, under a target that moves its own
 * primary key.**
 *
 * Measured live before the absorption, both substrates, 0 statements:
 *
 *   UnsupportedOperationError: query-engine-v2 update for relation 'posts' transitions
 *   the target primary key 'id' while writing both a many-to-many edge and a child-held
 *   edge whose foreign key does not cascade on update.
 *
 * The refusal's own record named the mechanism it was waiting for, and the mechanism
 * already existed. Under the post-transition ordering (N5-U1: the non-cascade child edge
 * is written AFTER the self-UPDATE, against the new key, behind the occupied guard) a
 * junction needs TWO parent values, not one:
 *
 *  · its membership READ runs at planning, before any write, so it can only ask for the
 *    key the join rows carry now — the where-pinned PRE-transition value;
 *  · its WRITES run after the self-UPDATE, by which time `ON UPDATE CASCADE` has carried
 *    those same rows to the new key, so they must use the POST-transition value.
 *
 * That is `RelationSetConfig.correlationParentId`, the split N5-U1 built for `set`'s two
 * halves, threaded through the child-Part seam into `RelationJunctionPart`.
 *
 * The batch substrate forced one more thing into the open, measured rather than assumed:
 * the atomic unit evaluates EVERY guard before any write in it (the root's bucketing in
 * `UpdateOperation.compile`), so a junction's membership GUARD is also a read of the
 * pre-transition state. Pointing it at the written value made the batch leg fail a
 * premise that held (`Cannot update relation 'tags': target record was not found for
 * this parent.`) while the transaction leg succeeded — so the guards take the read
 * correlation too, and the two substrates agree again.
 *
 * Decoys throughout: a second author owns a second post that shares the same tag and has
 * a comment of its own. Every assertion below says where the writes landed AND that the
 * decoy's rows are untouched.
 */
const mixedEdgeSchema = (() => {
  const author = s
    .model({
      id: s.string().id(),
      name: s.string(),
      posts: s.oneToMany(() => post),
    })
    .map("e2u3_authors");
  const post = s
    .model({
      id: s.string().id(),
      title: s.string(),
      // A non-primary-key unique, so a nested target can be named by something OTHER
      // than the key it transitions — the merge carve-out below.
      slug: s.string().unique(),
      authorId: s.string(),
      author: s
        .manyToOne(() => author)
        .fields("authorId")
        .references("id"),
      // The non-cascade edge: a child-held foreign key defaults to NO ACTION, which is
      // what makes this target's transition take the post-transition ordering.
      comments: s.oneToMany(() => comment),
      notes: s.oneToMany(() => note),
      // The junction edge: an implicit m2m foreign key is ON UPDATE CASCADE.
      tags: s.manyToMany(() => tag),
    })
    .map("e2u3_posts");
  const comment = s
    .model({
      id: s.string().id(),
      body: s.string(),
      postId: s.string(),
      post: s
        .manyToOne(() => post)
        .fields("postId")
        .references("id"),
    })
    .map("e2u3_comments");
  const note = s
    .model({
      id: s.string().id(),
      body: s.string(),
      postId: s.string().nullable(),
      post: s
        .manyToOne(() => post)
        .fields("postId")
        .references("id")
        .onUpdate("cascade"),
    })
    .map("e2u3_notes");
  const tag = s
    .model({
      id: s.string().id(),
      name: s.string(),
      posts: s.manyToMany(() => post),
    })
    .map("e2u3_tags");
  return { author, post, comment, note, tag };
})();

hydrateSchemaNames(mixedEdgeSchema);

class BatchOnlyPGliteDriver extends PGliteDriver {
  override readonly supportsTransactions = false;
  override readonly supportsBatch = true;

  protected override async executeBatch<T>(
    client: PGlite | Transaction,
    queries: BatchQuery[]
  ): Promise<QueryResult<T>[]> {
    return this.transaction(client, async (transaction) => {
      const results: QueryResult<T>[] = [];
      for (const query of queries) {
        results.push(
          await this.executeRaw<T>(transaction, query.sql, query.params)
        );
      }
      return results;
    });
  }
}

/** V1's verbatim occupied-slot rejection for a non-cascade referenced-key transition. */
const OCCUPIED_AT_DEPTH = /while the current relation is occupied/;

function makeClient(driver: PGliteDriver) {
  return createClient({ schema: mixedEdgeSchema, driver });
}

type Client = ReturnType<typeof makeClient>;

/** `p1` is the transitioning target; `p-decoy` belongs to another author, shares `t1`,
 *  and owns a comment — so a write that lost track of which parent it acts for shows up
 *  as the decoy's rows moving. */
async function seed(client: Client): Promise<void> {
  await client.author.create({ data: { id: "a1", name: "author" } });
  await client.author.create({ data: { id: "a-decoy", name: "decoy" } });
  await client.tag.create({ data: { id: "t1", name: "shared" } });
  await client.tag.create({ data: { id: "t2", name: "second" } });
  await client.post.create({
    data: { id: "p1", title: "target", slug: "target-slug", authorId: "a1" },
  });
  await client.post.create({
    data: {
      id: "p-decoy",
      title: "decoy",
      slug: "decoy-slug",
      authorId: "a-decoy",
    },
  });
  await client.comment.create({
    data: { id: "c-decoy", body: "decoy", postId: "p-decoy" },
  });
  await client.post.update({
    where: { id: "p1" },
    data: { tags: { connect: [{ id: "t1" }, { id: "t2" }] } },
  });
  await client.post.update({
    where: { id: "p-decoy" },
    data: { tags: { connect: { id: "t1" } } },
  });
}

async function setup(driver: PGliteDriver) {
  const client = makeClient(driver);
  await push(client, { force: true });
  await seed(client);
  return client;
}

/** The tag ids a post is a member of, read back through the relation (membership is the
 *  join row, which has no model of its own). */
async function tagsOf(client: Client, postId: string): Promise<string[]> {
  const tags = await client.tag.findMany({
    where: { posts: { some: { id: postId } } },
    orderBy: { id: "asc" },
  });
  return tags.map((tag) => tag.id);
}

for (const substrate of ["transaction", "atomic batch"] as const) {
  const makeDriver = () =>
    substrate === "transaction"
      ? new PGliteDriver()
      : new BatchOnlyPGliteDriver();

  describe(`E2-U3 primary-key transition with a junction and a non-cascade edge (${substrate})`, () => {
    test("the junction WRITE takes the post-transition key", async () => {
      const client = await setup(makeDriver());
      try {
        await client.author.update({
          where: { id: "a1" },
          data: {
            posts: {
              update: {
                where: { id: "p1" },
                data: {
                  id: "p9",
                  tags: { connect: { id: "t2" } },
                  comments: { create: { id: "c1", body: "fresh" } },
                },
              },
            },
          },
        });
        // The row moved, the cascade carried its existing membership, and the new join
        // row named the key the row has NOW — a write against the vacated `p1` has no
        // row to reference at all.
        await expect(
          client.post.findUnique({ where: { id: "p9" } })
        ).resolves.toEqual({
          id: "p9",
          title: "target",
          slug: "target-slug",
          authorId: "a1",
        });
        await expect(
          client.post.findUnique({ where: { id: "p1" } })
        ).resolves.toBeNull();
        await expect(tagsOf(client, "p9")).resolves.toEqual(["t1", "t2"]);
        // The non-cascade edge was written after the UPDATE, against the new key.
        await expect(
          client.comment.findMany({ orderBy: { id: "asc" } })
        ).resolves.toEqual([
          { id: "c-decoy", body: "decoy", postId: "p-decoy" },
          { id: "c1", body: "fresh", postId: "p9" },
        ]);
        await expect(tagsOf(client, "p-decoy")).resolves.toEqual(["t1"]);
      } finally {
        await client.$disconnect();
      }
    }, 30_000);

    test("the junction membership READ takes the pre-transition key", async () => {
      const client = await setup(makeDriver());
      try {
        await client.author.update({
          where: { id: "a1" },
          data: {
            posts: {
              update: {
                where: { id: "p1" },
                data: {
                  id: "p9",
                  // A targeted junction `update` locates its target through the
                  // MEMBERSHIP read. That read runs at planning, when the join rows
                  // still carry `p1`; asking for `p9` there finds nothing and the arm
                  // aborts with `Cannot update relation 'tags' …`.
                  tags: {
                    update: { where: { id: "t1" }, data: { name: "edited" } },
                  },
                  comments: { create: { id: "c1", body: "fresh" } },
                },
              },
            },
          },
        });
        await expect(
          client.tag.findMany({ orderBy: { id: "asc" } })
        ).resolves.toEqual([
          { id: "t1", name: "edited" },
          { id: "t2", name: "second" },
        ]);
        await expect(tagsOf(client, "p9")).resolves.toEqual(["t1", "t2"]);
        await expect(
          client.comment.findUnique({ where: { id: "c1" } })
        ).resolves.toMatchObject({ postId: "p9" });
      } finally {
        await client.$disconnect();
      }
    }, 30_000);

    test("a nested child-held set reads the old key and writes the transitioned key", async () => {
      const client = await setup(makeDriver());
      try {
        await client.note.create({
          data: { id: "n-old", body: "departing", postId: "p1" },
        });
        await client.note.create({
          data: { id: "n-target", body: "incoming", postId: null },
        });
        await client.note.create({
          data: { id: "n-decoy", body: "decoy", postId: "p-decoy" },
        });

        await client.author.update({
          where: { id: "a1" },
          data: {
            posts: {
              update: {
                where: { id: "p1" },
                data: {
                  id: "p9",
                  comments: { create: { id: "c1", body: "fresh" } },
                  notes: { set: { id: "n-target" } },
                },
              },
            },
          },
        });

        await expect(
          client.note.findMany({ orderBy: { id: "asc" } })
        ).resolves.toEqual([
          { id: "n-decoy", body: "decoy", postId: "p-decoy" },
          { id: "n-old", body: "departing", postId: null },
          { id: "n-target", body: "incoming", postId: "p9" },
        ]);
        await expect(
          client.comment.findUnique({ where: { id: "c1" } })
        ).resolves.toMatchObject({ postId: "p9" });
        await expect(tagsOf(client, "p-decoy")).resolves.toEqual(["t1"]);
      } finally {
        await client.$disconnect();
      }
    }, 30_000);

    test("a bulk membership read reaches only this parent's members", async () => {
      const client = await setup(makeDriver());
      try {
        await client.author.update({
          where: { id: "a1" },
          data: {
            posts: {
              update: {
                where: { id: "p1" },
                data: {
                  id: "p9",
                  tags: { deleteMany: { name: { equals: "second" } } },
                  comments: { create: { id: "c1", body: "fresh" } },
                },
              },
            },
          },
        });
        // `t2` was a member of the transitioning post only, so it is gone; `t1` is
        // shared and outside the filter, so both memberships stand.
        await expect(
          client.tag.findMany({ orderBy: { id: "asc" } })
        ).resolves.toEqual([{ id: "t1", name: "shared" }]);
        await expect(tagsOf(client, "p9")).resolves.toEqual(["t1"]);
        await expect(tagsOf(client, "p-decoy")).resolves.toEqual(["t1"]);
      } finally {
        await client.$disconnect();
      }
    }, 30_000);

    test("a disconnect removes the membership the cascade just carried", async () => {
      const client = await setup(makeDriver());
      try {
        await client.author.update({
          where: { id: "a1" },
          data: {
            posts: {
              update: {
                where: { id: "p1" },
                data: {
                  id: "p9",
                  tags: { disconnect: { id: "t2" } },
                  comments: { create: { id: "c1", body: "fresh" } },
                },
              },
            },
          },
        });
        await expect(tagsOf(client, "p9")).resolves.toEqual(["t1"]);
        await expect(tagsOf(client, "p-decoy")).resolves.toEqual(["t1"]);
        await expect(
          client.tag.findMany({ orderBy: { id: "asc" } })
        ).resolves.toEqual([
          { id: "t1", name: "shared" },
          { id: "t2", name: "second" },
        ]);
      } finally {
        await client.$disconnect();
      }
    }, 30_000);

    test("the occupied-slot guard still rejects a vacated key with children on it", async () => {
      const client = await setup(makeDriver());
      try {
        // N5-U1's CLASS IV guard at depth: a comment already carries `p1`, and the
        // transition would strand it (the foreign key does not cascade). Absorbing the
        // junction mix must not have loosened it.
        await client.comment.create({
          data: { id: "c-old", body: "old", postId: "p1" },
        });
        await expect(
          client.author.update({
            where: { id: "a1" },
            data: {
              posts: {
                update: {
                  where: { id: "p1" },
                  data: {
                    id: "p9",
                    tags: { connect: { id: "t2" } },
                    comments: { create: { id: "c1", body: "fresh" } },
                  },
                },
              },
            },
          })
        ).rejects.toThrow(OCCUPIED_AT_DEPTH);
        await expect(
          client.post.findUnique({ where: { id: "p1" } })
        ).resolves.toMatchObject({ id: "p1" });
        await expect(
          client.comment.findUnique({ where: { id: "c1" } })
        ).resolves.toBeNull();
        await expect(tagsOf(client, "p1")).resolves.toEqual(["t1", "t2"]);
      } finally {
        await client.$disconnect();
      }
    }, 30_000);
  });
}

describe("E2-U3 the carve-out that stays refused", () => {
  test("a target named by a NON-primary-key unique keeps the merge refusal", async () => {
    // The pre-transition value has to be a compile-time literal — both the junction's
    // read correlation and the occupied guard's slot are that value — and a target
    // named by another unique has only the probe's PRE-transition read, which is the
    // key the transition vacates. Unchanged by this unit (the N4 × N5 merge row).
    const client = await setup(new PGliteDriver());
    try {
      await expect(
        client.author.update({
          where: { id: "a1" },
          data: {
            posts: {
              update: {
                where: { slug: "target-slug" },
                data: {
                  id: "p9",
                  tags: { connect: { id: "t2" } },
                  comments: { create: { id: "c1", body: "fresh" } },
                },
              },
            },
          },
        })
      ).rejects.toThrow(
        "query-engine-v2 update for relation 'posts' transitions the target primary key 'id' while writing a deeper edge whose foreign key does not cascade on update; it must locate the target by that primary key."
      );
      await expect(
        client.post.findUnique({ where: { id: "p1" } })
      ).resolves.toMatchObject({ id: "p1" });
    } finally {
      await client.$disconnect();
    }
  }, 30_000);
});
