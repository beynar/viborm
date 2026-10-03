import type { AnyDriver } from "@drivers";
import { UniqueConstraintError } from "@errors";
import { openDeletionFixture } from "@tests/contracts/engine/write/deletion-capability-behavior";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

/**
 * The races of the `deletion` and `rows` capabilities that only two real
 * connections can run (extension-capabilities plan v3.1 §2.3 DC14, v2 §4.5
 * consumer 3), over `deletion-capability-behavior.ts`'s fixture: post 14 is
 * live with no child, comment ids 300 and 301 are free.
 *
 * Each race is made deterministic by a driver that awaits `beforeStatement`
 * before sending a statement: the test arms one pattern, and when the first
 * operation reaches it, the rival runs on another pooled connection. A rival
 * that waits on a lock the paused operation holds cannot finish, so it gets
 * `RIVAL_GRACE_MS`, then the paused operation resumes and both settle.
 */

/** A statement the paused operation is about to send. */
export type BeforeStatement = (sql: string) => Promise<void>;

export interface DeletionRaceProvider {
  readonly name: string;
  /** A multi-connection driver that awaits `beforeStatement` first. */
  readonly createDriver: (beforeStatement: BeforeStatement) => AnyDriver;
}

const RIVAL_GRACE_MS = 750;
/** The tombstone UPDATE of `post`, whatever the dialect quotes. */
const POST_TOMBSTONE =
  /^\s*UPDATE\s+(?:\S+\.)?["`]?post["`]?\s+SET\s+["`]?deletedAt\b/i;
