/**
 * Rulings unit — D-32, the registered concurrency witness.
 *
 * A singular polymorphic slot is filled by a TRANSFER: the plan captures the
 * complete membership pair that currently holds the target, and the atomic unit
 * deletes exactly that pair before it inserts its own. Both halves of the
 * capture are premises, and both state the same kind of fact — a membership
 * this operation OBSERVED (or observed to be absent) has changed underneath it.
 *
 * Arnaud's D-32: that is a race like any other. The unit aborts, the operation
 * re-plans ONCE from the admitted values, the fresh capture reads the
 * membership the race produced, and it converges. The rows the write connects
 * are the ones the arguments named, so no re-plan can land on another identity
 * — which is what separates these premises from the captured ROW's own presence
 * (`commands/execution.ts:264`) and the parent-presence premise
 * (`commands/execution.ts:833`), both of which stay non-raceable.
 *
 * The estate's live witnesses for this slot are the pg modes
 * `g2-junction-held-capture-race` / `g2-junction-captured-owner-replaced` and
 * the `pg` driver-contract cell "an adopter whose captured owner was replaced";
 * they state the same law under the ruling. This file is the deterministic
 * one: a real SQLite database, a batch-only transport that proves its rollback,
 * and a competing commit planted in the exact window the premise exists for.
 */

import assert from "node:assert/strict";
import { createClient } from "@client/client";
import type { BatchQuery, QueryResult } from "@drivers";
import { s } from "@schema";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import Database from "better-sqlite3";
import { afterEach, describe, it } from "vitest";
import { RecordingSQLiteDriver } from "../unit02/world";

const book = s
  .model({
    id: s.string().id(),
    title: s.string(),
    shelf: s.toOne(() => shelf),
  })
  .map("d32_books");

const shelf = s
  .model({
    id: s.string().id(),
    label: s.string(),
    items: s
      .toMany({ book: () => book }, { values: { book: "stored.book.v1" } })
      .through({
        book: { table: "d32_members", source: "holder", target: "entry" },
      }),
  })
  .map("d32_shelves");

const schema = { shelf, book };

/** Does this batch carry a write? Only that batch is the atomic unit. */
const MUTATION = /^\s*(?:insert|update|delete)\b/i;
/**
 * One PLAN, counted at the root locate: the plan-time read projects the
 * adopter's own columns, which the premise over the same row (a bare identity
 * assertion) and the fresh-state diagnostic that re-reads it do not.
 */
const PLAN = /"label" FROM "d32_shelves"/;
/** The capture's premise, as the adapter spells an assertion. */
const PREMISE = /__viborm_assert__/;
const MEMBERSHIP = /"d32_members"/;
/** The one sentence both arms of the capture raise. */
const MEMBERSHIP_RACE =
  /Concurrent membership change on the singular polymorphic member of relation 'items\.book'/;

interface Move {
  readonly from?: string;
  readonly to: string;
}

/**
 * A batch-only transport over a real SQLite database, which commits a competing
 * membership move in the window the premise exists for: after the plan-time
 * capture read, and before the atomic unit that trusts it.
 */
class RacingMembershipDriver extends RecordingSQLiteDriver {
  override readonly supportsTransactions = false;
  override readonly supportsBatch = true;
  override readonly supportsOrderedCommittedSegments = true;
  /** How many atomic write batches lose the race; the world seeds with none. */
  plantsLeft = 0;
  planted: string[] = [];
  move: Move = { to: "r" };

  protected override async executeBatch<T>(
    client: Database.Database,
    queries: BatchQuery[]
  ): Promise<QueryResult<T>[]> {
    // The window is between the plan-time capture and the ATOMIC WRITE UNIT
    // that trusts it, so the competing commit lands before a batch that
    // mutates — never before a planning batch, which the plan would read.
    if (
      this.plantsLeft > 0 &&
      queries.some((query) => MUTATION.test(query.sql))
    ) {
      this.plantsLeft--;
      this.plant(client);
    }
    this.batchCalls++;
    // An atomic batch that PROVES its rollback — the transport where a rejected
    // batch is known to have left nothing behind. Without that proof a rejected
    // batch is `may-have-committed` and no recovery is allowed, which is the
    // engine's rule, not this fixture's.
    return this.transaction(client, async (transaction) => {
      const responses: QueryResult<T>[] = [];
      for (const query of queries)
        responses.push(
          await this.execute<T>(transaction, query.sql, query.params ?? [])
        );
      return responses;
    });
  }

