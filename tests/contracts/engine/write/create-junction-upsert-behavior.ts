import { hydrateSchemaNames, s } from "@schema";
import { describe, expect, test } from "vitest";

/**
 * E5-U1 — **many-to-many `upsert` under a CREATE root.**
 *
 * Measured at a554419, at construction, through the public client:
 *
 *   UnsupportedOperationError: query-engine-v2 create does not support nested 'upsert'
 *   on the many-to-many relation 'topics'.
 *
 * The refusal was mechanical, not semantic. The junction's correlated three-way reads a
 * MEMBERSHIP probe correlated on the parent, and that read goes through `parentRef`,
 * which needs a `planned` or `literal` parent id — a create root whose primary key is
 * DB-generated supplies a `ref`. So the shape the parse boundary has documented since
 * P−1.2 (`src/validation/relations/create.ts`: a deliberate Prisma superset, GLOBAL
 * LOOKUP + ADOPT-AND-UPDATE) could be spelled and never run.
 *
 * The absorption removes the question instead of answering it: a fresh parent has no
 * membership, so the read is elided (`RelationJunctionConfig.freshParent`) and the
 * three-way collapses to the adopt family's two-way. The DONOR is the ADOPT slot
 * (`compileConnectOrCreate`), NOT the member arm — the member found-arm writes no join
 * row (a member already has one) and skips an empty UPDATE, so reusing it verbatim
 * would ship a silent no-op adopt.
 *
 * What that decision buys, witnessed below:
 *
 *  · the FOUND arm ALWAYS writes the join row. An empty update payload, or a
 *    relation-only one, still adopts — the membership add is the point of the shape.
 *  · the ABSENT arm creates and joins, riding E4-U3's `freshTargetFold`: a generated
 *    target key is produced by the arm's own INSERT and referenced by BOTH the join row
 *    and the arm's grandchildren, and the arm's missing premise stays pinned by the
 *    child unique constraint (`racePin`), never by a notExists guard.
 *  · what the own-write preflight (ATOM §4) already refuses at this root refuses still
 *    — M7's gate, pinned here before the absorption landed and unchanged by it.
 */
export const createJunctionUpsertSchema = (() => {
  // A GENERATED parent key: the junction's parent id is a backward `Ref`, the case that
  // made the membership read impossible to build at all.
  const article = s
    .model({
      id: s.int().id().increment(),
      title: s.string(),
      topics: s.toMany(() => topic),
    })
    .map("e5u1_articles");

  // A SPELLED parent key: the parent id is a compile-time literal, so a membership read
  // COULD have been built — and would still have been a read whose answer is known.
  const page = s
    .model({
      id: s.string().id(),
      title: s.string(),
      topics: s.toMany(() => topic),
    })
    .map("e5u1_pages");

  const topic = s
    .model({
      id: s.int().id().increment(),
      name: s.string().unique(),
      weight: s.int().default(0),
      authorId: s.string().nullable(),
      author: s
        .toOne(() => author)
        .fields("authorId")
        .references("id"),
      articles: s.toMany(() => article),
      pages: s.toMany(() => page),
      notes: s.toMany(() => note),
    })
    .map("e5u1_topics");

  const author = s
    .model({
      id: s.string().id(),
      name: s.string(),
      topics: s.toMany(() => topic),
    })
    .map("e5u1_authors");

  const note = s
    .model({
      id: s.string().id(),
      body: s.string(),
      topicId: s.int(),
      topic: s
        .toOne(() => topic)
        .fields("topicId")
        .references("id"),
    })
    .map("e5u1_notes");

  return { article, page, topic, author, note };
})();

hydrateSchemaNames(createJunctionUpsertSchema);

async function reset(client: any): Promise<void> {
  await client.note.deleteMany({});
  await client.article.deleteMany({});
  await client.page.deleteMany({});
  await client.topic.deleteMany({});
  await client.author.deleteMany({});
}

/**
 * The DECOY is a complete, already-linked world: a topic that owns a note and belongs to
 * an article. Every witness below runs after it, so a join row or a grandchild carrying
 * a stale, borrowed, or previous-insert identity lands ON the decoy — observable as a
 * changed decoy, not as a value comparison.
 */
