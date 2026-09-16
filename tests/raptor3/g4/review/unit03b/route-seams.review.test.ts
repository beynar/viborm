/**
 * G4-03b independent review probe — the seams the follow-up re-owned.
 *
 * The unit moved three client facts from the shipped operation to the
 * candidate's ONE `engine.prepare(...)` handle:
 *
 *   - `PendingOperation.cacheKeyArgs()` (NS-04) now answers `prepared.args`
 *     instead of `#statementOperation()?.validatedArgs`;
 *   - the query interceptor's `input` (LX-12) answers the same object instead
 *     of `RoutedExecutableOperation.validatedArgs`;
 *   - the driver receives the client's own trusted execution context (LX-13),
 *     which is what carries the resolved statement-transform chain.
 *
 * The unit's own oracles exercise ONE verb each (`findMany` for the cache key,
 * `create`/`findMany` for the interceptor, an observe-only statement hook).
 * These probes widen all three: every read verb for the key, every client verb
 * for the interceptor payload, and a statement transform that REWRITES the SQL
 * rather than only observing it.
 */

import assert from "node:assert/strict";
import { VibORM, type VibORMClient } from "@client/client";
import type { BatchQuery, QueryResult } from "@drivers";
import { SQLite3Driver } from "@drivers/sqlite3";
import { createCandidateRoute } from "@query-engine/raptor3/route/client-route";
import { s } from "@schema";
import { Sql } from "@sql";
import { createClient } from "@src/index";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import Database from "better-sqlite3";
import { afterEach, describe, test } from "vitest";

const note = s
  .model({
    id: s.int().id().increment(),
    slug: s.string().unique(),
    title: s.string(),
    score: s.int().default(0),
  })
  .map("g4r3b_seam_notes");

const schema = { note };

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
  scenario: (world: World) => Promise<T>
): Promise<{ candidate: T; shipped: T }> {
  const shipped = await scenario(await createWorld("shipped"));
  const candidate = await scenario(await createWorld("candidate"));
  return { candidate, shipped };
}

/** Untyped `$extends`, for definitions the typed surface cannot spell. */
function applyUnsafe<T extends object>(client: T, definition: unknown): T {
  const extend = Reflect.get(client, "$extends") as CallableFunction;
  return Reflect.apply(extend, client, [definition]) as T;
}

/** The seam the official cache reads its key payload from. */
interface KeyedOperation {
  cacheKeyArgs(): Record<string, unknown>;
}

function keyOf(pending: unknown): string {
  try {
    return `ok:${JSON.stringify((pending as KeyedOperation).cacheKeyArgs())}`;
  } catch (error) {
    return `${(error as Error).constructor.name}:${(error as Error).message}`;
  }
}

