import { getExecutionExtensionChain } from "@drivers/execution-context";
import { QueryError, UnsupportedOperationError } from "@errors";
import { appendResolvedExtension } from "@extensions/chain";
import { createOperationExecutionContext } from "@query-engine/execution-context";
import { s } from "@schema";
import { raw, type Sql, sql } from "@sql";
import { defineExtension } from "@src/index";
import { usePGliteSchemaFamily } from "@tests/fixtures/drivers/pglite";
import { readTestTransactionOperation } from "@tests/fixtures/transaction-operation";
import { afterEach, describe, expect, test, vi } from "vitest";

const author = s.model({
  id: s.string().id(),
  name: s.string(),
  posts: s.toMany(() => post),
});
const post = s.model({
  id: s.string().id(),
  title: s.string(),
  authorId: s.string(),
  author: s
    .toOne(() => author)
    .fields("authorId")
    .references("id"),
});
const schema = { author, post };

interface StatementCall {
  readonly extension: string;
  readonly model: string | undefined;
  readonly operation: string;
  readonly statement: Sql;
}

function labelComposedCreateStatement(statement: Sql): string {
  const text = statement.toStatement("$n");
  if (text.startsWith('INSERT INTO "author"')) return "write:author";
  if (text.startsWith('INSERT INTO "post"')) return "write:post";
  if (text.startsWith("SELECT") && text.includes('FROM "author"')) {
    return "result:author";
  }
  return `unexpected:${text}`;
}

function operationContext(operation: unknown) {
  const capability = readTestTransactionOperation(operation);
  if (capability === undefined) throw new Error("Expected pending operation");
  return capability.context;
}

const transactionFamily = usePGliteSchemaFamily(schema);
const nativeBatchFamily = usePGliteSchemaFamily(schema, "atomicBatch");

afterEach(() => vi.restoreAllMocks());

function recordingExtension(name: string, prefix: Sql, calls: StatementCall[]) {
  return defineExtension<typeof schema>()({
    name,
    statement(context) {
      calls.push({
        extension: name,
        model: context.model,
        operation: context.operation,
        statement: context.statement,
      });
      return sql`${prefix}${context.statement}`;
    },
  });
}