  private plant(client: Database.Database): void {
    const holder = `${this.move.to}${this.planted.length + 1}`;
    client
      .prepare('INSERT INTO "d32_shelves" ("id","label") VALUES (?,?)')
      .run(holder, holder);
    client.prepare('DELETE FROM "d32_members" WHERE "entry" = ?').run("b1");
    client
      .prepare('INSERT INTO "d32_members" ("holder","entry") VALUES (?,?)')
      .run(holder, "b1");
    this.planted.push(holder);
  }
}

interface World {
  readonly driver: RacingMembershipDriver;
  readonly client: ReturnType<typeof buildClient>;
  members(): { holder: string; entry: string }[];
  close(): Promise<void>;
}

function buildClient(driver: RacingMembershipDriver) {
  return createClient({ schema, driver });
}

let world: World | undefined;

afterEach(async () => {
  await world?.close();
  world = undefined;
});

async function createWorld(options: {
  plantsLeft: number;
  held: boolean;
}): Promise<World> {
  const database = new Database(":memory:");
  const driver = new RacingMembershipDriver({ client: database });
  const client = buildClient(driver);
  const migration = await syncLiveSchema(client);
  if (!migration.applied) throw new Error("D-32 world schema did not apply");
  await client.book.create({ data: { id: "b1", title: "requested" } });
  await client.shelf.create({ data: { id: "s0", label: "s0" } });
  await client.shelf.create({ data: { id: "s2", label: "s2" } });
  if (options.held)
    await client.shelf.update({
      where: { id: "s0" },
      data: { items: { connect: [{ type: "book", where: { id: "b1" } }] } },
    });
  driver.reset();
  driver.plantsLeft = options.plantsLeft;
  driver.planted = [];
  return {
    driver,
    client,
    members: () =>
      database
        .prepare('SELECT "holder","entry" FROM "d32_members" ORDER BY "holder"')
        .all() as { holder: string; entry: string }[],
    async close() {
      await client.$disconnect();
      database.close();
    },
  };
}

const adopt = (client: World["client"]) =>
  client.shelf.update({
    where: { id: "s2" },
    data: { items: { connect: [{ type: "book", where: { id: "b1" } }] } },
    select: { id: true },
  });

/** How many times this operation planned: the original, plus each re-plan. */
const plans = (driver: RacingMembershipDriver) =>
  driver.statements.filter((statement) => PLAN.test(statement.sql)).length;

/** How many of the capture's own premises reached the transport. */
const premises = (driver: RacingMembershipDriver) =>
  driver.statements.filter(
    (statement) => PREMISE.test(statement.sql) && MEMBERSHIP.test(statement.sql)
  ).length;

describe("integration — a captured membership is a race, not an identity", () => {
  it("re-plans once and converges when the captured membership is replaced", async () => {
    world = await createWorld({ plantsLeft: 1, held: true });
    assert.deepEqual(world.members(), [{ holder: "s0", entry: "b1" }]);

    assert.deepEqual(await adopt(world.client), { id: "s2" });

    // Two plan-time captures: the first captured `s0`, the race moved the
    // membership to `s1`, the premise aborted the unit, and the re-plan
    // captured `s1` and transferred THAT pair.
    assert.deepEqual(world.driver.planted, ["r1"]);
    assert.equal(plans(world.driver), 2);
    assert.equal(premises(world.driver), 2);
    // The slot is singular and the requested target belongs to the adopter.
    assert.deepEqual(world.members(), [{ holder: "s2", entry: "b1" }]);
  });

  it("spends the allowance once: a repeated replacement propagates the sentence", async () => {
    world = await createWorld({ plantsLeft: 2, held: true });

    await assert.rejects(
      async () => {
        await adopt(world!.client);
      },
      (error: Error) => MEMBERSHIP_RACE.test(error.message)
    );

    assert.deepEqual(world.driver.planted, ["r1", "r2"]);
    assert.equal(plans(world.driver), 2);
    // Nothing of ours was written: the abort rolled its atomic unit back and
    // the last racing writer still holds the target.
    assert.deepEqual(world.members(), [{ holder: "r2", entry: "b1" }]);
  });

  it("re-plans once and converges when a slot read empty is taken", async () => {
    world = await createWorld({ plantsLeft: 1, held: false });
    assert.deepEqual(world.members(), []);

    assert.deepEqual(await adopt(world.client), { id: "s2" });

    // The capture read the slot EMPTY, so the premise it queued was the
    // absence one; the race filled the slot, the unit aborted, and the re-plan
    // captured the new holder's pair and transferred it.
    assert.deepEqual(world.driver.planted, ["r1"]);
    assert.equal(plans(world.driver), 2);
    assert.equal(premises(world.driver), 2);
    assert.deepEqual(world.members(), [{ holder: "s2", entry: "b1" }]);
  });
});
