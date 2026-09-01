import { createClient, type VibORMClient } from "@client/client";
import type { Driver } from "@drivers";
import { PGliteDriver } from "@drivers/pglite";
import type { BatchQuery, QueryResult } from "@drivers/types";
import type { PGlite, Transaction } from "@electric-sql/pglite";
import {
  NestedWriteAssertionError,
  NestedWriteError,
  UniqueConstraintError,
} from "@errors";
import { usePGliteSchemaFamily } from "@tests/fixtures/drivers/pglite";
import { nestedWriteBehaviorSchema } from "@tests/fixtures/nested-write-behavior-schema";
import { describe, expect, test } from "vitest";

/**
 * M8 gate (DESIGN.md §11 M8, §7.4). The write-race retry is unified above
 * `strategy selection`, so both substrates converge on a rerun after losing a
 * missing-key create-branch race. The full converge-under-real-concurrency
 * proof needs two real connections and lives with the Docker-gated driver tests
 * (`nested-write-concurrency-behavior.ts`); PGlite is single-connection.
 *
 * This file pins the mode-independent classification facts that DO NOT need a
 * racing database:
 *
 *  1. Un-attributable abort surfaces HARD. A planned-mode atomic batch that
 *     aborts on an assertion the ladder cannot attribute (no statement index,
 *     no re-probeable violated premise) surfaces the typed step-4 fallback
 *     (`NestedWriteError`, NESTED_WRITE_ASSERTION_FAILED, non-raceable) — never
 *     a silent success, never a raceable classification. Because it is
 *     non-raceable, the retry wrapper does NOT re-run it.
 *
 *  2. A non-raceable guard failure is NOT retried. A correlated-update failure
 *     (stealing another parent's child) is a non-raceable typed error; the
 *     operation runs EXACTLY ONCE (spy on attempt count) in both modes. Blanket
 *     retry of assertion errors is explicitly rejected (§12.14).
 *
 *  3. Pass-through: a real UniqueConstraintError raised mid-batch is surfaced
 *     unchanged (Pin Rule 2, §7.3 step 1) so the retry wrapper classifies it.
 *
 * THE PLANNED-MODE PAYLOADS CARRY A RELATION PROJECTION ON PURPOSE. Since
 * `64339541` (residual-write-limitation-lift-plan.md Package M) a PostgreSQL
 * create tree whose arms are order-insensitive and guard-free is merged into ONE
 * `WITH` statement, and a single statement never reaches a driver's batch entry
 * at all. `CreateOperation.buildTreeFold` declines when the operation's own
 * projection reads a table the tree writes (a `WITH` hands the outer SELECT the
 * pre-statement snapshot), so `include` on the written relation is what keeps
 * these payloads on the multi-statement atomic batch this file is about. Drop it
 * and the batch spies below observe nothing — which is the failure these tests
 * were retargeted out of on 2026-08-19, not a ladder change. The folded route's
 * own error contract is owned by `mutation-dependency-fold.test.ts`.
 */

type BehaviorSchema = typeof nestedWriteBehaviorSchema;

/** The top-level users table appears in the locate probe SELECT, issued once
 *  per interpreter attempt. Top-level literal so the hot path doesn't recompile
 *  it (Ultracite). */
const USERS_TABLE_PATTERN = /nested_behavior_users/;

/** A batch-only PGlite driver (batch strategy), counting atomic batches so a
 *  retry is visible as a second batch, and counting top-level locate probes so
 *  a retry is visible even when the failure fires at PLAN time (before any
 *  batch — a correlated locate that misses throws during plan construction). */
class CountingBatchDriver extends PGliteDriver {
  override readonly supportsTransactions = false;
  override readonly supportsBatch = true;
  batchCount = 0;
  /** Attempts = the number of times the planned path re-entered the interpreter.
   *  Each attempt binds the plan state exactly once via a fresh scope; we count
   *  the top-level operation entry by watching `_executeBatch` AND the plan-time
   *  probe below. A cleaner single counter: `_execute` calls whose SQL targets
   *  the top-level users table (the locate probe fires once per attempt). */
  locateProbes = 0;

