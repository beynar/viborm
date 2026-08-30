import { createClient } from "@client/client";
import { QueryEngineError, QueryError } from "@errors";
import { s } from "@schema";
import { sql } from "@sql";
import type { QueryExecutionContext } from "@src/drivers/driver";
import { NeonHTTPDriver } from "@src/drivers/neon-http";
import type {
  BatchQuery,
  CommittedBatchNotification,
  QueryResult,
} from "@src/drivers/types";
import { beforeEach, describe, expect, test, vi } from "vitest";

interface FakeNeonState {
  directOptions: unknown[];
  directResults: unknown[];
  events: string[];
  results: unknown;
  transactionError: Error | undefined;
}

const fakeNeonState = vi.hoisted<FakeNeonState>(() => ({
  directOptions: [],
  directResults: [],
  events: [],
  results: undefined,
  transactionError: undefined,
}));

vi.mock("@neondatabase/serverless", () => ({
  neon: () => {
    const query = async (sql: string, _params: unknown[], options: unknown) => {
      fakeNeonState.directOptions.push(options);
      const directResult = fakeNeonState.directResults.shift();
      if (directResult !== undefined) {
        fakeNeonState.events.push(`direct:${sql}`);
        return directResult;
      }
      throw new Error(
        "The callback seam must use the native transaction batch"
      );
    };
    return Object.assign(query, {
      transaction: (buildQueries: unknown) => {
        fakeNeonState.events.push("transaction-start");
        if (typeof buildQueries !== "function") {
          return Promise.reject(
            new Error("Expected a Neon transaction query builder")
          );
        }
        buildQueries((sql: string, params: unknown[] = []) => {
          fakeNeonState.events.push(`statement:${sql}`);
          return { parameterizedQuery: { query: sql, params } };
        });
        return Promise.resolve().then(() => {
          if (fakeNeonState.transactionError) {
            fakeNeonState.events.push("transaction-rejected");
            throw fakeNeonState.transactionError;
          }
          fakeNeonState.events.push("transaction-resolved");
          return fakeNeonState.results;
        });
      },
    });
  },
  types: {
    getTypeParser: () => (value: string) => value,
  },
}));

/**
 * RESIDUAL PACKAGE H, unit H2 — Neon HTTP ordered committed segments remain disabled.
 *
 * A ROOT dynamic series may use the driver's awaited native batches even while the strong
 * committed-segment capability remains false. The gated fake below proves that local
 * executor order: the operation reaches `_executeBatch`, stays pending while that promise
 * is pending, and observes its rejection only after release.
 *
 * The fake native client proves only local driver-code order. Once its transaction promise
 * resolves, `executeBatch` awaits the committed notification before cardinality checks or
 * statement-result parsing; a rejected transaction never notifies. A fake cannot prove that
 * Neon durably committed, preserved atomic order and visibility, or attributed a hosted
 * error correctly.
 *
 * `supportsOrderedCommittedSegments` therefore stays inherited false. It denotes the
 * stronger acknowledged-commit and precise-progress contract, not basic awaited batch
 * ordering. Activation still needs live durability, visibility, normalization, and
 * failure-attribution evidence. It is not a one-boolean change.
 */
const REACHED_PROVIDER = "NEON CLIENT CONSTRUCTED";
const REACHED_BATCH = "NEON BATCH RELEASED";
/** What the base driver wraps a failed `initClient` in; the positive control's evidence. */
const CONNECTION_FAILED = "Database connection failed";

class SentinelNeonDriver extends NeonHTTPDriver {
  clientRequests = 0;

  protected override initClient(): Promise<never> {
    this.clientRequests += 1;
    return Promise.reject(new Error(REACHED_PROVIDER));
  }
}

class AwaitedBatchNeonDriver extends NeonHTTPDriver {
  readonly events: string[] = [];
  private readonly batchGate = (() => {
    let release: (() => void) | undefined;
    const promise = new Promise<void>((resolve) => {
      release = resolve;
    });
    return {
      promise,
      release: () => {
        if (!release) {
          throw new Error("batch gate was not initialized");
        }
        release();
      },
    };
  })();

  release(): void {
    this.batchGate.release();
  }

  override async _executeBatch<T>(
    _queries: BatchQuery[]
  ): Promise<QueryResult<T>[]> {
    this.events.push("batch-entered");
    await this.batchGate.promise;
    this.events.push("batch-released");
    throw new Error(REACHED_BATCH);
  }
}

