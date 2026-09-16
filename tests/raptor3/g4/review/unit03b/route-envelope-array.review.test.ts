/**
 * G4-03b independent review probe — the transferred region and the array owner.
 *
 * `runCandidate` (src/query-engine/raptor3/route/client-route.ts) now names
 * three situations and grants accordingly:
 *
 *   - root                      → no binding;
 *   - array `driverOverride`    → borrowed, NO grant;
 *   - transaction-bound engine  → borrowed, `operationRegion` + `memberRollback`.
 *
 * The unit's LX-02/LX-14 oracles cover a statement-atomic write (no region) and
 * a multi-statement write (one region) inside `$transaction(callback)`. These
 * probes attack the cases the oracles do not reach:
 *
 *   1. after a FAILING multi-statement member, is the caller's transaction still
 *      usable, and does its later work COMMIT? (a region that rolls back more
 *      than its own work, or poisons the caller, shows up only here);
 *   2. the same inside a NESTED `tx.$transaction(...)`, where the transferred
 *      region is opened on a savepoint driver rather than the transaction's;
 *   3. an array `$transaction([...])` whose member is MULTI-statement — the arm
 *      that gets no grant at all — on an interactive and on a batch-only driver.
 */

import assert from "node:assert/strict";
import { VibORM, type VibORMClient } from "@client/client";
import type { BatchQuery, QueryResult } from "@drivers";
import { SQLite3Driver } from "@drivers/sqlite3";
import { createCandidateRoute } from "@query-engine/raptor3/route/client-route";
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
    books: s.toMany(() => book),
  })
  .map("g4r3b_env_authors");

const book = s
  .model({
    id: s.int().id().increment(),
    title: s.string().unique(),
    authorId: s.int(),
    author: s
      .toOne(() => author)
      .fields("authorId")
      .references("id"),
  })
  .map("g4r3b_env_books");

const schema = { author, book };

class InteractiveDriver extends SQLite3Driver {
  readonly statements: string[] = [];

  protected override async execute<T>(
    client: Database.Database,
    statement: string,
    parameters: unknown[]
  ): Promise<QueryResult<T>> {
    this.statements.push(statement);
    return super.execute<T>(client, statement, parameters);
  }
}

class BatchOnlyDriver extends InteractiveDriver {
  override readonly supportsTransactions = false;
  override readonly supportsBatch = true;

  protected override async executeBatch<T>(
    client: Database.Database,
    queries: BatchQuery[]
  ): Promise<QueryResult<T>[]> {
    for (const query of queries) this.statements.push(query.sql);
    return this.transaction(client, (transaction) =>
      super.executeBatch<T>(transaction, queries)
    );
  }
}

type WorldClient = VibORMClient<{
  driver: InteractiveDriver;
  schema: typeof schema;
}>;

interface World {
  readonly client: WorldClient;
  readonly database: Database.Database;
  readonly driver: InteractiveDriver;
}

const worlds: World[] = [];

async function createWorld(
  route: "shipped" | "candidate",
  driverKind: "interactive" | "batch-only" = "interactive"
): Promise<World> {
  const database = new Database(":memory:");
  const driver: InteractiveDriver =
    driverKind === "interactive"
      ? new InteractiveDriver({ client: database })
      : new BatchOnlyDriver({ client: database });
  const config = { driver, schema };
  const client = (
    route === "shipped"
      ? createClient(config)
      : VibORM.create(config, createCandidateRoute)
  ) as WorldClient;
  const migration = await syncLiveSchema(client);
  if (!migration.applied) throw new Error("schema did not apply");
  driver.statements.length = 0;
  const world: World = { client, database, driver };
  worlds.push(world);
  return world;
}

afterEach(async () => {
  for (const world of worlds.splice(0)) {
    await world.client.$disconnect();
    world.database.close();
  }
});

async function onBothRoutes<T>(
  scenario: (world: World) => Promise<T>,
  driverKind: "interactive" | "batch-only" = "interactive"
): Promise<{ candidate: T; shipped: T }> {
  const shipped = await scenario(await createWorld("shipped", driverKind));
  const candidate = await scenario(await createWorld("candidate", driverKind));
  return { candidate, shipped };
}

function stored(world: World) {
  return {
    authors: world.database
      .prepare("SELECT email FROM g4r3b_env_authors ORDER BY id")
      .all(),
    books: world.database
      .prepare("SELECT title FROM g4r3b_env_books ORDER BY id")
      .all(),
  };
}

async function outcome<T>(run: () => PromiseLike<T>): Promise<string> {
  try {
    return `ok:${JSON.stringify(await run())}`;
  } catch (error) {
    return `${(error as Error).constructor.name}`;
  }
}

async function detailedOutcome<T>(run: () => PromiseLike<T>): Promise<string> {
  try {
    return `ok:${JSON.stringify(await run())}`;
  } catch (error) {
    return `${(error as Error).constructor.name}: ${(error as Error).message}`;
  }
}