  protected override async executeBatch<T>(
    client: PGlite | Transaction,
    queries: BatchQuery[]
  ): Promise<QueryResult<T>[]> {
    this.batchCount++;
    return this.transaction(client, async (tx) => {
      const results: QueryResult<T>[] = [];
      for (const query of queries) {
        results.push(await this.executeRaw<T>(tx, query.sql, query.params));
      }
      return results;
    });
  }

  override _execute<T = Record<string, unknown>>(
    ...args: Parameters<PGliteDriver["_execute"]>
  ): Promise<QueryResult<T>> {
    const [query] = args;
    // The top-level locate probe is a SELECT against the users table, issued
    // exactly once per interpreter attempt (before the plan-time correlated
    // failure throws). A retry would issue it a second time.
    if (USERS_TABLE_PATTERN.test(query.toStatement())) {
      this.locateProbes++;
    }
    return super._execute<T>(...args);
  }
}

/** A batch-only PGlite driver whose FIRST atomic batch aborts with a synthetic
 *  `NestedWriteAssertionError` carrying NO statement index — the un-attributable
 *  case (§7.3 step 4). Used on a guard-free create tree, so the ladder finds no
 *  registered premise to re-probe and lands on the typed floor. Counts batches
 *  so a (wrongly authorized) retry is visible. */
class UnattributableAbortDriver extends PGliteDriver {
  override readonly supportsTransactions = false;
  override readonly supportsBatch = true;
  batchCount = 0;

  protected override executeBatch<T>(
    _client: PGlite | Transaction,
    _queries: BatchQuery[]
  ): Promise<QueryResult<T>[]> {
    this.batchCount++;
    // A generic assertion abort with no statementIndex meta — the driver could
    // not tell the query engine WHICH statement failed. The ladder cannot index-
    // attribute it (step 2), the create tree registered no guards to re-probe
    // (step 3), so it must land on the typed non-raceable floor (step 4).
    return Promise.reject(
      new NestedWriteAssertionError("simulated un-attributable batch abort")
    );
  }
}

/** A transaction strategy PGlite driver counting `withTransaction` scopes, so a retry is
 *  visible as a second scope. */
class CountingTxDriver extends PGliteDriver {
  txCount = 0;

  override withTransaction<T>(
    fn: (txDriver: Driver<PGlite, Transaction>) => Promise<T>
  ): Promise<T> {
    this.txCount++;
    return super.withTransaction<T>(fn);
  }
}

/**
 * The suite's private schema on the worker-shared PGlite. Every driver built
 * over `family.database` must carry `family.namespace`, or it addresses an empty
 * `public`.
 */
const getFamily = usePGliteSchemaFamily(nestedWriteBehaviorSchema);

function boot<TDriver extends PGliteDriver>(
  driver: TDriver
): VibORMClient<{ schema: BehaviorSchema; driver: TDriver }> {
  return createClient({ schema: nestedWriteBehaviorSchema, driver });
}

