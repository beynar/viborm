/**
 * G4-03 C13 — the candidate reached only through the ordinary client lifecycle.
 *
 * Every case here runs the SAME world twice: once through the shipped public
 * client and once through the private Raptor 3 route
 * (`createCandidateClient`). The oracle is the shipped client's observable
 * behavior — results, error identities and the lifecycle units observers see.
 * A lifecycle event the route fails to produce fails these tests: the observed
 * unit kinds are asserted as exact sequences, not as "at least".
 *
 * Inventory rows: LX-01 (lazy pending operation, memoized preparation),
 * LX-09/LX-11 (default omit, request transforms before admission), LX-10
 * (extension chain order and collisions), LX-12 (query interceptors),
 * LX-13 (statement transforms), LX-14/LX-15 (observers, instrumentation),
 * LX-16/LX-17 (connect/disconnect/dispose, `$driver`, `$schema`,
 * introspection).
 */

import assert from "node:assert/strict";
import type { VibORMClient } from "@client/client";
import type { BatchQuery, QueryResult } from "@drivers";
import { SQLite3Driver } from "@drivers/sqlite3";
import { createCandidateClient } from "@query-engine/raptor3/route/client-route";
import { s } from "@schema";
import { defaultOmit } from "@src/client/exports";
import {
  createClient,
  getOperationPayloadSchema,
  renderOperationResultType,
  validateOperationPayload,
} from "@src/index";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import Database from "better-sqlite3";
import { afterEach, describe, expect, test } from "vitest";

const author = s
  .model({
    id: s.int().id().increment(),
    email: s.string().unique(),
    name: s.string(),
    secret: s.string().default("hidden"),
    score: s.int().default(0),
  })
  .map("g4_route_authors");

const schema = { author };

class WitnessDriver extends SQLite3Driver {
  readonly statements: string[] = [];

  protected override async execute<T>(
    client: Database.Database,
    statement: string,
    parameters: unknown[]
  ): Promise<QueryResult<T>> {
    this.statements.push(statement);
    return super.execute<T>(client, statement, parameters);
  }

  protected override async executeBatch<T>(
    client: Database.Database,
    queries: BatchQuery[]
  ): Promise<QueryResult<T>[]> {
    for (const query of queries) this.statements.push(query.sql);
    return super.executeBatch<T>(client, queries);
  }
}

type WorldClient = VibORMClient<{
  driver: WitnessDriver;
  schema: typeof schema;
}>;

interface World {
  readonly client: WorldClient;
  readonly database: Database.Database;
  readonly driver: WitnessDriver;
}

const worlds: World[] = [];

