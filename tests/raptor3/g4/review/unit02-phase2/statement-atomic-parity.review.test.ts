/**
 * G4-02 phase-2 review — the statement-atomic failure surface.
 *
 *  1. scope item 6: a folded root write's `NotFoundError` carries
 *     `{model, operation}` and nothing else — compared field by field with the
 *     SHIPPED engine's error for the same request, on a transaction-capable and
 *     on a batch-only transport.
 *  2. the G2.9 specimen change: phase 2 rewrote
 *     `tests/raptor3/post-prep/g29-result-progress.test.ts` so the row is now
 *     DURABLE where that specimen used to assert a rollback. The justification
 *     is shipped parity, so this probe measures the shipped engine's own
 *     committed state on the same corrupting driver, independently of the
 *     unit's own cell.
 */
import assert from "node:assert/strict";
import { createClient } from "@client/client";
import type { BatchQuery, QueryExecutionContext, QueryResult } from "@drivers";
import { SQLite3Driver } from "@drivers/sqlite3";
import { createCommandEngine } from "@query-engine/raptor3/commands";
import { s } from "@schema";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import { isRecord } from "@validation/value-guards";
import Database from "better-sqlite3";
import { describe, it } from "vitest";

const entity = s
  .model({ id: s.int().id(), label: s.string() })
  .map("r2_atomic_entities");
const schema = { entity };

class BatchOnlyDriver extends SQLite3Driver {
  override readonly supportsTransactions = false;
  override readonly supportsBatch = true;
}

class CorruptingDriver extends SQLite3Driver {
  armed = false;
  protected override async execute<T>(
    client: Database.Database,
    statement: string,
    parameters: unknown[],
    context?: QueryExecutionContext
  ): Promise<QueryResult<T>> {
    const response = await super.execute<T>(client, statement, parameters);
    if (this.armed)
      for (const row of response.rows)
        if (isRecord(row) && Object.hasOwn(row, "id"))
          Reflect.set(row, "id", "not-an-integer");
    return response;
  }
  protected override async executeBatch<T>(
    client: Database.Database,
    queries: BatchQuery[],
    context?: QueryExecutionContext
  ): Promise<QueryResult<T>[]> {
    const responses = await super.executeBatch<T>(client, queries, context);
    if (this.armed)
      for (const response of responses)
        for (const row of response.rows)
          if (isRecord(row) && Object.hasOwn(row, "id"))
            Reflect.set(row, "id", "not-an-integer");
    return responses;
  }
}

type Build = (database: Database.Database) => SQLite3Driver;

async function withWorld<T>(
  build: Build,
  body: (
    world: {
      database: Database.Database;
      driver: SQLite3Driver;
      client: Record<string, Record<string, (args?: unknown) => Promise<unknown>>>;
      candidate: ReturnType<typeof createCommandEngine>;
    }
  ) => Promise<T>
): Promise<T> {
  const database = new Database(":memory:");
  const driver = build(database);
  const client = createClient({ schema, driver });
  assert.equal((await syncLiveSchema(client)).applied, true);
  try {
    return await body({
      database,
      driver,
      client: client as unknown as Record<
        string,
        Record<string, (args?: unknown) => Promise<unknown>>
      >,
      candidate: createCommandEngine({ schema, driver }),
    });
  } finally {
    await client.$disconnect();
    database.close();
  }
}

function failureShape(error: unknown): unknown {
  const failure = error as Error & { code?: string; meta?: object };
  return {
    constructor: failure.constructor.name,
    name: failure.name,
    code: failure.code,
    message: failure.message,
    meta: { ...failure.meta },
  };
}

async function missing(
  build: Build,
  operation: "update" | "delete",
  engine: "shipped" | "candidate"
): Promise<unknown> {
  return await withWorld(build, async (world) => {
    const args =
      operation === "update"
        ? { where: { id: 99 }, data: { label: "z" } }
        : { where: { id: 99 } };
    try {
      await (engine === "shipped"
        ? world.client.entity?.[operation]?.(args)
        : world.candidate.execute("entity", operation, args));
      return "no refusal";
    } catch (error) {
      return failureShape(error);
    }
  });
}

describe("G4-02 review — the folded root write's missing-row failure", () => {
  for (const [transport, build] of [
    ["transaction-capable", (d: Database.Database) => new SQLite3Driver({ client: d })],
    ["batch-only", (d: Database.Database) => new BatchOnlyDriver({ client: d })],
  ] as [string, Build][]) {
    for (const operation of ["update", "delete"] as const) {
      it(`${operation} on a ${transport} driver carries the shipped meta`, async () => {
        const shipped = await missing(build, operation, "shipped");
        const candidate = await missing(build, operation, "candidate");
        assert.deepEqual(
          candidate,
          shipped,
          `candidate ${JSON.stringify(candidate)}\nshipped   ${JSON.stringify(shipped)}`
        );
      });
    }
  }
});

describe("G4-02 review — the G2.9 specimen's durability claim", () => {
  it("leaves the same committed state on both engines when the provider corrupts the returned row", async () => {
    const run = async (engine: "shipped" | "candidate") =>
      await withWorld(
        (database) => new CorruptingDriver({ client: database }),
        async (world) => {
          (world.driver as CorruptingDriver).armed = true;
          let answer: string;
          try {
            const value =
              engine === "shipped"
                ? await world.client.entity?.create?.({
                    data: { id: 1, label: "written" },
                  })
                : await world.candidate.execute("entity", "create", {
                    data: { id: 1, label: "written" },
                  });
            answer = `ok:${JSON.stringify(value)}`;
          } catch (error) {
            answer = `${(error as Error).constructor.name}`;
          }
          return {
            answer,
            rows: world.database
              .prepare("SELECT id,label FROM r2_atomic_entities")
              .all(),
          };
        }
      );
    const shipped = await run("shipped");
    const candidate = await run("candidate");
    assert.deepEqual(
      candidate,
      shipped,
      `candidate ${JSON.stringify(candidate)}\nshipped   ${JSON.stringify(shipped)}`
    );
  });
});
