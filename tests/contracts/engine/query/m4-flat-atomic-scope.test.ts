import { createClient, type VibORMClient } from "@client/client";
import { Driver } from "@drivers";
import { PGliteDriver } from "@drivers/pglite";
import type { BatchQuery, QueryResult } from "@drivers/types";
import type { PGlite, Transaction } from "@electric-sql/pglite";
import { batchIsAtomicUnit } from "@tests/fixtures/atomic-unit-batch";
import {
  BatchOnlyPGliteDriver,
  usePGliteSchemaFamily,
} from "@tests/fixtures/drivers/pglite";
import { nestedWriteBehaviorSchema } from "@tests/fixtures/nested-write-behavior-schema";
import { describe, expect, test, vi } from "vitest";

/**
 * M4 gate (DESIGN.md §11 M4): the interpreter's recursion threads ONE emit/scope
 * — a nested create tree of any depth runs in exactly one atomic scope per
 * operation. The two load-bearing assertions the milestone demands:
 *
 *  1. A driver spy asserts exactly ONE `withTransaction` per interpreter
 *     operation on the transaction strategy substrate (and exactly one `_executeBatch` on
 *     the batch strategy substrate). Recursion threads the same `emit`/scope; there
 *     is never a nested `withTransaction` (the frozen tx engine's per-level
 *     `runNestedMutationAtomically` / savepoint mechanism is gone on this path —
 *     §8.2, DIVERGENCE-RECURSION-ATOMICITY removed). A savepoint would open a
 *     transaction on the tx-bound driver, a DIFFERENT object than the base
 *     driver the spy watches, so the count stays at one exactly when no nested
 *     scope is opened.
 *
 *  2. The multi-level nested rollback scenario is green in BOTH modes: a deep
 *     FK-only create tree whose deepest statement fails leaves ZERO rows at
 *     every level. All-or-nothing across the whole recursion proves the single
 *     flat scope — if any level committed independently (its own scope), the
 *     top-level row (inserted first, before the failing deep child) would
 *     survive.
 *
 * The tree used throughout: user → posts (child-holds-FK oneToMany) → postTags
 * (child-holds-FK oneToMany) → tag (parent-holds-FK manyToOne connect). Four
 * models, before- and after-parent FK splits, all FK — eligible for the
 * interpreter at M3+, so both spies fire.
 */

type BehaviorSchema = typeof nestedWriteBehaviorSchema;

// A nested (savepoint) scope is realized as a `SAVEPOINT ...` raw statement;
// a flat interpreter scope issues none.
const SAVEPOINT_PATTERN = /SAVEPOINT/i;

// A batch-only PGlite driver forced down the atomic-batch (batch strategy) path,
// recording how many ATOMIC UNITS it runs. Mirrors the conformance harness.
//
// PIN NARROWED DELIBERATELY — PLAN Phase 6.1. This counted every `executeBatch`
// call, which was the same number while planning reads travelled one `_execute`
// at a time. Phase 6.1 sends a dependency LEVEL of independent planning reads
// through the batch seam, so this tree (whose two `connect` probes share a
// level) now makes two calls: one planning batch, then the atomic unit. The
// invariant M4 states is about the ATOMIC SCOPE — the whole recursion commits
// or rolls back as one indivisible unit, with no per-level scope — and a batch
// of planning SELECTs is not one. Counting the unit rather than the call
// measures M4 directly instead of by a proxy that a planning change can move.
class AtomicUnitCountingPGliteDriver extends BatchOnlyPGliteDriver {
  batchCount = 0;

  protected override async executeBatch<T>(
    client: PGlite | Transaction,
    queries: BatchQuery[]
  ): Promise<QueryResult<T>[]> {
    if (batchIsAtomicUnit(queries)) this.batchCount++;
    return super.executeBatch<T>(client, queries);
  }
}

/**
 * One PGlite for the whole worker, one private schema for this suite. Every
 * driver below is built over that shared database and MUST carry the suite's
 * namespace: without it the driver addresses `public`, where this suite has no
 * tables at all.
 */
const getFamily = usePGliteSchemaFamily(nestedWriteBehaviorSchema);

function sharedDatabase(): { client: PGlite; namespace: string } {
  const family = getFamily();
  return { client: family.database, namespace: family.namespace };
}

function boot<TDriver extends PGliteDriver>(
  driver: TDriver
): VibORMClient<{ schema: BehaviorSchema; driver: TDriver }> {
  return createClient({ schema: nestedWriteBehaviorSchema, driver });
}

// A deep FK-only create tree of depth four: the top-level user, its posts
// (child holds FK), each post's postTags (child holds FK), and each postTag's
// tag connect (parent holds FK). Every relation is FK, so the whole tree is
// interpreter-eligible.
function deepCreateData() {
  return {
    id: "u1",
    name: "Alice",
    posts: {
      create: [
        {
          id: "po1",
          title: "First",
          postTags: {
            create: [{ id: "j1", tag: { connect: { id: "t1" } } }],
          },
        },
        {
          id: "po2",
          title: "Second",
          postTags: {
            create: [{ id: "j2", tag: { connect: { id: "t2" } } }],
          },
        },
      ],
    },
  };
}

async function seedTags<TDriver extends PGliteDriver>(
  client: VibORMClient<{ schema: BehaviorSchema; driver: TDriver }>
): Promise<void> {
  await client.tag.create({ data: { id: "t1", name: "tag-1" } });
  await client.tag.create({ data: { id: "t2", name: "tag-2" } });
}

