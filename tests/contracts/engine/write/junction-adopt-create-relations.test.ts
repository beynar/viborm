import { createClient } from "@client/client";
import { PGliteDriver } from "@drivers/pglite";

import { createModelRegistry, QueryEngine } from "@query-engine/query-engine";
import { hydrateSchemaNames, s } from "@schema";
import type {
  OperationStep,
  WriteStep,
} from "@src/query-engine/write-engine/OperationFragment";
import { UpdateOperation } from "@src/query-engine/write-engine/UpdateOperation";
import { BatchOnlyPGliteDriver } from "@tests/fixtures/drivers/pglite";
import { createSchemaRegistry } from "@validation";
import { describe, expect, test } from "vitest";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";

/**
 * E2-U2 — **relations inside a many-to-many `connectOrCreate` create arm.**
 *
 * The create arm inserts a row keyed by the literal primary key its data spells, so its
 * deeper edges use the ordinary fresh-target compiler. What is arm-specific is WHERE
 * those Parts are emitted: `connectOrCreate` has THREE branches and only one of them
 * makes a row.
 *
 *  · **found** (the global probe located the target) — adopt: the join row alone. Prisma's
 *    semantics are that an existing row is joined, not described, so the create payload
 *    is not applied — its relations included.
 *  · **dedup-adopt** (an earlier item in the same array already created this target) —
 *    the join row alone. The earlier item's INSERT already ran this payload with its
 *    children, so first-create-wins stays whole rather than half.
 *  · **create** — child INSERT (carrying the missing-premise `racePin`), join row, then
 *    the folded child Parts against the arm's literal primary key.
 *
 * Planning is the widened superset of all three (ATOM §3 technique 2): the child Parts
 * plan their reads unconditionally, because which branch runs is decided at compile from
 * the probe's rows. A deeper `connect` — whose Part owes a planning probe — is the shape
 * that proves the planning half is wired and not merely the compile half.
 *
 * Two carve-outs stay refused, each named where it is decided:
 *  · a DB-generated target primary key (the child Parts fold against a compile-time
 *    literal; a produced identity is a backward `Ref`) — E4's row;
 *  · a create arm whose relations need the whole-create delegation, which would replace
 *    the arm's INSERT and with it the `racePin` — also E4's, and the pin is witnessed
 *    here so the trade cannot be made silently.
 *
 * Relation-bearing `updateMany` now captures connected target row keys at this Part's
 * ordered position and runs one selected-record compiler subtree per target.
 */
const adoptRelationsSchema = (() => {
  const user = s
    .model({
      id: s.string().id(),
      name: s.string(),
      tags: s.toMany(() => tag),
    })
    .map("e2u2_users");
  const post = s
    .model({
      id: s.string().id(),
      title: s.string(),
      tags: s.toMany(() => tag),
      stamps: s.toMany(() => stamp),
    })
    .map("e2u2_posts");
  const tag = s
    .model({
      id: s.string().id(),
      name: s.string().unique(),
      ownerId: s.string().nullable(),
      // The parent-held to-one that routes a create arm into the whole-create
      // delegation — the carve-out this file pins.
      owner: s
        .toOne(() => user)
        .fields("ownerId")
        .references("id"),
      posts: s.toMany(() => post),
      notes: s.toMany(() => note),
      polymorphicNotes: s.toMany(() => polymorphicNote).name("subject"),
    })
    .map("e2u2_tags");
  const note = s
    .model({
      id: s.string().id(),
      body: s.string(),
      tagId: s.string(),
      tag: s
        .toOne(() => tag)
        .fields("tagId")
        .references("id"),
    })
    .map("e2u2_notes");
  /** The DB-generated target primary key carve-out. */
  const stamp = s
    .model({
      id: s.int().id().increment(),
      name: s.string().unique(),
      posts: s.toMany(() => post),
      notes: s.toMany(() => stampNote),
    })
    .map("e2u2_stamps");
  const stampNote = s
    .model({
      id: s.string().id(),
      body: s.string(),
      stampId: s.int(),
      stamp: s
        .toOne(() => stamp)
        .fields("stampId")
        .references("id"),
    })
    .map("e2u2_stamp_notes");
  /** The third root: the same shape one level deeper, under a located nested target. */
  const board = s
    .model({
      id: s.string().id(),
      name: s.string(),
      posts: s.toMany(() => boardPost),
    })
    .map("e2u2_boards");
  const boardPost = s
    .model({
      id: s.string().id(),
      title: s.string(),
      boardId: s.string(),
      board: s
        .toOne(() => board)
        .fields("boardId")
        .references("id"),
      marks: s.toMany(() => mark),
    })
    .map("e2u2_board_posts");
  const mark = s
    .model({
      id: s.string().id(),
      name: s.string().unique(),
      posts: s.toMany(() => boardPost),
      notes: s.toMany(() => markNote),
    })
    .map("e2u2_marks");
  const markNote = s
    .model({
      id: s.string().id(),
      body: s.string(),
      markId: s.string(),
      mark: s
        .toOne(() => mark)
        .fields("markId")
        .references("id"),
    })
    .map("e2u2_mark_notes");
  const polymorphicNote = s
    .model({
      id: s.string().id(),
      body: s.string(),
      subject: s
        .toOne(
          { tag: () => tag, mark: () => mark },
          {
            values: {
              tag: "junction.tag.v1",
              mark: "junction.mark.v1",
            },
          }
        )
        .name("subject")
        .optional(),
    })
    .map("e2u2_polymorphic_notes");
  return {
    user,
    post,
    tag,
    note,
    stamp,
    stampNote,
    board,
    boardPost,
    mark,
    markNote,
    polymorphicNote,
  };
})();

