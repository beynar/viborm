import {
  createClient,
  type VibORMClient,
  type VibORMConfig,
} from "@client/client";
import type { AnyDriver } from "@drivers";
import { UniqueConstraintError } from "@errors";

import { s } from "@schema";
import { sql } from "@sql";
import { defineContract } from "@tests/contracts/contract";
import { upsertAtomicitySchema as schema } from "@tests/fixtures/upsert-atomicity-schema";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";

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
 *  4. The SINGULAR polymorphic member's slot transfer (§9.4, §13.4) arbitrates
 *     two concurrent adopters — see `runSingularSlotTransferRaces` below, which
 *     carries its own fixture because `upsertAtomicitySchema` has no polymorphic
 *     collection and therefore no target-side UNIQUE to arbitrate on.
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
  /** A batch-forced driver that awaits an arbitrary callback ONCE, after this
   *  operation's plan-time reads and before the first atomic batch that WRITES.
   *  (Not merely "before the first batch": a planning level with several
   *  independent reads is itself dispatched as a batch, so that earlier boundary
   *  sits before the capture rather than after it.) The singular slot-transfer
   *  races below use it two ways: to let a SECOND REAL CONNECTION commit the
   *  winning adoption against an already-captured plan, and as the two-connection
   *  latch that proves both racers captured the same old owner. */
  createCapturedPlanBatchDriver?: (config: {
    beforeFirstWriteBatch: () => Promise<void>;
    onBatchError: (error: unknown) => void;
  }) => AnyDriver;
}

export function runNestedWriteConcurrencyBehavior(
  options: NestedWriteConcurrencyBehaviorOptions
) {
  runUpsertRaces(options);
  runSingularSlotTransferRaces(options);
}