describe("M8 race-retry classification", () => {
  test(
    "an un-attributable planned abort surfaces the typed non-raceable floor, not retried",
    { timeout: 30_000 },
    async () => {
      const family = getFamily();
      const driver = new UnattributableAbortDriver({
        client: family.database,
        namespace: family.namespace,
      });
      const client = boot(driver);

      let error: unknown;
      try {
        // A guard-free child-holds-FK create tree (no connect, no correlated
        // update) — the ladder has no registered premise to attribute or
        // re-probe, so the synthetic assertion abort lands on step 4. The
        // `include` keeps the tree on the batch route (see the file header).
        await client.user.create({
          data: {
            id: "u-floor",
            name: "Floor",
            posts: { create: { id: "p-floor", title: "Floor Post" } },
          },
          include: { posts: true },
        });
      } catch (caught) {
        error = caught;
      }

      // Step-4 floor: a typed NestedWriteError with the assertion code — never a
      // silent success, never a bare NestedWriteAssertionError leaking out.
      expect(error).toBeInstanceOf(NestedWriteError);
      expect((error as NestedWriteError).code).toBe("V7006");
      // Non-raceable: the floor never carries the raceable meta, so the retry
      // wrapper leaves it alone — exactly ONE batch attempt.
      expect((error as NestedWriteError).meta.raceable).toBeUndefined();
      expect(driver.batchCount).toBe(1);
    }
  );

  test(
    "a non-raceable correlated-update failure is not retried (planned mode)",
    { timeout: 30_000 },
    async () => {
      const family = getFamily();
      const db = family.database;
      const namespace = family.namespace;
      // Seed two owners, each with one post, on the tx driver.
      const seed = boot(new PGliteDriver({ client: db, namespace }));
      await seed.user.create({
        data: {
          id: "owner",
          name: "Owner",
          posts: { create: { id: "p-owner", title: "Owned" } },
        },
      });
      await seed.user.create({
        data: {
          id: "other",
          name: "Other",
          posts: { create: { id: "p-other", title: "Foreign" } },
        },
      });

      const driver = new CountingBatchDriver({ client: db, namespace });
      const client = boot(driver);

      let error: unknown;
      try {
        // Stealing another parent's child: the correlated-update exists-assert
        // aborts. This is a non-raceable premise (Pin Rule 1 / §5.3), so the
        // retry must NOT fire.
        await client.user.update({
          where: { id: "owner" },
          data: {
            name: "Renamed",
            posts: {
              update: { where: { id: "p-other" }, data: { title: "Stolen" } },
            },
          },
        });
      } catch (caught) {
        error = caught;
      }

      expect(error).toBeInstanceOf(NestedWriteError);
      expect((error as NestedWriteError).meta.raceable).toBeUndefined();
      // Exactly ONE interpreter attempt — no retry on a non-raceable failure.
      // The correlated locate throws at plan time (before any batch), so the
      // top-level locate probe against the users table is the attempt counter.
      expect(driver.locateProbes).toBe(1);
    }
  );

  test(
    "a non-raceable correlated-update failure is not retried (live mode)",
    { timeout: 30_000 },
    async () => {
      const family = getFamily();
      const db = family.database;
      const namespace = family.namespace;
      const seed = boot(new PGliteDriver({ client: db, namespace }));
      await seed.user.create({
        data: {
          id: "owner",
          name: "Owner",
          posts: { create: { id: "p-owner", title: "Owned" } },
        },
      });
      await seed.user.create({
        data: {
          id: "other",
          name: "Other",
          posts: { create: { id: "p-other", title: "Foreign" } },
        },
      });

      const driver = new CountingTxDriver({ client: db, namespace });
      const client = boot(driver);
      driver.txCount = 0;

      let error: unknown;
      try {
        await client.user.update({
          where: { id: "owner" },
          data: {
            name: "Renamed",
            posts: {
              update: { where: { id: "p-other" }, data: { title: "Stolen" } },
            },
          },
        });
      } catch (caught) {
        error = caught;
      }

      expect(error).toBeInstanceOf(NestedWriteError);
      expect((error as NestedWriteError).meta.raceable).toBeUndefined();
      // Exactly one withTransaction scope — no retry on a non-raceable failure.
      expect(driver.txCount).toBe(1);
    }
  );

  test(
    "a create-branch unique violation passes through the ladder unchanged (pass-through)",
    { timeout: 30_000 },
    async () => {
      const family = getFamily();
      const db = family.database;
      const namespace = family.namespace;
      const seed = boot(new PGliteDriver({ client: db, namespace }));
      await seed.tag.create({ data: { id: "t-existing", name: "dup" } });

      const driver = new CountingBatchDriver({ client: db, namespace });
      const client = boot(driver);

      let error: unknown;
      try {
        // `tag.name` is unique; a nested create of a second tag with name "dup"
        // violates the constraint mid-batch. Pin Rule 2 (§7.3 step 1): the
        // ladder passes the UniqueConstraintError through unchanged so the retry
        // wrapper can classify it — it is NOT rewrapped into an assertion error.
        // The `include` keeps the tree on the batch route (see the file header).
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
          include: { postTags: true },
        });
      } catch (caught) {
        error = caught;
      }

      expect(error).toBeInstanceOf(UniqueConstraintError);
      // The tree has no connectOrCreate/upsert, so hasRaceableCreateBranch is
      // false and the error is not self-authorizing raceable — a plain nested
      // create is not retried even on a unique violation. Exactly one batch.
      expect(driver.batchCount).toBe(1);
    }
  );
});