hydrateSchemaNames(adoptRelationsSchema);

function makeClient(driver: PGliteDriver) {
  return createClient({ schema: adoptRelationsSchema, driver });
}

type Client = ReturnType<typeof makeClient>;

/**
 * `decoy` is a tag that ALREADY exists with a note of its own: every create-arm
 * assertion below has to leave it exactly as it was, and the found-arm assertion turns
 * on it. `n-loose` is an unattached note the deeper `connect` reparents.
 */
async function seed(client: Client): Promise<void> {
  await client.post.create({ data: { id: "post1", title: "post" } });
  await client.tag.create({ data: { id: "t-decoy", name: "decoy" } });
  await client.note.create({
    data: { id: "n-decoy", body: "decoy", tagId: "t-decoy" },
  });
  await client.tag.create({ data: { id: "t-loose", name: "loose" } });
  await client.note.create({
    data: { id: "n-loose", body: "loose", tagId: "t-loose" },
  });
}

async function setup(driver: PGliteDriver) {
  const client = makeClient(driver);
  await syncLiveSchema(client);
  await seed(client);
  return client;
}

async function tagsOf(client: Client, postId: string) {
  return client.tag.findMany({
    where: { posts: { some: { id: postId } } },
    orderBy: { id: "asc" },
  });
}

