/**
 * G4-03 C13 — transactions, arrays and raw through the candidate route.
 *
 * The transaction, array and raw owners are the existing ones; the route only
 * decides which driver the candidate borrows. Each case runs on both routes and
 * compares public results, database state and error identities.
 *
 * Inventory rows: LX-02 (callback transaction), LX-03 (nested savepoint),
 * LX-04 (array transaction: sequential fallback and native package),
 * LX-05/LX-06 + NS-03 (raw bypass is never interpreted by the route),
 * NS-05 (the exact bound driver executes), RF-09 (callback transactions are
 * refused on a non-interactive transport; unsupported options are refused).
 */

import assert from "node:assert/strict";
import { VibORM, type VibORMClient } from "@client/client";
import type { BatchQuery, QueryResult } from "@drivers";
import { SQLite3Driver } from "@drivers/sqlite3";
import { TransactionError, UniqueConstraintError } from "@errors";
import {
  type ClientOperationRoute,
  createCandidateRoute,
} from "@query-engine/raptor3/route/client-route";
import { s } from "@schema";
import { createClient, sql } from "@src/index";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import Database from "better-sqlite3";
import { afterEach, describe, expect, test } from "vitest";

const author = s
  .model({
    id: s.int().id().increment(),
    email: s.string().unique(),
    name: s.string(),
    books: s.toMany(() => book),
  })
  .map("g4_tx_authors");

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
  .map("g4_tx_books");

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
  readonly batches: BatchQuery[][] = [];
  override readonly supportsTransactions = false;
  override readonly supportsBatch = true;

  protected override async executeBatch<T>(
    client: Database.Database,
    queries: BatchQuery[]
  ): Promise<QueryResult<T>[]> {
    this.batches.push(queries);
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
  readonly routeCalls: string[];
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
  const routeCalls: string[] = [];
  const config = { driver, schema };
  const client: WorldClient =
    route === "shipped"
      ? createClient(config)
      : VibORM.create(config, (clientSchema, clientDriver) =>
          countingRoute(
            createCandidateRoute(clientSchema, clientDriver),
            routeCalls
          )
        );
  const migration = await syncLiveSchema(client);
  if (!migration.applied) throw new Error("The world's schema did not apply");
  driver.statements.length = 0;
  routeCalls.length = 0;
  const world: World = { client, database, driver, routeCalls };
  worlds.push(world);
  return world;
}

