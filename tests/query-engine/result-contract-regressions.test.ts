import type { DatabaseAdapter } from "@adapters/database-adapter";
import { SQLiteAdapter } from "@adapters/databases/sqlite/sqlite-adapter";
import { createClient } from "@client/client";
import { D1Driver } from "@drivers/d1";
import { Driver } from "@drivers/driver";
import { NeonHTTPDriver } from "@drivers/neon-http";
import type { BatchQuery, QueryResult } from "@drivers/types";
import { QueryEngineError, QueryError } from "@errors";
import { s } from "@schema";
import { afterEach, describe, expect, test, vi } from "vitest";

const MALFORMED_RESULT_PATTERN = /result|payload|rows/i;
const neonFixture = vi.hoisted(
  (): {
    getResult: () => unknown;
    getBatchResults: () => unknown;
  } => ({
    getResult: () => undefined,
    getBatchResults: () => undefined,
  })
);

vi.mock("@neondatabase/serverless", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@neondatabase/serverless")>();

  return {
    ...actual,
    neon: () => {
      const query = async () => neonFixture.getResult();
      return Object.assign(query, {
        transaction: async () => neonFixture.getBatchResults(),
      });
    },
  };
});

type BatchResultFault = "truncated" | "extra" | "empty-final";

class MalformedBatchDriver extends Driver<object, object> {
  readonly adapter: DatabaseAdapter = new SQLiteAdapter();
  override readonly supportsTransactions = false;
  override readonly supportsBatch = true;
  private readonly fault: BatchResultFault;

  constructor(fault: BatchResultFault) {
    super("sqlite", "malformed-batch");
    this.fault = fault;
  }

  protected async initClient(): Promise<object> {
    return {};
  }

  protected async closeClient(): Promise<void> {
    // No provider resource to release.
  }

  protected async execute<T>(): Promise<QueryResult<T>> {
    return { rows: [], rowCount: 0 };
  }

  protected async executeRaw<T>(): Promise<QueryResult<T>> {
    return { rows: [], rowCount: 0 };
  }

  protected async transaction<T>(
    _client: object,
    fn: (tx: object) => Promise<T>
  ): Promise<T> {
    return fn({});
  }

  protected override async executeBatch<T>(
    _client: object,
    queries: BatchQuery[]
  ): Promise<QueryResult<T>[]> {
    if (this.fault === "truncated") {
      return [];
    }
    const results = queries.map(() => ({ rows: [], rowCount: 0 }));
    if (this.fault === "extra") {
      results.push({ rows: [], rowCount: 0 });
    }
    return results;
  }
}

class UncheckedBatchWindowDriver extends MalformedBatchDriver {
  private readonly uncheckedFault: "truncated" | "extra";

  constructor(uncheckedFault: "truncated" | "extra") {
    super(uncheckedFault);
    this.uncheckedFault = uncheckedFault;
  }

  override async _executeBatch<T>(
    queries: BatchQuery[]
  ): Promise<QueryResult<T>[]> {
    if (this.uncheckedFault === "truncated") {
      return [];
    }
    return [
      ...queries.map(() => ({ rows: [], rowCount: 0 })),
      { rows: [], rowCount: 0 },
    ];
  }
}

const malformedBatchSchema = (() => {
  const parent = s.model({
    id: s.string().id(),
    children: s.oneToMany(() => child),
  });

  const child = s.model({
    id: s.string().id(),
    parentId: s.string(),
    parent: s
      .manyToOne(() => parent)
      .fields("parentId")
      .references("id"),
  });

  return { parent, child };
})();

function neonResult(
  rows: Record<string, unknown>[],
  rowCount: number | null = rows.length,
  command = "SELECT"
) {
  return {
    fields: [],
    command,
    rowCount,
    rows,
    rowAsArray: false,
  };
}

async function captureQueryError(
  promise: Promise<unknown>
): Promise<QueryError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof QueryError) {
      return error;
    }
    throw error;
  }
  throw new Error("Expected a QueryError from malformed provider output.");
}