describe("G4-03b review — the re-owned client seams", () => {
  /**
   * NS-04 across every read verb, not only `findMany`.
   *
   * `cacheKeyArgs()` is the payload the official cache keys an entry on. Two
   * admissions of the same public payload that differ in ANY key are two
   * different cache entries for one query, which is what NS-04 prevents.
   */
  test("the cache-key payload is identical on both routes for every read verb", async () => {
    const observations = await onBothRoutes(async (world) => {
      const client = world.client;
      return {
        aggregate: keyOf(
          client.note.aggregate({ _count: true, where: { score: { gt: 1 } } })
        ),
        count: keyOf(client.note.count()),
        countWhere: keyOf(client.note.count({ where: { slug: "k" } })),
        exist: keyOf(client.note.exist({ where: { slug: "k" } })),
        findFirst: keyOf(
          client.note.findFirst({
            orderBy: { slug: "asc" },
            select: { slug: true },
          })
        ),
        findFirstOrThrow: keyOf(
          client.note.findFirstOrThrow({ where: { slug: "k" } })
        ),
        findManyBare: keyOf(client.note.findMany()),
        findManyPaged: keyOf(
          client.note.findMany({
            orderBy: { slug: "desc" },
            skip: 1,
            take: 2,
            where: { OR: [{ slug: "a" }, { score: { gte: 3 } }] },
          })
        ),
        findUnique: keyOf(client.note.findUnique({ where: { slug: "k" } })),
        findUniqueOrThrow: keyOf(
          client.note.findUniqueOrThrow({ where: { id: 1 } })
        ),
        groupBy: keyOf(client.note.groupBy({ _count: true, by: ["slug"] })),
      };
    });

    assert.deepEqual(observations.candidate, observations.shipped);
  });

  /**
   * LX-12 across every client verb.
   *
   * A query interceptor reads `input` BEFORE `proceed()`, so the payload it
   * sees is the admitting owner's publication. The unit's own cell installs one
   * interceptor on `create`; this one installs the whole family.
   */
  test("the interceptor payload is identical on both routes for every client verb", async () => {
    const verbs = [
      "aggregate",
      "count",
      "create",
      "createMany",
      "delete",
      "deleteMany",
      "exist",
      "findFirst",
      "findFirstOrThrow",
      "findMany",
      "findUnique",
      "findUniqueOrThrow",
      "groupBy",
      "update",
      "updateMany",
      "upsert",
    ] as const;

    const observations = await onBothRoutes(async (world) => {
      const seen: string[] = [];
      const handlers: Record<string, unknown> = {};
      for (const verb of verbs) {
        handlers[verb] = async ({
          input,
          proceed,
        }: {
          input: unknown;
          proceed: () => Promise<unknown>;
        }) => {
          seen.push(`${verb}=${JSON.stringify(input)}`);
          return proceed();
        };
      }
      const client = applyUnsafe(world.client, {
        name: "payload-witness",
        query: { note: handlers },
      });

      const outcomes: string[] = [];
      const script: [string, () => PromiseLike<unknown>][] = [
        [
          "create",
          () => client.note.create({ data: { slug: "a", title: "t" } }),
        ],
        [
          "createMany",
          () =>
            client.note.createMany({
              data: [
                { slug: "b", title: "t" },
                { score: 4, slug: "c", title: "t" },
              ],
            }),
        ],
        ["findMany", () => client.note.findMany({ select: { slug: true } })],
        [
          "findFirst",
          () => client.note.findFirst({ where: { score: { gte: 0 } } }),
        ],
        ["findUnique", () => client.note.findUnique({ where: { slug: "b" } })],
        [
          "findUniqueOrThrow",
          () => client.note.findUniqueOrThrow({ where: { slug: "zz" } }),
        ],
        [
          "findFirstOrThrow",
          () => client.note.findFirstOrThrow({ where: { slug: "a" } }),
        ],
        ["count", () => client.note.count({ where: { slug: { not: "a" } } })],
        ["aggregate", () => client.note.aggregate({ _sum: { score: true } })],
        [
          "groupBy",
          () =>
            client.note.groupBy({
              _count: true,
              by: ["slug"],
              orderBy: { slug: "asc" },
            }),
        ],
        ["exist", () => client.note.exist({ where: { slug: "a" } })],
        [
          "update",
          () =>
            client.note.update({ data: { score: 9 }, where: { slug: "a" } }),
        ],
        [
          "updateMany",
          () =>
            client.note.updateMany({
              data: { score: { increment: 1 } },
              where: { slug: { in: ["b", "c"] } },
            }),
        ],
        [
          "upsert",
          () =>
            client.note.upsert({
              create: { slug: "d", title: "t" },
              update: { title: "x" },
              where: { slug: "d" },
            }),
        ],
        ["delete", () => client.note.delete({ where: { slug: "d" } })],
        [
          "deleteMany",
          () => client.note.deleteMany({ where: { slug: { in: ["c"] } } }),
        ],
      ];
      for (const [label, call] of script) {
        try {
          outcomes.push(`${label}=${JSON.stringify(await call())}`);
        } catch (error) {
          outcomes.push(`${label}!${(error as Error).constructor.name}`);
        }
      }
      return { outcomes, seen };
    });

    assert.deepEqual(observations.candidate.seen, observations.shipped.seen);
    assert.deepEqual(
      observations.candidate.outcomes,
      observations.shipped.outcomes
    );
  });

  /**
   * LX-13's other half: a statement transform that REWRITES the statement.
   *
   * The unit's LX-13 cell only OBSERVES (it returns the statement unchanged),
   * so it cannot tell a context that carries the chain from one that carries it
   * but whose rewrite is dropped downstream. A neutral rewrite (a trailing SQL
   * comment) is the falsifier: the text the driver receives must carry it on
   * every statement, on both routes, and the rows must be unchanged.
   */
  test("a statement transform that rewrites SQL reaches the driver on both routes", async () => {
    const observations = await onBothRoutes(async (world) => {
      await world.client.note.createMany({
        data: [
          { slug: "keep", title: "t" },
          { slug: "drop", title: "t" },
        ],
      });
      world.driver.statements.length = 0;
      const client = world.client.$extends({
        name: "statement-rewriter",
        statement({ statement }) {
          const strings = [...statement.strings];
          strings[strings.length - 1] = `${strings.at(-1)} /* rewritten */`;
          return new Sql(strings, [...statement.values]);
        },
      }) as unknown as WorldClient;
      const rows = await client.note.findMany({
        orderBy: { slug: "asc" },
        select: { slug: true },
      });
      await client.note.create({ data: { slug: "added", title: "t" } });
      return {
        rewritten: world.driver.statements.filter((statement) =>
          statement.includes("/* rewritten */")
        ).length,
        rows,
        total: world.driver.statements.length,
      };
    });

    assert.deepEqual(observations.candidate.rows, observations.shipped.rows);
    assert.deepEqual(observations.candidate.rows, [
      { slug: "drop" },
      { slug: "keep" },
    ]);
    // Every statement the driver saw carried the rewrite, on both routes.
    assert.equal(
      observations.shipped.rewritten,
      observations.shipped.total,
      "the shipped route dropped a statement rewrite"
    );
    assert.equal(
      observations.candidate.rewritten,
      observations.candidate.total,
      "the candidate route dropped a statement rewrite"
    );
    assert(observations.candidate.total > 0);
  });
});