for (const substrate of ["transaction", "atomic batch"] as const) {
  const makeDriver = () =>
    substrate === "transaction"
      ? new PGliteDriver()
      : new BatchOnlyPGliteDriver();

  describe(`E2-U2 connectOrCreate create-arm relations (${substrate})`, () => {
    test("the update root creates the target, joins it, and writes its children", async () => {
      const client = await setup(makeDriver());
      try {
        await client.post.update({
          where: { id: "post1" },
          data: {
            tags: {
              connectOrCreate: {
                where: { id: "t-fresh" },
                create: {
                  id: "t-fresh",
                  name: "fresh",
                  notes: { create: { id: "n-fresh", body: "fresh" } },
                },
              },
            },
          },
        });
        await expect(tagsOf(client, "post1")).resolves.toEqual([
          { id: "t-fresh", name: "fresh", ownerId: null },
        ]);
        await expect(
          client.note.findMany({ orderBy: { id: "asc" } })
        ).resolves.toEqual([
          { id: "n-decoy", body: "decoy", tagId: "t-decoy" },
          { id: "n-fresh", body: "fresh", tagId: "t-fresh" },
          { id: "n-loose", body: "loose", tagId: "t-loose" },
        ]);
      } finally {
        await client.$disconnect();
      }
    }, 30_000);

    test("the create root does the same under a fresh parent", async () => {
      const client = await setup(makeDriver());
      try {
        await client.post.create({
          data: {
            id: "post2",
            title: "second",
            tags: {
              connectOrCreate: {
                where: { id: "t-root" },
                create: {
                  id: "t-root",
                  name: "root",
                  notes: { create: { id: "n-root", body: "root" } },
                },
              },
            },
          },
        });
        await expect(tagsOf(client, "post2")).resolves.toEqual([
          { id: "t-root", name: "root", ownerId: null },
        ]);
        await expect(
          client.note.findUnique({ where: { id: "n-root" } })
        ).resolves.toEqual({ id: "n-root", body: "root", tagId: "t-root" });
      } finally {
        await client.$disconnect();
      }
    }, 30_000);

    test("a fresh inline junction target globally adopts through a polymorphic inverse", async () => {
      const client = await setup(makeDriver());
      try {
        await client.polymorphicNote.create({
          data: { id: "pn-loose", body: "before adoption" },
        });
        await client.post.update({
          where: { id: "post1" },
          data: {
            tags: {
              connectOrCreate: {
                where: { id: "t-polymorphic" },
                create: {
                  id: "t-polymorphic",
                  name: "polymorphic target",
                  polymorphicNotes: {
                    upsert: {
                      where: { id: "pn-loose" },
                      create: {
                        id: "pn-loose",
                        body: "must not create",
                      },
                      update: { body: "after adoption" },
                    },
                  },
                },
              },
            },
          },
        });

        await expect(
          client.polymorphicNote.findUniqueOrThrow({
            where: { id: "pn-loose" },
            include: { subject: true },
          })
        ).resolves.toMatchObject({
          body: "after adoption",
          subject: {
            type: "tag",
            data: { id: "t-polymorphic" },
          },
        });
      } finally {
        await client.$disconnect();
      }
    }, 30_000);

    test("the same shape one level deeper, under a located nested target", async () => {
      const client = await setup(makeDriver());
      try {
        await client.board.create({ data: { id: "b1", name: "board" } });
        await client.boardPost.create({
          data: { id: "bp1", title: "bp", boardId: "b1" },
        });
        await client.board.update({
          where: { id: "b1" },
          data: {
            posts: {
              update: {
                where: { id: "bp1" },
                data: {
                  marks: {
                    connectOrCreate: {
                      where: { id: "m-fresh" },
                      create: {
                        id: "m-fresh",
                        name: "fresh",
                        notes: { create: { id: "mn1", body: "deep" } },
                      },
                    },
                  },
                },
              },
            },
          },
        });
        await expect(
          client.mark.findMany({
            where: { posts: { some: { id: "bp1" } } },
          })
        ).resolves.toEqual([{ id: "m-fresh", name: "fresh" }]);
        await expect(
          client.markNote.findMany({ orderBy: { id: "asc" } })
        ).resolves.toEqual([{ id: "mn1", body: "deep", markId: "m-fresh" }]);
      } finally {
        await client.$disconnect();
      }
    }, 30_000);

    test("a deeper CONNECT proves the arm's children plan their reads", async () => {
      const client = await setup(makeDriver());
      try {
        // `connect` owes a planning probe. If `planning()` did not descend into the
        // arm's child Parts, that probe would never run and compile would find no
        // planning key — so this payload is the planning half of the wiring, not the
        // compile half.
        await client.post.update({
          where: { id: "post1" },
          data: {
            tags: {
              connectOrCreate: {
                where: { id: "t-linker" },
                create: {
                  id: "t-linker",
                  name: "linker",
                  notes: { connect: { id: "n-loose" } },
                },
              },
            },
          },
        });
        await expect(
          client.note.findUnique({ where: { id: "n-loose" } })
        ).resolves.toEqual({
          id: "n-loose",
          body: "loose",
          tagId: "t-linker",
        });
      } finally {
        await client.$disconnect();
      }
    }, 30_000);

    test("the FOUND arm adopts the existing row and writes none of its children", async () => {
      const client = await setup(makeDriver());
      try {
        await client.post.update({
          where: { id: "post1" },
          data: {
            tags: {
              connectOrCreate: {
                where: { id: "t-decoy" },
                create: {
                  id: "t-decoy",
                  name: "would-be",
                  notes: { create: { id: "n-never", body: "never" } },
                },
              },
            },
          },
        });
        // Joined, unchanged, and the create arm's child was not written: an adopted
        // row is the row that was already there.
        await expect(tagsOf(client, "post1")).resolves.toEqual([
          { id: "t-decoy", name: "decoy", ownerId: null },
        ]);
        await expect(
          client.note.findMany({ where: { tagId: "t-decoy" } })
        ).resolves.toEqual([
          { id: "n-decoy", body: "decoy", tagId: "t-decoy" },
        ]);
        await expect(
          client.note.findUnique({ where: { id: "n-never" } })
        ).resolves.toBeNull();
      } finally {
        await client.$disconnect();
      }
    }, 30_000);

    test("first-create-wins: a duplicate item adopts and writes no second child set", async () => {
      const client = await setup(makeDriver());
      try {
        await client.post.update({
          where: { id: "post1" },
          data: {
            tags: {
              connectOrCreate: [
                {
                  where: { id: "t-dup" },
                  create: {
                    id: "t-dup",
                    name: "first",
                    notes: { create: { id: "n-first", body: "first" } },
                  },
                },
                {
                  where: { id: "t-dup" },
                  create: {
                    id: "t-dup",
                    name: "second",
                    notes: { create: { id: "n-second", body: "second" } },
                  },
                },
              ],
            },
          },
        });
        await expect(tagsOf(client, "post1")).resolves.toEqual([
          { id: "t-dup", name: "first", ownerId: null },
        ]);
        // The second item adopted the first item's row; its children did not run —
        // the ledger's first-create-wins now covers the whole payload, not half of it.
        await expect(
          client.note.findMany({ where: { tagId: "t-dup" } })
        ).resolves.toEqual([{ id: "n-first", body: "first", tagId: "t-dup" }]);
        await expect(
          client.note.findUnique({ where: { id: "n-second" } })
        ).resolves.toBeNull();
      } finally {
        await client.$disconnect();
      }
    }, 30_000);
  });
}