/** Record every operation the route is asked for, without changing one. */
function countingRoute(
  route: ClientOperationRoute,
  calls: string[]
): ClientOperationRoute {
  return {
    operation(model, requestedOperation, args) {
      calls.push(`${model["~"].names.ts}.${requestedOperation}`);
      return route.operation(model, requestedOperation, args);
    },
  };
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

function storedAuthors(world: World): unknown[] {
  return world.database
    .prepare("SELECT email FROM g4_tx_authors ORDER BY id")
    .all();
}

describe("G4-03 C13 candidate transactions, arrays and raw", () => {
  test("LX-02/NS-05 one callback transaction commits, and a throw rolls every member back", async () => {
    const observations = await onBothRoutes(async (world) => {
      const committed = await world.client.$transaction(async (tx) => {
        await tx.author.create({
          data: { email: "committed@example.test", name: "Ada" },
        });
        return tx.author.findMany({ select: { email: true } });
      });
      const rollback = new Error("caller rollback");
      let rejection: unknown;
      try {
        await world.client.$transaction(async (tx) => {
          await tx.author.create({
            data: { email: "rolled-back@example.test", name: "Grace" },
          });
          throw rollback;
        });
      } catch (error) {
        rejection = error;
      }
      return { committed, rejection, stored: storedAuthors(world) };
    });

    assert.deepEqual(
      observations.candidate.committed,
      observations.shipped.committed
    );
    assert.deepEqual(observations.candidate.committed, [
      { email: "committed@example.test" },
    ]);
    assert.equal(
      (observations.candidate.rejection as Error).message,
      "caller rollback"
    );
    assert.deepEqual(
      observations.candidate.stored,
      observations.shipped.stored
    );
    assert.deepEqual(observations.candidate.stored, [
      { email: "committed@example.test" },
    ]);
  });

  test("LX-02 a failed operation inside a callback transaction rolls back only itself", async () => {
    const observations = await onBothRoutes(async (world) => {
      const failure = await world.client.$transaction(async (tx) => {
        await tx.author.create({
          data: { email: "keeper@example.test", name: "Keeper" },
        });
        let caught: string | undefined;
        try {
          await tx.author.create({
            data: {
              books: { create: [{ title: "first" }, { title: "first" }] },
              email: "partial@example.test",
              name: "Partial",
            },
          });
        } catch (error) {
          caught = (error as Error).constructor.name;
        }
        return caught;
      });
      return {
        books: world.database
          .prepare("SELECT title FROM g4_tx_books ORDER BY id")
          .all(),
        failure,
        stored: storedAuthors(world),
      };
    });

    assert.equal(observations.candidate.failure, observations.shipped.failure);
    // The caller's transaction survived, keeping only the first author, and the
    // failed operation left neither its author row nor its first book behind.
    assert.deepEqual(observations.candidate.stored, [
      { email: "keeper@example.test" },
    ]);
    assert.deepEqual(observations.candidate.books, []);
    assert.deepEqual(
      observations.candidate.stored,
      observations.shipped.stored
    );
    assert.deepEqual(observations.candidate.books, observations.shipped.books);
  });

  test("LX-03 a nested transaction is a savepoint that keeps the outer effects", async () => {
    const observations = await onBothRoutes(async (world) => {
      const inner = new Error("inner rollback");
      let rejection: string | undefined;
      await world.client.$transaction(async (tx) => {
        await tx.author.create({
          data: { email: "outer@example.test", name: "Outer" },
        });
        try {
          await tx.$transaction(async (nested) => {
            await nested.author.create({
              data: { email: "inner@example.test", name: "Inner" },
            });
            throw inner;
          });
        } catch (error) {
          rejection = (error as Error).message;
        }
      });
      return { rejection, stored: storedAuthors(world) };
    });

    assert.equal(observations.candidate.rejection, "inner rollback");
    assert.deepEqual(
      observations.candidate.stored,
      observations.shipped.stored
    );
    assert.deepEqual(observations.candidate.stored, [
      { email: "outer@example.test" },
    ]);
  });

  test("LX-04 an array transaction keeps admission order, per-member results and atomicity", async () => {
    const observations = await onBothRoutes(async (world) => {
      const results = await world.client.$transaction([
        world.client.author.create({
          data: { email: "array-one@example.test", name: "One" },
          select: { email: true },
        }),
        world.client.author.createMany({
          data: [
            { email: "array-two@example.test", name: "Two" },
            { email: "array-three@example.test", name: "Three" },
          ],
        }),
      ]);
      let rejection: string | undefined;
      try {
        await world.client.$transaction([
          world.client.author.create({
            data: { email: "array-four@example.test", name: "Four" },
          }),
          world.client.author.create({
            // The unique collision is the second member: the first must not
            // survive the array's rollback.
            data: { email: "array-one@example.test", name: "Collide" },
          }),
        ]);
      } catch (error) {
        rejection = (error as Error).constructor.name;
      }
      return { rejection, results, stored: storedAuthors(world) };
    });

    assert.deepEqual(
      observations.candidate.results,
      observations.shipped.results
    );
    assert.deepEqual(observations.candidate.results, [
      { email: "array-one@example.test" },
      { count: 2 },
    ]);
    assert.equal(
      observations.candidate.rejection,
      observations.shipped.rejection
    );
    assert.deepEqual(
      observations.candidate.stored,
      observations.shipped.stored
    );
    assert.deepEqual(observations.candidate.stored, [
      { email: "array-one@example.test" },
      { email: "array-two@example.test" },
      { email: "array-three@example.test" },
    ]);
  });

  test("LX-04 a batch-only driver packages candidate operations through the array owner", async () => {
    const observations = await onBothRoutes(async (world) => {
      const results = await world.client.$transaction([
        world.client.author.createMany({
          data: [
            { email: "packaged-one@example.test", name: "One" },
            { email: "packaged-two@example.test", name: "Two" },
          ],
        }),
        world.client.author.deleteMany({
          where: { email: "packaged-two@example.test" },
        }),
      ]);
      return {
        batches: (world.driver as BatchOnlyDriver).batches.length,
        results,
        stored: storedAuthors(world),
      };
    }, "batch-only");

    assert.deepEqual(
      observations.candidate.results,
      observations.shipped.results
    );
    assert.deepEqual(observations.candidate.results, [
      { count: 2 },
      { count: 1 },
    ]);
    assert.deepEqual(
      observations.candidate.stored,
      observations.shipped.stored
    );
    // One native batch carried both members' packages.
    assert.equal(observations.candidate.batches, 1);
  });

  /**
   * LX-04's READ half, retired from a divergence pin (r3 finding 2) into a
   * parity oracle by the G4-02 follow-up.
   *
   * On a batch-only driver the array owner asks each member for one prepared
   * statement (`owner.prepare`) and, when there is none, for a package
   * (`owner.prepareBatch`). `PendingOperation.#resolveSinglePlan` answers
   * `undefined` for every routed operation, so a candidate member is always
   * asked for a package — and since G4-02 item 12 the candidate packages a
   * READ as well as a write. The array therefore succeeds on both routes, with
   * the same rows, in one native batch.
   */
  test("LX-04 an array transaction containing a read is packaged on a batch-only driver on both routes", async () => {
    const observations = await onBothRoutes(async (world) => {
      await world.client.author.create({
        data: { email: "read-array@example.test", name: "Ada" },
      });
      const batchesBefore = (world.driver as BatchOnlyDriver).batches.length;
      let outcome: string;
      try {
        outcome = `ok:${JSON.stringify(
          await world.client.$transaction([
            world.client.author.findMany({ select: { email: true } }),
          ])
        )}`;
      } catch (error) {
        outcome = `${(error as Error).constructor.name}:${(error as Error).message}`;
      }
      return {
        batches:
          (world.driver as BatchOnlyDriver).batches.length - batchesBefore,
        outcome,
      };
    }, "batch-only");

    assert.equal(observations.candidate.outcome, observations.shipped.outcome);
    assert.equal(
      observations.candidate.outcome,
      'ok:[[{"email":"read-array@example.test"}]]'
    );
    // One native batch carried the read on both routes.
    assert.equal(observations.candidate.batches, observations.shipped.batches);
    assert.equal(observations.candidate.batches, 1);
  });

  /**
   * D-5, decided by Arnaud on 2026-09-15: "accepted" — the refusal removal
   * stands, and the candidate's answer is the contract this cell states.
   *
   * A MULTI-statement write as an array member on a BATCH-ONLY driver is
   * PACKAGED atomically: `PendingOperation.#resolveSinglePlan` answers
   * `undefined` for every routed operation, so the array owner asks the route
   * for a package (`prepareBatch`), and the candidate's package carries the
   * whole multi-statement write, which the one native batch then commits.
   *
   * Legacy baseline, recorded not asserted: the shipped route REFUSES the same
   * request — `OperationExecutor.prepareSharedBatch`
   * (`src/query-engine/write-engine/OperationExecutor.ts:1515`) rejects a plan
   * whose steps use the insertId scratch with `TransactionError:
   * query-engine-v2 cannot merge an insertId-scratch operation into a shared
   * driver batch.`, and with no interactive transport there is no sequential
   * fallback, so the array fails and writes nothing. The decision retires that
   * refusal; this cell no longer fails when the shipped route moves, and it
   * still fails the moment the CANDIDATE stops packaging.
   *
   * The same scenario on an INTERACTIVE driver agrees on both routes (both fall
   * through to the array owner's sequential `executeWith` arm) — a genuine
   * parity fact, still asserted, and the reason the contract names the
   * batch-only substrate explicitly.
   */
  test("D-5 CONTRACT a MULTI-statement array member is packaged atomically on a batch-only driver", async () => {
    // `batches` exists only on the batch-only driver; the interactive run below
    // reads 0 - 0 and asserts nothing about packaging.
    const batchesOf = (subject: World) =>
      (subject.driver as BatchOnlyDriver).batches?.length ?? 0;
    const multiStatementMember = async (world: World) => {
      const batchesBefore = batchesOf(world);
      let outcome: string;
      try {
        outcome = `ok:${JSON.stringify(
          await world.client.$transaction([
            world.client.author.create({
              data: {
                books: { create: [{ title: "d5-1" }, { title: "d5-2" }] },
                email: "d5@example.test",
                name: "Divergent",
              },
              select: { email: true },
            }),
          ])
        )}`;
      } catch (error) {
        outcome = `${(error as Error).constructor.name}: ${(error as Error).message}`;
      }
      return {
        batches: batchesOf(world) - batchesBefore,
        books: world.database
          .prepare("SELECT title FROM g4_tx_books ORDER BY id")
          .all(),
        outcome,
        stored: storedAuthors(world),
      };
    };
    const observations = await onBothRoutes(multiStatementMember, "batch-only");

    // On an INTERACTIVE driver the same member AGREES on both routes: the array
    // owner falls through to its sequential `executeWith` arm on both, so there
    // is no packaging question to answer. The contract below applies only where
    // that fallback does not exist.
    const interactive = await onBothRoutes(multiStatementMember, "interactive");
    assert.equal(interactive.candidate.outcome, interactive.shipped.outcome);
    assert.equal(
      interactive.candidate.outcome,
      'ok:[{"email":"d5@example.test"}]'
    );

    // THE CONTRACT: one native batch, committed rows, the array's own answer.
    assert.equal(
      observations.candidate.outcome,
      'ok:[{"email":"d5@example.test"}]'
    );
    assert.equal(observations.candidate.batches, 1);
    assert.deepEqual(observations.candidate.stored, [
      { email: "d5@example.test" },
    ]);
    assert.deepEqual(observations.candidate.books, [
      { title: "d5-1" },
      { title: "d5-2" },
    ]);

    // Legacy baseline, recorded not asserted (it must not gate this cell): the
    // shipped route answers `TransactionError: query-engine-v2 cannot merge an
    // insertId-scratch operation into a shared driver batch.`, with `batches`
    // 0, no author row and no book row.
  });

  /**
   * LX-14 inside a caller transaction, retired from a divergence pin (r3
   * finding 1) into a parity oracle by the G4-02 follow-up.
   *
   * The route no longer opens a region of its own. Inside
   * `$transaction(callback)` it TRANSFERS the right to open one
   * (`operationRegion` on the borrowed binding), and the candidate applies the
   * same envelope rule it applies everywhere: an operation that reaches its
   * terminal statement having issued no other runs that statement directly. So
   * a statement-atomic write inside a caller transaction opens nothing on
   * either route, and an observer sees the same three units.
   */
  test("LX-14 a statement-atomic write inside a callback transaction opens no region on either route", async () => {
    const observations = await onBothRoutes(async (world) => {
      const units: string[] = [];
      const completions: Promise<unknown>[] = [];
      const client = world.client.$extends({
        name: "envelope-observer",
        observe(unit, proceed) {
          units.push(`${unit.kind}:${unit.operation}`);
          completions.push(proceed());
        },
      });
      await client.$transaction(async (tx) => {
        await tx.author.create({
          data: { email: "envelope@example.test", name: "Ada" },
        });
      });
      await Promise.all(completions);
      return { units };
    });

    assert.deepEqual(observations.candidate.units, observations.shipped.units);
    assert.deepEqual(observations.candidate.units, [
      "transaction:$transaction(callback)",
      "operation:create",
      "statement:create",
    ]);
  });

  /**
   * The other half of the transferred region: a MULTI-statement write inside a
   * caller transaction opens EXACTLY ONE region on both routes.
   *
   * The shipped executor opens it in `runTransactionScope`; the candidate opens
   * the one the route transferred. Counting savepoint units rather than
   * comparing whole sequences keeps this an envelope oracle and not a pin on
   * either engine's physical plan — the two engines write the same rows with a
   * different number of statements.
   */
  test("LX-14 a multi-statement write inside a callback transaction opens exactly one region on either route", async () => {
    const observations = await onBothRoutes(async (world) => {
      const units: string[] = [];
      const completions: Promise<unknown>[] = [];
      const client = world.client.$extends({
        name: "multi-envelope-observer",
        observe(unit, proceed) {
          units.push(`${unit.kind}:${unit.operation}`);
          completions.push(proceed());
        },
      });
      await client.$transaction(async (tx) => {
        await tx.author.create({
          data: {
            books: { create: [{ title: "one" }, { title: "two" }] },
            email: "multi@example.test",
            name: "Multi",
          },
        });
      });
      await Promise.all(completions);
      return {
        savepoints: units.filter((unit) => unit.startsWith("savepoint:"))
          .length,
        statements: units.filter((unit) => unit.startsWith("statement:"))
          .length,
        stored: storedAuthors(world),
      };
    });

    assert.equal(
      observations.candidate.savepoints,
      observations.shipped.savepoints
    );
    assert.equal(observations.candidate.savepoints, 1);
    assert(observations.candidate.statements > 1);
    assert.deepEqual(
      observations.candidate.stored,
      observations.shipped.stored
    );
  });

  /**
   * The STATE and CALLER-OUTCOME half of the same envelope question, retired
   * from a divergence pin (repair 2, review follow-up finding 9) into a parity
   * oracle by the G4-02 follow-up.
   *
   * With the region gone, a statement-atomic write runs as a DIRECT statement
   * on the caller's transaction driver on BOTH routes, and the base driver
   * tracks a direct statement with `poisonOnFailure = true`
   * (`src/drivers/driver.ts`), which marks the caller's scope rollback-only. So
   * a failing member poisons the caller's transaction identically: the next
   * operation rejects with the same error, `$transaction` rejects, and nothing
   * the callback wrote commits.
   *
   * This is NOT the multi-statement case the LX-02 oracle above covers, where
   * each route opens its own savepoint and the member rolls back alone.
   */
  test("LX-02 a FAILING statement-atomic write inside a callback transaction poisons the caller's transaction on both routes", async () => {
    const observations = await onBothRoutes(async (world) => {
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
            await tx.author.create({
              data: { email: "taken@example.test", name: "Duplicate" },
            });
          } catch (error) {
            inner = (error as Error).constructor.name;
          }
          // The caller catches the failure and keeps using its transaction.
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
      return { afterWrite, inner, outer, stored: storedAuthors(world) };
    });

    assert.equal(observations.candidate.inner, observations.shipped.inner);
    assert.equal(
      observations.candidate.afterWrite,
      observations.shipped.afterWrite
    );
    assert.equal(observations.candidate.outer, observations.shipped.outer);
    assert.deepEqual(
      observations.candidate.stored,
      observations.shipped.stored
    );

    // The exact shared answer: the member's own error, the caller's poisoned
    // scope, the rejected `$transaction`, and only the pre-transaction row.
    assert.equal(observations.candidate.inner, UniqueConstraintError.name);
    assert.equal(observations.candidate.afterWrite, UniqueConstraintError.name);
    assert.equal(observations.candidate.outer, UniqueConstraintError.name);
    assert.deepEqual(observations.candidate.stored, [
      { email: "taken@example.test" },
    ]);
  });

  test("RF-09 a callback transaction stays refused on a non-interactive transport", async () => {
    const observations = await onBothRoutes(async (world) => {
      let refusal: { message: string; name: string } | undefined;
      try {
        await world.client.$transaction(async (tx) => {
          await tx.author.findMany();
        });
      } catch (error) {
        refusal = {
          message: (error as Error).message,
          name: (error as Error).constructor.name,
        };
      }
      return { refusal };
    }, "batch-only");

    assert.deepEqual(
      observations.candidate.refusal,
      observations.shipped.refusal
    );
    assert.equal(observations.candidate.refusal?.name, TransactionError.name);
  });

  test("LX-05/LX-06/NS-03 raw SQL bypasses the route entirely", async () => {
    const world = await createWorld("candidate");
    await world.client.author.create({
      data: { email: "raw@example.test", name: "Raw" },
    });
    const routeCallsAfterModelWrite = [...world.routeCalls];
    const rows = await world.client.$queryRaw<{ email: string }[]>(
      sql`SELECT email FROM g4_tx_authors ORDER BY id`
    );
    const affected = await world.client.$executeRawUnsafe(
      "UPDATE g4_tx_authors SET name = ? WHERE email = ?",
      "Renamed",
      "raw@example.test"
    );
    expect(rows).toEqual([{ email: "raw@example.test" }]);
    expect(affected).toBe(1);
    // Raw is a physical statement: the route is never asked for an operation.
    assert.deepEqual(world.routeCalls, routeCallsAfterModelWrite);
    assert.deepEqual(world.routeCalls, ["author.create"]);
  });

  test("NS-05 two clients over one database keep their own bound drivers", async () => {
    const left = await createWorld("candidate");
    const right = await createWorld("candidate");
    await Promise.all([
      left.client.$transaction(async (tx) => {
        await tx.author.create({
          data: { email: "left@example.test", name: "Left" },
        });
      }),
      right.client.$transaction(async (tx) => {
        await tx.author.create({
          data: { email: "right@example.test", name: "Right" },
        });
      }),
    ]);
    assert.deepEqual(storedAuthors(left), [{ email: "left@example.test" }]);
    assert.deepEqual(storedAuthors(right), [{ email: "right@example.test" }]);
    assert.deepEqual(left.routeCalls, ["author.create"]);
    assert.deepEqual(right.routeCalls, ["author.create"]);
  });
});