describe("M4 one flat atomic scope", () => {
  describe("exactly one atomic scope per interpreter operation", () => {
    test(
      "live mode opens withTransaction exactly once for a deep nested create",
      { timeout: 30_000 },
      async () => {
        const driver = new PGliteDriver(sharedDatabase());
        const client = boot(driver);
        await seedTags(client);

        // Spy on the base `Driver` prototype where `withTransaction` actually
        // lives: it is shared by the base driver AND every TransactionBoundDriver
        // (which extends Driver), so a per-recursion-level nested scope (opened on
        // the tx-bound driver) is counted too. The interpreter threads the same
        // emit/scope through the whole tree, so the count is exactly one — a count
        // above one would prove a nested scope was opened.
        const txSpy = vi.spyOn(Driver.prototype, "withTransaction");

        await client.user.create({ data: deepCreateData() });

        expect(txSpy).toHaveBeenCalledTimes(1);
        txSpy.mockRestore();
      }
    );

    test(
      "planned mode runs the whole deep tree as exactly one batch",
      { timeout: 30_000 },
      async () => {
        const driver = new AtomicUnitCountingPGliteDriver(sharedDatabase());
        const client = boot(driver);
        // Seed the connect targets with the same client, then zero the counter so
        // only the deep create's batch is counted.
        await seedTags(client);
        driver.batchCount = 0;

        await client.user.create({ data: deepCreateData() });

        // The entire depth-four tree is one atomic batch: one _executeBatch call
        // reaching executeBatch exactly once.
        expect(driver.batchCount).toBe(1);
      }
    );

    test(
      "live mode never opens a nested (savepoint) transaction on the tx driver",
      { timeout: 30_000 },
      async () => {
        const driver = new PGliteDriver(sharedDatabase());
        const client = boot(driver);
        await seedTags(client);

        // A nested withTransaction (the frozen engine's per-level scope) is
        // realized as a SAVEPOINT, issued as a raw statement by the tx-bound
        // driver's savepoint machinery (driver.ts transaction() override). A flat
        // scope issues none. Watch the raw execution path for the keyword.
        const rawSpy = vi.spyOn(
          PGliteDriver.prototype as unknown as {
            executeRaw: (
              client: unknown,
              sqlText: string,
              params?: unknown[]
            ) => Promise<unknown>;
          },
          "executeRaw"
        );

        await client.user.create({ data: deepCreateData() });

        const savepointCalls = rawSpy.mock.calls.filter((call) =>
          SAVEPOINT_PATTERN.test(String(call[1]))
        );
        expect(savepointCalls).toEqual([]);
        rawSpy.mockRestore();
      }
    );
  });

  describe("multi-level nested rollback is atomic in both modes", () => {
    // A deep create tree whose DEEPEST statement fails: the second post's
    // postTag connects to a tag that does not exist, so its connect target-exists
    // guard fails AFTER the user, the first post, its postTag, and the second
    // post have all been emitted. A single flat scope rolls the whole tree back;
    // zero rows must remain at every level. If any level had its own scope, the
    // top-level user (emitted first) would survive the deep failure.
    function deepCreateWithDeepFailure() {
      return {
        id: "u_rollback",
        name: "Bob",
        posts: {
          create: [
            {
              id: "po_ok",
              title: "Fine",
              postTags: {
                create: [{ id: "jt_ok", tag: { connect: { id: "t1" } } }],
              },
            },
            {
              id: "po_bad",
              title: "Doomed",
              postTags: {
                // Connecting to a missing tag fails the target-exists guard.
                create: [
                  { id: "jt_bad", tag: { connect: { id: "t-missing" } } },
                ],
              },
            },
          ],
        },
      };
    }

    // Run the failing deep create and report whether it threw plus the row
    // counts left at every level. The assertions live in the test bodies
    // (noMisplacedAssertion); the helper only exercises the operation.
    async function runRollback(
      createDriver: (db: { client: PGlite; namespace: string }) => PGliteDriver
    ): Promise<{
      threw: boolean;
      counts: { users: number; posts: number; postTags: number };
    }> {
      // Both arms of the comparison below run inside ONE test, so the arm's
      // starting state is reset here rather than relying on the per-test hook.
      await getFamily().reset();
      const client = boot(createDriver(sharedDatabase()));
      // Seed the connect targets with the same client so the shared PGlite
      // instance is never closed between seeding and the create under test.
      await seedTags(client);
      let threw = false;
      try {
        await client.user.create({ data: deepCreateWithDeepFailure() });
      } catch {
        threw = true;
      }

      const users = await client.user.findMany({});
      const posts = await client.post.findMany({});
      const postTags = await client.postTag.findMany({});
      return {
        threw,
        counts: {
          users: users.length,
          posts: posts.length,
          postTags: postTags.length,
        },
      };
    }

    test(
      "live mode rolls back every level of a deep nested create on a deep failure",
      { timeout: 30_000 },
      async () => {
        const outcome = await runRollback((db) => new PGliteDriver(db));
        expect(outcome.threw).toBe(true);
        expect(outcome.counts).toEqual({ users: 0, posts: 0, postTags: 0 });
      }
    );

    test(
      "planned mode rolls back every level of a deep nested create on a deep failure",
      { timeout: 30_000 },
      async () => {
        const outcome = await runRollback(
          (db) => new AtomicUnitCountingPGliteDriver(db)
        );
        expect(outcome.threw).toBe(true);
        expect(outcome.counts).toEqual({ users: 0, posts: 0, postTags: 0 });
      }
    );

    // The rollback leaves state byte-identical to before the operation in both
    // substrates: only the two seeded tags remain, nothing from the tree.
    test(
      "both modes leave identical persisted state after a rolled-back deep create",
      { timeout: 30_000 },
      async () => {
        const live = await runRollback((db) => new PGliteDriver(db));
        const planned = await runRollback(
          (db) => new AtomicUnitCountingPGliteDriver(db)
        );
        expect(planned).toEqual(live);
      }
    );
  });
});
