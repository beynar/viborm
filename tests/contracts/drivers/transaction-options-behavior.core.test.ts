import { MySQL2Driver } from "@drivers/mysql2";
import { describe, expect, test, vi } from "vitest";

describe("isolationLevel: pre-begin placement (MySQL family)", () => {
  interface FakeConnection {
    query: ReturnType<typeof vi.fn>;
    beginTransaction: ReturnType<typeof vi.fn>;
    commit: ReturnType<typeof vi.fn>;
    rollback: ReturnType<typeof vi.fn>;
    release: ReturnType<typeof vi.fn>;
    destroy: ReturnType<typeof vi.fn>;
  }

  function fakeMysqlPool(order: string[]) {
    const connection: FakeConnection = {
      query: vi.fn(async (sql: string) => {
        order.push(sql);
        return [[], []];
      }),
      beginTransaction: vi.fn(async () => {
        order.push("BEGIN");
      }),
      commit: vi.fn(async () => {
        order.push("COMMIT");
      }),
      rollback: vi.fn(async () => {
        order.push("ROLLBACK");
      }),
      release: vi.fn(),
      destroy: vi.fn(),
    };
    return {
      pool: {
        getConnection: vi.fn(async () => connection),
        end: vi.fn(async () => undefined),
      },
      connection,
    };
  }

  test("mysql2 sets the level before BEGIN, not after", async () => {
    const order: string[] = [];
    const { pool } = fakeMysqlPool(order);
    const driver = new MySQL2Driver({ pool: pool as never });

    await driver._transaction(async () => undefined, {
      isolationLevel: "RepeatableRead",
    });

    expect(order).toEqual([
      "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ",
      "BEGIN",
      "COMMIT",
    ]);
  });

  test("mysql2 emits no isolation statement when no level is asked for", async () => {
    const order: string[] = [];
    const { pool } = fakeMysqlPool(order);
    const driver = new MySQL2Driver({ pool: pool as never });

    await driver._transaction(async () => undefined);

    expect(order).toEqual(["BEGIN", "COMMIT"]);
  });

  test("mysql2 bounds pool acquisition with maxWait and releases what it abandoned", async () => {
    const released: string[] = [];
    const slowConnection = {
      query: vi.fn(async () => [[], []]),
      beginTransaction: vi.fn(async () => undefined),
      commit: vi.fn(async () => undefined),
      rollback: vi.fn(async () => undefined),
      release: vi.fn(() => released.push("released")),
      destroy: vi.fn(),
    };
    let handOver: (() => void) | undefined;
    let acquisition: Promise<unknown> | undefined;
    const pool = {
      getConnection: vi.fn(() => {
        acquisition = new Promise((resolve) => {
          handOver = () => resolve(slowConnection);
        });
        return acquisition;
      }),
      end: vi.fn(async () => undefined),
    };
    const driver = new MySQL2Driver({ pool: pool as never });
    const callback = vi.fn(async () => undefined);

    await expect(
      driver._transaction(callback, { maxWait: 10 })
    ).rejects.toMatchObject({ code: "V5002" });
    expect(callback).not.toHaveBeenCalled();
    expect(slowConnection.beginTransaction).not.toHaveBeenCalled();

    handOver?.();
    await acquisition;
    expect(released).toEqual(["released"]);
  });
});