describe("G4-03b review — the transferred region and the array owner", () => {
  /**
   * The LX-02 oracle stops at "the caller's transaction survived": it returns
   * from the callback right after the failure. This one keeps USING the caller's
   * transaction afterwards and then lets it COMMIT. A member region that leaks
   * (rolls the caller back, or leaves the scope rollback-only) is invisible to
   * the oracle and loud here.
   */
  test("after a failing MULTI-statement member the caller's transaction still commits on both routes", async () => {
    const observations = await onBothRoutes(async (world) => {
      const steps: string[] = [];
      const commit = await outcome(() =>
        world.client.$transaction(async (tx) => {
          await tx.author.create({
            data: { email: "first@example.test", name: "First" },
          });
          steps.push(
            await outcome(() =>
              tx.author.create({
                data: {
                  books: { create: [{ title: "dup" }, { title: "dup" }] },
                  email: "failing@example.test",
                  name: "Failing",
                },
              })
            )
          );
          steps.push(
            await outcome(() =>
              tx.author.create({
                data: { email: "after@example.test", name: "After" },
              })
            )
          );
          return "callback-done";
        })
      );
      return { commit, steps, stored: stored(world) };
    });

    assert.deepEqual(observations.candidate.steps, observations.shipped.steps);
    assert.equal(observations.candidate.commit, observations.shipped.commit);
    assert.deepEqual(
      observations.candidate.stored,
      observations.shipped.stored
    );
    // The caller's own two writes committed; the failing member left nothing.
    assert.deepEqual(observations.candidate.stored, {
      authors: [
        { email: "first@example.test" },
        { email: "after@example.test" },
      ],
      books: [],
    });
  });

  /**
   * The same, one level deeper: inside `tx.$transaction(...)` the engine driver
   * is a SAVEPOINT driver, so the transferred `operationRegion` opens a savepoint
   * inside a savepoint. Both routes must keep the outer effects.
   */
  test("a failing MULTI-statement member inside a NESTED transaction keeps the outer effects on both routes", async () => {
    const observations = await onBothRoutes(async (world) => {
      const steps: string[] = [];
      const commit = await outcome(() =>
        world.client.$transaction(async (tx) => {
          await tx.author.create({
            data: { email: "outer@example.test", name: "Outer" },
          });
          steps.push(
            await outcome(() =>
              tx.$transaction(async (nested) => {
                await nested.author.create({
                  data: {
                    books: { create: [{ title: "n" }, { title: "n" }] },
                    email: "nested@example.test",
                    name: "Nested",
                  },
                });
                return "nested-done";
              })
            )
          );
          steps.push(
            await outcome(() =>
              tx.$transaction(async (nested) => {
                await nested.author.create({
                  data: {
                    books: { create: [{ title: "ok-1" }, { title: "ok-2" }] },
                    email: "nested-ok@example.test",
                    name: "NestedOk",
                  },
                });
                return "nested-ok";
              })
            )
          );
          return "outer-done";
        })
      );
      return { commit, steps, stored: stored(world) };
    });

    assert.deepEqual(observations.candidate.steps, observations.shipped.steps);
    assert.equal(observations.candidate.commit, observations.shipped.commit);
    assert.deepEqual(
      observations.candidate.stored,
      observations.shipped.stored
    );
  });

  /**
   * The array arm gets NO grant. A MULTI-statement member is the case that
   * distinguishes "no grant" from "one region": every statement runs directly on
   * the array owner's transaction driver.
   */
  test("an array transaction whose member is MULTI-statement behaves the same on both routes (interactive)", async () => {
    const observations = await onBothRoutes(async (world) => {
      const ok = await outcome(() =>
        world.client.$transaction([
          world.client.author.create({
            data: {
              books: { create: [{ title: "a-1" }, { title: "a-2" }] },
              email: "arr@example.test",
              name: "Arr",
            },
            select: { email: true },
          }),
          world.client.author.create({
            data: { email: "arr-2@example.test", name: "Arr2" },
            select: { email: true },
          }),
        ])
      );
      const failing = await outcome(() =>
        world.client.$transaction([
          world.client.author.create({
            data: { email: "arr-3@example.test", name: "Arr3" },
          }),
          world.client.author.create({
            data: {
              books: { create: [{ title: "dup2" }, { title: "dup2" }] },
              email: "arr-4@example.test",
              name: "Arr4",
            },
          }),
        ])
      );
      return { failing, ok, stored: stored(world) };
    });

    assert.equal(observations.candidate.ok, observations.shipped.ok);
    assert.equal(observations.candidate.failing, observations.shipped.failing);
    assert.deepEqual(
      observations.candidate.stored,
      observations.shipped.stored
    );
  });

  test("an array transaction whose member is MULTI-statement behaves the same on both routes (batch-only)", async () => {
    const observations = await onBothRoutes(async (world) => {
      const withSelect = await detailedOutcome(() =>
        world.client.$transaction([
          world.client.author.create({
            data: {
              books: { create: [{ title: "b-1" }, { title: "b-2" }] },
              email: "barr@example.test",
              name: "BArr",
            },
            select: { email: true },
          }),
        ])
      );
      const withoutSelect = await detailedOutcome(() =>
        world.client.$transaction([
          world.client.author.create({
            data: {
              books: { create: [{ title: "c-1" }, { title: "c-2" }] },
              email: "barr2@example.test",
              name: "BArr2",
            },
          }),
        ])
      );
      return { stored: stored(world), withSelect, withoutSelect };
    }, "batch-only");

    assert.deepEqual(observations.candidate, observations.shipped);
  });

  /**
   * A read member beside a MULTI-statement write member. The unit's LX-04 read
   * oracle uses a read-only array; this mixes the two packaging arms.
   */
  test("an array transaction mixing a read and a MULTI-statement write agrees on both routes", async () => {
    const observations = await onBothRoutes(async (world) => {
      await world.client.author.create({
        data: { email: "seed@example.test", name: "Seed" },
      });
      const result = await outcome(() =>
        world.client.$transaction([
          world.client.author.findMany({
            orderBy: { email: "asc" },
            select: { email: true },
          }),
          world.client.author.create({
            data: {
              books: { create: [{ title: "m-1" }, { title: "m-2" }] },
              email: "mixed@example.test",
              name: "Mixed",
            },
            select: { email: true },
          }),
        ])
      );
      return { result, stored: stored(world) };
    });

    assert.equal(observations.candidate.result, observations.shipped.result);
    assert.deepEqual(
      observations.candidate.stored,
      observations.shipped.stored
    );
  });
});
