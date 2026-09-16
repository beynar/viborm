/**
 * G4-03b independent review probe — LX-12 for `upsert`.
 *
 * Minimized from `route-seams.review.test.ts`, whose all-verb interceptor sweep
 * found exactly one verb whose published payload differs between the routes.
 *
 * The shipped route validates only the UPSERT ENVELOPE at construction
 * (`src/query-engine/write-engine/routing.ts`, `case "upsert"`: "the delegated
 * sub-ops still parse raw, and … stays deferred to the taken branch"), so the
 * `create` and `update` arms reach a query interceptor exactly as the caller
 * wrote them. The candidate admits the WHOLE payload once
 * (`EngineSchema.admit`), which fills scalar defaults into the `create` arm and
 * normalizes the `update` arm's assignments to `{ set: … }`.
 *
 * `PendingOperation.#preparedInput()` now answers that admission on the routed
 * path, so `context.input` — the documented LX-12 surface — changes shape for
 * `upsert` alone.
 */

import assert from "node:assert/strict";
import { VibORM, type VibORMClient } from "@client/client";
import { SQLite3Driver } from "@drivers/sqlite3";
import { createCandidateRoute } from "@query-engine/raptor3/route/client-route";
import { s } from "@schema";
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
  .map("g4r3b_upsert_notes");

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
  closers.push(async () => {
    await client.$disconnect();
    database.close();
  });
  return { client, database };
}

afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});

function applyUnsafe<T extends object>(client: T, definition: unknown): T {
  const extend = Reflect.get(client, "$extends") as CallableFunction;
  return Reflect.apply(extend, client, [definition]) as T;
}

async function observe(route: "shipped" | "candidate") {
  const world = await createWorld(route);
  const seen: unknown[] = [];
  const client = applyUnsafe(world.client, {
    name: "upsert-payload-witness",
    query: {
      note: {
        async upsert({
          input,
          proceed,
        }: {
          input: unknown;
          proceed: () => Promise<unknown>;
        }) {
          seen.push(structuredClone(input));
          return proceed();
        },
      },
    },
  });
  // Insert arm, then update arm, so both are published.
  const inserted = await client.note.upsert({
    create: { slug: "u", title: "created" },
    update: { title: "updated" },
    where: { slug: "u" },
  });
  const updated = await client.note.upsert({
    create: { slug: "u", title: "created" },
    update: { title: "updated" },
    where: { slug: "u" },
  });
  return { inserted, seen, updated };
}

describe("G4-03b review — LX-12 payload for upsert", () => {
  test("a query interceptor on upsert sees the same input on both routes", async () => {
    const shipped = await observe("shipped");
    const candidate = await observe("candidate");

    // The public results agree …
    assert.deepEqual(candidate.inserted, shipped.inserted);
    assert.deepEqual(candidate.updated, shipped.updated);
    // … and LX-12 claims the published payload does too.
    assert.deepEqual(
      candidate.seen,
      shipped.seen,
      "the interceptor payload for `upsert` differs between the routes"
    );
  });
});
