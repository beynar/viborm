/**
 * G4-03b independent review probe — the ONE admission, from every consumer.
 *
 * `RoutedCandidateOperation.preparedArgs` is a getter over the candidate's
 * `PreparedOperation.args`, which memoizes `EngineSchema.admit`. Three client
 * consumers can reach it before execution — a query interceptor, the official
 * cache key, and the array owner's `prepareAdmission` — and the operation then
 * executes from the same handle.
 *
 * The unit's falsification 4 records that the estate could not catch a double
 * admission until the author wrote an interceptor cell. These probes reach the
 * seam through the OTHER consumers, and through a cache-wrapped operation whose
 * source and wrapper share one `OperationResolution`.
 */

import assert from "node:assert/strict";
import { VibORM, type VibORMClient } from "@client/client";
import { SQLite3Driver } from "@drivers/sqlite3";
import { createCandidateRoute } from "@query-engine/raptor3/route/client-route";
import { s } from "@schema";
import { createClient } from "@src/index";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import v from "@validation/primitives/v";
import Database from "better-sqlite3";
import { afterEach, describe, test } from "vitest";

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
  .map("g4r3b_seam_admission");

const schema = { note };

type WorldClient = VibORMClient<{
  driver: SQLite3Driver;
  schema: typeof schema;
}>;

const closers: (() => Promise<void>)[] = [];

async function createWorld(route: "shipped" | "candidate") {
  const database = new Database(":memory:");
  const driver = new SQLite3Driver({ client: database });
  const config = { driver, schema };
  const client = (
    route === "shipped"
      ? createClient(config)
      : VibORM.create(config, createCandidateRoute)
  ) as WorldClient;
  const migration = await syncLiveSchema(client);
  if (!migration.applied) throw new Error("schema did not apply");
  admissions = [];
  closers.push(async () => {
    await client.$disconnect();
    database.close();
  });
  return { client, database, driver };
}

afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});

interface KeyedOperation {
  cacheKeyArgs(): Record<string, unknown>;
}

async function outcome<T>(run: () => PromiseLike<T>): Promise<string> {
  try {
    return `ok:${JSON.stringify(await run())}`;
  } catch (error) {
    return `${(error as Error).constructor.name}`;
  }
}

describe("G4-03b review — one admission from every consumer", () => {
  /**
   * The cache-key seam, then execution, on the SAME pending operation. A second
   * admission behind `preparedArgs` pushes the transformed value twice.
   */
  test("reading the cache key and then executing admits exactly once on both routes", async () => {
    const observe = async (route: "shipped" | "candidate") => {
      const world = await createWorld(route);
      await world.client.note.create({
        data: { slug: "seed", title: "value" },
      });
      admissions = [];
      const pending = world.client.note.findMany({
        select: { title: true },
        where: { title: "value" },
      });
      const key = (pending as unknown as KeyedOperation).cacheKeyArgs();
      const secondKey = (pending as unknown as KeyedOperation).cacheKeyArgs();
      const rows = await pending;
      return { admissions: [...admissions], key, rows, secondKey };
    };

    const shipped = await observe("shipped");
    const candidate = await observe("candidate");
    assert.deepEqual(candidate.admissions, shipped.admissions);
    assert.deepEqual(candidate.key, shipped.key);
    assert.deepEqual(candidate.secondKey, shipped.secondKey);
    assert.deepEqual(candidate.rows, shipped.rows);
    // Non-vacuous: the transform really ran, and only once.
    assert.equal(candidate.admissions.length, 1);
  });

  /**
   * The array owner calls `prepareAdmission` before it prepares each member,
   * then the member executes. Two admissions there would run the field
   * transform twice for one array member.
   */
  test("an array member admits exactly once on both routes", async () => {
    const observe = async (route: "shipped" | "candidate") => {
      const world = await createWorld(route);
      admissions = [];
      const result = await outcome(() =>
        world.client.$transaction([
          world.client.note.create({
            data: { slug: "arr", title: "value" },
            select: { title: true },
          }),
        ])
      );
      return { admissions: [...admissions], result };
    };

    const shipped = await observe("shipped");
    const candidate = await observe("candidate");
    assert.deepEqual(candidate.admissions, shipped.admissions);
    assert.equal(candidate.result, shipped.result);
    assert.equal(candidate.admissions.length, 1);
  });

  /** Awaiting one pending operation twice must run and admit it once. */
  test("awaiting the same pending operation twice admits and runs once on both routes", async () => {
    const observe = async (route: "shipped" | "candidate") => {
      const world = await createWorld(route);
      admissions = [];
      const pending = world.client.note.create({
        data: { slug: "twice", title: "value" },
        select: { title: true },
      });
      const first = await outcome(() => pending);
      const second = await outcome(() => pending);
      return {
        admissions: [...admissions],
        first,
        second,
        stored: world.database
          .prepare("SELECT slug FROM g4r3b_seam_admission ORDER BY id")
          .all(),
      };
    };

    const shipped = await observe("shipped");
    const candidate = await observe("candidate");
    assert.deepEqual(candidate, shipped);
    assert.equal(candidate.admissions.length, 1);
    assert.equal(candidate.stored.length, 1);
  });

  /** Two root operations in flight at once keep independent envelopes. */
  test("two concurrent root writes behave the same on both routes", async () => {
    const observe = async (route: "shipped" | "candidate") => {
      const world = await createWorld(route);
      admissions = [];
      const results = await Promise.allSettled([
        world.client.note.create({
          data: { slug: "par-1", title: "value" },
          select: { slug: true },
        }),
        world.client.note.create({
          data: { slug: "par-2", title: "value" },
          select: { slug: true },
        }),
        world.client.note.create({
          data: { slug: "par-1", title: "value" },
          select: { slug: true },
        }),
      ]);
      return {
        admissions: admissions.length,
        results: results.map((result) =>
          result.status === "fulfilled"
            ? `ok:${JSON.stringify(result.value)}`
            : `${(result.reason as Error).constructor.name}`
        ),
        stored: world.database
          .prepare("SELECT slug FROM g4r3b_seam_admission ORDER BY slug")
          .all(),
      };
    };

    const shipped = await observe("shipped");
    const candidate = await observe("candidate");
    assert.deepEqual(candidate, shipped);
  });

  /** A query interceptor that throws BEFORE proceed() must not run any SQL. */
  test("an interceptor that throws before proceed leaves the same state on both routes", async () => {
    const observe = async (route: "shipped" | "candidate") => {
      const world = await createWorld(route);
      admissions = [];
      const failure = new Error("interceptor refused");
      const client = world.client.$extends({
        name: "throwing-interceptor",
        query: {
          note: {
            create() {
              throw failure;
            },
          },
        },
      }) as unknown as WorldClient;
      const result = await outcome(() =>
        client.note.create({ data: { slug: "never", title: "value" } })
      );
      return {
        admissions: admissions.length,
        result,
        stored: world.database
          .prepare("SELECT slug FROM g4r3b_seam_admission ORDER BY id")
          .all(),
      };
    };

    const shipped = await observe("shipped");
    const candidate = await observe("candidate");
    assert.deepEqual(candidate, shipped);
    assert.deepEqual(candidate.stored, []);
  });
});