function runUpsertRaces({
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
      await syncLiveSchema(client);
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

// =============================================================================
// GATE 4 — the SINGULAR polymorphic member's SLOT TRANSFER under a real race
// (plan §9.4, §13.4).
//
// A collection member whose inverse is a fields-less singular `manyToOne` puts
// a UNIQUE over the member table's complete TARGET side: at most one owner may
// hold a given target. Adding a membership there is therefore a SLOT
// REPLACEMENT, and `transferSingularJunctionMembership` is the primitive that
// performs it — capture the current owner, guard that captured fact inside the
// atomic unit, delete that exact old row, insert the desired one.
//
// Everything below asserts DATABASE STATE after both connections have settled,
// which is the only thing an arbitration claim can be about. The fixture is
// local because `upsertAtomicitySchema` has no polymorphic collection and hence
// no target-side UNIQUE — the constraint that does the arbitrating.
// =============================================================================

const singularSlotSchema = (() => {
  const book = s
    .model({
      id: s.string().id(),
      title: s.string(),
      // SINGULAR, fields-less, optional inverse. This — and only this — is what
      // makes the member table's TARGET side unique.
      shelf: s.toOne(() => shelf),
    })
    .map("nwc_slot_books");

  const shelf = s
    .model({
      id: s.string().id(),
      label: s.string(),
      items: s
        .toMany(
          { book: () => book },
          { values: { book: "nwc.book.v1" } }
        )
        .through({
          book: {
            table: "nwc_slot_members",
            source: "holder",
            target: "entry",
          },
        }),
    })
    .map("nwc_slot_shelves");

  return { book, shelf };
})();

type SlotClientConfig = VibORMConfig & {
  schema: typeof singularSlotSchema;
  driver: AnyDriver;
};

type SlotClient = VibORMClient<SlotClientConfig>;

const SLOT_TABLES = ["nwc_slot_members", "nwc_slot_books", "nwc_slot_shelves"];

/**
 * A latch over TWO REAL CONNECTIONS.
 *
 * It does not simulate concurrency — both operations run on their own database
 * connection throughout. All it does is hold each one at the point where its
 * plan-time capture is already committed to memory and its atomic batch has not
 * started, so "both racers captured the same old owner" is a FACT of the run
 * rather than a probability. The timeout keeps a party that never arrives (a
 * planning failure) from hanging the suite instead of failing it.
 */
function createArrivalLatch(parties: number, timeoutMs: number) {
  let arrived = 0;
  let open = () => {
    /* replaced below */
  };
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return {
    arrive: async () => {
      arrived += 1;
      if (arrived >= parties) {
        open();
        return;
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      const stall = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
      });
      await Promise.race([opened, stall]);
      if (timer) clearTimeout(timer);
    },
  };
}

function runSingularSlotTransferRaces({
  driverName,
  createTxDriver,
  createBatchDriver,
  createCapturedPlanBatchDriver,
}: NestedWriteConcurrencyBehaviorOptions) {
  describe(`${driverName} singular polymorphic slot transfer under concurrency`, () => {
    let clients: SlotClient[] = [];

    function boot(driver: AnyDriver): SlotClient {
      const client = createClient({ schema: singularSlotSchema, driver });
      clients.push(client);
      return client;
    }

    beforeEach(async () => {
      clients = [];
      const driver = createTxDriver();
      const client = boot(driver);
      // Same drop-and-push discipline as the suite above: a persistent database
      // keeps tables between runs and re-pushing a UNIQUE is not idempotent.
      for (const table of SLOT_TABLES) {
        await driver._executeRaw(`DROP TABLE IF EXISTS ${table}`);
      }
      await syncLiveSchema(client);
    });

    afterEach(async () => {
      for (const client of clients) {
        await client.$disconnect();
      }
      clients = [];
    });

    /**
     * Every membership row, rendered `owner/target`. Read through THIS driver's
     * own identifier escaping (MySQL reads a double-quoted name as a string
     * literal), and ordered by the `.through()` tokens rather than by column
     * order, which the topology owner legitimately decides for itself.
     */
    async function members(client: SlotClient): Promise<string[]> {
      const ident = client.$driver.adapter.identifiers.escape;
      const rows = await client.$queryRaw<Record<string, unknown>>(
        sql`SELECT * FROM ${ident("nwc_slot_members")}`
      );
      return rows
        .map((row) => {
          const names = Object.keys(row);
          return [
            ...names.filter((name) => name.startsWith("holder")),
            ...names.filter((name) => name.startsWith("entry")),
          ]
            .map((name) => String(row[name]))
            .join("/");
        })
        .sort();
    }

    /** Three shelves and one book; `heldBy` seeds the book's starting owner. */
    async function seed(client: SlotClient, heldBy?: string): Promise<void> {
      for (const id of ["s0", "s1", "s2"]) {
        await client.shelf.create({ data: { id, label: id } });
      }
      await client.book.create({ data: { id: "b1", title: "Book one" } });
      if (heldBy) {
        await adopt(client, heldBy);
      }
    }

    /** The verb under test: `connect` routes through the slot transfer. */
    const adopt = (client: SlotClient, shelfId: string) =>
      client.shelf.update({
        where: { id: shelfId },
        data: {
          items: { connect: [{ type: "book", where: { id: "b1" } }] },
        },
      });

    /** Which of the two adopters reported success, by desired owner. */
    const succeeded = (settled: PromiseSettledResult<unknown>[]) =>
      ["s1", "s2"].filter((_, index) => settled[index]?.status === "fulfilled");

    const modes: Array<{
      name: "tx" | "batch";
      createDriver: () => AnyDriver;
    }> = [{ name: "tx", createDriver: createTxDriver }];
    if (createBatchDriver) {
      modes.push({ name: "batch", createDriver: createBatchDriver });
    }

    // --- (a) two adopters of an OCCUPIED slot ------------------------------

    for (const mode of modes) {
      const makeDriver = mode.createDriver;

      test(
        `two adopters of a held target leave one membership owned by an adopter that succeeded (${mode.name})`,
        { timeout: 30_000 },
        async () => {
          const observer = clients[0]!;
          await seed(observer, "s0");
          expect(await members(observer)).toEqual(["s0/b1"]);

          const a = boot(makeDriver());
          const b = boot(makeDriver());
          const settled = await Promise.allSettled([
            adopt(a, "s1"),
            adopt(b, "s2"),
          ]);

          const rows = await members(observer);
          // ONE row, whatever the interleaving: two rows would mean the
          // target-side UNIQUE never bit, zero would mean a loser deleted the
          // winner's row on its way out.
          expect(rows).toHaveLength(1);
          const owner = rows[0]?.split("/")[0];
          const winners = succeeded(settled);
          if (winners.length === 0) {
            // Nobody committed, so nobody may have moved the book either.
            expect(owner).toBe("s0");
          } else {
            // The surviving owner is one an adopter ASKED for and REPORTED
            // success on — never `s0` (whoever won had to vacate it) and never
            // the desired owner of an adopter that failed. A lone success that
            // did not end up holding the slot is the "loser clobbered the
            // winner" state §9.4 forbids.
            expect(winners).toContain(owner);
          }
          // The transfer moves MEMBERSHIP; the target row is preserved.
          expect(await observer.book.findMany({})).toHaveLength(1);
        }
      );

      // --- (b) two adopters of an OBSERVED-EMPTY slot ----------------------

      test(
        `two adopters of an empty slot are arbitrated to one membership (${mode.name})`,
        { timeout: 30_000 },
        async () => {
          const observer = clients[0]!;
          await seed(observer);
          expect(await members(observer)).toEqual([]);

          const a = boot(makeDriver());
          const b = boot(makeDriver());
          const settled = await Promise.allSettled([
            adopt(a, "s1"),
            adopt(b, "s2"),
          ]);

          const rows = await members(observer);
          const winners = succeeded(settled);
          if (winners.length === 0) {
            expect(rows).toEqual([]);
          } else {
            // Nothing pins the absence premise on this route but the target-side
            // UNIQUE, so this is the constraint arbitrating: one row survives and
            // it belongs to an adopter that reported success.
            expect(rows).toHaveLength(1);
            expect(winners).toContain(rows[0]?.split("/")[0]);
          }
          expect(await observer.book.findMany({})).toHaveLength(1);
        }
      );
    }

    // --- The deterministic pins, on the planned route ----------------------

    if (createCapturedPlanBatchDriver) {
      test(
        "an adopter whose captured owner was replaced fails and leaves the winner's row",
        { timeout: 30_000 },
        async () => {
          const observer = clients[0]!;
          await seed(observer, "s0");
          expect(await members(observer)).toEqual(["s0/b1"]);

          // The winner runs on its OWN connection, after the loser's plan-time
          // capture read `s0` and before the loser's atomic batch — the exact
          // window §9.4's in-batch premise exists to close, made deterministic
          // rather than left to timing.
          const winner = boot(createTxDriver());
          const batchErrors: unknown[] = [];
          const loser = boot(
            createCapturedPlanBatchDriver({
              beforeFirstWriteBatch: async () => {
                await adopt(winner, "s1");
              },
              onBatchError: (error) => batchErrors.push(error),
            })
          );

          // The loser captured `s0`. Its atomic unit re-asserts that captured
          // membership BEFORE writing, so it aborts — `raceable: false`, because
          // a row that was there and is gone is a genuine replacement, not
          // something a rerun can win.
          await expect(adopt(loser, "s2")).rejects.toThrow();
          expect(batchErrors.length).toBeGreaterThanOrEqual(1);

          // THE CLAUSE: the winner's row was not deleted on the loser's way out.
          //
          // MEASURED against the unpinned adoption §9.4 forbids — the in-batch
          // captured-owner premise removed AND the vacate's own captured-owner
          // scoping removed: the loser then deletes `s1/b1`, inserts `s2/b1` and
          // REPORTS SUCCESS, reddening both halves of this row at once. Removing
          // either half ALONE leaves this row green, and that is the honest shape
          // of the design rather than a gap: with only the premise gone the
          // target-side UNIQUE still refuses the loser's insert, and with only the
          // scoping gone the premise still aborts first. The captured-owner
          // condition is what the pair states together.
          expect(await members(observer)).toEqual(["s1/b1"]);
          expect(await observer.book.findMany({})).toHaveLength(1);
        }
      );

      test(
        "two adopters that captured the SAME old owner produce exactly one winner",
        { timeout: 30_000 },
        async () => {
          const observer = clients[0]!;
          await seed(observer, "s0");
          expect(await members(observer)).toEqual(["s0/b1"]);

          // Both operations plan (and capture `s0`) on their own connection, then
          // wait for each other, then run their atomic batches concurrently. The
          // latch is what turns "probably both captured `s0`" into a fact.
          const latch = createArrivalLatch(2, 15_000);
          const racer = () =>
            boot(
              createCapturedPlanBatchDriver({
                beforeFirstWriteBatch: () => latch.arrive(),
                onBatchError: () => {
                  /* the surfaced rejection below is the assertion */
                },
              })
            );
          const a = racer();
          const b = racer();

          const settled = await Promise.allSettled([
            adopt(a, "s1"),
            adopt(b, "s2"),
          ]);
          const winners = succeeded(settled);

          // Both captured `s0` and both want it for themselves, so they CANNOT
          // both finish: whoever loses the vacate finds nothing to delete and its
          // insert collides on the target side. A membership-PK duplicate skip
          // would swallow that collision and report two successes.
          expect(winners).toHaveLength(1);
          expect(await members(observer)).toEqual([`${winners[0]}/b1`]);
          expect(await observer.book.findMany({})).toHaveLength(1);
        }
      );

      test(
        "two adopters that both observed the slot EMPTY produce exactly one winner",
        { timeout: 30_000 },
        async () => {
          const observer = clients[0]!;
          await seed(observer);

          const latch = createArrivalLatch(2, 15_000);
          const racer = () =>
            boot(
              createCapturedPlanBatchDriver({
                beforeFirstWriteBatch: () => latch.arrive(),
                onBatchError: () => {
                  /* the surfaced rejection below is the assertion */
                },
              })
            );
          const a = racer();
          const b = racer();

          const settled = await Promise.allSettled([
            adopt(a, "s1"),
            adopt(b, "s2"),
          ]);

          // Both absence premises pass — neither has committed when they are
          // evaluated — so the TARGET-SIDE UNIQUE is the only arbiter left, which
          // is exactly the claim: one winner, one loser, one row.
          const winners = succeeded(settled);
          expect(winners).toHaveLength(1);
          expect(await members(observer)).toEqual([`${winners[0]}/b1`]);
          expect(await observer.book.findMany({})).toHaveLength(1);
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