async function seedDecoy(client: any): Promise<{
  topicId: number;
  articleId: number;
}> {
  const decoyTopic = await client.topic.create({
    data: { id: -100, name: "decoy", weight: 1 },
  });
  await client.note.create({
    data: { id: "n-decoy", body: "decoy", topicId: decoyTopic.id },
  });
  const decoyArticle = await client.article.create({
    data: {
      id: -100,
      title: "decoy",
      topics: { connect: { name: "decoy" } },
    },
  });
  return { topicId: decoyTopic.id, articleId: decoyArticle.id };
}

const topicsOf = async (client: any, articleId: number): Promise<number[]> =>
  (
    await client.topic.findMany({
      where: { articles: { some: { id: articleId } } },
      orderBy: { id: "asc" },
    })
  ).map((row: any) => row.id);

export function registerCreateJunctionUpsertBehavior(
  name: string,
  connect: () => Promise<any>,
  register: (label: string, body: () => void) => void = describe
): void {
  register(`E5-U1 m2m upsert under a create root (${name})`, () => {
    const executeArticleCreate = (
      client: any,
      args: Record<string, unknown>
    ): Promise<any> => client.article.create(args);

    test("FOUND: the target is updated AND the join row is written", async () => {
      const client = await connect();
      await reset(client);
      const decoy = await seedDecoy(client);
      const existing = await client.topic.create({
        data: { id: -1, name: "existing", weight: 1 },
      });

      const made = await executeArticleCreate(client, {
        data: {
          title: "fresh",
          topics: {
            upsert: {
              where: { name: "existing" },
              // The create arm describes a row that is already there, so none of it is
              // applied — the adopt family's rule, unchanged.
              create: { name: "existing", weight: 99 },
              update: { weight: 5 },
            },
          },
        },
      });
      if (made === undefined) return;

      expect(await client.topic.count({ where: { name: "existing" } })).toBe(1);
      expect(
        (await client.topic.findUnique({ where: { name: "existing" } })).weight
      ).toBe(5);
      // The adopt: the fresh article now holds the membership.
      expect(await topicsOf(client, made.id)).toEqual([existing.id]);
      // The decoy world is untouched — its own topic, its own note, its own membership.
      expect(await topicsOf(client, decoy.articleId)).toEqual([decoy.topicId]);
      expect(
        (await client.topic.findUnique({ where: { id: decoy.topicId } })).weight
      ).toBe(1);
    }, 120_000);

    test("FOUND with an EMPTY update payload still adopts", async () => {
      // The whole reason the member arm is the WRONG donor: it skips an empty UPDATE and
      // writes no join row, so this payload would do nothing at all.
      const client = await connect();
      await reset(client);
      await seedDecoy(client);
      const existing = await client.topic.create({
        data: { id: -1, name: "quiet", weight: 3 },
      });

      const made = await executeArticleCreate(client, {
        data: {
          title: "quiet-holder",
          topics: {
            upsert: {
              where: { name: "quiet" },
              create: { name: "quiet", weight: 99 },
              update: {},
            },
          },
        },
      });
      if (made === undefined) return;

      expect(await topicsOf(client, made.id)).toEqual([existing.id]);
      expect(
        (await client.topic.findUnique({ where: { name: "quiet" } })).weight
      ).toBe(3);
    }, 120_000);

    test("FOUND with a RELATION-ONLY update payload adopts and writes the child", async () => {
      const client = await connect();
      await reset(client);
      await seedDecoy(client);
      const existing = await client.topic.create({
        data: { id: -1, name: "deep", weight: 7 },
      });

      const made = await executeArticleCreate(client, {
        data: {
          title: "deep-holder",
          topics: {
            upsert: {
              // The target's own primary key, so the deeper edge folds against a literal.
              where: { id: existing.id },
              create: { name: "deep", weight: 99 },
              update: { notes: { create: { id: "n-deep", body: "deep" } } },
            },
          },
        },
      });
      if (made === undefined) return;

      expect(await topicsOf(client, made.id)).toEqual([existing.id]);
      expect(
        await client.note.findUnique({ where: { id: "n-deep" } })
      ).toMatchObject({ topicId: existing.id });
      // No scalar SET was spelled, so nothing about the row changed.
      expect(
        (await client.topic.findUnique({ where: { id: existing.id } })).weight
      ).toBe(7);
    }, 120_000);

    test("ABSENT: the created target's PRODUCED id reaches the join row and its grandchildren", async () => {
      const client = await connect();
      await reset(client);
      const decoy = await seedDecoy(client);

      const made = await executeArticleCreate(client, {
        data: {
          title: "maker",
          topics: {
            upsert: {
              where: { name: "made" },
              create: {
                name: "made",
                weight: 42,
                notes: { create: { id: "n-made", body: "made" } },
              },
              update: { weight: 0 },
            },
          },
        },
      });
      if (made === undefined) return;

      const fresh = await client.topic.findUnique({ where: { name: "made" } });
      expect(fresh.id).not.toBe(decoy.topicId);
      expect(fresh.weight).toBe(42);
      expect(await topicsOf(client, made.id)).toEqual([fresh.id]);
      expect(
        await client.note.findUnique({ where: { id: "n-made" } })
      ).toMatchObject({ topicId: fresh.id });
      // The decoy still owns exactly its own note and its own membership.
      expect(
        (await client.note.findMany({ where: { topicId: decoy.topicId } })).map(
          (row: any) => row.id
        )
      ).toEqual(["n-decoy"]);
      expect(await topicsOf(client, decoy.articleId)).toEqual([decoy.topicId]);
    }, 120_000);

    test("a LITERAL parent key takes the same two branches", async () => {
      const client = await connect();
      await reset(client);
      await seedDecoy(client);
      const existing = await client.topic.create({
        data: { id: -1, name: "shared", weight: 2 },
      });

      await client.page.create({
        data: {
          id: "pg-found",
          title: "found",
          topics: {
            upsert: {
              where: { name: "shared" },
              create: { name: "shared" },
              update: { weight: 8 },
            },
          },
        },
      });
      expect(
        (
          await client.topic.findMany({
            where: { pages: { some: { id: "pg-found" } } },
          })
        ).map((row: any) => row.id)
      ).toEqual([existing.id]);
      expect(
        (await client.topic.findUnique({ where: { name: "shared" } })).weight
      ).toBe(8);
      const missingOperation = client.page.create({
        data: {
          id: "pg-absent",
          title: "absent",
          topics: {
            upsert: {
              where: { name: "brand-new" },
              create: { name: "brand-new", weight: 4 },
              update: { weight: 0 },
            },
          },
        },
      });
      await missingOperation;

      const brandNew = await client.topic.findUnique({
        where: { name: "brand-new" },
      });
      expect(
        (
          await client.topic.findMany({
            where: { pages: { some: { id: "pg-found" } } },
          })
        ).map((row: any) => row.id)
      ).toEqual([existing.id]);
      expect(
        (
          await client.topic.findMany({
            where: { pages: { some: { id: "pg-absent" } } },
          })
        ).map((row: any) => row.id)
      ).toEqual([brandNew.id]);
      expect(
        (await client.topic.findUnique({ where: { name: "shared" } })).weight
      ).toBe(8);
    }, 120_000);

    // ─────────────────────────────────────────────────────────────────────────
    // M7 — the own-write preflight gate. These three rejections were measured at
    // a554419, BEFORE the absorption, and are what made it safe: no `upsert` item at
    // this root can name a row another item in the same payload wrote.
    // ─────────────────────────────────────────────────────────────────────────
    test("M7: two upsert items on one relation are refused (overlapping selectors)", async () => {
      const client = await connect();
      await reset(client);
      await expect(
        client.article.create({
          data: {
            title: "two",
            topics: {
              upsert: [
                {
                  where: { name: "same" },
                  create: { name: "same" },
                  update: { weight: 1 },
                },
                {
                  where: { name: "same" },
                  create: { name: "same" },
                  update: { weight: 2 },
                },
              ],
            },
          },
        })
      ).rejects.toThrow(
        "Nested operation 'upsert' on relation 'topics' depends on an earlier 'upsert' target write in the same nested write. Split these operations into separate queries."
      );
    }, 120_000);

    test("M7: two upsert items are refused even with DISJOINT selectors", async () => {
      // Measured, and it is the WALL this unit did not move: the preflight classifies a
      // second `upsert` on one relation by its FOOTPRINT, not by whether the two
      // selectors can name one row, so no multi-entry array reaches the junction here.
      const client = await connect();
      await reset(client);
      await expect(
        client.article.create({
          data: {
            title: "two-disjoint",
            topics: {
              upsert: [
                {
                  where: { name: "left" },
                  create: { name: "left" },
                  update: { weight: 1 },
                },
                {
                  where: { name: "right" },
                  create: { name: "right" },
                  update: { weight: 2 },
                },
              ],
            },
          },
        })
      ).rejects.toThrow(
        "Nested operation 'upsert' on relation 'topics' depends on an earlier 'upsert' target write in the same nested write. Split these operations into separate queries."
      );
    }, 120_000);

    test("M7: an upsert beside a connectOrCreate on one relation is refused", async () => {
      const client = await connect();
      await reset(client);
      await expect(
        client.article.create({
          data: {
            title: "beside",
            topics: {
              upsert: {
                where: { name: "a" },
                create: { name: "a" },
                update: { weight: 1 },
              },
              connectOrCreate: {
                where: { name: "a" },
                create: { name: "a" },
              },
            },
          },
        })
      ).rejects.toThrow(
        "Nested operation 'connectOrCreate' on relation 'topics' depends on an earlier 'upsert' target write in the same nested write. Split these operations into separate queries."
      );
    }, 120_000);

    // ─────────────────────────────────────────────────────────────────────────
    // The two compositions M7-b(ii) left ACCEPTED. Measured post-absorption: each
    // writes ONE join row per named target, and a target the upsert adopted and the
    // sibling kind also names ends with exactly one membership (the join write is
    // idempotent through the junction primary key).
    // ─────────────────────────────────────────────────────────────────────────
    test("upsert + connect naming ONE row joins it exactly once", async () => {
      const client = await connect();
      await reset(client);
      await seedDecoy(client);
      const existing = await client.topic.create({
        data: { id: -1, name: "both", weight: 1 },
      });

      const made = await executeArticleCreate(client, {
        data: {
          title: "upsert-plus-connect",
          topics: {
            upsert: {
              where: { name: "both" },
              create: { name: "both" },
              update: { weight: 9 },
            },
            connect: { name: "both" },
          },
        },
      });
      if (made === undefined) return;

      expect(await topicsOf(client, made.id)).toEqual([existing.id]);
      expect(
        (await client.topic.findUnique({ where: { name: "both" } })).weight
      ).toBe(9);
    }, 120_000);

    test("upsert + create naming DIFFERENT rows writes both memberships", async () => {
      const client = await connect();
      await reset(client);
      await seedDecoy(client);
      const existing = await client.topic.create({
        data: { id: -1, name: "adopted", weight: 1 },
      });

      const made = await executeArticleCreate(client, {
        data: {
          title: "upsert-plus-create",
          topics: {
            upsert: {
              where: { name: "adopted" },
              create: { name: "adopted" },
              update: { weight: 6 },
            },
            create: { name: "invented", weight: 3 },
          },
        },
      });
      if (made === undefined) return;

      const invented = await client.topic.findUnique({
        where: { name: "invented" },
      });
      expect(await topicsOf(client, made.id)).toEqual(
        [existing.id, invented.id].sort((a, b) => a - b)
      );
      expect(
        (await client.topic.findUnique({ where: { name: "adopted" } })).weight
      ).toBe(6);
    }, 120_000);

    // ─────────────────────────────────────────────────────────────────────────
    // Both of E5-U1's carve-outs, DISCHARGED by U-E6.1: the arm's probe id is now
    // wired through the upsert fold, so the found arm addresses the key its own probe
    // captured instead of asking the selector a second time. The two tests below were
    // the refusals; they are the absorptions now, in the same place, with the state
    // assertions the discharge owes.
    // ─────────────────────────────────────────────────────────────────────────
    test("the WHOLE-TARGET update arm runs, and only on the located row", async () => {
      const client = await connect();
      await reset(client);
      const decoy = await seedDecoy(client);
      await client.author.create({ data: { id: "au", name: "au" } });
      const target = await client.topic.create({
        data: { id: -1, name: "carve", weight: 1 },
      });

      const made = await executeArticleCreate(client, {
        data: {
          title: "carve",
          topics: {
            upsert: {
              where: { id: target.id },
              create: { name: "carve-2" },
              // A parent-held to-one on the target: `targetNeedsFullUpdate`, so the
              // whole target write delegates to `UpdateOperation` — which now locates
              // by the primary key this arm's global probe captured, not by the
              // selector the probe already spent.
              update: { author: { connect: { id: "au" } } },
            },
          },
        },
      });
      if (made === undefined) return;

      // The create arm never ran, the adopt did, and the delegated update landed.
      expect(await client.topic.count({ where: { name: "carve-2" } })).toBe(0);
      expect(
        (await client.topic.findUnique({ where: { id: target.id } })).authorId
      ).toBe("au");
      expect(await topicsOf(client, made.id)).toEqual([target.id]);
      // The decoy topic kept its own author (none) and its own membership.
      expect(
        (await client.topic.findUnique({ where: { id: decoy.topicId } }))
          .authorId
      ).toBeNull();
      expect(await topicsOf(client, decoy.articleId)).toEqual([decoy.topicId]);
    }, 120_000);

    test("a relation-carrying update arm named by a NON-primary-key unique runs", async () => {
      const client = await connect();
      await reset(client);
      const decoy = await seedDecoy(client);
      // A DECOY sharing the non-unique half: same weight, different unique name. The
      // arm's deeper edge takes a `planned` source into the probe, so a note that
      // landed on this row would be reading the selector rather than the located key.
      await client.topic.create({
        data: { id: -2, name: "look-alike", weight: 4 },
      });
      const target = await client.topic.create({
        data: { id: -1, name: "by-name", weight: 4 },
      });

      const made = await executeArticleCreate(client, {
        data: {
          title: "non-pk",
          topics: {
            upsert: {
              where: { name: "by-name" },
              create: { name: "by-name" },
              update: { notes: { create: { id: "n-x", body: "x" } } },
            },
          },
        },
      });
      if (made === undefined) return;

      expect(
        await client.note.findUnique({ where: { id: "n-x" } })
      ).toMatchObject({ topicId: target.id });
      expect(await topicsOf(client, made.id)).toEqual([target.id]);
      expect(
        (await client.note.findMany({ where: { topicId: decoy.topicId } })).map(
          (row: any) => row.id
        )
      ).toEqual(["n-decoy"]);
    }, 120_000);

    test("the ABSENT arm still creates, with the update arm's deeper edge unapplied", async () => {
      // The arm probe publishes its captured key as an OPTIONAL output for exactly this
      // branch: nothing was found, no update-arm child compiles, and a REQUIRED output
      // would have aborted the planning pass on the arm that is taken.
      const client = await connect();
      await reset(client);
      await seedDecoy(client);

      const made = await executeArticleCreate(client, {
        data: {
          title: "absent-arm",
          topics: {
            upsert: {
              where: { name: "never-there" },
              create: { name: "never-there", weight: 9 },
              update: { notes: { create: { id: "n-unused", body: "x" } } },
            },
          },
        },
      });
      if (made === undefined) return;

      const fresh = await client.topic.findUnique({
        where: { name: "never-there" },
      });
      expect(fresh.weight).toBe(9);
      expect(await topicsOf(client, made.id)).toEqual([fresh.id]);
      expect(
        await client.note.findUnique({ where: { id: "n-unused" } })
      ).toBeNull();
    }, 120_000);
  });
}