async function createWorld(route: "shipped" | "candidate"): Promise<World> {
  const database = new Database(":memory:");
  const driver = new WitnessDriver({ client: database });
  const config = { driver, schema };
  const client: WorldClient =
    route === "shipped" ? createClient(config) : createCandidateClient(config);
  const migration = await syncLiveSchema(client);
  if (!migration.applied) throw new Error("The world's schema did not apply");
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

/**
 * Apply an extension without its type gate, the way the shipped extension
 * contracts do: a collision and a write interceptor that never proceeds are
 * both refused at COMPILE time on the typed surface, so the RUNTIME refusal
 * needs an untyped application to reach it.
 */
function applyUnsafe<T extends object>(client: T, definition: unknown): T {
  const extend = Reflect.get(client, "$extends") as CallableFunction;
  return Reflect.apply(extend, client, [definition]) as T;
}

/** Run one scenario on both routes and return both observations. */
async function onBothRoutes<T>(
  scenario: (world: World) => Promise<T>
): Promise<{ candidate: T; shipped: T }> {
  const shipped = await scenario(await createWorld("shipped"));
  const candidate = await scenario(await createWorld("candidate"));
  return { candidate, shipped };
}

describe("G4-03 C13 candidate client lifecycle", () => {
  test("LX-01 a model call is lazy and memoizes one preparation, value and failure", async () => {
    const observations = await onBothRoutes(async (world) => {
      let prepared = 0;
      const client = world.client.$extends({
        name: "counting-request",
        request({ input }) {
          prepared += 1;
          return input;
        },
      });
      const pending = client.author.create({
        data: { email: "lazy@example.test", name: "Lazy" },
      });
      const beforeAwait = world.driver.statements.length;
      const first = await pending;
      const second = await pending;

      let failedPreparations = 0;
      const failing = client.author.create({
        data: { email: 1 as unknown as string, name: "Invalid" },
      });
      const failures: string[] = [];
      for (const _attempt of [0, 1]) {
        try {
          await failing;
        } catch (error) {
          failedPreparations += 1;
          failures.push((error as Error).constructor.name);
        }
      }
      return {
        beforeAwait,
        failedPreparations,
        failures,
        first,
        prepared,
        second,
      };
    });

    assert.equal(observations.candidate.beforeAwait, 0);
    assert.equal(
      observations.candidate.prepared,
      observations.shipped.prepared
    );
    assert.equal(observations.candidate.failedPreparations, 2);
    assert.deepEqual(
      observations.candidate.failures,
      observations.shipped.failures
    );
    assert.deepEqual(observations.candidate.first, observations.shipped.first);
    // The same await answers the same memoized value, never a second execution.
    assert.equal(observations.candidate.first, observations.candidate.second);
  });

  test("LX-09/LX-11 request transforms run once, before admission, and default omit still applies", async () => {
    const observations = await onBothRoutes(async (world) => {
      const seen: unknown[] = [];
      const client = world.client
        .$extends({
          name: "request-transform",
          request: {
            author: {
              create({ input }) {
                seen.push(structuredClone(input));
                return {
                  data: {
                    ...input.data,
                    name: `${input.data.name}-transformed`,
                  },
                };
              },
            },
          },
        })
        .$extends(defaultOmit<typeof schema>()({ author: { secret: true } }));
      const created = await client.author.create({
        data: { email: "transform@example.test", name: "Ada" },
      });
      return { created, seen };
    });

    assert.deepEqual(
      observations.candidate.created,
      observations.shipped.created
    );
    assert.deepEqual(observations.candidate.seen, observations.shipped.seen);
    assert.equal(
      (observations.candidate.created as { name: string }).name,
      "Ada-transformed"
    );
    assert.equal(
      Object.hasOwn(observations.candidate.created as object, "secret"),
      false
    );
  });

  test("LX-10 the extension chain keeps its order and its collision refusal", async () => {
    const observations = await onBothRoutes(async (world) => {
      const order: string[] = [];
      const client = world.client
        .$extends({
          name: "first",
          request: {
            author: {
              findMany({ input }) {
                order.push("first");
                return input;
              },
            },
          },
        })
        .$extends({
          name: "second",
          request: {
            author: {
              findMany({ input }) {
                order.push("second");
                return input;
              },
            },
          },
        });
      await client.author.findMany();
      let collision: string | undefined;
      try {
        applyUnsafe(
          applyUnsafe(client, {
            client: () => ({ $probe: () => 1 }),
            name: "collide-a",
          }),
          { client: () => ({ $probe: () => 2 }), name: "collide-b" }
        );
      } catch (error) {
        collision = (error as Error).constructor.name;
      }
      return { collision, order };
    });

    assert.deepEqual(observations.candidate.order, observations.shipped.order);
    assert.deepEqual(observations.candidate.order, ["first", "second"]);
    assert.equal(
      observations.candidate.collision,
      observations.shipped.collision
    );
  });

  test("LX-12 a query interceptor owns proceed() and short-circuit, and its input is the admitted payload on both routes", async () => {
    const observations = await onBothRoutes(async (world) => {
      const order: string[] = [];
      const seen: unknown[] = [];
      const client = world.client.$extends({
        name: "interceptor",
        query: {
          author: {
            async findMany({ input, proceed }) {
              seen.push(structuredClone(input));
              order.push("findMany:in");
              const rows = await proceed();
              order.push("findMany:out");
              return rows;
            },
            // A READ may answer without proceeding at all.
            findUnique: async () => {
              order.push("findUnique:short-circuit");
              return null;
            },
          },
        },
      });
      // A WRITE that never proceeds is refused by the extension owner; the
      // refusal must read the same on both routes.
      const writing = applyUnsafe(client, {
        name: "write-interceptor",
        query: {
          author: {
            update: async () => {
              order.push("update:no-proceed");
              return { email: "never", id: 0, name: "never" };
            },
          },
        },
      });
      await client.author.create({
        data: { email: "intercepted@example.test", name: "Grace" },
      });
      const rows = await client.author.findMany({
        select: { email: true },
        where: { email: "intercepted@example.test" },
      });
      const selectsBefore = world.driver.statements.length;
      const shortCircuit = await client.author.findUnique({
        where: { email: "intercepted@example.test" },
      });
      const statementsWhileShortCircuited =
        world.driver.statements.length - selectsBefore;
      let writeRefusal: string | undefined;
      try {
        await writing.author.update({
          data: { name: "never" },
          where: { email: "intercepted@example.test" },
        });
      } catch (error) {
        writeRefusal = (error as Error).message;
      }
      const updates = world.driver.statements.filter((statement) =>
        statement.startsWith("UPDATE")
      ).length;
      return {
        order,
        rows,
        seen,
        shortCircuit,
        statementsWhileShortCircuited,
        updates,
        writeRefusal,
      };
    });

    assert.deepEqual(observations.candidate.rows, observations.shipped.rows);
    // Retired from a blocker-B-1 pin by the G4-02 follow-up: both routes now
    // snapshot the payload their own admitting owner produced, and it is the
    // same payload — the candidate's `prepare(...)` publishes its ONE admission
    // before `proceed()` runs, where the route previously had to answer with
    // the client-prepared input. This is also the payload the official cache
    // keys on (`PendingOperation.cacheKeyArgs`), which the NS-04 cell in
    // `route-cache.test.ts` compares directly.
    assert.deepEqual(observations.candidate.seen, observations.shipped.seen);
    assert.deepEqual(observations.candidate.seen, [
      {
        select: { email: true },
        where: { email: { equals: "intercepted@example.test" } },
      },
    ]);
    // The read answered from the interceptor alone.
    assert.equal(observations.candidate.shortCircuit, null);
    assert.equal(observations.shipped.shortCircuit, null);
    assert.equal(observations.candidate.statementsWhileShortCircuited, 0);
    assert.equal(
      observations.candidate.writeRefusal,
      observations.shipped.writeRefusal
    );
    assert.equal(observations.candidate.updates, 0);
    assert.deepEqual(observations.candidate.order, observations.shipped.order);
    assert.deepEqual(observations.candidate.order, [
      "findMany:in",
      "findMany:out",
      "findUnique:short-circuit",
      "update:no-proceed",
    ]);
  });

  /**
   * D-6, decided by Arnaud on 2026-09-15: "accept the normalized payload as the
   * contract" — the candidate's published `context.input` for `upsert` is the
   * one admission, and this cell states it.
   *
   * The candidate admits the WHOLE payload once, and
   * `PendingOperation.#preparedInput` publishes that ONE admission
   * (`src/query-engine/pending-operation.ts:569`): scalar defaults filled into
   * the `create` arm, the `update` arm's assignments normalized to `{ set: … }`.
   * That is the payload that actually runs, which is the LX-12 rule for every
   * other verb — `upsert` now obeys it too.
   *
   * Legacy baseline, recorded not asserted: the shipped route validates only
   * the upsert ENVELOPE at construction
   * (`src/query-engine/write-engine/routing.ts`, `case "upsert"`: "the
   * delegated sub-ops still parse raw, and … stays deferred to the taken
   * branch"), so its interceptor sees `create: { email, name }` and
   * `update: { name: "Updated" }` — the caller's arms, exactly as written.
   *
   * Public results, committed state and the whole envelope OUTSIDE the two arms
   * are identical on both routes; those are genuine parity facts and are still
   * asserted. Every other verb agrees on the arms too — the 16-verb parity
   * sweep in `route-admission.test.ts` and the LX-12 cell above cover the rest.
   */
  test("D-6 CONTRACT the interceptor input for upsert is the ONE admission on the candidate route", async () => {
    const observations = await onBothRoutes(async (world) => {
      const seen: Record<string, unknown>[] = [];
      const client = applyUnsafe(world.client, {
        name: "upsert-interceptor",
        query: {
          author: {
            upsert({
              input,
              proceed,
            }: {
              input: Record<string, unknown>;
              proceed: () => Promise<unknown>;
            }) {
              seen.push(structuredClone(input));
              return proceed();
            },
          },
        },
      });
      const call = {
        create: { email: "upsert@example.test", name: "Created" },
        update: { name: "Updated" },
        where: { email: "upsert@example.test" },
      };
      // The insert arm, then the update arm: both publish before proceeding.
      const inserted = await client.author.upsert(call);
      const updated = await client.author.upsert(call);
      return { inserted, seen, updated };
    });

    // The public answers agree — only the PUBLISHED payload diverges.
    assert.deepEqual(
      observations.candidate.inserted,
      observations.shipped.inserted
    );
    assert.deepEqual(
      observations.candidate.updated,
      observations.shipped.updated
    );
    assert.equal(observations.candidate.seen.length, 2);

    // Everything outside the two delegated arms agrees, key for key.
    const envelopeOf = ({
      create: _create,
      update: _update,
      ...envelope
    }: Record<string, unknown>) => envelope;
    assert.deepEqual(
      observations.candidate.seen.map(envelopeOf),
      observations.shipped.seen.map(envelopeOf)
    );

    // THE CONTRACT: the one admission — scalar defaults filled into `create`,
    // assignments normalized in `update`, on the insert arm and the update arm
    // alike.
    const armsOf = ({ create, update }: Record<string, unknown>) => ({
      create,
      update,
    });
    const candidateArms = {
      create: {
        email: "upsert@example.test",
        id: undefined,
        name: "Created",
        score: 0,
        secret: "hidden",
      },
      update: { name: { set: "Updated" } },
    };
    assert.deepEqual(observations.candidate.seen.map(armsOf), [
      candidateArms,
      candidateArms,
    ]);

    // Legacy baseline, recorded not asserted (it must not gate this cell): the
    // shipped route publishes `create: { email, name }` and
    // `update: { name: "Updated" }` on both arms.
  });

  test("LX-13 statement transforms see the same statements on both routes", async () => {
    const observations = await onBothRoutes(async (world) => {
      const observed: string[] = [];
      const client = world.client.$extends({
        name: "statement-observer",
        statement({ statement }) {
          observed.push((statement.strings[0] ?? "").slice(0, 6));
          return statement;
        },
      });
      await client.author.create({
        data: { email: "statements@example.test", name: "Hedy" },
      });
      await client.author.findMany({ select: { email: true } });
      return { observed };
    });

    // Both routes hand the driver the operation's own TRUSTED execution
    // context, which is what carries the resolved extension chain: the route
    // passes `execution.context` and `OperationContext` uses it instead of
    // minting a plain attribution (retired B-4 pin).
    assert.deepEqual(
      observations.candidate.observed,
      observations.shipped.observed
    );
    assert.deepEqual(observations.candidate.observed, ["INSERT", "SELECT"]);
  });

  test("LX-14 every observed unit matches the shipped route, operation and statement alike", async () => {
    const observations = await onBothRoutes(async (world) => {
      const units: string[] = [];
      const completions: Promise<unknown>[] = [];
      const client = world.client.$extends({
        name: "lifecycle-observer",
        observe(unit, proceed) {
          units.push(`${unit.kind}:${unit.operation}`);
          completions.push(proceed());
        },
      });
      await client.author.create({
        data: { email: "observed@example.test", name: "Alan" },
      });
      await client.author.findMany({ select: { email: true } });
      await Promise.all(completions);
      return { units };
    });

    // Retired B-4 pin: the statement, transaction and savepoint units are
    // driver-side observations that read the chain from the execution context,
    // which the candidate now receives, so the WHOLE sequence matches — not
    // just the operation units `PendingOperation` owned all along.
    assert.deepEqual(observations.candidate.units, observations.shipped.units);
    assert.deepEqual(observations.candidate.units, [
      "operation:create",
      "statement:create",
      "operation:findMany",
      "statement:findMany",
    ]);
  });

  test("LX-16/LX-17 lifecycle and introspection stay on the existing owners", async () => {
    const world = await createWorld("candidate");
    await world.client.$connect();
    expect(world.client.$driver).toBe(world.driver);
    expect(world.client.$schema).toBe(schema);
    // Introspection is the schema's own owner and never reaches a route.
    expect(
      getOperationPayloadSchema(schema, "author", "findMany")
    ).toBeDefined();
    expect(
      validateOperationPayload(schema, "author", "findMany", {
        where: { email: "introspected@example.test" },
      })
    ).toEqual({
      where: { email: { equals: "introspected@example.test" } },
    });
    expect(
      typeof renderOperationResultType(schema, "author", "findUnique", {
        where: { id: 1 },
      })
    ).toBe("string");
    // The disposal door is the same function object as `$disconnect`.
    expect(world.client[Symbol.asyncDispose]).toBe(world.client.$disconnect);
  });
});
