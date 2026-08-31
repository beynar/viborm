import type { DatabaseAdapter } from "@adapters/database-adapter";
import { SQLiteAdapter } from "@adapters/databases/sqlite/sqlite-adapter";
import {
  combineArrayFailures,
  markArrayCommitCertainty,
} from "@client/array-transaction-failures";
import {
  assertAtomicArraySupport,
  assertNativeBatchResults,
  unbatchableArrayError,
} from "@client/array-transaction-native-batch";
import { createClient } from "@client/client";
import {
  getOperationPayloadSchema,
  renderOperationResultType,
  renderSchemaType,
} from "@client/schema-introspection";
import type { Operations } from "@client/types";
import type { QueryResult } from "@drivers";
import { Driver } from "@drivers";
import { QueryError, VibORMErrorCode } from "@errors";
import { s } from "@schema";
import { sql } from "@sql";
import { describe, expect, test } from "vitest";

const operationNames = [
  "findFirst",
  "findMany",
  "findUnique",
  "findUniqueOrThrow",
  "findFirstOrThrow",
  "create",
  "createMany",
  "update",
  "updateMany",
  "delete",
  "deleteMany",
  "count",
  "aggregate",
  "groupBy",
  "upsert",
  "exist",
] satisfies readonly Operations[];
const NO_ATOMIC_FORM = /supports neither transactions nor atomic batch/;

const record = s.model({
  id: s.string().id(),
  label: s.string(),
});
const schema = { record };

class ClientCoverageDriver extends Driver<object, object> {
  readonly adapter: DatabaseAdapter = new SQLiteAdapter();
  executionCalls = 0;

  constructor() {
    super("sqlite", "client-coverage");
    this.client = {};
  }

  protected async initClient(): Promise<object> {
    return {};
  }

  protected async closeClient(): Promise<void> {
    // This driver owns no provider resource.
  }

  protected async execute<T>(): Promise<QueryResult<T>> {
    this.executionCalls += 1;
    return { rows: [], rowCount: 3 };
  }

  protected async executeRaw<T>(): Promise<QueryResult<T>> {
    this.executionCalls += 1;
    return { rows: [], rowCount: 3 };
  }

  protected async transaction<T>(
    client: object,
    run: (client: object) => Promise<T>
  ): Promise<T> {
    return run(client);
  }
}

class NoAtomicClientCoverageDriver extends ClientCoverageDriver {
  override readonly supportsTransactions = false;
  override readonly supportsBatch = false;
}

function invoke(method: CallableFunction, args: unknown[]): Promise<unknown> {
  return Promise.resolve(Reflect.apply(method, undefined, args));
}

