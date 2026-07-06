import { createClient, type VibORMClient } from "@client/client";
import { PGliteDriver } from "@drivers/pglite";
import type { BatchQuery, QueryResult } from "@drivers/types";
import { PGlite, type Transaction } from "@electric-sql/pglite";
import { NestedWriteError, UniqueConstraintError } from "@errors";
import { push } from "@migrations";
import { describe, expect, test } from "vitest";
import { nestedWriteBehaviorSchema } from "../fixtures/nested-write-behavior-schema";

/**
 * M7 gate (§11 M7, §7.3): one error surface. When a planned-mode atomic batch
 * aborts on a premise assertion, the abort-attribution ladder maps the failure
 * back to the SAME typed error live mode throws — no more per-substrate message
 * split. These FK trees are interpreted since M5/M6, so both modes reach the
 * interpreter and its guards.
 *
 * Gates:
 *  1. Orphan (set on required-FK children) — the departing-rows `notExists`
 *     guard aborts the batch; the ladder re-probes the premise and surfaces the
 *     orphan message byte-identically to live mode (was: the generic
 *     "Nested write assertion failed", the deleted supportsTransactions branch).
 *  2. Correlated update (stealing another parent's child) — the
 *     `requireAffected` exists-assert aborts; the ladder surfaces the correlated
 *     not-found message, identical to live mode.
 *  3. Write-race signal pass-through — a `UniqueConstraintError` raised by an
 *     INSERT inside the atomic unit is NOT rewrapped by the ladder (§7.3 step 1,
 *     Pin Rule 2): the retryable signal must survive so the retry wrapper
 *     classifies it.
 *  4. Fail-closed atomicity — an attributed abort leaves committed state exactly
 *     as it was, in both modes (the whole atomic unit rolled back).
 */

type BehaviorSchema = typeof nestedWriteBehaviorSchema;

/** A batch-only driver sharing one PGlite instance with its tx sibling, so both
 *  modes run head-to-head against identical committed state. */
class BatchOnlyDriver extends PGliteDriver {
  override readonly supportsTransactions = false;
  override readonly supportsBatch = true;

  protected override async executeBatch<T>(
    client: PGlite | Transaction,
    queries: BatchQuery[]
  ): Promise<QueryResult<T>[]> {
    return this.transaction(client, async (tx) => {
      const results: QueryResult<T>[] = [];
      for (const query of queries) {
        results.push(await this.executeRaw<T>(tx, query.sql, query.params));
      }
      return results;
    });
  }
}

async function setupDb(): Promise<PGlite> {
  const db = new PGlite();
  const setupClient = createClient({
    schema: nestedWriteBehaviorSchema,
    driver: new PGliteDriver({ client: db }),
  });
  await push(setupClient, { force: true });
  return db;
}

function boot<TDriver extends PGliteDriver>(
  driver: TDriver
): VibORMClient<{ schema: BehaviorSchema; driver: TDriver }> {
  return createClient({ schema: nestedWriteBehaviorSchema, driver });
}

/** Run a scenario against a fresh DB under both substrates, seeding first, and
 *  return each mode's caught error plus the post-failure state snapshot. */
async function bothModes<S>(scenario: {
  seed: (client: ReturnType<typeof boot>) => Promise<void>;
  run: (client: ReturnType<typeof boot>) => PromiseLike<unknown>;
  snapshot: (client: ReturnType<typeof boot>) => Promise<S>;
}): Promise<{
  live: { error: unknown; state: S };
  planned: { error: unknown; state: S };
}> {
  const results: { error: unknown; state: S }[] = [];
  for (const makeDriver of [
    (db: PGlite) => new PGliteDriver({ client: db }),
    (db: PGlite) => new BatchOnlyDriver({ client: db }),
  ]) {
    const db = await setupDb();
    const seedClient = boot(new PGliteDriver({ client: db }));
    await scenario.seed(seedClient);
    const client = boot(makeDriver(db));
    let error: unknown;
    try {
      await scenario.run(client);
    } catch (caught) {
      error = caught;
    }
    const state = await scenario.snapshot(client);
    await client.$disconnect();
    results.push({ error, state });
  }
  return { live: results[0]!, planned: results[1]! };
}

