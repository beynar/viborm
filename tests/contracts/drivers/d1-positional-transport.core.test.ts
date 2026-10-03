import { createClient } from "@client/client";
import { D1Driver } from "@drivers/d1";
import { s } from "@schema";
import { defineExtension } from "@src/index";
import { describe, expect, test, vi } from "vitest";

type D1Database = ConstructorParameters<typeof D1Driver>[0]["database"];

const entry = s.model({ id: s.int().id(), title: s.string() }).map("entries");

type ParseResult = NonNullable<D1Driver["result"]["parseResult"]>;

/** A result hook that renumbers the row with id 1 as 101, in any shape. */
const renumberFirst: ParseResult = (rawResult, operation, next) => {
  const renumber = (row: unknown) =>
    row && typeof row === "object" && (row as { id?: unknown }).id === 1
      ? { ...row, id: 101 }
      : row;
  const parsed = next(rawResult, operation);
  return Array.isArray(parsed) ? parsed.map(renumber) : renumber(parsed);
};

/** A binding answering every statement with the same two rows. */
function fakeDatabase() {
  const raw = vi.fn(async () => [
    ["id", "title"],
    [1, "first"],
    [2, "second"],
  ]);
  const run = vi.fn(async () => ({
    success: true,
    results: [
      { id: 1, title: "first" },
      { id: 2, title: "second" },
    ],
    meta: { changes: 0, last_row_id: 0 },
  }));
  const statement = { bind: () => statement, raw, run };
  const database = { prepare: () => statement } as unknown as D1Database;
  return { database, raw, run };
}

