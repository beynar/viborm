import { defineContract } from "@tests/contracts/contract";
import {
  createClient,
  type VibORMClient,
  type VibORMConfig,
} from "@client/client";
import type { AnyDriver } from "@drivers";
import { UniqueConstraintError } from "@errors";
import { push } from "@migrations";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { upsertAtomicitySchema as schema } from "@tests/fixtures/upsert-atomicity-schema";

/**
 * M8 concurrent suite (§11 M8, §7.4, D7). The write-race retry is unified above
 * `selectMode`, so every configured substrate converges after losing a
 * missing-key create-branch race. This needs two real connections — PGlite is
 * single-connection — so it lives with the Docker-gated driver tests.
 *
 * A caller wires driver factories over the SAME database:
 *  - `createTxDriver`   — the interactive-transaction substrate (LiveMode).
 *  - optional `createBatchDriver` — a batch-forced sibling of the same driver
 *    (`supportsTransactions:false`, `supportsBatch:true`) that runs the planned
 *    plan as one real atomic batch (PlannedMode). This is the ONLY way to
 *    exercise the planned path against a real racing database, since every real
 *    driver here also supports transactions and would otherwise take LiveMode.
 *
 * Gates:
 *  1. Concurrent top-level upsert of a missing unique key converges to exactly
 *     one committed row in every configured mode (the loser takes the update
 *     branch, never a second insert, never a surfaced constraint error).
 *  2. Concurrent nested connectOrCreate of a missing key converges to exactly
 *     one committed row in every configured mode.
 *  3. When the planned path is configured, the loser's PRE-RETRY error is a
 *     `UniqueConstraintError` (Pin Rule 2: no `notExists` pin precedes the
 *     create INSERT, so the DB constraint is the enforcer and its violation is
 *     the already-retryable signal) — NOT a rewrapped assertion abort.
 */

type ConcurrencyClientConfig = VibORMConfig & {
  schema: typeof schema;
  driver: AnyDriver;
};

type ConcurrencyClient = VibORMClient<ConcurrencyClientConfig>;

export interface NestedWriteConcurrencyBehaviorOptions {
  driverName: string;
  /** The interactive-transaction substrate (LiveMode). */
  createTxDriver: () => AnyDriver;
  /** A batch-forced sibling of the same driver (PlannedMode), racing the same
   *  database over a real connection. */
  createBatchDriver?: () => AnyDriver;
  /** A batch-forced driver that, before running its FIRST atomic batch, commits
   *  the given conflicting row out-of-band — deterministically forcing the
   *  create-branch INSERT to violate the unique constraint, so the loser's
   *  pre-retry error can be observed without a real timing race. `onBatchError`
   *  fires with the error thrown by each atomic batch (the pre-retry signal). */
  createRacePlantingBatchDriver?: (config: {
    plant: { sql: string; params: unknown[] };
    onBatchError: (error: unknown) => void;
  }) => AnyDriver;
}

