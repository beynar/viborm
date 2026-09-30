import { createClient } from "@client/client";
import type { AnyDriver } from "@drivers";
import { ForeignKeyError, NestedWriteError, NotFoundError } from "@errors";
import { s } from "@schema";
import { instrumentation } from "@src/instrumentation/exports";
import { failure } from "@tests/fixtures/failure";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import { v } from "@validation";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

/**
 * The `deletion` capability on a real database (extension-capabilities plan
 * v3.1 §2.3, Appendix deletion sites), through public entry points only.
 *
 * Where core deletes a row of a model the chain manages — root `delete` and
 * `deleteMany`, nested `delete` and `deleteMany`, the members a series
 * captures — it writes the declaration's tombstone instead: the call's one
 * instant in `at`, the constant `assign`, admitted as update data (so
 * `updatedAt` is refreshed and a custom transform runs once per occurrence).
 * A soft delete takes only rows of the model's default domain, keeps every
 * link, fires no cascade, and is refused while a live row still references
 * the candidate through a restricting foreign key — the parent's own link
 * excepted for a nested delete. `mode: "hard"` (`removeWhen`) is today's
 * physical delete over the call's domain.
 *
 * Fixture (hand-computed oracles below): `author` <- `post.author` (required
 * FK, default RESTRICT); `post` <- `comment.post` (RESTRICT), `note.post`
 * (optional, RESTRICT), `vote.post` (CASCADE), `pin.post` (optional, default
 * SET NULL), and the `post`/`tag` junction whose post-side key RESTRICTs.
 * `author`, `post` and `comment` are managed. Rows: authors 1-3; posts 10, 11,
 * 14 (author 1), 12 (tombstone), 13 (author 2), 15, 16 (author 3); comments
 * 100 (post 10), 101 and 102 (tombstones, posts 10 and 12); tag 1 links post
 * 13; vote 1 and pin 1 on post 11; notes 1 (post 15), 2 and 4 (post 16), 3
 * (none).
 */