/** Test-only exposure of the protected native-batch seam. */
class CallbackSeamNeonDriver extends NeonHTTPDriver {
  async executeNativeBatchForTest<T>(
    queries: BatchQuery[],
    context: QueryExecutionContext,
    committed: CommittedBatchNotification
  ): Promise<QueryResult<T>[]> {
    const client = await this.initClient();
    const executeWithCommitted: (
      activeClient: typeof client,
      activeQueries: BatchQuery[],
      activeContext: QueryExecutionContext,
      notification: CommittedBatchNotification
    ) => Promise<QueryResult<T>[]> = this.executeBatch.bind(this);
    return executeWithCommitted(client, queries, context, committed);
  }
}

const CALLBACK_QUERY: BatchQuery = {
  sql: 'INSERT INTO "h2_probe" ("value") VALUES ($1)',
  params: [1],
};

const validNeonResult = () => ({
  fields: [],
  command: "INSERT",
  rowCount: 1,
  rows: [],
  rowAsArray: false,
});

function neonResult(
  rows: Record<string, unknown>[],
  command: "INSERT" | "SELECT" | "UPDATE",
  rowCount = rows.length
) {
  return {
    fields: [],
    command,
    rowCount,
    rows,
    rowAsArray: false,
  };
}

const seriesSchema = (() => {
  const author = s
    .model({
      id: s.string().id(),
      name: s.string(),
      posts: s.toMany(() => post),
    })
    .map("h2_authors");

  const post = s
    .model({
      id: s.string().id(),
      title: s.string(),
      authorId: s.string().nullable(),
      author: s
        .toOne(() => author)
        .fields("authorId")
        .references("id"),
    })
    .map("h2_posts");

  return { author, post };
})();

const providerEvidenceSchema = {
  entry: s
    .model({
      id: s.string().id(),
      label: s.string(),
    })
    .map("p1_neon_entries"),
  generatedEntry: s
    .model({
      id: s.int().id().increment(),
      label: s.string().unique(),
    })
    .map("p4_neon_generated_entries"),
};

const driverFor = () => {
  const driver = new SentinelNeonDriver({
    // No real network is dialed: `initClient` is the sentinel. The realistic spelling
    // ensures the provider-bound control is not a malformed-configuration result.
    databaseUrl: "postgresql://user:pw@db.neon.invalid/neondb",
  });
  return {
    driver,
    client: createClient({ schema: seriesSchema, driver }) as any,
  };
};

const RELATION_BEARING_ROWS = [
  { id: "a1", name: "one", posts: { create: { id: "p1", title: "t" } } },
];