describe("integrated statement transforms", () => {
  test("runs direct model transforms in extension application order", async () => {
    const { client } = transactionFamily();
    await client.author.create({ data: { id: "a1", name: "Ada" } });
    const calls: StatementCall[] = [];
    const derived = client
      .$extends(recordingExtension("A", raw("/* A */ "), calls))
      .$extends(recordingExtension("B", raw("/* B */ "), calls));

    await expect(
      derived.author.findMany({ where: { id: "a1" } })
    ).resolves.toMatchObject([{ id: "a1", name: "Ada" }]);
    expect(calls.map(({ extension }) => extension)).toEqual(["A", "B"]);
    expect(calls.map(({ model }) => model)).toEqual(["author", "author"]);
    expect(calls.map(({ operation }) => operation)).toEqual([
      "findMany",
      "findMany",
    ]);
    expect(calls[1]?.statement).not.toBe(calls[0]?.statement);
  });

  test("covers the exact physical statement sequence in one composed write", async () => {
    const { client } = transactionFamily();
    const calls: StatementCall[] = [];
    const derived = client.$extends(
      recordingExtension("composed", raw("/* composed */ "), calls)
    );

    await expect(
      derived.author.create({
        data: {
          id: "a1",
          name: "Ada",
          posts: { create: { id: "p1", title: "First" } },
        },
        include: { posts: true },
      })
    ).resolves.toMatchObject({
      id: "a1",
      posts: [{ id: "p1", authorId: "a1" }],
    });
    expect(
      calls.map(({ statement }) => labelComposedCreateStatement(statement))
    ).toEqual(["write:author", "write:post", "result:author"]);
    expect(new Set(calls.map(({ model }) => model))).toEqual(
      new Set(["author"])
    );
    expect(new Set(calls.map(({ operation }) => operation))).toEqual(
      new Set(["create"])
    );
  });

  test("preserves the chain through callback transactions", async () => {
    const { client } = transactionFamily();
    const calls: StatementCall[] = [];
    const derived = client.$extends(
      recordingExtension("callback", raw("/* callback */ "), calls)
    );
    const rootOperation = derived.author.findMany();
    const chain = getExecutionExtensionChain(operationContext(rootOperation));

    await derived.$transaction(async (tx) => {
      const transactionOperation = tx.author.create({
        data: { id: "a1", name: "Ada" },
      });
      expect(
        getExecutionExtensionChain(operationContext(transactionOperation))
      ).toBe(chain);
      await transactionOperation;
      await tx.author.findMany({ where: { id: "a1" } });
    });

    expect(calls.map(({ operation }) => operation)).toEqual([
      "create",
      "findMany",
    ]);
  });

  test("runs transforms for every fallback array operation", async () => {
    const { client } = transactionFamily();
    await client.author.create({ data: { id: "a1", name: "Ada" } });
    const calls: StatementCall[] = [];
    const derived = client.$extends(
      recordingExtension("fallback", raw("/* fallback */ "), calls)
    );

    const [rows, count] = await derived.$transaction([
      derived.author.findMany({ where: { id: "a1" } }),
      derived.author.count(),
    ]);

    expect(rows).toMatchObject([{ id: "a1" }]);
    expect(count).toBe(1);
    expect(calls.map(({ operation }) => operation)).toEqual([
      "findMany",
      "count",
    ]);
  });

  test("transforms native prepared entries but leaves marked verbatim raw exact", async () => {
    const { client, driver } = nativeBatchFamily();
    await client.author.create({ data: { id: "a1", name: "Ada" } });
    const calls: StatementCall[] = [];
    const derived = client.$extends(
      recordingExtension("native", raw("/* native */ "), calls)
    );
    const executeBatch = vi.spyOn(driver, "_executeBatch");
    const unsafeSql = "SELECT 'verbatim-native' AS value";
    const unsafeExecuteSql =
      'UPDATE "author" SET "name" = \'unsafe-native\' WHERE "id" = \'a1\'';

    const [rows, safeRaw, unsafeRaw, safeCount, unsafeCount] =
      await derived.$transaction([
        derived.author.findMany({ where: { id: "a1" } }),
        derived.$queryRaw<{ value: number }>`SELECT ${1}::int AS value`,
        derived.$queryRawUnsafe<{ value: string }>(unsafeSql),
        derived.$executeRaw`UPDATE "author" SET "name" = ${"safe-native"} WHERE "id" = ${"a1"}`,
        derived.$executeRawUnsafe(unsafeExecuteSql),
      ]);

    expect(rows).toMatchObject([{ id: "a1" }]);
    expect(safeRaw).toEqual([{ value: 1 }]);
    expect(unsafeRaw).toEqual([{ value: "verbatim-native" }]);
    expect(safeCount).toBe(1);
    expect(unsafeCount).toBe(1);
    expect(calls.map(({ operation }) => operation)).toEqual([
      "findMany",
      "$queryRaw",
      "$executeRaw",
    ]);
    expect(executeBatch).toHaveBeenCalledOnce();
    const submitted = executeBatch.mock.calls[0]?.[0] ?? [];
    expect(submitted[0]?.sql).toContain("/* native */");
    expect(submitted[1]?.sql).toContain("/* native */");
    expect(submitted[2]?.sql).toBe(unsafeSql);
    expect(submitted[3]?.sql).toContain("/* native */");
    expect(submitted[4]?.sql).toBe(unsafeExecuteSql);
  });

  test("transforms tagged raw and preserves unsafe and legacy strings byte-for-byte", async () => {
    const { client, database, driver } = transactionFamily();
    await client.author.create({ data: { id: "a1", name: "Ada" } });
    const calls: StatementCall[] = [];
    const derived = client.$extends(
      recordingExtension("raw", raw("/* raw */ "), calls)
    );
    const providerQuery = vi.spyOn(database, "query");
    const executeRaw = vi.spyOn(driver, "_executeRaw");
    const unsafeSql = "SELECT 'unsafe-direct' AS value";
    const legacySql = "SELECT 'legacy-direct' AS value";
    const unsafeExecuteSql =
      'UPDATE "author" SET "name" = \'unsafe-direct\' WHERE "id" = \'a1\'';

    await expect(
      derived.$queryRaw<{ value: number }>`SELECT ${1}::int AS value`
    ).resolves.toEqual([{ value: 1 }]);
    await expect(
      derived.$queryRawUnsafe<{ value: string }>(unsafeSql)
    ).resolves.toEqual([{ value: "unsafe-direct" }]);
    await expect(
      derived.$queryRaw<{ value: string }>(legacySql)
    ).resolves.toEqual([{ value: "legacy-direct" }]);
    const safeExecuteProviderIndex = providerQuery.mock.calls.length;
    await expect(
      derived.$executeRaw`UPDATE "author" SET "name" = ${"safe-direct"} WHERE "id" = ${"a1"}`
    ).resolves.toBe(1);
    await expect(derived.$executeRawUnsafe(unsafeExecuteSql)).resolves.toBe(1);

    expect(calls.map(({ operation }) => operation)).toEqual([
      "$queryRaw",
      "$executeRaw",
    ]);
    expect(
      String(providerQuery.mock.calls[safeExecuteProviderIndex]?.[0])
    ).toContain("/* raw */");
    expect(executeRaw.mock.calls.at(-3)?.[0]).toBe(unsafeSql);
    expect(executeRaw.mock.calls.at(-2)?.[0]).toBe(legacySql);
    expect(executeRaw.mock.calls.at(-1)?.[0]).toBe(unsafeExecuteSql);
  });

  test("rejects an invalid return before provider execution", async () => {
    const { client, database } = transactionFamily();
    const providerQuery = vi.spyOn(database, "query");
    const derived = client.$extends({
      name: "invalid-return",
      // @ts-expect-error - hostile JavaScript can violate the public Sql return
      statement() {
        return "SELECT 1";
      },
    });

    await expect(derived.author.findMany()).rejects.toMatchObject({
      name: QueryError.name,
      message: expect.stringContaining('Extension "invalid-return"'),
    });
    expect(providerQuery).not.toHaveBeenCalled();
  });

  test("rejects fake structural Sql renderers before provider execution", async () => {
    const { client, database } = transactionFamily();
    const providerQuery = vi.spyOn(database, "query");
    const fakeSqlValues: ReadonlyArray<readonly [string, unknown]> = [
      ["missing-renderer", { strings: ["SELECT 1"], values: [] }],
      [
        "non-callable-renderer",
        { strings: ["SELECT 1"], values: [], toStatement: 1 },
      ],
      [
        "unreadable-renderer",
        Object.defineProperty(
          { strings: ["SELECT 1"], values: [] },
          "toStatement",
          {
            get() {
              throw new Error("private renderer accessor failure");
            },
          }
        ),
      ],
      [
        "throwing-renderer",
        {
          strings: ["SELECT 1"],
          values: [],
          toStatement() {
            throw new Error("private renderer failure");
          },
        },
      ],
    ];

    for (const [name, fakeSql] of fakeSqlValues) {
      const derived = client.$extends({
        name,
        // @ts-expect-error - hostile JavaScript can violate the public Sql return.
        statement() {
          return fakeSql;
        },
      });

      await expect(derived.author.findMany()).rejects.toMatchObject({
        name: QueryError.name,
        message: expect.stringContaining(`Extension "${name}"`),
      });
    }
    expect(providerQuery).not.toHaveBeenCalled();
  });

  test("checks the verified bind limit only after an active transform", async () => {
    const { client, driver, database } = transactionFamily();
    const capacityDescriptor = Object.getOwnPropertyDescriptor(
      driver,
      "maxBindParametersPerStatement"
    );
    if (!capacityDescriptor) throw new Error("PGlite bind limit is missing");
    Object.defineProperty(driver, "maxBindParametersPerStatement", {
      ...capacityDescriptor,
      value: 1,
    });
    const providerQuery = vi.spyOn(database, "query");
    const derived = client.$extends({
      name: "bind-growth",
      statement({ statement }) {
        return sql`${statement}${"first"}${"second"}`;
      },
    });

    try {
      await expect(derived.author.findMany()).rejects.toMatchObject({
        name: UnsupportedOperationError.name,
        message: expect.stringContaining(
          "2 bound values, above the verified limit of 1"
        ),
      });
      expect(providerQuery).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(
        driver,
        "maxBindParametersPerStatement",
        capacityDescriptor
      );
    }
  });

  test("ignores a caller-spoofed chain and keeps trusted provenance hidden", async () => {
    const { driver } = transactionFamily();
    const calls: StatementCall[] = [];
    const chain = appendResolvedExtension(
      undefined,
      recordingExtension("trusted", raw("/* trusted */ "), calls),
      schema
    );
    const spoofedContext = {
      model: "author",
      operation: "findMany",
      extensionChain: chain,
    };

    expect(getExecutionExtensionChain(spoofedContext)).toBeUndefined();
    await expect(
      driver._execute(sql`SELECT 1 AS value`, spoofedContext)
    ).resolves.toMatchObject({ rows: [{ value: 1 }] });
    expect(calls).toEqual([]);

    const trustedContext = createOperationExecutionContext(
      "$transaction",
      "$transaction(callback)",
      undefined,
      chain
    );
    expect(Reflect.ownKeys(trustedContext)).toEqual([
      "model",
      "operation",
      "correlationId",
    ]);
    expect(getExecutionExtensionChain(trustedContext)).toBe(chain);

    await driver.withTransaction(
      async (transactionDriver) => {
        const prepared = transactionDriver._prepare(sql`SELECT 1 AS value`);
        expect(prepared.sql).toContain("/* trusted */");
      },
      undefined,
      trustedContext
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      model: "$transaction",
      operation: "$transaction(callback)",
    });
  });
});