describe("schema introspection completeness", () => {
  test("exposes a payload schema for every public operation spelling", () => {
    for (const operation of operationNames) {
      expect(
        getOperationPayloadSchema(schema, "record", operation)["~standard"]
          .version
      ).toBe(1);
    }
  });

  test("renders every scalar output domain, lists, and nullable values", () => {
    const scalarRecord = s.model({
      id: s.string().id(),
      integer: s.int(),
      real: s.number(),
      amount: s.decimal({ precision: 12, scale: 2 }),
      enabled: s.boolean(),
      happenedAt: s.dateTime(),
      happenedOn: s.date(),
      happenedTime: s.time(),
      total: s.bigInt(),
      metadata: s.json(),
      bytes: s.blob(),
      embedding: s.vector().dimension(2),
      location: s.point(),
      status: s.enum(["open", "closed"]),
      flags: s.boolean().array().nullable(),
    });

    const rendered = renderSchemaType({ scalarRecord });

    expect(rendered).toContain("integer: number;");
    expect(rendered).toContain("real: number;");
    expect(rendered).toContain('amount: import("viborm").Decimal;');
    expect(rendered).toContain("enabled: boolean;");
    expect(rendered).toContain("happenedAt: Date;");
    expect(rendered).toContain("happenedOn: Date;");
    expect(rendered).toContain("happenedTime: string;");
    expect(rendered).toContain("total: bigint;");
    expect(rendered).toContain("metadata: unknown;");
    expect(rendered).toContain("bytes: Uint8Array;");
    expect(rendered).toContain("embedding: Array<number>;");
    expect(rendered).toContain('status: "open" | "closed";');
    expect(rendered).toContain("flags: Array<boolean> | null;");
    expect(rendered).toContain(`location: {
      longitude: number;
      latitude: number;
    };`);
  });

  test("renders bulk returning and nullable distance carriers", () => {
    expect(
      renderOperationResultType(schema, "record", "createMany", {
        data: [{ id: "first", label: "one" }],
      })
    ).toBe(`{
  count: number;
}`);
    expect(
      renderOperationResultType(schema, "record", "createMany", {
        data: [{ id: "first", label: "one" }],
        select: { label: true },
      })
    ).toBe(`Array<{
  label: string;
}>`);
    expect(
      renderOperationResultType(schema, "record", "updateMany", {
        data: { label: "updated" },
        select: { id: true },
      })
    ).toBe(`Array<{
  id: string;
}>`);

    const place = s.model({
      id: s.string().id(),
      location: s.point(),
      optionalLocation: s.point().nullable(),
    });
    const target = { longitude: 2.3522, latitude: 48.8566 };
    expect(
      renderOperationResultType({ place }, "place", "findMany", {
        select: { location: { _distance: { to: target } } },
      })
    ).toBe(`Array<{
  _distance: number;
}>`);
    expect(
      renderOperationResultType({ place }, "place", "findMany", {
        select: { optionalLocation: { _distance: { to: target } } },
      })
    ).toBe(`Array<{
  _distance: number | null;
}>`);
  });

  test("renders singular variant relations as readonly discriminated values", () => {
    const article = s.model({ id: s.string().id(), title: s.string() });
    const clip = s.model({ id: s.string().id(), duration: s.int() });
    const comment = s.model({
      id: s.string().id(),
      subject: s.toOne(
        { article: () => article, clip: () => clip },
        {
          values: {
            article: "coverage.article.v1",
            clip: "coverage.clip.v1",
          },
        }
      ),
    });

    const variantSchema = { article, clip, comment };
    const rendered = renderSchemaType(variantSchema);
    const selected = renderOperationResultType(
      variantSchema,
      "comment",
      "findMany",
      { select: { subject: true } }
    );

    expect(rendered).toContain('readonly type: "article";');
    expect(rendered).toContain('readonly data: VibORMSchema["article"];');
    expect(rendered).toContain('readonly type: "clip";');
    expect(rendered).toContain('readonly data: VibORMSchema["clip"];');
    expect(selected).toContain('readonly type: "article";');
    expect(selected).toContain('readonly type: "clip";');
  });

  test("renders an inverse singular slot as nullable", () => {
    const account = s.model({
      id: s.string().id(),
      profile: s.toOne(() => profile),
    });
    const profile = s.model({
      id: s.string().id(),
      accountId: s.string(),
      account: s
        .toOne(() => account)
        .fields("accountId")
        .references("id"),
    });

    expect(renderSchemaType({ account, profile })).toContain(
      'profile: VibORMSchema["profile"] | null;'
    );
  });
});