export function runNestedWriteConcurrencyBehavior({
  driverName,
  createTxDriver,
  createBatchDriver,
  createRacePlantingBatchDriver,
}: NestedWriteConcurrencyBehaviorOptions) {
  describe(`${driverName} nested-write concurrency behavior`, () => {
    let clients: ConcurrencyClient[] = [];

    async function reset(): Promise<void> {
      const driver = createTxDriver();
      const client = createClient({ schema, driver });
      clients.push(client);
      // Persistent databases keep tables between runs; re-pushing a schema with
      // unique fields is not idempotent on Postgres — start clean every time.
      for (const table of [
        "upsert_atomicity_posts",
        "upsert_atomicity_users",
        "upsert_atomicity_tags",
        "upsert_atomicity_counters",
      ]) {
        await driver._executeRaw(`DROP TABLE IF EXISTS ${table}`);
      }
      await push(client, { force: true });
    }

    function boot(driver: AnyDriver): ConcurrencyClient {
      const client = createClient({ schema, driver });
      clients.push(client);
      return client;
    }

    beforeEach(async () => {
      clients = [];
      await reset();
    });

    afterEach(async () => {
      for (const client of clients) {
        await client.$disconnect();
      }
      clients = [];
    });

    // --- Gate 1: concurrent top-level upsert converges ----------------------

    const modes: Array<{
      name: "tx" | "batch";
      createDriver: () => AnyDriver;
    }> = [{ name: "tx", createDriver: createTxDriver }];
    if (createBatchDriver) {
      modes.push({ name: "batch", createDriver: createBatchDriver });
    }
    for (const mode of modes) {
      const makeDriver = mode.createDriver;

      test(
        `concurrent upsert of a missing key converges to one row (${mode.name})`,
        { timeout: 30_000 },
        async () => {
          const a = boot(makeDriver());
          const b = boot(makeDriver());

          const results = await Promise.all([
            a.tag.upsert({
              where: { name: "converge" },
              create: { id: "converge-a", name: "converge", count: 1 },
              update: { count: 10 },
            }),
            b.tag.upsert({
              where: { name: "converge" },
              create: { id: "converge-b", name: "converge", count: 2 },
              update: { count: 20 },
            }),
          ]);

          expect(results).toHaveLength(2);

          const observer = boot(createTxDriver());
          const rows = await observer.tag.findMany({
            where: { name: "converge" },
          });
          // Exactly one row survives: one upsert created it, the other lost the
          // race, reran, and took the update branch (count bumped to 10 or 20).
          expect(rows).toHaveLength(1);
          expect([10, 20]).toContain(rows[0]?.count);
        }
      );

      test(
        `concurrent nested connectOrCreate of a missing key converges to one row (${mode.name})`,
        { timeout: 30_000 },
        async () => {
          const a = boot(makeDriver());
          const b = boot(makeDriver());

          // The nested create tree (a post whose author is connectOrCreated)
          // forces the SELECT-then-write path where the missing-key create-branch
          // race lives (Pin Rule 2). Both racers target the same author key.
          const run = (client: ConcurrencyClient, suffix: string) =>
            client.post.create({
              data: {
                id: `coc-post-${suffix}`,
                title: `title-${suffix}`,
                author: {
                  connectOrCreate: {
                    where: { id: "coc-author" },
                    create: { id: "coc-author", name: `author-${suffix}` },
                  },
                },
              },
            });

          const results = await Promise.all([run(a, "a"), run(b, "b")]);
          expect(results).toHaveLength(2);

          const observer = boot(createTxDriver());
          const authors = await observer.user.findMany({
            where: { id: "coc-author" },
          });
          // Exactly one author committed; the loser reran and connected instead
          // of creating a second — never a surfaced raw constraint error.
          expect(authors).toHaveLength(1);
          const posts = await observer.post.findMany();
          expect(posts).toHaveLength(2);
        }
      );
    }

    // --- Gate 3: the planned-path loser's pre-retry signal ------------------

    if (createRacePlantingBatchDriver) {
      test(
        "planned-path create-branch race loser surfaces a UniqueConstraintError, then the retry converges",
        { timeout: 30_000 },
        async () => {
          // A batch-forced driver that plants the winner's author row (same PK
          // `coc-author`) just before its FIRST atomic batch runs. The nested
          // connectOrCreate forces the interpreter's planned path (a plain tag
          // upsert would use the native ON CONFLICT and never reach a batch); the
          // create branch — chosen against the plan-time probe that saw no author —
          // deterministically violates the PK constraint at INSERT time. The
          // driver records the error each atomic batch threw (the pre-retry
          // signal).
          const batchErrors: unknown[] = [];
          const driver = createRacePlantingBatchDriver({
            plant: {
              sql: insertUserSql().sql,
              params: ["coc-author", "planted-winner"],
            },
            onBatchError: (error) => batchErrors.push(error),
          });
          const client = boot(driver);

          // With no committed author at plan time the planned plan takes the
          // connectOrCreate create branch; the planted author lands first, so the
          // create INSERT hits the PK constraint. The retry wrapper (§7.4) reruns;
          // the second plan-time probe sees the planted author and takes the
          // connect branch, converging.
          const post = await client.post.create({
            data: {
              id: "coc-post",
              title: "Converged",
              author: {
                connectOrCreate: {
                  where: { id: "coc-author" },
                  create: { id: "coc-author", name: "mine" },
                },
              },
            },
          });

          // The loser's PRE-RETRY error was the DB's own constraint violation,
          // passed through the ladder unchanged (§7.3 step 1). Pin Rule 2 (§5.5,
          // F1 fix): the create-branch premise is NOT pinned by a `notExists`
          // assertion, so the abort is a real UniqueConstraintError — the
          // already-retryable signal — not a rewrapped NestedWriteAssertionError.
          // Were it rewrapped, the retry would never fire and this operation would
          // hard-fail instead of converging.
          expect(batchErrors.length).toBeGreaterThanOrEqual(1);
          expect(batchErrors[0]).toBeInstanceOf(UniqueConstraintError);

          // Converged onto the planted winner via the connect branch.
          expect(post.userId).toBe("coc-author");

          const observer = boot(createTxDriver());
          const authors = await observer.user.findMany({
            where: { id: "coc-author" },
          });
          expect(authors).toHaveLength(1);
          expect(authors[0]?.name).toBe("planted-winner");
        }
      );
    }
  });
}

/** PostgreSQL INSERT used by the planned race-planting driver. */
function insertUserSql(): { sql: string } {
  return {
    sql: 'INSERT INTO "upsert_atomicity_users" ("id", "name") VALUES ($1, $2)',
  };
}

export const nestedWriteConcurrencyContract = defineContract({
  id: "drivers.nested-write-concurrency",
  owningLayer: "drivers",
  tier: "extended",
  requiredCapabilities: ["sql-execution"],
  register: runNestedWriteConcurrencyBehavior,
});