describe("malformed successful provider payloads", () => {
  afterEach(() => {
    neonFixture.getResult = () => undefined;
    neonFixture.getBatchResults = () => undefined;
  });

  test.each([
    [
      "missing rows",
      { fields: [], command: "SELECT", rowCount: 0, rowAsArray: false },
    ],
    [
      "missing rowCount",
      { fields: [], command: "SELECT", rows: [], rowAsArray: false },
    ],
    [
      "missing command",
      { fields: [], rowCount: 0, rows: [], rowAsArray: false },
    ],
    ["empty command", neonResult([], 0, "")],
    ["unknown command", neonResult([], 0, "MYSTERY")],
    ["array-mode rows", { ...neonResult([]), rowAsArray: true }],
    ["non-object row", { ...neonResult([]), rows: [null] }],
    ["null SELECT rowCount", neonResult([], null)],
    ["null INSERT rowCount", neonResult([], null, "INSERT")],
    ["null UPDATE rowCount", neonResult([], null, "UPDATE")],
    ["null DELETE rowCount", neonResult([], null, "DELETE")],
    ["null MERGE rowCount", neonResult([], null, "MERGE")],
    ["null COPY rowCount", neonResult([], null, "COPY")],
    ["null FETCH rowCount", neonResult([], null, "FETCH")],
    ["null MOVE rowCount", neonResult([], null, "MOVE")],
    ["null unknown-command rowCount", neonResult([], null, "MYSTERY")],
  ])("Neon HTTP rejects %s", async (_label, payload) => {
    neonFixture.getResult = () => payload;
    const driver = new NeonHTTPDriver({
      databaseUrl: "postgresql://fixture.invalid/viborm",
    });

    const error = await captureQueryError(
      driver._executeRaw("SELECT $1", ["phase6-private-value"])
    );
    expect(error.message).toMatch(MALFORMED_RESULT_PATTERN);
    expect(error.meta).toMatchObject({
      driver: "neon-http",
      operation: "executeRaw",
    });
    expect(error.meta).not.toHaveProperty("query");
    expect(error.meta).not.toHaveProperty("params");
    expect(error.message).not.toContain("phase6-private-value");
  });

  test.each([
    ["DDL", neonResult([], null, "CREATE")],
    [
      "row-bearing uncounted command",
      neonResult([{ setting: "on" }], null, "SHOW"),
    ],
  ])("Neon HTTP preserves a valid %s null rowCount", async (_label, payload) => {
    neonFixture.getResult = () => payload;
    const driver = new NeonHTTPDriver({
      databaseUrl: "postgresql://fixture.invalid/viborm",
    });

    await expect(driver._executeRaw("fixture statement")).resolves.toEqual({
      rows: payload.rows,
      rowCount: payload.rows.length,
    });
  });

  test.each([
    ["truncated", []],
    ["extra", [neonResult([]), neonResult([])]],
  ])("Neon HTTP rejects a %s transaction result array", async (_label, results) => {
    neonFixture.getBatchResults = () => results;
    const driver = new NeonHTTPDriver({
      databaseUrl: "postgresql://fixture.invalid/viborm",
    });

    const error = await captureQueryError(
      driver._executeBatch([{ sql: "SELECT 1" }])
    );
    expect(error.meta).toMatchObject({
      driver: "neon-http",
      operation: "executeBatch",
    });
  });

  test("D1 binding normalizes explicit null results without accepting absence", async () => {
    const statement = {
      bind() {
        return statement;
      },
      async run() {
        return { success: true, results: null, meta: { changes: 0 } };
      },
    };
    const database = {
      prepare() {
        return statement;
      },
    } as unknown as ConstructorParameters<typeof D1Driver>[0]["database"];
    const driver = new D1Driver({ database });

    await expect(
      driver._executeRaw("PRAGMA foreign_keys = ON")
    ).resolves.toEqual({
      rows: [],
      rowCount: 0,
    });
  });

  test.each([
    ["absent results", { success: true, meta: { changes: 0 } }],
    [
      "failed success flag",
      { success: false, results: [], meta: { changes: 0 } },
    ],
  ])("D1 binding rejects %s", async (_label, payload) => {
    const statement = {
      bind() {
        return statement;
      },
      async run() {
        return payload;
      },
    };
    const database = {
      prepare() {
        return statement;
      },
    } as unknown as ConstructorParameters<typeof D1Driver>[0]["database"];
    const driver = new D1Driver({ database });

    const error = await captureQueryError(
      driver._executeRaw("SELECT ?", ["phase6-private-value"])
    );
    expect(error.meta).toMatchObject({ driver: "d1", operation: "executeRaw" });
    expect(error.meta).not.toHaveProperty("query");
    expect(error.meta).not.toHaveProperty("params");
  });
});

describe("planned batch result cardinality", () => {
  test.each([
    "truncated",
    "extra",
  ] as const)("client rejects a %s unchecked transaction result window before slicing", async (fault) => {
    const client = createClient({
      schema: malformedBatchSchema,
      driver: new UncheckedBatchWindowDriver(fault),
    });

    try {
      await expect(
        client.$transaction([client.parent.findMany(), client.child.findMany()])
      ).rejects.toMatchObject({
        meta: {
          driver: "malformed-batch",
          operation: "$transaction([...])",
          expectedStatementCount: 2,
          actualResultCount: fault === "truncated" ? 0 : 3,
        },
      });
    } finally {
      await client.$disconnect();
    }
  });

  test.each([
    "truncated",
    "extra",
  ] as const)("rejects a %s successful batch before slicing", async (fault) => {
    const client = createClient({
      schema: malformedBatchSchema,
      driver: new MalformedBatchDriver(fault),
    });

    try {
      let caught: unknown;
      try {
        await client.parent.create({
          data: {
            id: "parent-1",
            children: { create: { id: "child-1" } },
          },
        });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(QueryError);
      if (!(caught instanceof QueryError)) {
        throw new Error(
          "Expected a QueryError for malformed batch cardinality."
        );
      }
      expect(caught.meta).toMatchObject({
        driver: "malformed-batch",
        actualResultCount: fault === "truncated" ? 0 : expect.any(Number),
      });
      expect(caught.meta).not.toHaveProperty("query");
      expect(caught.meta).not.toHaveProperty("params");
    } finally {
      await client.$disconnect();
    }
  });

  test("rejects an empty final refetch row when every statement slot exists", async () => {
    const client = createClient({
      schema: malformedBatchSchema,
      driver: new MalformedBatchDriver("empty-final"),
    });

    try {
      let caught: unknown;
      try {
        await client.parent.create({
          data: {
            id: "parent-1",
            children: { create: { id: "child-1" } },
          },
        });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(QueryEngineError);
      if (!(caught instanceof QueryEngineError)) {
        throw new Error("Expected a QueryEngineError for an empty final row.");
      }
      expect(caught.meta).toMatchObject({
        driver: "malformed-batch",
        operation: "create",
        expectedRowCount: 1,
        actualRowCount: 0,
      });
    } finally {
      await client.$disconnect();
    }
  });
});
