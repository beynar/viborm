/**
 * Phase 9 — PostgreSQL transport pipelining: the measurement.
 *
 * The plan's premise was that postgres.js "pipelines statements inside
 * `sql.begin` automatically when statements are issued without intermediate
 * awaits". This file measures that premise at the wire, because the plan's own
 * rule is measure first, then adopt the measured winner.
 *
 * The measurement instrument is a TCP proxy that counts round trips: a
 * client->server burst that follows server->client data is one completed round
 * trip, which is exactly one wait the client could not avoid.
 *
 * The verdict these tests pin is recorded in
 * `docs/architecture/query-performance-plan.md` under Phase 9. Should a future
 * postgres.js open the pipeline gate, `pipelining stays closed ...` fails and
 * sends the reader back to that section.
 */

import net from "node:net";
import { PostgresDriver } from "@drivers/postgres";
import postgres from "postgres";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "vitest";

const TEST_CONNECTION_STRING = process.env.PG_TEST_CONNECTION_STRING;
const describeIf = TEST_CONNECTION_STRING ? describe : describe.skip;

const TABLE = "p9_pipelining_probe";
/** Statements per measured transaction. */
const N = 8;

// =============================================================================
// THE INSTRUMENT: a wire-level round-trip counter
// =============================================================================

type RoundTripProxy = {
  port: number;
  start: () => void;
  stop: () => number;
  close: () => Promise<void>;
};