/** The fragment's write statements, narrowed to the owner of `racePin`. */
function writeSteps(steps: readonly OperationStep[]): readonly WriteStep[] {
  return steps.filter((step): step is WriteStep => step.kind === "write");
}

describe("E2-U2 the missing-premise race pin survives the absorption", () => {
  /** The arm's `where` is the target primary key, so the pinned constraint is the
   *  table's primary key under both of its dialect spellings. */
  const TAG_PIN = {
    fields: ["id"],
    table: "e2u2_tags",
    columns: ["id"],
    constraints: ["e2u2_tags_pkey", "PRIMARY"],
  };

  for (const substrate of [
    { name: "transaction", make: () => new PGliteDriver() },
    { name: "atomic batch", make: () => new BatchOnlyPGliteDriver() },
  ]) {
    test(`the arm's INSERT still carries the pin, and nothing deeper does (${substrate.name})`, () => {
      const driver = substrate.make();
      const schemas = createSchemaRegistry(adoptRelationsSchema);
      const engine = new QueryEngine(
        driver,
        createModelRegistry(adoptRelationsSchema, schemas)
      );
      const operation = new UpdateOperation(engine, adoptRelationsSchema.post, {
        where: { id: "post1" },
        data: {
          tags: {
            connectOrCreate: {
              where: { id: "t-fresh" },
              create: {
                id: "t-fresh",
                name: "fresh",
                notes: { create: { id: "n-fresh", body: "fresh" } },
              },
            },
          },
        },
      });
      // The root located its post; the arm's global probe found nothing, so the CREATE
      // branch is taken.
      const compiled = operation.compile({
        "post.locate.rows": [{ id: "post1" }],
        "tag.find.rows": [],
      });
      const writes = writeSteps(compiled.steps);
      // The missing premise is enforced by the child's unique constraint (Pin Rule:
      // never a notExists guard), and the absorption must not move or drop it.
      expect(
        writes.filter((step) => step.racePin !== undefined).map((s) => s.id)
      ).toEqual(["tag.create"]);
      expect(writes.find((step) => step.id === "tag.create")?.racePin).toEqual(
        TAG_PIN
      );
      // The deeper record is really there (so the assertion above is about a folded
      // subtree, not an empty one) and unpinned.
      expect(writes.map((step) => step.id)).toEqual(
        expect.arrayContaining(["note.create"])
      );
    });
  }
});

