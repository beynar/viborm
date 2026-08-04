import { createClient } from "@client/client";
import type { BatchQuery, QueryResult } from "@drivers";
import { PGliteDriver } from "@drivers/pglite";
import type { PGlite, Transaction } from "@electric-sql/pglite";
import { push } from "@migrations";
import { createModelRegistry, QueryEngine } from "@query-engine/query-engine";
import { hydrateSchemaNames, s } from "@schema";
import { createSchemaRegistry } from "@validation";
import { describe, expect, test } from "vitest";
import type {
  OperationStep,
  StatementStep,
} from "../../src/query-engine/write-engine/OperationFragment";
import { UnsupportedOperationError } from "../../src/query-engine/write-engine/shared";
import { UpdateOperation } from "../../src/query-engine/write-engine/UpdateOperation";

/**
 * E2-U2 — **relations inside a many-to-many `connectOrCreate` create arm.**
 *
 * The `scalarOnly` boundary refused them at every root, measured live before the lift
 * (0 statements, both substrates, all three `buildJunctionParts` callers):
 *
 *   UnsupportedOperationError: query-engine-v2 nested 'connectOrCreate' on many-to-many
 *   relation 'tags' does not support nested relation writes in its data.
 *
 * The create arm inserts a row keyed by the literal primary key its data spells, so its
 * deeper edges are the ordinary fresh-target case (mechanism 2) the `create` and `upsert`
 * arms already fold. What is arm-specific is WHERE the folded Parts are emitted, and that
 * is the whole of this unit's care: `connectOrCreate` has THREE branches and only one of
 * them makes a row.
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
 * The `updateMany` sibling of the same boundary stays refused with the ENGINE's reason
 * (M4): a set-based `UPDATE … WHERE <membership>` never learns which rows it touched, so
 * a deeper edge has no per-row identity to reference.
 */
const adoptRelationsSchema = (() => {
  const user = s
    .model({
      id: s.string().id(),
      name: s.string(),
      tags: s.oneToMany(() => tag),
    })
    .map("e2u2_users");
  const post = s
    .model({
      id: s.string().id(),
      title: s.string(),
      tags: s.manyToMany(() => tag),
      stamps: s.manyToMany(() => stamp),
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
        .manyToOne(() => user)
        .fields("ownerId")
        .references("id")
        .optional(),
      posts: s.manyToMany(() => post),
      notes: s.oneToMany(() => note),
    })
    .map("e2u2_tags");
  const note = s
    .model({
      id: s.string().id(),
      body: s.string(),
      tagId: s.string(),
      tag: s
        .manyToOne(() => tag)
        .fields("tagId")
        .references("id"),
    })
    .map("e2u2_notes");
  /** The DB-generated target primary key carve-out. */
  const stamp = s
    .model({
      id: s.int().id().increment(),
      name: s.string().unique(),
      posts: s.manyToMany(() => post),
      notes: s.oneToMany(() => stampNote),
    })
    .map("e2u2_stamps");
  const stampNote = s
    .model({
      id: s.string().id(),
      body: s.string(),
      stampId: s.int(),
      stamp: s
        .manyToOne(() => stamp)
        .fields("stampId")
        .references("id"),
    })
    .map("e2u2_stamp_notes");
  /** The third root: the same shape one level deeper, under a located nested target. */
  const board = s
    .model({
      id: s.string().id(),
      name: s.string(),
      posts: s.oneToMany(() => boardPost),
    })
    .map("e2u2_boards");
  const boardPost = s
    .model({
      id: s.string().id(),
      title: s.string(),
      boardId: s.string(),
      board: s
        .manyToOne(() => board)
        .fields("boardId")
        .references("id"),
      marks: s.manyToMany(() => mark),
    })
    .map("e2u2_board_posts");
  const mark = s
    .model({
      id: s.string().id(),
      name: s.string().unique(),
      posts: s.manyToMany(() => boardPost),
      notes: s.oneToMany(() => markNote),
    })
    .map("e2u2_marks");
  const markNote = s
    .model({
      id: s.string().id(),
      body: s.string(),
      markId: s.string(),
      mark: s
        .manyToOne(() => mark)
        .fields("markId")
        .references("id"),
    })
    .map("e2u2_mark_notes");
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
  };
})();

hydrateSchemaNames(adoptRelationsSchema);

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
  await push(client, { force: true });
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

/** The fragment's write statements — `racePin` is a property of a statement step, and a
 *  `filter` on `kind` does not narrow the union on its own. */
function writeSteps(steps: readonly OperationStep[]): readonly StatementStep[] {
  return steps.filter((step): step is StatementStep => step.kind === "write");
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

describe("E2-U2 the carve-outs that stay refused", () => {
  test("a relation-carrying arm with a DB-generated target primary key", async () => {
    const client = await setup(new PGliteDriver());
    try {
      await expect(
        client.post.update({
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
        })
      ).rejects.toThrow(
        "query-engine-v2 create-through-junction for relation 'stamps' requires the target primary key 'id' in the create data (connectOrCreate)."
      );
      // The scalar-only spelling of the SAME arm still rides the produced identity:
      // the refusal is about the deeper edges' literal, not about generated keys.
      await client.post.update({
        where: { id: "post1" },
        data: {
          stamps: {
            connectOrCreate: {
              where: { name: "fresh-stamp" },
              create: { name: "fresh-stamp" },
            },
          },
        },
      });
      await expect(
        client.stamp.findMany({ where: { posts: { some: { id: "post1" } } } })
      ).resolves.toMatchObject([{ name: "fresh-stamp" }]);
    } finally {
      await client.$disconnect();
    }
  }, 30_000);

  test("a create arm whose relations need the whole-create delegation", async () => {
    const client = await setup(new PGliteDriver());
    try {
      await expect(
        client.post.update({
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
        })
      ).rejects.toThrow(UnsupportedOperationError);
      await expect(
        client.post.update({
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
        })
      ).rejects.toThrow(
        "does not support a create arm whose relations need the whole-create delegation"
      );
      await expect(
        client.tag.findUnique({ where: { id: "t-owned" } })
      ).resolves.toBeNull();
    } finally {
      await client.$disconnect();
    }
  }, 30_000);

  test("the updateMany sibling keeps the boundary, for the engine's own reason", async () => {
    const client = await setup(new PGliteDriver());
    try {
      await client.board.create({ data: { id: "b1", name: "board" } });
      await client.boardPost.create({
        data: { id: "bp1", title: "bp", boardId: "b1" },
      });
      // One level deeper, where the update root's own CLASS V legality check does not
      // run: a set-based UPDATE has no per-row identity for a child write to reference.
      await expect(
        client.board.update({
          where: { id: "b1" },
          data: {
            posts: {
              update: {
                where: { id: "bp1" },
                data: {
                  marks: {
                    updateMany: {
                      where: {},
                      data: { notes: { create: { id: "x", body: "b" } } },
                    },
                  },
                },
              },
            },
          },
        })
      ).rejects.toThrow(
        "query-engine-v2 nested 'updateMany' on many-to-many relation 'marks' does not support nested relation writes in its data."
      );
      await expect(client.markNote.findMany({})).resolves.toEqual([]);
    } finally {
      await client.$disconnect();
    }
  }, 30_000);
});
