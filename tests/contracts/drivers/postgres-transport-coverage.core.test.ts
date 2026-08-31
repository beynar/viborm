import { PostgresDriver } from "@drivers/postgres";
import { sql } from "@sql";
import { beforeEach, describe, expect, test, vi } from "vitest";

interface CapturedPostgresType {
  from: number[];
  parse: (value: string) => unknown;
  serialize: (value: unknown) => unknown;
  to: number;
}

interface CapturedPostgresOptions {
  database?: string;
  host?: string;
  max?: number;
  password?: string;
  port?: number;
  types: Record<string, CapturedPostgresType>;
  user?: string;
}

const postgresProvider = vi.hoisted(() => {
  const state: { command: string; count: number | null; rows: unknown[] } = {
    command: "SELECT",
    count: null,
    rows: [],
  };
  const unsafe = vi.fn(async () =>
    Object.assign([...state.rows], {
      command: state.command,
      count: state.count,
    })
  );
  const end = vi.fn(async () => undefined);
  const client = { end, unsafe };
  const create = vi.fn((_options: CapturedPostgresOptions) => client);

  return { client, create, end, state, unsafe };
});

vi.mock("postgres", () => ({ default: postgresProvider.create }));

beforeEach(() => {
  vi.clearAllMocks();
  postgresProvider.state.command = "SELECT";
  postgresProvider.state.count = null;
  postgresProvider.state.rows = [];
});

describe("postgres.js controlled transport execution", () => {
  test("builds an owned client from its URL and installs VibORM scalar codecs", async () => {
    postgresProvider.state.rows = [{ id: 9 }];
    const customType = {
      from: [23],
      parse: (value: string) => Number(value),
      serialize: (value: unknown) => String(value),
      to: 23,
    };
    const driver = new PostgresDriver({
      databaseUrl: "postgres://user:pass@local.test:6543/viborm",
      options: { max: 3, types: { int4: customType } },
    });

    await expect(
      driver._execute<{ id: number }>(sql`SELECT ${9}`, {
        operation: "findUnique",
      })
    ).resolves.toEqual({ rows: [{ id: 9 }], rowCount: 1 });

    expect(postgresProvider.create).toHaveBeenCalledTimes(1);
    const options = postgresProvider.create.mock.calls[0]?.[0];
    expect(options).toMatchObject({
      database: "viborm",
      host: "local.test",
      max: 3,
      password: "pass",
      port: 6543,
      user: "user",
    });
    expect(options?.types.int4).toBe(customType);
    expect(options?.types.timestamp.serialize("2026-08-31 11:12:13")).toBe(
      "2026-08-31 11:12:13"
    );
    expect(options?.types.timestamp.parse("2026-08-31 11:12:13")).toBe(
      "2026-08-31 11:12:13"
    );
    expect(options?.types.json.serialize('{"ready":true}')).toBe(
      '{"ready":true}'
    );
    expect(options?.types.json.serialize({ ready: true })).toBe(
      '{"ready":true}'
    );
    expect(options?.types.json.parse('{"ready":true}')).toEqual({
      ready: true,
    });

    await driver.disconnect();
    expect(postgresProvider.end).toHaveBeenCalledOnce();
  });

  test("normalizes raw mutation counts through the supplied transport", async () => {
    postgresProvider.state.command = "UPDATE";
    postgresProvider.state.count = 4;
    const supplied = postgresProvider.client;
    const driver = new PostgresDriver({
      client: supplied as never,
    });

    await expect(
      driver._executeRaw("UPDATE events SET active = $1", [false], {
        operation: "updateMany",
      })
    ).resolves.toEqual({ rows: [], rowCount: 4 });
    expect(postgresProvider.unsafe).toHaveBeenCalledWith(
      "UPDATE events SET active = $1",
      [false]
    );

    await driver.disconnect();
    expect(postgresProvider.end).not.toHaveBeenCalled();
    expect(postgresProvider.create).not.toHaveBeenCalled();
  });

  test("uses default owned-client options when no URL is configured", async () => {
    const driver = new PostgresDriver();

    await expect(driver._executeRaw("SELECT 1")).resolves.toEqual({
      rows: [],
      rowCount: 0,
    });
    expect(postgresProvider.create).toHaveBeenCalledWith(
      expect.objectContaining({ types: expect.any(Object) })
    );
  });
});
