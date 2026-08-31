/**
 * The postgres.js transport, driven through a controlled stand-in for the
 * `postgres` module.
 *
 * The other postgres.js contracts all hand the driver a client, which is the
 * one path that never reaches `initClient`. Replacing the module is what makes
 * the OWNED half observable: URL parsing, the caller's option merge, and the
 * VibORM scalar codecs installed into `types` (`src/drivers/postgres/index.ts:76`).
 *
 * Result-shape normalization for this provider is owned by
 * `provider-result-contracts.core.test.ts`, and supplied-transport ownership by
 * `supplied-pool-ownership.core.test.ts`; neither is restated here.
 */

import { PostgresDriver } from "@drivers/postgres";
import { sql } from "@sql";
import { beforeEach, describe, expect, test, vi } from "vitest";

interface CapturedPostgresType {
  from: number[];
  parse: (value: string) => unknown;
  serialize: (value: unknown) => unknown;
  to: number;
}

/**
 * `types` is spelled member by member rather than as an index signature:
 * `noUncheckedIndexedAccess` would otherwise make every codec possibly
 * undefined and no call below would compile.
 */
interface CapturedPostgresOptions {
  database?: string;
  host?: string;
  max?: number;
  password?: string;
  port?: number;
  types: {
    int4?: CapturedPostgresType;
    json: CapturedPostgresType;
    timestamp: CapturedPostgresType;
  };
  user?: string;
}

const postgresProvider = vi.hoisted(() => {
  // postgres.js answers with its Result: an ARRAY of rows carrying `command`
  // and `count` as own properties. The driver returns that exact array as
  // `rows`, which is why row assertions below read length and elements rather
  // than comparing the whole array.
  const state: { command: string; count: number | null; rows: unknown[] } = {
    command: "SELECT",
    count: 0,
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
  postgresProvider.state.count = 0;
  postgresProvider.state.rows = [];
});

describe("postgres.js controlled transport execution", () => {
  test("builds an owned client from its URL and installs VibORM scalar codecs", async () => {
    postgresProvider.state.rows = [{ id: 9 }];
    postgresProvider.state.count = 1;
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

    const result = await driver._execute<{ id: number }>(sql`SELECT ${9}`, {
      operation: "findUnique",
    });

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toEqual({ id: 9 });
    expect(result.rowCount).toBe(1);

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

  test("runs a raw mutation on a supplied transport without building one", async () => {
    postgresProvider.state.command = "UPDATE";
    postgresProvider.state.count = 4;
    const driver = new PostgresDriver({
      client: postgresProvider.client as never,
    });

    const result = await driver._executeRaw(
      "UPDATE events SET active = $1",
      [false],
      { operation: "updateMany" }
    );

    // The UPDATE returns no rows, so 4 can only have come from the command tag.
    expect(result.rows).toHaveLength(0);
    expect(result.rowCount).toBe(4);
    expect(postgresProvider.unsafe).toHaveBeenCalledWith(
      "UPDATE events SET active = $1",
      [false]
    );
    // `initClient` short-circuits on the supplied transport, so the provider
    // module is never asked for a second one.
    expect(postgresProvider.create).not.toHaveBeenCalled();
  });

  test("installs only the codecs when no URL is configured", async () => {
    await new PostgresDriver()._connect();

    expect(postgresProvider.create).toHaveBeenCalledTimes(1);
    // No URL means no connection keys at all: postgres.js resolves its own
    // defaults, and the driver contributes exactly its `types` install.
    expect(postgresProvider.create.mock.calls[0]?.[0]).toEqual({
      types: expect.any(Object),
    });
  });
});