/** Any INSERT into `comment`. */
const COMMENT_INSERT = /^\s*INSERT\s+INTO\s+(?:\S+\.)?["`]?comment["`]?\s/i;

type Settled =
  | { readonly status: "fulfilled"; readonly value: unknown }
  | { readonly status: "rejected"; readonly reason: unknown };

const settle = (pending: PromiseLike<unknown>): Promise<Settled> =>
  Promise.resolve(pending).then(
    (value) => ({ status: "fulfilled", value }),
    (reason: unknown) => ({ status: "rejected", reason })
  );
const grace = () =>
  new Promise<void>((resolve) => setTimeout(resolve, RIVAL_GRACE_MS));

export function runDeletionRaceBehavior(provider: DeletionRaceProvider): void {
  describe(`${provider.name}: deletion races on two connections`, () => {
    let context: Awaited<ReturnType<typeof openDeletionFixture>>;
    let armed: { pattern: RegExp; rival: () => Promise<Settled> } | undefined;
    let rival: Promise<Settled> | undefined;
    /** The rival was still pending when the paused operation resumed. */
    let rivalWaited: boolean | undefined;

    beforeEach(async () => {
      armed = undefined;
      rival = undefined;
      rivalWaited = undefined;
      context = await openDeletionFixture(
        provider.createDriver(async (sql) => {
          const pending = armed;
          if (pending === undefined || !pending.pattern.test(sql)) return;
          armed = undefined;
          let settled = false;
          rival = pending.rival().then((outcome) => {
            settled = true;
            return outcome;
          });
          await Promise.race([rival, grace()]);
          rivalWaited = !settled;
        })
      );
    });
    afterEach(async () => {
      await context.base.$disconnect();
    });

    /** Arms the race, runs `first`, and settles both sides. */
    async function race(
      pattern: RegExp,
      first: () => PromiseLike<unknown>,
      second: () => PromiseLike<unknown>
    ) {
      armed = { pattern, rival: () => settle(second()) };
      const firstSettled = await settle(first());
      if (rival === undefined)
        throw new Error(`the first operation never reached ${pattern}`);
      return { first: firstSettled, second: await rival };
    }

    /** Post 14's marker and the live comments that reference it. */
    async function postAndChildren() {
      const { base } = context;
      const post = await base.post.findUniqueOrThrow({ where: { id: 14 } });
      const children = await base.comment.findMany({
        where: { postId: 14, deletedAt: null },
        select: { id: true },
      });
      return { tombstoned: post.deletedAt !== null, children };
    }

    // DC14: the requirement read and the tombstone UPDATE are two statements.
    // A create that connects the post between them must not leave a live
    // child under a tombstone, a state neither serial order produces: after
    // the delete, `connect` refuses the tombstone; before it, the child
    // refuses the delete.
    test("a create connecting the post while its soft delete is between the requirement and the tombstone: the delete wins, the create is refused", async () => {
      const { db } = context;
      const outcome = await race(
        POST_TOMBSTONE,
        () => db.post.delete({ where: { id: 14 }, select: { id: true } }),
        () =>
          db.comment.create({
            data: { id: 300, body: "raced", post: { connect: { id: 14 } } },
          })
      );
      expect(outcome.first).toEqual({
        status: "fulfilled",
        value: { id: 14 },
      });
      // The create's connect waited for the tombstone, then found no live
      // target: the refusal a connect to a tombstone gets serially.
      expect(outcome.second).toMatchObject({
        status: "rejected",
        reason: {
          name: "NestedWriteError",
          message:
            "Cannot connect relation 'post': target record was not found.",
        },
      });
      expect(await postAndChildren()).toEqual({
        tombstoned: true,
        children: [],
      });
    });

    test("a soft delete while a create connecting the post is between its target check and its INSERT: the create wins, the delete is refused", async () => {
      const { db } = context;
      const outcome = await race(
        COMMENT_INSERT,
        () =>
          db.comment.create({
            data: { id: 300, body: "first", post: { connect: { id: 14 } } },
            select: { id: true },
          }),
        () => db.post.delete({ where: { id: 14 } })
      );
      expect(outcome.first).toEqual({
        status: "fulfilled",
        value: { id: 300 },
      });
      expect(outcome.second).toMatchObject({
        status: "rejected",
        reason: { name: "ForeignKeyError" },
      });
      expect(await postAndChildren()).toEqual({
        tombstoned: false,
        children: [{ id: 300 }],
      });
    });

    // The same race through a nested set-oriented deleteMany, whose candidates
    // no earlier locate holds (a nested `delete` locks its target first).
    test("a create connecting the post while a nested deleteMany is between the requirement and the tombstone: the delete wins, the create is refused", async () => {
      const { db } = context;
      const outcome = await race(
        POST_TOMBSTONE,
        () =>
          db.author.update({
            where: { id: 1 },
            data: { posts: { deleteMany: { id: 14 } } },
            select: { id: true },
          }),
        () =>
          db.comment.create({
            data: { id: 300, body: "raced", post: { connect: { id: 14 } } },
          })
      );
      expect(outcome.first).toEqual({ status: "fulfilled", value: { id: 1 } });
      expect(outcome.second).toMatchObject({
        status: "rejected",
        reason: { name: "NestedWriteError" },
      });
      expect(await postAndChildren()).toEqual({
        tombstoned: true,
        children: [],
      });
    });

    // A limited deleteMany locks its window and no other candidate: a rival
    // reaching a row inside it waits for the tombstone, one reaching a
    // candidate outside it does not wait at all.
    test("a create connecting a post inside a limited deleteMany's window, between the requirement and the tombstone: the delete wins, the create is refused", async () => {
      const { db } = context;
      const outcome = await race(
        POST_TOMBSTONE,
        () => db.post.deleteMany({ where: { id: { in: [14, 16] } }, limit: 1 }),
        () =>
          db.comment.create({
            data: { id: 300, body: "raced", post: { connect: { id: 14 } } },
          })
      );
      expect(outcome.first).toEqual({
        status: "fulfilled",
        value: { count: 1 },
      });
      expect(rivalWaited).toBe(true);
      expect(outcome.second).toMatchObject({
        status: "rejected",
        reason: { name: "NestedWriteError" },
      });
      expect(await postAndChildren()).toEqual({
        tombstoned: true,
        children: [],
      });
    });

    test("a create connecting a candidate outside a limited deleteMany's window does not wait for it: both succeed", async () => {
      const { base, db } = context;
      const outcome = await race(
        POST_TOMBSTONE,
        () => db.post.deleteMany({ where: { id: { in: [11, 14] } }, limit: 1 }),
        () =>
          db.comment.create({
            data: { id: 300, body: "outside", post: { connect: { id: 14 } } },
            select: { id: true },
          })
      );
      expect(outcome).toEqual({
        first: { status: "fulfilled", value: { count: 1 } },
        second: { status: "fulfilled", value: { id: 300 } },
      });
      expect(rivalWaited).toBe(false);
      expect(await postAndChildren()).toEqual({
        tombstoned: false,
        children: [{ id: 300 }],
      });
      expect(
        (await base.post.findUniqueOrThrow({ where: { id: 11 } })).deletedAt
      ).not.toBeNull();
    });

    // v2 §4.5 consumer 3: the conjunction keeps the unique key, so an upsert
    // under the call's domain that loses its INSERT to a live row converges
    // on that row, as without a domain; a tombstone in the way is a hidden
    // conflict and surfaces the database's own UniqueConstraintError.
    test("an upsert that loses its INSERT to a live row converges on it", async () => {
      const { base, db } = context;
      const outcome = await race(
        COMMENT_INSERT,
        () =>
          db.comment.upsert({
            where: { id: 301 },
            create: { id: 301, body: "mine", postId: 10 },
            update: { body: "updated" },
            select: { id: true, body: true },
          }),
        () =>
          base.comment.create({ data: { id: 301, body: "theirs", postId: 11 } })
      );
      expect(outcome).toEqual({
        first: { status: "fulfilled", value: { id: 301, body: "updated" } },
        second: { status: "fulfilled", value: expect.anything() },
      });
      expect(await base.comment.findMany({ where: { id: 301 } })).toEqual([
        { id: 301, body: "updated", postId: 11, deletedAt: null },
      ]);
    });

    test("an upsert that loses its INSERT to a tombstone surfaces the hidden conflict", async () => {
      const { base, db } = context;
      const at = new Date("2026-02-01T00:00:00.000Z");
      const outcome = await race(
        COMMENT_INSERT,
        () =>
          db.comment.upsert({
            where: { id: 301 },
            create: { id: 301, body: "mine", postId: 10 },
            update: { body: "updated" },
          }),
        () =>
          base.comment.create({
            data: { id: 301, body: "theirs", postId: 11, deletedAt: at },
          })
      );
      expect(outcome.first.status).toBe("rejected");
      expect(
        outcome.first.status === "rejected" && outcome.first.reason
      ).toBeInstanceOf(UniqueConstraintError);
      expect(await base.comment.findMany({ where: { id: 301 } })).toEqual([
        { id: 301, body: "theirs", postId: 11, deletedAt: at },
      ]);
    });
  });
}
