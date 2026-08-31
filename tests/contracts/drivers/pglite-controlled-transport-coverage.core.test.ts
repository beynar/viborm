import { PGliteDriver } from "@drivers/pglite";
import { sql } from "@sql";
import { describe, expect, test, vi } from "vitest";

describe("PGlite controlled transport execution", () => {
  test("executes a typed statement through a supplied database without taking ownership", async () => {
    const close = vi.fn(async () => undefined);
    const query = vi.fn(async () => ({
      affectedRows: 0,
      rows: [{ id: 5 }, { id: 6 }],
    }));
    const driver = new PGliteDriver({
      client: { close, query } as never,
    });

    await expect(
      driver._execute<{ id: number }>(
        sql`SELECT id FROM events WHERE id > ${4}`,
        {
          operation: "findMany",
        }
      )
    ).resolves.toEqual({
      rows: [{ id: 5 }, { id: 6 }],
      rowCount: 2,
    });
    expect(query).toHaveBeenCalledWith(
      "SELECT id FROM events WHERE id > $1",
      [4]
    );

    await driver.disconnect();
    expect(close).not.toHaveBeenCalled();
  });
});
