/**
 * G4-03 C13 — one admission, candidate results, candidate refusals.
 *
 * The route never parses a payload: it hands the client-prepared payload to the
 * candidate's `prepare(...)`, which admits it exactly once through
 * `EngineSchema.admit` and publishes that one admission to every consumer. The
 * counter below is the falsifier for that claim — a second admission runs the
 * field transform twice.
 *
 * Also pins what the route must NOT do: fall back to the shipped engine for any
 * verb (every client family reaches the candidate, and the route records each
 * one), and re-shape the candidate's results or error identities.
 */

import assert from "node:assert/strict";
import { VibORM, type VibORMClient } from "@client/client";
import type { QueryResult } from "@drivers";
import { SQLite3Driver } from "@drivers/sqlite3";
import { UniqueConstraintError, ValidationError } from "@errors";
import {
  type ClientOperationRoute,
  createCandidateRoute,
} from "@query-engine/raptor3/route/client-route";
import { s } from "@schema";
import { validateClientSchemaOrThrow } from "@schema/validation/validator";
import { createClient } from "@src/index";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import { createResolvedSchemaRegistry } from "@validation/builder";
import v from "@validation/primitives/v";
import Database from "better-sqlite3";
import { afterEach, describe, expect, test } from "vitest";

let admissions: string[] = [];

const note = s
  .model({
    id: s.int().id().increment(),
    slug: s.string().unique(),
    title: s.string().schema(
      v.string({
        transform(value) {
          admissions.push(value);
          return `${value}-admitted`;
        },
      })
    ),
  })
  .map("g4_admission_notes");

const schema = { note };

