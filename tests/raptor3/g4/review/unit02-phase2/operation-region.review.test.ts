/**
 * G4-02 phase-2 review — what the `operationRegion` grant DOES on failure.
 *
 * The unit's two `operationRegion` cells count savepoints on a successful
 * multi-statement borrowed write and pin a successful single-statement one.
 * Brief item 11 and note §P.7 falsifier 1 promise more than a count: "a
 * multi-statement one opens one nested region and rolls back only its own
 * work", while "a single-statement write then runs directly on the caller's
 * transaction driver and poisons that scope". These cells measure the failure
 * side of both, and that the caller's transaction is still usable afterwards.
 */
import assert from "node:assert/strict";
import type { AnyDriver, QueryExecutionContext } from "@drivers";
import { createCommandEngine } from "@query-engine/raptor3/commands";
import { afterEach, describe, it } from "vitest";
import { createWorld, worldSchema, type World } from "../../unit02/world";

let world: World | undefined;

afterEach(async () => {
  await world?.close();
  world = undefined;
});

function transferred(caller: AnyDriver) {
  return {
    kind: "borrowed-transaction",
    driver: caller,
    memberRollback: <T,>(
      execute: (driver: AnyDriver) => Promise<T>,
      context: QueryExecutionContext
    ) => caller.withTransaction(execute, undefined, context),
    operationRegion: <T,>(
      execute: (driver: AnyDriver) => Promise<T>,
      context: QueryExecutionContext
    ) => caller.withTransaction(execute, undefined, context),
  } as const;
}

function memberOnly(caller: AnyDriver) {
  return {
    kind: "borrowed-transaction",
    driver: caller,
    memberRollback: <T,>(
      execute: (driver: AnyDriver) => Promise<T>,
      context: QueryExecutionContext
    ) => caller.withTransaction(execute, undefined, context),
  } as const;
}

describe("G4-02 review — the granted region on failure", () => {
  it("rolls back only its own work and leaves the caller's transaction usable", async () => {
    world = await createWorld();
    const engine = createCommandEngine({
      schema: worldSchema,
      driver: world.driver,
    });
    const driver = world.driver;
    let refusal: unknown;
    let survived = false;
    await driver.withTransaction(async (caller) => {
      // A relation-bearing update whose child write violates the post key.
      try {
        await engine.execute(
          "author",
          "update",
          {
            where: { id: 1 },
            data: {
              name: "Ada+",
              posts: { create: [{ id: 10, title: "dup", rank: 9 }] },
            },
          },
          transferred(caller as AnyDriver)
        );
      } catch (error) {
        refusal = error;
      }
      // The caller's transaction must still be usable after the member failed:
      // the same connection reads its own uncommitted state.
      const rows = world!.database
        .prepare("SELECT name FROM g4u2_authors WHERE id = 1")
        .all() as { name: string }[];
      survived = rows.length === 1;
      assert.equal(
        rows[0]?.name,
        "Ada",
        `the operation's own work must be rolled back: ${JSON.stringify(rows)}`
      );
    });
    assert.ok(refusal, "the duplicate child write must refuse");
    assert.ok(survived, "the caller's transaction must still be usable");
  });

  it("a FAILING single-statement borrowed write poisons the caller's scope the same way with and without the grant", async () => {
    const outcomes: string[] = [];
    for (const binding of [transferred, memberOnly]) {
      world = await createWorld();
      const engine = createCommandEngine({
        schema: worldSchema,
        driver: world.driver,
      });
      const driver = world.driver;
      try {
        await driver.withTransaction(async (caller) => {
          try {
            await engine.execute(
              "author",
              "create",
              { data: { id: 1, name: "clash", age: 1 } },
              binding(caller as AnyDriver)
            );
          } catch {
            // The write failed; the caller's scope is what this cell measures.
          }
          const rows = world!.database
            .prepare("SELECT COUNT(*) AS n FROM g4u2_authors")
            .all();
          outcomes.push(`usable:${JSON.stringify(rows)}`);
        });
      } catch (error) {
        outcomes.push(`poisoned:${(error as Error).constructor.name}`);
      }
      await world.close();
      world = undefined;
    }
    // Two entries per binding: what the caller could still read, and what the
    // caller's own scope did at the end.
    assert.deepEqual(
      outcomes.slice(0, 2),
      outcomes.slice(2, 4),
      `the grant must not change a single-statement write's effect on the caller: ${outcomes.join(" | ")}`
    );
    assert.match(
      outcomes[1] ?? "",
      /^poisoned:/,
      `a failing single-statement borrowed write must poison the caller's scope: ${outcomes.join(" | ")}`
    );
  });
});
