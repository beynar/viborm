/**
 * SQL Server: a transaction the server rolls back itself (a deadlock victim,
 * a killed session, `XACT_ABORT ON`) fails with its own typed error, and the
 * client stays usable. Set MSSQL_TEST_CONNECTION_STRING to run.
 */

import { createClient } from "@client/client";
import { MssqlDriver } from "@drivers/mssql";
import {
  TransactionError,
  UniqueConstraintError,
  VibORMErrorCode,
} from "@errors";
import { s } from "@schema";
import { sql } from "@sql";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import sqlServer from "mssql";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  onTestFinished,
  test,
} from "vitest";
import {
  createSchema,
  dropSchema,
  TEST_CONNECTION_STRING,
} from "./mssql-fixtures";

const describeIf = TEST_CONNECTION_STRING ? describe : describe.skip;
const NAMESPACE = "viborm_transactions";

const counter = s
  .model({
    id: s.int().id().increment(),
    key: s.string().unique(),
    value: s.int(),
  })
  .map("counters");

const open = (options?: object) =>
  createClient({
    schema: { counter },
    driver: new MssqlDriver({
      databaseUrl: TEST_CONNECTION_STRING,
      namespace: NAMESPACE,
      ...(options ? { options } : {}),
    }),
  });

type Client = ReturnType<typeof open>;
const clients: Client[] = [];
const client = (options?: object): Client => {
  const opened = open(options);
  clients.push(opened);
  return opened;
};

describeIf("SQL Server transactions the server rolls back", () => {
  beforeAll(async () => {
    await createSchema(NAMESPACE);
    await syncLiveSchema(client());
  });
  beforeEach(async () => {
    await clients[0]!.counter.deleteMany({});
  });
  afterAll(async () => {
    for (const opened of clients) await opened.$disconnect();
    await dropSchema(NAMESPACE);
  });

  test("a deadlock victim fails with the typed deadlock, and both clients stay usable", async () => {
    const first = client();
    const second = client();
    await first.counter.createMany({
      data: [
        { key: "a", value: 0 },
        { key: "b", value: 0 },
      ],
    });
    let arrived = 0;
    let release!: () => void;
    const bothLocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const crossing = (db: Client, mine: string, theirs: string) =>
      db.$transaction(async (tx) => {
        await tx.counter.update({ where: { key: mine }, data: { value: 1 } });
        arrived += 1;
        if (arrived === 2) release();
        await bothLocked;
        await tx.counter.update({ where: { key: theirs }, data: { value: 2 } });
      });
    const outcomes = await Promise.allSettled([
      crossing(first, "a", "b"),
      crossing(second, "b", "a"),
    ]);
    const failures = outcomes.flatMap((outcome) =>
      outcome.status === "rejected" ? [outcome.reason as unknown] : []
    );
    expect(failures).toHaveLength(1);
    expect(failures[0]).toBeInstanceOf(TransactionError);
    expect((failures[0] as TransactionError).code).toBe(
      VibORMErrorCode.DEADLOCK
    );
    expect(await first.counter.count()).toBe(2);
    expect(await second.counter.count()).toBe(2);
  });

  test("a session killed under its transaction fails it, and the client stays usable", async () => {
    const victim = client();
    const killer = client();
    await expect(
      victim.$transaction(async (tx) => {
        const [row] = await tx.$queryRaw<{ spid: number }>(
          sql`SELECT @@SPID AS spid`
        );
        await killer.$executeRaw(sql.raw(`KILL ${Number(row!.spid)}`));
        await tx.counter.create({ data: { key: "k", value: 1 } });
      })
    ).rejects.toThrow();
    expect(await victim.counter.count()).toBe(0);
    await victim.counter.create({ data: { key: "after", value: 1 } });
    expect(await victim.counter.count()).toBe(1);
  });

  test("under XACT_ABORT ON a failed statement fails its transaction with its own error, and the client stays usable", async () => {
    const strict = client({ options: { abortTransactionOnError: true } });
    await strict.counter.create({ data: { key: "taken", value: 0 } });
    await expect(
      strict.$transaction(async (tx) => {
        await tx.counter.create({ data: { key: "first", value: 1 } });
        await tx.counter.create({ data: { key: "taken", value: 1 } });
      })
    ).rejects.toBeInstanceOf(UniqueConstraintError);
    expect(
      (await strict.counter.findMany({ orderBy: { key: "asc" } })).map(
        (row) => row.key
      )
    ).toEqual(["taken"]);
  });

  /** What a failed transaction reports: its class and its reason. */
  const reported = (error: unknown) => ({
    typed: error instanceof TransactionError,
    reason: (error as TransactionError | undefined)?.meta?.reason,
  });
  const UNKNOWN_COMMIT = { typed: true, reason: "commit-outcome-unknown" };

  test("a session lost between the last statement and COMMIT: an unknown outcome, nothing committed, the client usable", async () => {
    const victim = client();
    const killer = client();
    const failure = await victim
      .$transaction(async (tx) => {
        await tx.counter.create({ data: { key: "lost", value: 1 } });
        const [row] = await tx.$queryRaw<{ spid: number }>(
          sql`SELECT @@SPID AS spid`
        );
        await killer.$executeRaw(sql.raw(`KILL ${Number(row!.spid)}`));
      })
      .then(
        () => undefined,
        (error: unknown) => error
      );
    expect(reported(failure)).toEqual(UNKNOWN_COMMIT);
    expect(await victim.counter.count()).toBe(0);
  });

  test("a COMMIT past its request timeout: an unknown outcome, though the server committed, and the client usable", async () => {
    // One COMMIT with a 1 ms request timeout: tedious gives up waiting, the
    // server commits anyway.
    const prototype = sqlServer.Transaction.prototype as unknown as {
      commit: (...args: unknown[]) => Promise<void>;
      _acquiredConnection?: { config: { options: { requestTimeout: number } } };
    };
    const commit = prototype.commit;
    onTestFinished(() => {
      prototype.commit = commit;
    });
    prototype.commit = function (this: typeof prototype, ...args: unknown[]) {
      const options = this._acquiredConnection?.config.options;
      if (!options) return commit.apply(this, args);
      const before = options.requestTimeout;
      options.requestTimeout = 1;
      const restore = () => {
        options.requestTimeout = before;
      };
      const committing = commit.apply(this, args);
      committing.then(restore, restore);
      return committing;
    };
    const slow = client();
    const failure = await slow
      .$transaction(async (tx) => {
        await tx.$executeRaw(
          sql.raw(
            `INSERT INTO "${NAMESPACE}"."counters" ("key", "value") SELECT TOP 3000 CONCAT('slow-', ROW_NUMBER() OVER (ORDER BY (SELECT NULL))), 1 FROM sys.all_objects AS a CROSS JOIN sys.all_objects AS b`
          )
        );
      })
      .then(
        () => undefined,
        (error: unknown) => error
      );
    prototype.commit = commit;
    expect(reported(failure)).toEqual(UNKNOWN_COMMIT);
    expect(await client().counter.count()).toBe(3000);
    expect(await slow.counter.count()).toBe(3000);
  });
});