const T = new Date("2026-01-01T00:00:00.000Z");
const DELETE_STATEMENT = /^\s*DELETE\b/i;
const UPDATE_STATEMENT = /^\s*UPDATE\b/i;
/** An UPDATE whose SET starts with the marker: a tombstone write. */
const TOMBSTONE_WRITE = /^\s*UPDATE\s+\S+\s+SET\s+["`]?deletedAt\b/i;
const ACTOR = "actor-1";

function deletionSchema(ledger: string[]) {
  const author = s.model({
    id: s.int().id(),
    name: s.string(),
    deletedAt: s.dateTime().nullable(),
    posts: s.toMany(() => post),
  });
  const post = s.model({
    id: s.int().id(),
    title: s.string(),
    authorId: s.int(),
    author: s
      .toOne(() => author)
      .fields("authorId")
      .references("id"),
    deletedAt: s.dateTime().nullable(),
    // Every admission of the actor runs this transform once: the ledger.
    deletedById: s
      .string()
      .schema(
        v.string({
          transform(input) {
            ledger.push(input);
            return input;
          },
        })
      )
      .nullable(),
    updatedAt: s.dateTime().updatedAt(),
    comments: s.toMany(() => comment),
    tags: s
      .toMany(() => tag)
      .onDelete({ source: "restrict", target: "cascade" }),
    votes: s.toMany(() => vote),
    notes: s.toMany(() => note),
    pins: s.toMany(() => pin),
  });
  const comment = s.model({
    id: s.int().id(),
    body: s.string(),
    postId: s.int(),
    post: s
      .toOne(() => post)
      .fields("postId")
      .references("id")
      .onDelete("restrict"),
    deletedAt: s.dateTime().nullable(),
  });
  const tag = s.model({
    id: s.int().id(),
    name: s.string(),
    posts: s.toMany(() => post),
  });
  const vote = s.model({
    id: s.int().id(),
    postId: s.int(),
    post: s
      .toOne(() => post)
      .fields("postId")
      .references("id")
      .onDelete("cascade"),
  });
  const note = s.model({
    id: s.int().id(),
    postId: s.int().nullable(),
    post: s
      .toOne(() => post)
      .fields("postId")
      .references("id")
      .onDelete("restrict"),
  });
  const pin = s.model({
    id: s.int().id(),
    postId: s.int().nullable(),
    post: s
      .toOne(() => post)
      .fields("postId")
      .references("id"),
  });
  return { author, post, comment, tag, vote, note, pin };
}

const modes = {
  without: { root: { deletedAt: null }, related: { deletedAt: null } },
  with: {},
  only: { root: { deletedAt: { not: null } }, related: { deletedAt: null } },
} as const;

/** §1.1's step A, over the three managed models. */
const softDelete = {
  name: "test.softDelete",
  controls: { mode: { oneOf: ["soft", "hard"] } },
  rows: {
    control: "deleted",
    default: "without",
    models: { author: modes, post: modes, comment: modes },
  },
  deletion: {
    removeWhen: { mode: "hard" },
    models: {
      author: { at: "deletedAt" },
      post: { at: "deletedAt", assign: { deletedById: ACTOR } },
      comment: { at: "deletedAt" },
    },
  },
} as const;

/** One statement a transform saw: the SQL and the attribution it ran under. */
export interface SeenStatement {
  readonly model: string | undefined;
  readonly operation: string;
  readonly sql: string;
  readonly values: readonly unknown[];
}

/**
 * The seeded database and its soft-delete client, behind a statement log:
 * `ledger` holds every admission of the actor, `statements` every statement.
 */
export async function openDeletionFixture(driver: AnyDriver) {
  const ledger: string[] = [];
  const statements: SeenStatement[] = [];
  const base = createClient({ schema: deletionSchema(ledger), driver });
  await syncLiveSchema(base);
  for (const id of [1, 2, 3])
    await base.author.create({ data: { id, name: `a${id}` } });
  for (const [id, authorId, deletedAt] of [
    [10, 1, null],
    [11, 1, null],
    [12, 2, T],
    [13, 2, null],
    [14, 1, null],
    [15, 3, null],
    [16, 3, null],
  ] as const)
    await base.post.create({
      data: { id, authorId, title: `p${id}`, deletedAt },
    });
  for (const [id, postId, deletedAt] of [
    [100, 10, null],
    [101, 10, T],
    [102, 12, T],
  ] as const)
    await base.comment.create({
      data: { id, postId, body: `c${id}`, deletedAt },
    });
  await base.tag.create({
    data: { id: 1, name: "t1", posts: { connect: [{ id: 13 }] } },
  });
  await base.tag.create({ data: { id: 2, name: "t2" } });
  await base.vote.create({ data: { id: 1, postId: 11 } });
  await base.pin.create({ data: { id: 1, postId: 11 } });
  for (const [id, postId] of [
    [1, 15],
    [2, 16],
    [3, null],
    [4, 16],
  ] as const)
    await base.note.create({ data: { id, postId } });
  const db = base
    .$extends({
      name: "test.statements",
      statement: (statement) => {
        statements.push({
          model: statement.model,
          operation: statement.operation,
          sql: statement.statement.toStatement("?"),
          values: statement.statement.values,
        });
        return statement.statement;
      },
    })
    .$extends(softDelete);
  ledger.length = 0;
  return { base, db, ledger, statements };
}

export interface DeletionCapabilityProvider {
  readonly name: string;
  readonly createDriver: () => AnyDriver;
}

export function runDeletionCapabilityBehavior(
  provider: DeletionCapabilityProvider
): void {
  describe(`${provider.name}: the deletion capability`, () => {
    let context: Awaited<ReturnType<typeof openDeletionFixture>>;
    let ledger: string[];
    let statements: SeenStatement[];

    beforeEach(async () => {
      context = await openDeletionFixture(provider.createDriver());
      ({ ledger, statements } = context);
    });
    afterEach(async () => {
      await context.base.$disconnect();
    });

    const pause = () => new Promise((resolve) => setTimeout(resolve, 5));
    const physicalDeletes = () =>
      statements.filter((statement) => DELETE_STATEMENT.test(statement.sql));

    test("a root delete tombstones the row and returns its post-image; a repeat is NotFound", async () => {
      const { base, db } = context;
      const before = await base.post.findUniqueOrThrow({ where: { id: 11 } });
      await pause();
      const deleted = await db.post.delete({ where: { id: 11 } });
      expect(deleted).toMatchObject({
        id: 11,
        title: "p11",
        deletedById: ACTOR,
      });
      expect(deleted.deletedAt).toBeInstanceOf(Date);
      // `updatedAt` is admitted as update data: refreshed, its own sample.
      expect(deleted.updatedAt.getTime()).toBeGreaterThan(
        before.updatedAt.getTime()
      );
      // Nothing is removed and nothing cascades: the vote and the pin stay.
      expect(await base.post.findUnique({ where: { id: 11 } })).toMatchObject({
        id: 11,
        deletedById: ACTOR,
      });
      expect(await base.vote.findMany()).toEqual([{ id: 1, postId: 11 }]);
      expect(await base.pin.findMany()).toEqual([{ id: 1, postId: 11 }]);
      expect(physicalDeletes()).toEqual([]);
      // The UPDATE runs under the caller's attribution: a delete.
      expect(
        statements.filter((statement) => UPDATE_STATEMENT.test(statement.sql))
      ).toEqual([
        expect.objectContaining({ model: "post", operation: "delete" }),
      ]);
      // One admission of the actor per occurrence.
      expect(ledger).toEqual([ACTOR]);
      const repeat = await failure(db.post.delete({ where: { id: 11 } }));
      expect(repeat).toBeInstanceOf(NotFoundError);
      expect((repeat as NotFoundError).meta).toMatchObject({
        model: "post",
        operation: "delete",
      });
      // A soft delete takes the default domain whatever `deleted` says.
      expect(
        await failure(db.post.delete({ where: { id: 12 }, deleted: "with" }))
      ).toBeInstanceOf(NotFoundError);
      expect(physicalDeletes()).toEqual([]);
    });

    test("a root delete with a relation projection takes the record route and publishes the post-image", async () => {
      const { db } = context;
      const deleted = await db.post.delete({
        where: { id: 14 },
        select: {
          id: true,
          deletedById: true,
          author: { select: { id: true } },
        },
      });
      expect(deleted).toEqual({
        id: 14,
        deletedById: ACTOR,
        author: { id: 1 },
      });
      expect(physicalDeletes()).toEqual([]);
    });

    test("a root delete including to-many relations keeps the row and publishes them; a repeat is NotFound", async () => {
      const { base, db } = context;
      // Post 11 has vote 1 and no comment; its author is 1.
      const deleted = await db.post.delete({
        where: { id: 11 },
        include: { votes: true, author: true, comments: true },
      });
      expect(deleted).toMatchObject({
        id: 11,
        title: "p11",
        deletedById: ACTOR,
        votes: [{ id: 1, postId: 11 }],
        author: { id: 1, name: "a1" },
        comments: [],
      });
      expect(deleted.deletedAt).toBeInstanceOf(Date);
      expect(
        (await base.post.findUniqueOrThrow({ where: { id: 11 } })).deletedAt
      ).toEqual(deleted.deletedAt);
      expect(await base.vote.findMany()).toEqual([{ id: 1, postId: 11 }]);
      expect(physicalDeletes()).toEqual([]);
      expect(
        await failure(
          db.post.delete({ where: { id: 11 }, include: { votes: true } })
        )
      ).toBeInstanceOf(NotFoundError);
    });

    test("a root delete with a relation projection over a restricted candidate is refused and leaves the row live", async () => {
      const { base, db } = context;
      // Post 10 has the live comment 100.
      expect(
        await failure(
          db.post.delete({ where: { id: 10 }, include: { comments: true } })
        )
      ).toBeInstanceOf(ForeignKeyError);
      expect(
        await base.post.findUniqueOrThrow({
          where: { id: 10 },
          select: { deletedAt: true, deletedById: true },
        })
      ).toEqual({ deletedAt: null, deletedById: null });
    });

    test("a root deleteMany counts the live rows it tombstones, then none", async () => {
      const { base, db } = context;
      // 11 and 14 are live and unreferenced; 12 is already a tombstone.
      expect(
        await db.post.deleteMany({ where: { id: { in: [11, 12, 14] } } })
      ).toEqual({ count: 2 });
      expect(
        await db.post.deleteMany({ where: { id: { in: [11, 12, 14] } } })
      ).toEqual({ count: 0 });
      const rows = await base.post.findMany({
        where: { id: { in: [11, 12, 14] } },
        orderBy: { id: "asc" },
      });
      expect(rows.map((row) => row.deletedById)).toEqual([ACTOR, null, ACTOR]);
      // The tombstone written first keeps its own instant.
      expect(rows[1]!.deletedAt).toEqual(T);
      expect(rows[0]!.deletedAt).toEqual(rows[2]!.deletedAt);
      expect(physicalDeletes()).toEqual([]);
      expect(
        await db.post.deleteMany({
          where: { id: 12 },
          deleted: "only",
          select: { id: true },
        })
      ).toEqual([]);
    });

    test("mode: 'hard' deletes physically over the call's domain: without `deleted: \"only\"` it keeps the tombstones", async () => {
      const { base, db } = context;
      // The purge hazard, documented: the live default applies, so this
      // deletes the live 11 and keeps the tombstone 12.
      expect(
        await db.post.deleteMany({
          where: { id: { in: [11, 12] } },
          mode: "hard",
        })
      ).toEqual({ count: 1 });
      expect(
        (await base.post.findMany({ orderBy: { id: "asc" } })).map(
          (row) => row.id
        )
      ).toEqual([10, 12, 13, 14, 15, 16]);
      // The database's own referential actions run: 11's vote cascaded, its
      // pin was set null.
      expect(await base.vote.findMany()).toEqual([]);
      expect(await base.pin.findMany()).toEqual([{ id: 1, postId: null }]);
      // A purge says `deleted: "only"`, and the database still refuses one
      // whose tombstoned child restricts it: purge the children first.
      const purge = () =>
        db.post.delete({
          where: { id: 12 },
          deleted: "only",
          mode: "hard",
          select: { id: true },
        });
      expect(await failure(purge())).toBeInstanceOf(ForeignKeyError);
      expect(
        await db.comment.deleteMany({ deleted: "only", mode: "hard" })
      ).toEqual({ count: 2 });
      expect(await purge()).toEqual({ id: 12 });
      expect((await base.comment.findMany()).map((row) => row.id)).toEqual([
        100,
      ]);
    });

    test("a live child through a restricting key refuses the soft delete; a tombstoned one does not", async () => {
      const { base, db } = context;
      const refused = await failure(db.post.delete({ where: { id: 10 } }));
      expect(refused).toBeInstanceOf(ForeignKeyError);
      // Core's message (plan §2.3): the delete refused, naming the relation
      // live comment 100 references it through.
      const { message } = refused as ForeignKeyError;
      expect(message).toContain("Cannot delete 'post' record");
      expect(message).toContain("'comments'");
      // The refusal carries the context's attribution, as the database's does.
      expect((refused as ForeignKeyError).meta).toMatchObject({
        model: "post",
        operation: "delete",
      });
      // One blocked row fails the whole bulk call; nothing is tombstoned.
      const bulk = await failure(
        db.post.deleteMany({ where: { id: { in: [10, 11] } } })
      );
      expect(bulk).toBeInstanceOf(ForeignKeyError);
      expect((bulk as ForeignKeyError).meta).toMatchObject({
        model: "post",
        operation: "deleteMany",
      });
      expect(
        (await base.post.findMany({ where: { deletedAt: { not: null } } })).map(
          (row) => row.id
        )
      ).toEqual([12]);
      // The junction key restricts too: post 13 is linked to tag 1.
      expect(
        await failure(db.post.delete({ where: { id: 13 } }))
      ).toBeInstanceOf(ForeignKeyError);
      // Author 2's live post 13 blocks it; its tombstone 12 would not.
      expect(
        await failure(db.author.delete({ where: { id: 2 } }))
      ).toBeInstanceOf(ForeignKeyError);
      // Tombstone the live comment 100 (101 is one already): 10 is free.
      await db.comment.delete({ where: { id: 100 } });
      expect(
        await db.post.delete({ where: { id: 10 }, select: { id: true } })
      ).toEqual({ id: 10 });
      expect(physicalDeletes()).toEqual([]);
    });

    test("the requirement reads the child's default domain whatever the call's `deleted` says", async () => {
      const { db } = context;
      // Tombstone the live comment 100; 101 is one already. The call sees
      // both under `deleted: "with"`; the requirement sees neither.
      await db.comment.delete({ where: { id: 100 } });
      expect(
        await db.post.delete({
          where: { id: 10 },
          deleted: "with",
          select: { id: true, deletedById: true },
        })
      ).toEqual({ id: 10, deletedById: ACTOR });
      expect(physicalDeletes()).toEqual([]);
    });

    test("a nested delete tombstones the target and keeps its link", async () => {
      const { base, db } = context;
      await db.post.update({
        where: { id: 10 },
        data: { comments: { delete: { id: 100 } } },
      });
      expect(
        await base.comment.findUniqueOrThrow({ where: { id: 100 } })
      ).toMatchObject({ postId: 10, deletedAt: expect.any(Date) });
      // A tombstone is outside the default domain: deleting it again is the
      // nested missing-target refusal.
      expect(
        await failure(
          db.post.update({
            where: { id: 10 },
            data: { comments: { delete: { id: 101 } } },
          })
        )
      ).toBeInstanceOf(NestedWriteError);
      // A lax `delete: true` over a to-one the parent holds the key of: post
      // 15 is tombstoned and note 1 keeps its key, the very link that would
      // otherwise restrict the delete.
      await db.note.update({
        where: { id: 1 },
        data: { post: { delete: true } },
      });
      expect(
        await base.post.findUniqueOrThrow({ where: { id: 15 } })
      ).toMatchObject({ deletedById: ACTOR, deletedAt: expect.any(Date) });
      expect(await base.note.findUniqueOrThrow({ where: { id: 1 } })).toEqual({
        id: 1,
        postId: 15,
      });
      // Over an empty slot it stays a no-op.
      ledger.length = 0;
      await db.note.update({
        where: { id: 3 },
        data: { post: { delete: true } },
      });
      expect(ledger).toEqual([ACTOR]);
      expect(
        (await base.post.findMany({ where: { deletedAt: { not: null } } })).map(
          (row) => row.id
        )
      ).toEqual([12, 15]);
      expect(physicalDeletes()).toEqual([]);
    });

    test("a nested delete through a restricting slot is refused, the parent's own link excepted", async () => {
      const { base, db } = context;
      // Note 4 still references post 16 besides note 2 itself: refused, under
      // the attribution a physical nested DELETE's refusal carries.
      const refused = await failure(
        db.note.update({
          where: { id: 2 },
          data: { post: { delete: true } },
        })
      );
      expect(refused).toBeInstanceOf(ForeignKeyError);
      expect((refused as ForeignKeyError).meta).toMatchObject({
        model: "post",
        operation: "update",
      });
      // Post 10 has the live comment 100.
      expect(
        await failure(
          db.author.update({
            where: { id: 1 },
            data: { posts: { delete: { id: 10 } } },
          })
        )
      ).toBeInstanceOf(ForeignKeyError);
      // Post 13's only junction link is tag 1's own: tag 1 keeps it and the
      // post is tombstoned (a hard delete would have removed the link first).
      await db.tag.update({
        where: { id: 1 },
        data: { posts: { delete: { id: 13 } } },
      });
      expect(
        await base.post.findUniqueOrThrow({
          where: { id: 13 },
          include: { tags: true },
        })
      ).toMatchObject({
        deletedById: ACTOR,
        tags: [{ id: 1, name: "t1" }],
      });
      // A second link from another tag blocks it.
      await base.post.update({
        where: { id: 11 },
        data: { tags: { connect: [{ id: 1 }, { id: 2 }] } },
      });
      expect(
        await failure(
          db.tag.update({
            where: { id: 1 },
            data: { posts: { delete: { id: 11 } } },
          })
        )
      ).toBeInstanceOf(ForeignKeyError);
    });

    test("a nested deleteMany tombstones the parent's live members at one instant, set-oriented and through a captured series", async () => {
      const { base, db } = context;
      // Author 1's live posts 11 and 14 are free; 10 has the live comment 100.
      await db.comment.delete({ where: { id: 100 } });
      await pause();
      await db.author.update({
        where: { id: 1 },
        data: { posts: { deleteMany: {} } },
      });
      const posts = await base.post.findMany({
        where: { authorId: 1 },
        orderBy: { id: "asc" },
      });
      expect(posts.map((row) => row.deletedById)).toEqual([
        ACTOR,
        ACTOR,
        ACTOR,
      ]);
      const [first, ...rest] = posts.map((row) => row.deletedAt!.getTime());
      for (const instant of rest) expect(instant).toBe(first);
      // The comment deleted by the earlier call has its own instant.
      const comment = await base.comment.findUniqueOrThrow({
        where: { id: 100 },
      });
      expect(comment.deletedAt!.getTime()).not.toBe(first);
      // A junction deleteMany captures its members and writes each one's
      // tombstone, re-admitted per member from the same instant; links kept.
      await base.post.update({
        where: { id: 13 },
        data: { tags: { disconnect: [{ id: 1 }] } },
      });
      await base.post.create({
        data: {
          id: 17,
          title: "p17",
          authorId: 2,
          tags: { connect: [{ id: 2 }] },
        },
      });
      await base.post.create({
        data: {
          id: 18,
          title: "p18",
          authorId: 2,
          tags: { connect: [{ id: 2 }] },
        },
      });
      ledger.length = 0;
      await db.tag.update({
        where: { id: 2 },
        data: { posts: { deleteMany: {} } },
      });
      const series = await base.post.findMany({
        where: { id: { in: [17, 18] } },
        orderBy: { id: "asc" },
        include: { tags: true },
      });
      expect(series.map((row) => row.tags.map((tag) => tag.id))).toEqual([
        [2],
        [2],
      ]);
      expect(series[0]!.deletedAt!.getTime()).toBe(
        series[1]!.deletedAt!.getTime()
      );
      // Once per occurrence per attempt (plan §2.3, whose delete sites are
      // the nested deleteMany and each captured series member): three.
      expect(ledger).toEqual([ACTOR, ACTOR, ACTOR]);
      expect(physicalDeletes()).toEqual([]);
    });

    test("one call shares one instant across its nested occurrences; separate calls in one transaction do not", async () => {
      const { base, db } = context;
      await db.post.update({
        where: { id: 10 },
        data: {
          comments: { delete: { id: 100 } },
          author: { update: { posts: { deleteMany: { id: 14 } } } },
        },
      });
      const comment = await base.comment.findUniqueOrThrow({
        where: { id: 100 },
      });
      const post = await base.post.findUniqueOrThrow({ where: { id: 14 } });
      expect(comment.deletedAt!.getTime()).toBe(post.deletedAt!.getTime());
      // A batch-only substrate has no callback transaction to hold two calls.
      if (!base.$driver.supportsTransactions) return;
      await db.$transaction(async (tx) => {
        await tx.post.delete({ where: { id: 11 } });
        await pause();
        await tx.post.delete({ where: { id: 10 } });
      });
      const [ten, eleven] = await base.post.findMany({
        where: { id: { in: [10, 11] } },
        orderBy: { id: "asc" },
      });
      expect(ten!.deletedAt!.getTime()).not.toBe(eleven!.deletedAt!.getTime());
    });

    test("an array transaction carries soft deletes atomically; a restricted member rolls every member back", async () => {
      const { base, db } = context;
      expect(
        await db.$transaction([
          db.post.delete({
            where: { id: 11 },
            select: { id: true, deletedById: true },
          }),
          db.post.deleteMany({ where: { id: 14 } }),
          db.comment.delete({ where: { id: 100 }, select: { id: true } }),
        ])
      ).toEqual([{ id: 11, deletedById: ACTOR }, { count: 1 }, { id: 100 }]);
      // Post 10's comments are tombstones now; post 13 is linked to tag 1.
      const refused = await failure(
        db.$transaction([
          db.post.delete({ where: { id: 10 }, select: { id: true } }),
          db.post.deleteMany({ where: { id: { in: [13] } } }),
        ])
      );
      expect(refused).toBeInstanceOf(ForeignKeyError);
      expect((refused as ForeignKeyError).meta).toMatchObject({
        model: "post",
        operation: "deleteMany",
      });
      expect(
        (await base.post.findMany({ where: { deletedAt: { not: null } } }))
          .map((row) => row.id)
          .sort((left, right) => left - right)
      ).toEqual([11, 12, 14]);
      expect(physicalDeletes()).toEqual([]);
    });

    test("set over a required foreign key keeps today's refusal, and removes no target row", async () => {
      const { base, db } = context;
      const refused = await failure(
        db.author.update({
          where: { id: 2 },
          data: { posts: { set: [] } },
        })
      );
      expect(refused).toBeInstanceOf(NestedWriteError);
      expect((refused as Error).message).toContain("Delete them instead");
      expect(
        (await base.post.findMany({ where: { authorId: 2 } })).length
      ).toBe(2);
    });

    test("observers see a delete: its hook proceeds once, no update hook runs, and each tombstone UPDATE carries the attribution its DELETE would", async () => {
      const { base } = context;
      const hooks: string[] = [];
      const transformed: string[] = [];
      const logged: string[] = [];
      const observed = base
        .$extends({
          name: "test.tombstoneStatements",
          statement: ({ statement, model, operation }) => {
            if (TOMBSTONE_WRITE.test(statement.toStatement("?")))
              transformed.push(`${model}.${operation}`);
            return statement;
          },
        })
        .$extends(
          instrumentation({
            logging: {
              query: (event) => {
                if (TOMBSTONE_WRITE.test(event.sql ?? ""))
                  logged.push(`${event.model}.${event.operation}`);
              },
              includeSql: true,
            },
          })
        )
        .$extends(softDelete)
        .$extends({
          name: "test.hooks",
          query: {
            post: {
              async delete({ input, proceed }) {
                hooks.push(`post.delete ${JSON.stringify(input)}`);
                const result = await proceed();
                const { deletedById } = result as { deletedById: unknown };
                hooks.push(`post.delete -> ${deletedById}`);
                return result;
              },
              async deleteMany({ proceed }) {
                hooks.push("post.deleteMany");
                return proceed();
              },
              async update({ proceed }) {
                hooks.push("post.update");
                return proceed();
              },
              async updateMany({ proceed }) {
                hooks.push("post.updateMany");
                return proceed();
              },
            },
            comment: {
              async delete({ proceed }) {
                hooks.push("comment.delete");
                return proceed();
              },
              async update({ proceed }) {
                hooks.push("comment.update");
                return proceed();
              },
            },
            tag: {
              async update({ proceed }) {
                hooks.push("tag.update");
                return proceed();
              },
            },
          },
        });
      await observed.post.delete({ where: { id: 11 } });
      await observed.post.deleteMany({ where: { id: 14 } });
      // Nested: the root's hook alone; the UPDATE of the managed target
      // carries the caller's attribution, as the physical nested DELETE does.
      await observed.post.update({
        where: { id: 10 },
        data: { comments: { delete: { id: 100 } } },
      });
      // Captured: post 13's only link is tag 1's own.
      await observed.tag.update({
        where: { id: 1 },
        data: { posts: { deleteMany: {} } },
      });
      expect(hooks).toEqual([
        'post.delete {"where":{"id":11}}',
        `post.delete -> ${ACTOR}`,
        "post.deleteMany",
        "post.update",
        "tag.update",
      ]);
      const attributions = [
        "post.delete",
        "post.deleteMany",
        "comment.update",
        "post.update",
      ];
      expect(transformed).toEqual(attributions);
      // Instrumentation logs a statement as it runs; a batch-only substrate
      // runs a whole unit as one batch, logged once under its root.
      if (base.$driver.supportsTransactions)
        expect(logged).toEqual(attributions);
    });
  });
}