describe("M7 one error surface", () => {
  test(
    "set-orphan on a required FK surfaces the same typed message in both modes",
    { timeout: 30_000 },
    async () => {
      const { live, planned } = await bothModes<{
        postTitle: string | undefined;
        orphanPostId: string | undefined;
      }>({
        seed: async (client) => {
          await client.tag.create({ data: { id: "t-keep", name: "keep" } });
          await client.tag.create({ data: { id: "t-orphan", name: "orphan" } });
          await client.post.create({
            data: {
              id: "p1",
              title: "Original",
              userId: null,
              postTags: {
                create: [
                  { id: "j-keep", tag: { connect: { id: "t-keep" } } },
                  { id: "j-orphan", tag: { connect: { id: "t-orphan" } } },
                ],
              },
            },
          });
        },
        run: (client) =>
          client.post.update({
            where: { id: "p1" },
            data: {
              title: "Changed",
              postTags: { set: [{ id: "j-keep" }] },
            },
          }),
        snapshot: async (client) => {
          const [post, orphanJoin] = await Promise.all([
            client.post.findUnique({ where: { id: "p1" } }),
            client.postTag.findUnique({ where: { id: "j-orphan" } }),
          ]);
          return {
            postTitle: post?.title as string | undefined,
            orphanPostId: orphanJoin?.postId as string | undefined,
          };
        },
      });

      // Both modes throw the SAME typed NestedWriteError with the orphan message.
      expect(live.error).toBeInstanceOf(NestedWriteError);
      expect(planned.error).toBeInstanceOf(NestedWriteError);
      const message =
        "Cannot set relation 'postTags' because foreign key field(s) postId are required";
      expect((live.error as Error).message).toContain(message);
      expect((planned.error as Error).message).toBe(
        (live.error as Error).message
      );

      // Fail-closed: the atomic unit rolled back — title unchanged, join intact.
      expect(live.state).toEqual({ postTitle: "Original", orphanPostId: "p1" });
      expect(planned.state).toEqual(live.state);
    }
  );

  test(
    "correlated update of another parent's child surfaces the same typed message",
    { timeout: 30_000 },
    async () => {
      const { live, planned } = await bothModes<{
        ownerName: string | undefined;
        otherTitle: string | undefined;
        otherOwner: string | undefined;
      }>({
        seed: async (client) => {
          await client.user.create({
            data: {
              id: "owner",
              name: "Owner",
              posts: { create: { id: "p-owner", title: "Owned" } },
            },
          });
          await client.user.create({
            data: {
              id: "other",
              name: "Other",
              posts: { create: { id: "p-other", title: "Foreign" } },
            },
          });
        },
        run: (client) =>
          client.user.update({
            where: { id: "owner" },
            data: {
              name: "Renamed",
              posts: {
                update: {
                  where: { id: "p-other" },
                  data: { title: "Stolen" },
                },
              },
            },
          }),
        snapshot: async (client) => {
          const [owner, other] = await Promise.all([
            client.user.findUnique({ where: { id: "owner" } }),
            client.post.findUnique({ where: { id: "p-other" } }),
          ]);
          return {
            ownerName: owner?.name as string | undefined,
            otherTitle: other?.title as string | undefined,
            otherOwner: other?.userId as string | undefined,
          };
        },
      });

      expect(live.error).toBeInstanceOf(NestedWriteError);
      expect(planned.error).toBeInstanceOf(NestedWriteError);
      expect((live.error as Error).message).toContain(
        "Cannot update relation 'posts'"
      );
      expect((planned.error as Error).message).toBe(
        (live.error as Error).message
      );

      // Fail-closed: nothing committed in either mode.
      expect(live.state).toEqual({
        ownerName: "Owner",
        otherTitle: "Foreign",
        otherOwner: "other",
      });
      expect(planned.state).toEqual(live.state);
    }
  );

  test(
    "a unique-race constraint violation is NOT rewrapped by the ladder (pass-through)",
    { timeout: 30_000 },
    async () => {
      // A create tree whose child insert violates a UNIQUE constraint aborts the
      // atomic unit. The ladder must let the UniqueConstraintError through
      // unchanged (§7.3 step 1) so the retry wrapper can classify it — it must
      // NOT be rewrapped into a NestedWriteError/assertion error.
      const db = await setupDb();
      const seed = boot(new PGliteDriver({ client: db }));
      await seed.tag.create({ data: { id: "t-existing", name: "dup" } });
      const client = boot(new BatchOnlyDriver({ client: db }));

      let error: unknown;
      try {
        // `tag.name` is unique; creating a second tag with name "dup" inside a
        // nested-create tree violates the constraint mid-batch.
        await client.post.create({
          data: {
            id: "p-dup",
            title: "Dup",
            userId: null,
            postTags: {
              create: {
                id: "j-dup",
                tag: { create: { id: "t-new", name: "dup" } },
              },
            },
          },
        });
      } catch (caught) {
        error = caught;
      }

      expect(error).toBeInstanceOf(UniqueConstraintError);
      await client.$disconnect();
    }
  );
});
