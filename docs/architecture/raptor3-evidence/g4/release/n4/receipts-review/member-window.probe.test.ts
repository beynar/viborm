/** REVIEW PROBE (lens A) — N4 #25: what does a failing captured mutation report? */
import assert from "node:assert/strict";
import { createClient } from "@client/client";
import type { BatchQuery, QueryResult } from "@drivers";
import { s } from "@schema";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import type Database from "better-sqlite3";
import { describe, it } from "vitest";
import {
  BatchOnlyDriver,
  NoIndexBatchOnlyDriver,
} from "../../parity/batch-only-drivers";

class NoIndexNonReturning extends NoIndexBatchOnlyDriver {
  constructor() {
    super();
    this.adapter.capabilities.supportsReturning = false;
  }
}

class FailingWriteDriver extends BatchOnlyDriver {
  failOn?: RegExp;
  constructor() {
    super();
    this.adapter.capabilities.supportsReturning = false;
  }
  protected override async execute<T>(
    client: Database.Database,
    statement: string,
    parameters: unknown[],
    context?: never
  ): Promise<QueryResult<T>> {
    if (this.failOn?.test(statement))
      throw new Error("injected provider failure");
    return super.execute<T>(client, statement, parameters, context);
  }
  protected override async executeBatch<T>(
    client: Database.Database,
    queries: BatchQuery[]
  ): Promise<QueryResult<T>[]> {
    return super.executeBatch<T>(client, queries);
  }
}

const user = s
  .model({ id: s.string().id(), name: s.string(), posts: s.toMany(() => post).name("pmwA") })
  .map("pmw_users");
const post = s
  .model({
    id: s.string().id(),
    title: s.string(),
    userId: s.string().nullable(),
    author: s.toOne(() => user).fields("userId").references("id").name("pmwA"),
  })
  .map("pmw_posts");
const schema = { user, post };

describe("PROBE N4-25 member window", () => {
  it("a captured bulk mutation whose write fails reports ...", async () => {
    const driver = new FailingWriteDriver();
    const client = createClient({ schema, driver });
    await syncLiveSchema(client);
    await client.user.create({ data: { id: "u1", name: "O" } });
    await client.post.create({ data: { id: "p1", title: "A", userId: "u1" } });
    await client.post.create({ data: { id: "p2", title: "B", userId: "u1" } });
    driver.failOn = /^DELETE FROM "pmw_posts"/;
    let raised: unknown;
    try {
      await client.post.deleteMany({
        where: { userId: "u1" },
        select: { id: true },
      });
    } catch (error) {
      raised = error;
    }
    console.log("class:", (raised as Error)?.constructor?.name);
    console.log("message:", (raised as Error)?.message);
    console.log(
      "meta:",
      JSON.stringify((raised as { meta?: unknown })?.meta ?? null, null, 1)
    );
    await driver.disconnect();
    assert.ok(raised);
  });

  it("the SAME failure on the NON-captured (set-oriented) bulk delete reports ...", async () => {
    const driver = new FailingWriteDriver();
    const client = createClient({ schema, driver });
    await syncLiveSchema(client);
    await client.user.create({ data: { id: "u1", name: "O" } });
    await client.post.create({ data: { id: "p1", title: "A", userId: "u1" } });
    driver.failOn = /^DELETE FROM "pmw_posts"/;
    let raised: unknown;
    try {
      await client.post.deleteMany({ where: { userId: "u1" } });
    } catch (error) {
      raised = error;
    }
    console.log("[no-select] class:", (raised as Error)?.constructor?.name);
    console.log(
      "[no-select] meta:",
      JSON.stringify((raised as { meta?: unknown })?.meta ?? null, null, 1)
    );
    await driver.disconnect();
    assert.ok(raised);
  });

  it("a stale capture on a NO-INDEX batch transport still names the sentence", async () => {
    const driver = new NoIndexNonReturning();
    const client = createClient({ schema, driver });
    await syncLiveSchema(client);
    await client.user.create({ data: { id: "u1", name: "O" } });
    await client.post.create({ data: { id: "p1", title: "A", userId: "u1" } });
    await client.post.create({ data: { id: "p2", title: "B", userId: "u1" } });
    driver.plant = (database) => {
      database.exec(`DELETE FROM "pmw_posts" WHERE "id" = 'p1'`);
    };
    let raised: unknown;
    try {
      await client.post.deleteMany({
        where: { userId: "u1" },
        select: { id: true },
      });
    } catch (error) {
      raised = error;
    }
    console.log("[no-index] class:", (raised as Error)?.constructor?.name);
    console.log("[no-index] message:", (raised as Error)?.message);
    console.log(
      "[no-index] meta:",
      JSON.stringify((raised as { meta?: unknown })?.meta ?? null)
    );
    console.log(
      "[no-index] rows:",
      JSON.stringify(await client.post.findMany({ orderBy: { id: "asc" } }))
    );
    await driver.disconnect();
    assert.ok(raised);
  });
});