describe("client proxy and raw contracts", () => {
  test("keeps model proxies non-thenable, memoized, and utility-safe", async () => {
    const driver = new ClientCoverageDriver();
    const client = createClient({ schema, driver });

    expect(client.$driver).toBe(driver);
    expect(client.$schema).toBe(schema);
    expect(client.record).toBe(client.record);
    expect(client.record.findMany).toBe(client.record.findMany);
    expect(Reflect.get(client.record, "then")).toBeUndefined();
    await expect(Promise.resolve(client.record)).resolves.toBe(client.record);
    expect(Reflect.get(client, Symbol.toStringTag)).toBeUndefined();
    expect(Reflect.get(client, "$notAClientUtility")).toBeUndefined();

    await client.$disconnect();
  });

  test("keeps all four raw methods lazy and Promise-compatible", async () => {
    const driver = new ClientCoverageDriver();
    const client = createClient({
      schema,
      driver,
    });
    let finalizations = 0;
    const query = client.$queryRaw`SELECT ${1}`;

    expect(Object.prototype.toString.call(query)).toBe("[object Promise]");
    expect(driver.executionCalls).toBe(0);
    await expect(
      query.finally(() => {
        finalizations += 1;
      })
    ).resolves.toEqual([]);
    expect(finalizations).toBe(1);
    expect(driver.executionCalls).toBe(1);
    await expect(client.$queryRawUnsafe("SELECT 1")).resolves.toEqual([]);
    await expect(
      client.$executeRaw`UPDATE record SET label = ${"next"}`
    ).resolves.toBe(3);
    await expect(
      client.$executeRawUnsafe("UPDATE record SET label = ?", "next")
    ).resolves.toBe(3);

    await expect(
      client.$queryRaw`SELECT ${new Date("2026-08-31T00:00:00.000Z")}`
    ).resolves.toEqual([]);
    await client.$disconnect();
  });

  test("refuses malformed safe and unsafe raw calls before dispatch", async () => {
    const client = createClient({
      schema,
      driver: new ClientCoverageDriver(),
    });

    await expect(invoke(client.$queryRaw, ["SELECT 1"])).rejects.toMatchObject({
      code: VibORMErrorCode.INVALID_INPUT,
      meta: { method: "$queryRaw" },
    });
    await expect(invoke(client.$queryRawUnsafe, [42])).rejects.toMatchObject({
      code: VibORMErrorCode.INVALID_INPUT,
      meta: { method: "$queryRawUnsafe" },
    });
    await expect(
      invoke(client.$executeRaw, [sql`SELECT ${1}`, 2])
    ).rejects.toMatchObject({
      code: VibORMErrorCode.INVALID_INPUT,
      meta: { method: "$executeRaw" },
    });
    await expect(
      client.$executeRaw`SELECT ${new Date(Number.NaN)}`
    ).rejects.toMatchObject({
      code: VibORMErrorCode.INVALID_INPUT,
      meta: { method: "$executeRaw", parameterIndex: 0 },
    });

    await client.$disconnect();
  });
});

describe("array transaction capability contracts", () => {
  test("accepts transaction support and refuses a driver with no atomic form", () => {
    expect(() =>
      assertAtomicArraySupport(new ClientCoverageDriver())
    ).not.toThrow();
    expect(() =>
      assertAtomicArraySupport(new NoAtomicClientCoverageDriver())
    ).toThrow(NO_ATOMIC_FORM);
  });

  test("validates native result cardinality with provider attribution", () => {
    const driver = new ClientCoverageDriver();
    expect(() =>
      assertNativeBatchResults(
        driver,
        [
          { rows: [], rowCount: 0 },
          { rows: [], rowCount: 0 },
        ],
        2
      )
    ).not.toThrow();
    expect(() => assertNativeBatchResults(driver, [], 1)).toThrow();
    expect(unbatchableArrayError(driver)).toMatchObject({
      meta: {
        driver: "client-coverage",
        method: "$transaction([...])",
      },
    });
  });
});

describe("coverage low value", () => {
  test("walks nested array-failure metadata and de-duplicates witnesses", () => {
    const primary = new QueryError("primary");
    const secondary = new QueryError("secondary");
    const ordinary = new Error("ordinary");
    const nested = new AggregateError([primary, ordinary], "nested", {
      cause: primary,
    });
    const marked = markArrayCommitCertainty(nested, "committed");

    expect(markArrayCommitCertainty(ordinary, "committed")).toBe(ordinary);
    expect(marked).toBeInstanceOf(AggregateError);
    if (!(marked instanceof AggregateError)) {
      throw new Error("Expected a marked aggregate");
    }
    expect(marked.errors[0]).toMatchObject({
      meta: { commitCertainty: "committed" },
    });
    expect(marked.errors[1]).toBe(ordinary);
    expect(marked.cause).toBe(marked.errors[0]);

    const separatelyCaused = markArrayCommitCertainty(
      new AggregateError([ordinary], "separately caused", {
        cause: secondary,
      }),
      "may-have-committed"
    );
    expect(separatelyCaused).toBeInstanceOf(AggregateError);
    if (!(separatelyCaused instanceof AggregateError)) {
      throw new Error("Expected a separately caused aggregate");
    }
    expect(separatelyCaused.cause).toMatchObject({
      meta: { commitCertainty: "may-have-committed" },
    });

    expect(combineArrayFailures(primary, [primary])).toBe(primary);
    const combined = combineArrayFailures(primary, [primary, secondary]);
    expect(combined).toBeInstanceOf(AggregateError);
    if (!(combined instanceof AggregateError)) {
      throw new Error("Expected a combined aggregate");
    }
    expect(combined.errors).toEqual([primary, secondary]);
    expect(combined.cause).toBe(primary);
  });
});
