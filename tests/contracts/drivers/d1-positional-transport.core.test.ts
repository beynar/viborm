import { createClient } from "@client/client";
import { D1Driver } from "@drivers/d1";
import { s } from "@schema";
import { describe, expect, test, vi } from "vitest";

type D1Database = ConstructorParameters<typeof D1Driver>[0]["database"];

const entry = s.model({ id: s.int().id(), title: s.string() }).map("entries");

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
});