class CountingDriver extends SQLite3Driver {
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

type WorldClient = VibORMClient<{
  driver: CountingDriver;
  schema: typeof schema;
}>;

interface World {
  readonly client: WorldClient;
  readonly database: Database.Database;
  readonly driver: CountingDriver;
  /** Every operation the route was asked for, in order. Empty on the shipped route. */
  readonly routeCalls: string[];
}

const worlds: World[] = [];

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

async function createWorld(route: "shipped" | "candidate"): Promise<World> {
  const database = new Database(":memory:");
  const driver = new CountingDriver({ client: database });
  const config = { driver, schema };
  const routeCalls: string[] = [];
  const client: WorldClient =
    route === "shipped"
      ? createClient(config)
      : VibORM.create(config, (clientSchema, clientDriver, resolved) =>
          countingRoute(
            createCandidateRoute(clientSchema, clientDriver, resolved),
            routeCalls
          )
        );
  const migration = await syncLiveSchema(client);
  if (!migration.applied) throw new Error("The world's schema did not apply");
  driver.statements.length = 0;
  routeCalls.length = 0;
  admissions = [];
  const world: World = { client, database, driver, routeCalls };
  worlds.push(world);
  return world;
}

afterEach(async () => {
  for (const world of worlds.splice(0)) {
    await world.client.$disconnect();
    world.database.close();
  }
});

describe("G4-03 C13 candidate admission, results and refusals", () => {
  test("one admitted input is evaluated exactly once, request transform first", async () => {
    const world = await createWorld("candidate");
    const client = world.client.$extends({
      name: "request-first",
      request: {
        note: {
          create({ input }) {
            return {
              data: { ...input.data, title: `${input.data.title}-req` },
            };
          },
        },
      },
    });
    const created = await client.note.create({
      data: { slug: "once", title: "value" },
    });
    // Exactly one evaluation, of the request-transformed value.
    assert.deepEqual(admissions, ["value-req"]);
    assert.equal((created as { title: string }).title, "value-req-admitted");

    admissions = [];
    await client.note.createMany({
      data: [
        { slug: "bulk-a", title: "a" },
        { slug: "bulk-b", title: "b" },
      ],
    });
    assert.deepEqual(admissions, ["a", "b"]);
  });

  test("the same admission count as the shipped route for the same payload", async () => {
    const shipped = await createWorld("shipped");
    await shipped.client.note.create({ data: { slug: "s", title: "value" } });
    const shippedAdmissions = [...admissions];
    const candidate = await createWorld("candidate");
    await candidate.client.note.create({ data: { slug: "c", title: "value" } });
    assert.deepEqual(admissions, shippedAdmissions);
    assert.deepEqual(admissions, ["value"]);
  });

  /**
   * The B-1 seam's own falsifier.
   *
   * `preparedArgs` is read only when something in the lifecycle asks for the
   * payload before `proceed()` — a query interceptor, or the official cache
   * key. So the "exactly once" cells above cannot see a second admission
   * hiding behind that seam: this cell installs the interceptor that makes the
   * route answer it, and asserts BOTH that the transform ran once and that the
   * answer is the admitted payload, not the client-prepared one.
   */
  test("the payload published before proceed() is the ONE admission, on both routes", async () => {
    const seen: Record<string, unknown>[] = [];

    const observe = async (route: "shipped" | "candidate") => {
      const world = await createWorld(route);
      seen.length = 0;
      const client = world.client.$extends({
        name: "payload-witness",
        query: {
          note: {
            async create({ input, proceed }) {
              seen.push(structuredClone(input));
              return proceed();
            },
          },
        },
      });
      // Each route gets its own in-memory database, so the same slug on both
      // keeps the two payloads comparable field by field.
      const created = await client.note.create({
        data: { slug: "payload", title: "value" },
      });
      return { admissions: [...admissions], created, seen: [...seen] };
    };

    const shipped = await observe("shipped");
    const candidate = await observe("candidate");

    // One evaluation of the field transform on each route — a second admission
    // behind `preparedArgs` would push "value" twice here.
    assert.deepEqual(candidate.admissions, ["value"]);
    assert.deepEqual(candidate.admissions, shipped.admissions);
    // And the payload the interceptor saw is the ADMITTED one on both routes.
    assert.deepEqual(candidate.seen, shipped.seen);
    assert.equal(
      (candidate.seen[0] as { data: { title: string } }).data.title,
      "value-admitted"
    );
    assert.equal(
      (candidate.created as { title: string }).title,
      "value-admitted"
    );
  });

  /**
   * Retired from the r1 "unsupported verb" pin by the G4-02 follow-up.
   *
   * Every client operation family is now admitted by the candidate — the
   * `Raptor 3 G1 operation is not implemented` refusal is unreachable through
   * the public surface, which is what made the old assertion both unreachable
   * (the loop threw on `findFirst` first) and false (root `delete` had been
   * admitted). The replacement is the positive claim the pin existed to guard:
   * every verb is ANSWERED BY THE ROUTE — `routeCalls` names each one, so a
   * silent fallback to the shipped engine would leave a hole in it — and every
   * verb answers exactly what the shipped route answers.
   */
  test("every client verb is answered by the route and agrees with the shipped route", async () => {
    const script = (client: WorldClient) =>
      [
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
                { slug: "c", title: "t" },
              ],
            }),
        ],
        [
          "findMany",
          () =>
            client.note.findMany({
              orderBy: { slug: "asc" },
              select: { slug: true, title: true },
            }),
        ],
        [
          "findFirst",
          () =>
            client.note.findFirst({
              select: { slug: true },
              where: { slug: "a" },
            }),
        ],
        [
          "findUnique",
          () =>
            client.note.findUnique({
              select: { slug: true },
              where: { slug: "b" },
            }),
        ],
        [
          "findUniqueOrThrow",
          () => client.note.findUniqueOrThrow({ where: { slug: "absent" } }),
        ],
        [
          "findFirstOrThrow",
          () =>
            client.note.findFirstOrThrow({
              select: { slug: true },
              where: { slug: "a" },
            }),
        ],
        ["count", () => client.note.count()],
        ["aggregate", () => client.note.aggregate({ _count: true })],
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
            client.note.update({
              data: { title: "u" },
              select: { title: true },
              where: { slug: "a" },
            }),
        ],
        [
          "updateMany",
          () =>
            client.note.updateMany({
              data: { title: "m" },
              where: { slug: { in: ["b", "c"] } },
            }),
        ],
        [
          "upsert",
          () =>
            client.note.upsert({
              create: { slug: "d", title: "t" },
              select: { slug: true },
              update: { title: "x" },
              where: { slug: "d" },
            }),
        ],
        [
          "delete",
          () =>
            client.note.delete({
              select: { slug: true },
              where: { slug: "d" },
            }),
        ],
        [
          "deleteMany",
          () => client.note.deleteMany({ where: { slug: { in: ["b", "c"] } } }),
        ],
      ] as const;

    const observe = async (route: "shipped" | "candidate") => {
      const world = await createWorld(route);
      const outcomes: string[] = [];
      for (const [label, call] of script(world.client)) {
        try {
          outcomes.push(`${label}=${JSON.stringify(await call())}`);
        } catch (error) {
          outcomes.push(`${label}!${(error as Error).constructor.name}`);
        }
      }
      return {
        labels: script(world.client).map(([label]) => `note.${label}`),
        outcomes,
        routeCalls: [...world.routeCalls],
        stored: world.database
          .prepare("SELECT slug, title FROM g4_admission_notes ORDER BY id")
          .all(),
      };
    };

    const shipped = await observe("shipped");
    const candidate = await observe("candidate");

    assert.deepEqual(candidate.outcomes, shipped.outcomes);
    assert.deepEqual(candidate.stored, shipped.stored);
    // No fallback: the route was asked for every one of the sixteen verbs, in
    // order, and the shipped client consulted no route at all.
    assert.deepEqual(candidate.routeCalls, candidate.labels);
    assert.equal(candidate.labels.length, 16);
    assert.deepEqual(shipped.routeCalls, []);
  });

  test("results are fresh containers and errors keep their public identity", async () => {
    const world = await createWorld("candidate");
    await world.client.note.create({ data: { slug: "fresh", title: "t" } });
    const first = await world.client.note.findMany({ select: { slug: true } });
    const second = await world.client.note.findMany({ select: { slug: true } });
    assert.deepEqual(first, second);
    assert.notEqual(first, second);
    assert.notEqual(first[0], second[0]);
    (first[0] as { slug: string }).slug = "mutated";
    assert.deepEqual(second, [{ slug: "fresh" }]);

    await expect(
      world.client.note.create({ data: { slug: "fresh", title: "t" } })
    ).rejects.toMatchObject({ name: UniqueConstraintError.name });
    await expect(
      world.client.note.create({
        data: { slug: 1 as unknown as string, title: "t" },
      })
    ).rejects.toMatchObject({ name: ValidationError.name });
  });

  /**
   * B-3 — the candidate admits through the client's OWN resolved registry.
   *
   * `VibORM`'s constructor composes the topology index and the schema registry
   * once and hands both to the route factory; `EngineSchema` takes them by
   * identity instead of hydrating and validating a second time. The Proxy below
   * is the falsifier for the CONSUMPTION half: it wraps the exact registry the
   * client would hand over, and an engine that built its own would never touch
   * it.
   */
  test("B-3 the candidate admits through the schema registry the client handed it", async () => {
    const database = new Database(":memory:");
    const driver = new CountingDriver({ client: database });
    const index = validateClientSchemaOrThrow(schema);
    const reads: string[] = [];
    const registry = new Proxy(createResolvedSchemaRegistry(schema, index), {
      get(target, property, receiver) {
        reads.push(String(property));
        return Reflect.get(target, property, receiver);
      },
    });
    const client: WorldClient = VibORM.create(
      { driver, schema },
      (clientSchema, clientDriver) =>
        createCandidateRoute(clientSchema, clientDriver, { index, registry })
    );
    const migration = await syncLiveSchema(client);
    if (!migration.applied) throw new Error("The world's schema did not apply");
    worlds.push({ client, database, driver, routeCalls: [] });
    reads.length = 0;

    await client.note.create({ data: { slug: "resolved", title: "t" } });
    assert(
      reads.length > 0,
      "the candidate never read the handed-over registry"
    );
  });

  test("a findUnique miss answers null on both routes", async () => {
    const shipped = await createWorld("shipped");
    const candidate = await createWorld("candidate");
    for (const world of [shipped, candidate]) {
      assert.equal(
        await world.client.note.findUnique({ where: { slug: "absent" } }),
        null
      );
    }
  });
});