const startRoundTripProxy = (
  targetHost: string,
  targetPort: number
): Promise<RoundTripProxy> => {
  let roundTrips = 0;
  let counting = false;

  const server = net.createServer((client) => {
    const upstream = net.connect({ host: targetHost, port: targetPort });
    // Nagle would merge bursts that the protocol kept separate and undercount.
    client.setNoDelay(true);
    upstream.setNoDelay(true);

    let lastDirection: "c2s" | "s2c" | null = null;
    client.on("data", (chunk) => {
      if (counting && lastDirection === "s2c") roundTrips += 1;
      lastDirection = "c2s";
      upstream.write(chunk);
    });
    upstream.on("data", (chunk) => {
      lastDirection = "s2c";
      client.write(chunk);
    });

    const drop = () => {
      client.destroy();
      upstream.destroy();
    };
    client.on("error", drop);
    upstream.on("error", drop);
    client.on("close", () => upstream.destroy());
    upstream.on("close", () => client.destroy());
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        throw new Error("round-trip proxy did not bind a TCP port");
      }
      resolve({
        port: address.port,
        start: () => {
          roundTrips = 0;
          counting = true;
        },
        stop: () => {
          counting = false;
          return roundTrips;
        },
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
};

describeIf("postgres.js transport pipelining (Phase 9)", () => {
  const upstream = new URL(TEST_CONNECTION_STRING ?? "postgres://127.0.0.1");
  let proxy: RoundTripProxy;
  let sql: ReturnType<typeof postgres>;
  let driver: PostgresDriver;

  /** The statements every arm runs: ref-free, order-sensitive, parameterized. */
  const rows = Array.from({ length: N }, (_, i) => i);
  const INSERT = `INSERT INTO "${TABLE}" ("v") VALUES ($1)`;

  /** Count the round trips one arm spends, with the table emptied first. */
  const measure = async (arm: () => Promise<unknown>): Promise<number> => {
    await sql.unsafe(`TRUNCATE "${TABLE}"`);
    proxy.start();
    await arm();
    return proxy.stop();
  };

  beforeAll(async () => {
    proxy = await startRoundTripProxy(
      upstream.hostname,
      Number.parseInt(upstream.port, 10)
    );
    const proxied = {
      host: "127.0.0.1",
      port: proxy.port,
      database: upstream.pathname.slice(1),
      user: upstream.username,
      password: upstream.password,
      // One connection, so every measured burst belongs to the arm under test.
      max: 1,
      onnotice: () => {
        // DROP TABLE IF EXISTS on a missing table is expected here
      },
    };
    sql = postgres(proxied);
    driver = new PostgresDriver({ options: proxied });

    await sql.unsafe(`DROP TABLE IF EXISTS "${TABLE}"`);
    await sql.unsafe(
      `CREATE TABLE "${TABLE}" ("id" serial primary key, "v" int)`
    );
    // Open both connections before any measurement so that the startup
    // handshake never lands inside a counting window.
    await driver._executeRaw("SELECT 1");
  });

  afterAll(async () => {
    await sql.unsafe(`DROP TABLE IF EXISTS "${TABLE}"`).catch(() => {
      // the table is scratch; a teardown failure must not mask a test failure
    });
    await driver.disconnect();
    await sql.end();
    await proxy.close();
  });

  beforeEach(async () => {
    await sql.unsafe(`TRUNCATE "${TABLE}"`);
  });

  // ===========================================================================
  // THE BASELINE
  // ===========================================================================

  test("the driver's batch costs two round trips per parameterized statement", async () => {
    const batch = rows.map((v) => ({ sql: INSERT, params: [v] }));
    const roundTrips = await measure(() => driver._executeBatch(batch));

    // BEGIN and COMMIT cost one each; every parameterized statement costs two,
    // because postgres.js must ask the server to describe the parameters
    // before it can bind them (`connection.js` `describeFirst`).
    expect(roundTrips).toBe(2 * N + 2);

    const stored = await sql.unsafe(`SELECT "v" FROM "${TABLE}" ORDER BY "id"`);
    expect(stored.map((r) => r.v)).toEqual(rows);
  });

  // ===========================================================================
  // THE PHASE 9 MECHANISM, MEASURED
  // ===========================================================================

  test("pipelining stays closed when statements are issued without intermediate awaits", async () => {
    const sequential = await measure(() =>
      sql.begin(async (tx) => {
        for (const v of rows) await tx.unsafe(INSERT, [v]);
      })
    );
    const withoutAwaits = await measure(() =>
      sql.begin((tx) => Promise.all(rows.map((v) => tx.unsafe(INSERT, [v]))))
    );

    // This is Phase 9's proposal, verbatim, and it buys exactly nothing.
    // postgres.js gates pipelining on `!q.describeFirst` (connection.js), and
    // `describeFirst` is true for every parameterized query that is not already
    // a cached prepared statement. `sql.unsafe()` hard-sets `prepare: false`,
    // so viborm's statements are never cached and the gate never opens.
    expect(withoutAwaits).toBe(sequential);
    expect(withoutAwaits).toBe(2 * N + 2);
  });

  test("the pipeline gate opens only for cached prepared statements", async () => {
    // Warm the cache: the first execution still pays the describe round trip.
    await sql.begin((tx) =>
      Promise.all(rows.map((v) => tx.unsafe(INSERT, [v], { prepare: true })))
    );
    const pipelined = await measure(() =>
      sql.begin((tx) =>
        Promise.all(rows.map((v) => tx.unsafe(INSERT, [v], { prepare: true })))
      )
    );

    // The win Phase 9 was after is real, but it is behind `prepare`, not behind
    // the await pattern. Recorded as a quantified follow-up in the plan doc;
    // adopting it is a deployment decision (transaction-mode poolers reject
    // named prepared statements, and postgres.js never evicts its cache), so it
    // is not taken here.
    expect(pipelined).toBeLessThan(2 * N + 2);
    expect(pipelined).toBeLessThanOrEqual(N);
    // An upper bound alone would also be satisfied by an instrument that had
    // stopped counting; BEGIN and COMMIT alone cost round trips, so zero here
    // means the proxy went deaf rather than the transport getting faster.
    expect(pipelined).toBeGreaterThan(0);

    const stored = await sql.unsafe(`SELECT "v" FROM "${TABLE}" ORDER BY "id"`);
    expect(stored.map((r) => r.v)).toEqual(rows);
  });

  // ===========================================================================
  // THE CONTRACTS A FUTURE ADOPTION MUST NOT BREAK
  // ===========================================================================

  test("a mid-run failure reports the same error and rolls back the same way on both paths", async () => {
    // Statement 2 of 3 collides on the primary key.
    const collide = async (
      run: (tx: postgres.TransactionSql) => Promise<unknown>
    ) => {
      await sql.unsafe(`TRUNCATE "${TABLE}"`);
      await sql.unsafe(`INSERT INTO "${TABLE}" ("id", "v") VALUES (2, 0)`);
      let caught: (Error & Record<string, unknown>) | null = null;
      proxy.start();
      try {
        await sql.begin(run);
      } catch (error) {
        caught = error as Error & Record<string, unknown>;
      }
      const roundTrips = proxy.stop();
      const survivors = await sql.unsafe(
        `SELECT "id" FROM "${TABLE}" ORDER BY "id"`
      );
      return {
        surface: {
          name: caught?.name,
          code: caught?.code,
          message: caught?.message,
          constraint: caught?.constraint_name,
          aggregate: caught instanceof AggregateError,
          survivors: survivors.map((r) => r.id),
        },
        roundTrips,
      };
    };

    const attempts: [number, number][] = [
      [1, 10],
      [2, 20],
      [3, 30],
    ];
    const stmt = `INSERT INTO "${TABLE}" ("id", "v") VALUES ($1, $2)`;

    const sequential = await collide(async (tx) => {
      for (const a of attempts) await tx.unsafe(stmt, a);
    });
    // Warm the cache so this arm genuinely pipelines rather than falling back.
    await sql
      .begin(async (tx) => {
        await tx.unsafe(stmt, [99, 0], { prepare: true });
        throw new Error("warm-up rollback");
      })
      .catch(() => {
        // intentional: the warm-up only needs to populate the statement cache
      });
    const pipelined = await collide((tx) =>
      Promise.all(attempts.map((a) => tx.unsafe(stmt, a, { prepare: true })))
    );

    // Same error identity, same attribution, same rollback: statement 1 does
    // not survive, and the pre-existing row is untouched.
    expect(pipelined.surface).toEqual(sequential.surface);
    expect(sequential.surface.code).toBe("23505");
    expect(sequential.surface.constraint).toBe(`${TABLE}_pkey`);
    expect(sequential.surface.aggregate).toBe(false);
    expect(sequential.surface.survivors).toEqual([2]);

    // Without this the comparison would be vacuous: it would keep passing if
    // the "pipelined" arm quietly fell back to one statement at a time. Fewer
    // round trips for the same three statements is the proof that the second
    // arm really did have statement 3 on the wire before statement 2 failed.
    expect(pipelined.roundTrips).toBeLessThan(sequential.roundTrips);
  });

  test("statement order survives a run issued without intermediate awaits", async () => {
    // Order is the executor's contract; the transport may not reorder.
    await sql.unsafe(`TRUNCATE "${TABLE}"`);
    const marks = ["a", "b", "c", "d"].map((_, i) => i * 7 + 1);
    await sql.begin((tx) =>
      Promise.all(marks.map((v) => tx.unsafe(INSERT, [v], { prepare: true })))
    );

    const stored = await sql.unsafe(`SELECT "v" FROM "${TABLE}" ORDER BY "id"`);
    expect(stored.map((r) => r.v)).toEqual(marks);
  });
});