describe("E2-U2 the carve-outs — both DISCHARGED by E4-U3", () => {
  /**
   * DELIBERATE RETARGET (E4-U3). This pinned E2's first carve-out: a relation-carrying
   * create arm whose target primary key is DB-generated. The reason was that the arm's
   * deeper edges folded against a compile-time literal and a produced key is a backward
   * `Ref`.
   *
   * E4-U3 stopped folding. The arm is a whole create SUBTREE, the create root has
   * threaded produced identities to its own children since N4-U4, and the join row asks
   * the subtree for the identity its INSERT made. What this test pins now is that
   * lift — and, unchanged, that the SCALAR-only spelling still rides the slot's own
   * produced-identity path. The full state and provenance witnesses are
   * `junction-produced-identity(.test|-behavior|-docker.test).ts`.
   */
  test("a relation-carrying arm with a DB-generated target primary key", async () => {
    const client = await setup(new PGliteDriver());
    try {
      await client.post.update({
        where: { id: "post1" },
        data: {
          stamps: {
            connectOrCreate: {
              where: { name: "fresh-stamp" },
              create: {
                name: "fresh-stamp",
                notes: { create: { id: "sn1", body: "b" } },
              },
            },
          },
        },
      });
      const stamps = await client.stamp.findMany({
        where: { posts: { some: { id: "post1" } } },
      });
      expect(stamps).toMatchObject([{ name: "fresh-stamp" }]);
      // The grandchild the subtree wrote carries the SAME produced id the join row does.
      await expect(
        client.stampNote.findUnique({ where: { id: "sn1" } })
      ).resolves.toMatchObject({ stampId: (stamps[0] as any).id });
      // The scalar-only spelling of the SAME arm is untouched.
      await client.post.update({
        where: { id: "post1" },
        data: {
          stamps: {
            connectOrCreate: {
              where: { name: "second-stamp" },
              create: { name: "second-stamp" },
            },
          },
        },
      });
      await expect(
        client.stamp.findMany({
          where: { posts: { some: { id: "post1" } } },
          orderBy: { name: "asc" },
        })
      ).resolves.toMatchObject([
        { name: "fresh-stamp" },
        { name: "second-stamp" },
      ]);
    } finally {
      await client.$disconnect();
    }
  }, 30_000);

  /**
   * DELIBERATE RETARGET (E4-U3). E2's second carve-out refused the WHOLE-create
   * delegation on this arm for one reason, stated in its own message: the delegated
   * subtree replaces the arm's INSERT, and with it the unique-constraint `racePin` the
   * arm's missing premise is enforced by. E2 declined to trade a race protection for a
   * shape and named the wire that would settle it.
   *
   * E4-U3 laid that wire (`buildNestedTargetFreshCreatePart`'s `racePin`, threaded to
   * the subtree's ROOT insert through `nestedFresh.rootRacePin`), so the trade is no
   * longer being made. The pin's own witness is in
   * `junction-produced-identity.test.ts`; what this test pins is the SHAPE that used
   * to be refused, executing.
   */
  test("a create arm whose relations need the whole-create delegation", async () => {
    const client = await setup(new PGliteDriver());
    try {
      await client.post.update({
        where: { id: "post1" },
        data: {
          tags: {
            connectOrCreate: {
              where: { id: "t-owned" },
              create: {
                id: "t-owned",
                name: "owned",
                owner: { create: { id: "u1", name: "owner" } },
              },
            },
          },
        },
      });
      await expect(
        client.tag.findUnique({ where: { id: "t-owned" } })
      ).resolves.toMatchObject({ ownerId: "u1" });
      await expect(
        client.tag.findMany({ where: { posts: { some: { id: "post1" } } } })
      ).resolves.toMatchObject([{ id: "t-owned" }]);
    } finally {
      await client.$disconnect();
    }
  }, 30_000);

  test("junction updateMany runs one selected-record subtree per connected target", async () => {
    const client = await setup(new PGliteDriver());
    try {
      await client.board.create({ data: { id: "b1", name: "board" } });
      await client.boardPost.create({
        data: { id: "bp1", title: "bp", boardId: "b1" },
      });
      await client.mark.create({
        data: {
          id: "m1",
          name: "mark",
          posts: { connect: { id: "bp1" } },
        },
      });

      await client.board.update({
        where: { id: "b1" },
        data: {
          posts: {
            update: {
              where: { id: "bp1" },
              data: {
                marks: {
                  updateMany: {
                    where: { id: "m1" },
                    data: {
                      name: "updated",
                      notes: { create: { id: "x", body: "nested" } },
                    },
                  },
                },
              },
            },
          },
        },
      });

      await expect(
        client.mark.findUnique({ where: { id: "m1" } })
      ).resolves.toMatchObject({ name: "updated" });
      await expect(
        client.markNote.findUnique({ where: { id: "x" } })
      ).resolves.toEqual({ id: "x", body: "nested", markId: "m1" });
    } finally {
      await client.$disconnect();
    }
  }, 30_000);
});