describe("D1 positional transport", () => {
  test("a stock driver reads a collection as positional rows", async () => {
    const { database, raw, run } = fakeDatabase();
    const client = createClient({
      schema: { entry },
      driver: new D1Driver({ database }),
    });
    await expect(client.entry.findMany()).resolves.toEqual([
      { id: 1, title: "first" },
      { id: 2, title: "second" },
    ]);
    expect(raw).toHaveBeenCalledWith({ columnNames: true });
    expect(run).not.toHaveBeenCalled();
  });

  test("a driver whose parser was replaced keeps keyed rows", async () => {
    const { database, raw, run } = fakeDatabase();
    const driver = new D1Driver({ database });
    const parseField = driver.adapter.result.parseField;
    driver.adapter.result.parseField = (value, type, next) =>
      parseField(value, type, next);
    const client = createClient({ schema: { entry }, driver });
    await expect(client.entry.findMany()).resolves.toEqual([
      { id: 1, title: "first" },
      { id: 2, title: "second" },
    ]);
    expect(run).toHaveBeenCalled();
    expect(raw).not.toHaveBeenCalled();
  });

  test("a driver whose provider execute was wrapped keeps the wrapper's rows", async () => {
    const { database, raw } = fakeDatabase();
    const driver = new D1Driver({ database });
    // biome-ignore lint/suspicious/noExplicitAny: wrapping the protected provider hook is the point.
    const wrapped = driver as any;
    const execute = wrapped.execute.bind(driver);
    wrapped.execute = async (...args: unknown[]) => {
      const result = await execute(...args);
      return {
        ...result,
        rows: result.rows.map((row: Record<string, unknown>) => ({
          ...row,
          id: 42,
        })),
      };
    };
    const client = createClient({ schema: { entry }, driver });
    await expect(client.entry.findMany()).resolves.toEqual([
      { id: 42, title: "first" },
      { id: 42, title: "second" },
    ]);
    expect(raw).not.toHaveBeenCalled();
  });

  test("a parseResult hook is honoured by collection and singular reads alike", async () => {
    const { database, raw } = fakeDatabase();
    const driver = new D1Driver({ database });
    // The stock parser is a shared module object: restore what is installed.
    driver.result.parseResult = renumberFirst;
    try {
      const client = createClient({ schema: { entry }, driver });
      await expect(client.entry.findMany()).resolves.toEqual([
        { id: 101, title: "first" },
        { id: 2, title: "second" },
      ]);
      await expect(client.entry.findFirst()).resolves.toEqual({
        id: 101,
        title: "first",
      });
      await expect(client.entry.findMany()).resolves.toEqual([
        { id: 101, title: "first" },
        { id: 2, title: "second" },
      ]);
      expect(raw).not.toHaveBeenCalled();
    } finally {
      driver.result.parseResult = undefined;
    }
  });

  test("a parseResult hook installed while the statement is processed is honoured", async () => {
    const { database, raw } = fakeDatabase();
    const driver = new D1Driver({ database });
    try {
      const client = createClient({ schema: { entry }, driver }).$extends(
        defineExtension<{ entry: typeof entry }>()({
          name: "late-parser",
          statement: ({ statement }) => {
            driver.result.parseResult = renumberFirst;
            return statement;
          },
        })
      );
      await expect(client.entry.findMany()).resolves.toEqual([
        { id: 101, title: "first" },
        { id: 2, title: "second" },
      ]);
      expect(raw).not.toHaveBeenCalled();
    } finally {
      driver.result.parseResult = undefined;
    }
  });

  test("a hook on the shared parser before the driver module loads is still a hook", async () => {
    // The stock parser is one module object every SQLite-family driver shares
    // (LibSQL's included): a hook installed there before D1 is first imported
    // must not be mistaken for the shipped parser.
    vi.resetModules();
    const { sqliteResultParser } = await import("@drivers/shared");
    sqliteResultParser.parseResult = renumberFirst;
    try {
      const { D1Driver: FreshD1Driver } = await import("@drivers/d1");
      const { createClient: freshCreateClient } = await import(
        "@client/client"
      );
      const { s: fresh } = await import("@schema");
      const freshEntry = fresh
        .model({ id: fresh.int().id(), title: fresh.string() })
        .map("entries");
      const { database, raw } = fakeDatabase();
      const client = freshCreateClient({
        schema: { entry: freshEntry },
        driver: new FreshD1Driver({ database }),
      });
      await expect(client.entry.findMany()).resolves.toEqual([
        { id: 101, title: "first" },
        { id: 2, title: "second" },
      ]);
      expect(raw).not.toHaveBeenCalled();
    } finally {
      sqliteResultParser.parseResult = undefined;
    }
  });

  test("an execute wrapper installed while the statement is processed still runs", async () => {
    const { database, raw } = fakeDatabase();
    const driver = new D1Driver({ database });
    // biome-ignore lint/suspicious/noExplicitAny: wrapping the protected provider hook is the point.
    const wrapped = driver as any;
    const execute = wrapped.execute.bind(driver);
    const client = createClient({ schema: { entry }, driver }).$extends(
      defineExtension<{ entry: typeof entry }>()({
        name: "late-wrapper",
        // Eligibility was decided before this transform ran.
        statement: ({ statement }) => {
          wrapped.execute = async (...args: unknown[]) => {
            const result = await execute(...args);
            return {
              ...result,
              rows: result.rows.map((row: Record<string, unknown>) => ({
                ...row,
                id: 42,
              })),
            };
          };
          return statement;
        },
      })
    );
    await expect(client.entry.findMany()).resolves.toEqual([
      { id: 42, title: "first" },
      { id: 42, title: "second" },
    ]);
    expect(raw).not.toHaveBeenCalled();
  });

  test("a driver whose _execute was replaced keeps keyed rows", async () => {
    const { database, raw, run } = fakeDatabase();
    const driver = new D1Driver({ database });
    const original = driver._execute.bind(driver);
    driver._execute = (query, context) => original(query, context);
    const client = createClient({ schema: { entry }, driver });
    await client.entry.findMany();
    expect(run).toHaveBeenCalled();
    expect(raw).not.toHaveBeenCalled();
  });
});
