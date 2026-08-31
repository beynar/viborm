import type { DatabaseAdapter } from "@adapters/database-adapter";
import { SQLiteAdapter } from "@adapters/databases/sqlite/sqlite-adapter";
import { createClient } from "@client/client";
import type { BatchQuery, QueryExecutionContext, QueryResult } from "@drivers";
import { Driver } from "@drivers";
import { getExecutionTransactionPhases } from "@drivers/execution-context";
import { runTransactionLifecycle } from "@drivers/shared/transactions";
import { NestedWriteAssertionError, NotFoundError } from "@errors";
import { s } from "@schema";
import { sql } from "@sql";
import {
  overrideTransactionOperation,
  readTestTransactionOperation,
} from "@tests/fixtures/transaction-operation";
import { afterEach, describe, expect, test } from "vitest";

const record = s.model({
  id: s.int().id().increment(),
  code: s.string().unique(),
  label: s.string(),
});
const schema = { record };

class NativeBatchDriver extends Driver<object, object> {
  readonly adapter: DatabaseAdapter = new SQLiteAdapter();
  override readonly supportsTransactions = false;
  override readonly supportsBatch = true;
  readonly batches: BatchQuery[][] = [];
  assertionIndex: number | undefined;

  constructor() {
    super("sqlite", "legacy-native-coverage");
    this.client = {};
  }

  protected async initClient(): Promise<object> {
    return {};
  }

  protected async closeClient(): Promise<void> {
    // This fixture owns no provider resource.
  }

  protected async execute<T>(): Promise<QueryResult<T>> {
    throw new Error("NativeBatchDriver accepts only batch execution.");
  }

  protected async executeRaw<T>(): Promise<QueryResult<T>> {
    throw new Error("NativeBatchDriver accepts only batch execution.");
  }

  protected async transaction<T>(): Promise<T> {
    throw new Error("NativeBatchDriver has no callback transaction.");
  }

  protected async executeBatch<T>(
    _client: object,
    queries: BatchQuery[]
  ): Promise<QueryResult<T>[]> {
    this.batches.push(queries);
    if (this.assertionIndex !== undefined) {
      throw new NestedWriteAssertionError("guard failed", {
        meta: { statementIndex: this.assertionIndex },
      });
    }
    return queries.map(() => ({ rows: [], rowCount: 1 }));
  }
}

class LifecycleDriver extends Driver<object, object> {
  readonly adapter: DatabaseAdapter = new SQLiteAdapter();
  readonly failurePoint: "commit" | "close";

  constructor(failurePoint: "commit" | "close") {
    super("sqlite", `legacy-${failurePoint}-coverage`);
    this.failurePoint = failurePoint;
    this.client = {};
  }

  protected async initClient(): Promise<object> {
    return {};
  }

  protected async closeClient(): Promise<void> {
    // This fixture owns no provider resource.
  }

  protected async execute<T>(): Promise<QueryResult<T>> {
    return { rows: [], rowCount: 0 };
  }

  protected async executeRaw<T>(): Promise<QueryResult<T>> {
    return { rows: [], rowCount: 0 };
  }

  protected transaction<T>(
    client: object,
    callback: (transaction: object) => Promise<T>,
    context?: QueryExecutionContext
  ): Promise<T> {
    return runTransactionLifecycle({
      begin: () => undefined,
      callback: () => callback(client),
      commit: () => {
        if (this.failurePoint === "commit") throw new Error("commit failed");
      },
      rollback: () => undefined,
      close: () => {
        if (this.failurePoint === "close") throw new Error("close failed");
      },
      phases: getExecutionTransactionPhases(context),
    });
  }
}

const clients: Array<{ $disconnect(): Promise<void> }> = [];

function trackedClient<DriverType extends Driver<object, object>>(
  driver: DriverType
) {
  const client = createClient({ schema, driver });
  clients.push(client);
  return client;
}

afterEach(async () => {
  for (const client of clients.splice(0)) await client.$disconnect();
});

describe("legacy native array composition", () => {
  test("offsets a multi-statement member guard within the shared native batch", async () => {
    const driver = new NativeBatchDriver();
    const client = trackedClient(driver);
    const source = client.record.createMany({
      data: [
        { code: "generated", label: "first" },
        { id: 40, code: "explicit", label: "second" },
      ],
    });
    const prepared = await readTestTransactionOperation(source)?.prepareBatch();
    if (!prepared || prepared.queries.length !== 2) {
      throw new Error("expected a two-statement createMany batch");
    }
    const guarded = overrideTransactionOperation(source, {
      prepareBatch: async () => ({
        ...prepared,
        guards: [
          {
            queryIndex: 1,
            premise: "exists",
            probe: sql`SELECT 1`,
            failure: {
              kind: "notFound",
              message: "second create premise changed",
              raceable: false,
            },
            model: "record",
            operation: "createMany",
          },
        ],
      }),
    });
    driver.assertionIndex = 2;

    await expect(
      client.$transaction([client.record.findMany(), guarded])
    ).rejects.toMatchObject({
      name: NotFoundError.name,
      message: expect.stringContaining("No record record found"),
      meta: { model: "record", operation: "createMany" },
    });
    expect(driver.batches).toHaveLength(1);
    expect(driver.batches[0]).toHaveLength(3);
  });

  test("observes a multi-statement legacy member as one successful application", async () => {
    const driver = new NativeBatchDriver();
    const base = trackedClient(driver);
    const completions: string[] = [];
    const client = base.$extends({
      name: "legacy-observation-coverage",
      async observe(unit, proceed) {
        try {
          const value = await proceed();
          completions.push(`${unit.kind}:${unit.operation}:success`);
          return value;
        } catch (error) {
          completions.push(`${unit.kind}:${unit.operation}:failure`);
          throw error;
        }
      },
    });

    await expect(
      client.$transaction([
        client.record.createMany({
          data: [
            { code: "generated", label: "first" },
            { id: 41, code: "explicit", label: "second" },
          ],
        }),
      ])
    ).resolves.toEqual([{ count: 2 }]);
    expect(driver.batches[0]).toHaveLength(2);
    expect(completions).toContain("operation:createMany:success");
    expect(completions).toContain("batch:$transaction([...]):success");
  });
});

describe("observed legacy fallback certainty", () => {
  test.each([
    ["commit", "may-have-committed"],
    ["close", "committed"],
  ] as const)("reports %s-stage failure certainty as %s", async (failurePoint, expectedCertainty) => {
    const base = trackedClient(new LifecycleDriver(failurePoint));
    const facts: Array<string | undefined> = [];
    const client = base.$extends({
      name: `legacy-${failurePoint}-observation`,
      observe(unit, proceed) {
        if (unit.kind !== "batch") return;
        proceed().then((completion) => {
          facts.push(completion.commitCertainty);
        });
      },
    });

    await expect(
      client.$transaction([client.record.findMany()])
    ).rejects.toThrow();
    await Promise.resolve();
    expect(facts).toEqual([expectedCertainty]);
  });
});