describe("H2 — Neon HTTP declares no ordered committed segments", () => {
  beforeEach(() => {
    fakeNeonState.directOptions = [];
    fakeNeonState.directResults = [];
    fakeNeonState.events = [];
    fakeNeonState.results = [validNeonResult()];
    fakeNeonState.transactionError = undefined;
  });

  test("typed direct execution requests object-row full results", async () => {
    fakeNeonState.directResults = [
      neonResult([{ second: 2, first: 1 }], "SELECT"),
    ];
    const driver = new NeonHTTPDriver({ databaseUrl: "fake://neon" });

    const result = await driver._execute<Record<string, unknown>>(
      sql`SELECT 2 AS second, 1 AS first`
    );

    expect(result).toEqual({
      rows: [{ second: 2, first: 1 }],
      rowCount: 1,
    });
    expect(Object.keys(result.rows[0] ?? {})).toEqual(["second", "first"]);
    expect(fakeNeonState.directOptions).toEqual([
      { arrayMode: false, fullResults: true },
    ]);
  });

  test("raw direct execution retains named provider rows", async () => {
    const providerRow = { raw_value: 9 };
    fakeNeonState.directResults = [neonResult([providerRow], "SELECT")];
    const driver = new NeonHTTPDriver({ databaseUrl: "fake://neon" });

    const result = await driver._executeRaw("SELECT 9 AS raw_value");

    expect(result.rows[0]).toBe(providerRow);
    expect(fakeNeonState.directOptions).toEqual([
      { arrayMode: false, fullResults: true },
    ]);
  });

  test("the capability is false, beside the two that are true", () => {
    const { driver } = driverFor();
    expect(driver.supportsOrderedCommittedSegments).toBe(false);
    // The pair that makes the question live at all: no interactive transaction, but a
    // real atomic batch. Without both, the flag would be moot rather than unproven.
    expect(driver.supportsTransactions).toBe(false);
    expect(driver.supportsBatch).toBe(true);
  });

  test("raw and model operations share one native Neon array transaction", async () => {
    fakeNeonState.results = [
      neonResult([], "UPDATE", 1),
      neonResult([{ id: "ordered", label: "after" }], "SELECT"),
      neonResult([{ id: "ordered", label: "after" }], "SELECT"),
    ];
    const driver = new NeonHTTPDriver({ databaseUrl: "fake://neon" });
    const client = createClient({ schema: providerEvidenceSchema, driver });

    const [affected, modelRow, rawRows] = await client.$transaction([
      client.$executeRaw`
        UPDATE p1_neon_entries
        SET label = ${"after"}
        WHERE id = ${"ordered"}
      `,
      client.entry.findUniqueOrThrow({ where: { id: "ordered" } }),
      client.$queryRaw<{ id: string; label: string }>`
        SELECT id, label
        FROM p1_neon_entries
        WHERE label = ${"after"}
      `,
    ]);

    expect(affected).toBe(1);
    expect(modelRow).toEqual({ id: "ordered", label: "after" });
    expect(rawRows).toEqual([{ id: "ordered", label: "after" }]);
    expect(
      fakeNeonState.events.filter((event) => event === "transaction-start")
    ).toHaveLength(1);
    const statements = fakeNeonState.events.filter((event) =>
      event.startsWith("statement:")
    );
    expect(statements).toHaveLength(3);
    expect(statements[0]).toContain("UPDATE p1_neon_entries");
    expect(statements[1]).toContain("p1_neon_entries");
    expect(statements[2]).toContain("SELECT id, label");
    expect(fakeNeonState.events.at(-1)).toBe("transaction-resolved");
  });

  test("generated scalar create and upsert return from one native Neon request", async () => {
    fakeNeonState.directResults = [neonResult([], "SELECT")];
    fakeNeonState.results = [
      neonResult([{ id: 71, label: "upserted" }], "INSERT", 1),
      neonResult([{ id: 72, label: "created" }], "INSERT", 1),
    ];
    const driver = new NeonHTTPDriver({ databaseUrl: "fake://neon" });
    const client = createClient({ schema: providerEvidenceSchema, driver });

    const [upserted, created] = await client.$transaction([
      client.generatedEntry.upsert({
        where: { id: 999 },
        create: { label: "upserted" },
        update: { label: "must-not-run" },
        select: { id: true, label: true },
      }),
      client.generatedEntry.create({
        data: { label: "created" },
        select: { id: true, label: true },
      }),
    ]);

    expect(upserted).toEqual({ id: 71, label: "upserted" });
    expect(created).toEqual({ id: 72, label: "created" });
    expect(
      fakeNeonState.events.filter((event) => event === "transaction-start")
    ).toHaveLength(1);
    const statements = fakeNeonState.events.filter((event) =>
      event.startsWith("statement:")
    );
    expect(
      fakeNeonState.events.filter((event) => event.startsWith("direct:"))
    ).toHaveLength(1);
    expect(statements).toHaveLength(2);
    expect(statements[0]).toContain("INSERT INTO");
    expect(statements[0]).toContain("RETURNING");
    expect(statements[1]).toContain("INSERT INTO");
    expect(statements[1]).toContain("RETURNING");
    expect(fakeNeonState.events.at(-1)).toBe("transaction-resolved");
  });

  test("a ROOT relation-bearing createMany awaits batch execution while the capability is false", async () => {
    const driver = new AwaitedBatchNeonDriver({
      databaseUrl: "postgresql://user:pw@db.neon.invalid/neondb",
    });
    const client = createClient({ schema: seriesSchema, driver }) as any;
    expect(driver.supportsOrderedCommittedSegments).toBe(false);

    let settled = false;
    const outcome = Promise.resolve(
      client.author.createMany({ data: RELATION_BEARING_ROWS })
    ).then(
      () => {
        settled = true;
        return undefined;
      },
      (error: unknown) => {
        settled = true;
        return error;
      }
    );

    await vi.waitFor(() => expect(driver.events).toEqual(["batch-entered"]));
    expect(settled).toBe(false);
    driver.release();

    const rejection = await outcome;
    expect(rejection).toBeInstanceOf(QueryEngineError);
    expect(rejection).toHaveProperty(
      "message",
      "Record-series execution failed at a committed-segment boundary."
    );
    expect(rejection).toMatchObject({
      meta: {
        recordSeriesProgress: {
          committedSegments: 0,
          completedMembers: 0,
          committedWriteMembers: 0,
          mayHaveCommittedSegment: true,
        },
      },
    });
    expect(driver.events).toEqual(["batch-entered", "batch-released"]);
  });

  test("an ordinary write on the same driver DOES reach the provider", async () => {
    const { client, driver } = driverFor();
    await expect(
      client.author.createMany({ data: [{ id: "a1", name: "one" }] })
    ).rejects.toThrow(CONNECTION_FAILED);
    expect(driver.clientRequests).toBe(1);
  });

  test("the native batch acknowledges commit after transaction resolution and before returning", async () => {
    const driver = new CallbackSeamNeonDriver({ databaseUrl: "fake://neon" });
    const results = await driver.executeNativeBatchForTest(
      [CALLBACK_QUERY],
      { operation: "callback-order" },
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
        fakeNeonState.events.push("committed");
      }
    );
    fakeNeonState.events.push("returned");

    expect(results).toEqual([{ rows: [], rowCount: 1 }]);
    expect(fakeNeonState.events).toEqual([
      "transaction-start",
      `statement:${CALLBACK_QUERY.sql}`,
      "transaction-resolved",
      "committed",
      "returned",
    ]);
  });

  test("a committed callback precedes result-cardinality failure", async () => {
    fakeNeonState.results = [];
    const driver = new CallbackSeamNeonDriver({ databaseUrl: "fake://neon" });
    const rejection = await driver
      .executeNativeBatchForTest(
        [CALLBACK_QUERY],
        { operation: "malformed-cardinality" },
        async () => {
          fakeNeonState.events.push("committed");
        }
      )
      .then(
        () => undefined,
        (error: unknown) => {
          fakeNeonState.events.push("rejected");
          return error;
        }
      );

    expect(rejection).toBeInstanceOf(QueryError);
    expect(rejection).toHaveProperty(
      "message",
      'Driver "neon-http" returned a malformed result payload for operation "malformed-cardinality": expected 1 statement results but received 0.'
    );
    expect(fakeNeonState.events).toEqual([
      "transaction-start",
      `statement:${CALLBACK_QUERY.sql}`,
      "transaction-resolved",
      "committed",
      "rejected",
    ]);
  });

  test("a committed callback precedes statement-result parsing failure", async () => {
    fakeNeonState.results = [{ ...validNeonResult(), rows: "not-an-array" }];
    const driver = new CallbackSeamNeonDriver({ databaseUrl: "fake://neon" });
    const rejection = await driver
      .executeNativeBatchForTest(
        [CALLBACK_QUERY],
        { operation: "malformed-statement" },
        async () => {
          fakeNeonState.events.push("committed");
        }
      )
      .then(
        () => undefined,
        (error: unknown) => {
          fakeNeonState.events.push("rejected");
          return error;
        }
      );

    expect(rejection).toBeInstanceOf(QueryError);
    expect(rejection).toHaveProperty(
      "message",
      'Driver "neon-http" returned a malformed result payload for operation "malformed-statement": expected fullResults object with object rows and explicit rowCount.'
    );
    expect(fakeNeonState.events).toEqual([
      "transaction-start",
      `statement:${CALLBACK_QUERY.sql}`,
      "transaction-resolved",
      "committed",
      "rejected",
    ]);
  });

  test("a rejected native transaction never acknowledges a commit", async () => {
    const providerError = new Error("provider rejected the transaction");
    fakeNeonState.transactionError = providerError;
    const driver = new CallbackSeamNeonDriver({ databaseUrl: "fake://neon" });
    const rejection = await driver
      .executeNativeBatchForTest(
        [CALLBACK_QUERY],
        { operation: "transaction-rejection" },
        async () => {
          fakeNeonState.events.push("committed");
        }
      )
      .then(
        () => undefined,
        (error: unknown) => {
          fakeNeonState.events.push("rejected");
          return error;
        }
      );

    expect(rejection).toBe(providerError);
    expect(fakeNeonState.events).toEqual([
      "transaction-start",
      `statement:${CALLBACK_QUERY.sql}`,
      "transaction-rejected",
      "rejected",
    ]);
  });

  test("attributes a one-statement provider rejection and keeps an opaque multi-statement rejection at batch scope", async () => {
    const statementContext = {
      model: "post",
      operation: "findMany",
      correlationId: "neon-statement-correlation",
    };
    const batchContext = {
      model: "$transaction",
      operation: "$transaction([...])",
      correlationId: "neon-batch-correlation",
    };
    const driver = new NeonHTTPDriver({ databaseUrl: "fake://neon" });

    fakeNeonState.transactionError = new Error(
      "Neon rejected the native transaction"
    );
    const attributable = await driver
      ._executeBatch(
        [{ ...CALLBACK_QUERY, context: statementContext }],
        undefined,
        batchContext
      )
      .catch((error) => error);
    expect(attributable).toMatchObject({
      name: "QueryError",
      meta: {
        driver: "neon-http",
        ...statementContext,
        statementIndex: 0,
      },
    });

    fakeNeonState.transactionError = new Error(
      "Neon rejected the native transaction"
    );
    const opaque = await driver
      ._executeBatch(
        [
          { ...CALLBACK_QUERY, context: { model: "user" } },
          { ...CALLBACK_QUERY, context: statementContext },
        ],
        undefined,
        batchContext
      )
      .catch((error) => error);
    expect(opaque).toMatchObject({
      name: "QueryError",
      meta: { driver: "neon-http", ...batchContext },
    });
    expect(opaque.meta).not.toHaveProperty("statementIndex");
  });
});
