/**
 * G4-02 independent review — does the candidate admit once per client
 * operation through the REAL route when the array owner asks for a package
 * first and then executes?
 *
 * `createCommandEngine.execute` and `.prepareBatch` each build their OWN
 * prepared handle (`src/query-engine/raptor3/commands/index.ts`), so the
 * memoized admission is per-handle, not per-operation.
 */

import assert from "node:assert/strict";
import { VibORM } from "@client/client";
import type { QueryExecutionContext, QueryResult } from "@drivers";
import { SQLite3Driver } from "@drivers/sqlite3";
import { createCandidateRoute } from "@query-engine/raptor3/route/client-route";
import { s } from "@schema";
import { createClient } from "@src/index";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import v from "@validation/primitives/v";
import Database from "better-sqlite3";
import { afterEach, describe, it } from "vitest";

let transforms: string[] = [];

const note = s
  .model({
    id: s.int().id().increment(),
    label: s.string().schema(
      v.string({
        transform(value) {
          transforms.push(value);
          return value;
        },
      })
    ),
  })
  .map("rv2f_notes");

const schema = { note };

class Interactive extends SQLite3Driver {
  readonly statements: string[] = [];
  protected override async execute<T>(
    client: Database.Database,
    statement: string,
    parameters: unknown[],
    context?: QueryExecutionContext
  ): Promise<QueryResult<T>> {
    this.statements.push(statement);
    return super.execute<T>(client, statement, parameters);
  }
}

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});

async function world(route: "shipped" | "candidate") {
  const database = new Database(":memory:");
  const driver = new Interactive({ client: database });
  const config = { driver, schema };
  const client =
    route === "shipped"
      ? createClient(config)
      : VibORM.create(config, createCandidateRoute);
  const migration = await syncLiveSchema(client);
  if (!migration.applied) throw new Error("schema did not apply");
  closers.push(async () => {
    await client.$disconnect();
    database.close();
  });
  return { client, driver, database };
}

describe("G4-02 review — route admission count for an array member", () => {
  it("an array member admits the same number of times on both routes", async () => {
    const shippedWorld = await world("shipped");
    transforms = [];
    // biome-ignore lint/suspicious/noExplicitAny: structural array seam
    await (shippedWorld.client as any).$transaction([
      shippedWorld.client.note.create({ data: { label: "value" } }),
    ]);
    const shipped = [...transforms];

    const candidateWorld = await world("candidate");
    transforms = [];
    // biome-ignore lint/suspicious/noExplicitAny: structural array seam
    await (candidateWorld.client as any).$transaction([
      candidateWorld.client.note.create({ data: { label: "value" } }),
    ]);
    const candidate = [...transforms];

    // eslint-disable-next-line no-console
    console.log(
      "ROUTEADMIT",
      JSON.stringify({ shipped, candidate })
    );
    assert.deepEqual(candidate, shipped);
  });
});
