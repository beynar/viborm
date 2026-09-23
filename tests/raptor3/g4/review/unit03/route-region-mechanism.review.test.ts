/**
 * G4-03 second follow-up review probe (repair-2 verification).
 *
 * The repair-2 record claims a specific mechanism for divergence D-1's
 * state/outcome half: a DIRECT statement on a transaction-scoped driver is
 * tracked with `poisonOnFailure = true` (`src/drivers/driver.ts:665-667`) and
 * marks the caller's scope rollback-only, while a NESTED `withTransaction`
 * whose rejection is observed is tracked with `poisonOnFailure = false`
 * (`driver.ts:797-799`) and leaves the caller's transaction usable.
 *
 * This probe tests that claim WITHOUT the candidate route and WITHOUT mutating
 * any source: it runs the identical failing write on the SHIPPED route twice,
 * once directly inside `$transaction(callback)` and once wrapped in one nested
 * `$transaction`. If the mechanism is the shape (and not the route), the
 * wrapped run must reproduce the candidate's recorded outcome exactly.
 */

import assert from "node:assert/strict";
import { SQLite3Driver } from "@drivers/sqlite3";
import { s } from "@schema";
import { createClient } from "@src/index";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import Database from "better-sqlite3";
import { afterEach, describe, test } from "vitest";

const author = s
  .model({
    id: s.int().id().increment(),
    email: s.string().unique(),
    name: s.string(),
  })
  .map("g4r_mech_authors");

const schema = { author };

const worlds: {
  client: ReturnType<typeof makeClient>;
  database: Database.Database;
}[] = [];

function makeClient(database: Database.Database) {
  return createClient({
    driver: new SQLite3Driver({ client: database }),
    schema,
  });
}

async function createShippedWorld() {
  const database = new Database(":memory:");
  const client = makeClient(database);
  const migration = await syncLiveSchema(client);
  if (!migration.applied) throw new Error("schema did not apply");
  const world = { client, database };
  worlds.push(world);
  return world;
}

afterEach(async () => {
  for (const world of worlds.splice(0)) {
    await world.client.$disconnect();
    world.database.close();
  }
});

function storedAuthors(database: Database.Database): unknown[] {
  return database
    .prepare("SELECT email FROM g4r_mech_authors ORDER BY id")
    .all();
}

/**
 * Run the same program on the shipped route; `wrap` decides whether the failing
 * member runs directly on the caller's transaction client or inside one nested
 * `$transaction` (the shape the candidate route opens for every write).
 */
async function runProgram(wrapFailingMemberInNestedTransaction: boolean) {
  const world = await createShippedWorld();
  await world.client.author.create({
    data: { email: "taken@example.test", name: "Taken" },
  });
  let inner: string | undefined;
  let afterWrite: string | undefined;
  let outer: string | undefined;
  try {
    await world.client.$transaction(async (tx) => {
      await tx.author.create({
        data: { email: "kept@example.test", name: "Kept" },
      });
      try {
        if (wrapFailingMemberInNestedTransaction) {
          await tx.$transaction(async (member) => {
            await member.author.create({
              data: { email: "taken@example.test", name: "Duplicate" },
            });
          });
        } else {
          await tx.author.create({
            data: { email: "taken@example.test", name: "Duplicate" },
          });
        }
      } catch (error) {
        inner = (error as Error).constructor.name;
      }
      try {
        await tx.author.create({
          data: { email: "after@example.test", name: "After" },
        });
        afterWrite = "ok";
      } catch (error) {
        afterWrite = (error as Error).constructor.name;
      }
    });
  } catch (error) {
    outer = (error as Error).constructor.name;
  }
  return { afterWrite, inner, outer, stored: storedAuthors(world.database) };
}

describe("G4-03 repair-2 — the mechanism behind divergence D-1", () => {
  test("SHIPPED route: a DIRECT failing statement-atomic write poisons the caller's transaction", async () => {
    const observed = await runProgram(false);
    assert.equal(observed.inner, "UniqueConstraintError");
    assert.equal(observed.afterWrite, "UniqueConstraintError");
    assert.equal(observed.outer, "UniqueConstraintError");
    assert.deepEqual(observed.stored, [{ email: "taken@example.test" }]);
  });

  test("SHIPPED route: the SAME failing write inside ONE nested transaction leaves the caller usable — the candidate's recorded outcome, reached without the candidate", async () => {
    const observed = await runProgram(true);
    assert.equal(observed.inner, "UniqueConstraintError");
    // If this is "UniqueConstraintError", the recorded mechanism is wrong: the
    // region would not be what spares the caller's transaction.
    assert.equal(observed.afterWrite, "ok");
    assert.equal(observed.outer, undefined);
    assert.deepEqual(observed.stored, [
      { email: "taken@example.test" },
      { email: "kept@example.test" },
      { email: "after@example.test" },
    ]);
  });
});
