/**
 * How many statements a PostgreSQL migration command sends (plan D5,
 * decision 7), counted two ways:
 *
 * - the statement hook: every statement PGlite runs, whatever API sent it,
 *   reaches `execProtocolStream`, where a Parse or simple Query carries it;
 * - round trips: node-postgres over the PGlite wire bridge, where every Sync
 *   or simple Query the client sends is one wait for the server's reply.
 *
 * 1.1.0 sent 28 statements for a no-op `apply`, and 20 from the first DDL
 * through COMMIT for an add-column + index change (about 15 plus 5 per extra
 * proven operation), each one a round trip that holds the table lock at
 * 20 ms of latency. The targets: a no-op in 3 statements or fewer that still
 * proves there is no drift, and only the DDL plus at most 3 control
 * statements between the first DDL and COMMIT.
 *
 * The estate is realistic: a fifteen-field model holding 10,000 rows.
 */

import { createClient as createPgClient } from "@drivers/pg";
import { createClient } from "@drivers/pglite";
import type { PGlite } from "@electric-sql/pglite";
import { VibORMErrorCode } from "@errors";
import { createMigrationClient } from "@migrations";
import { MemoryEstateStorage } from "@migrations/storage/memory";
import { s } from "@schema";
import { openTestPGlite } from "@tests/fixtures/pglite-lifecycle";
import { pgliteWireServer } from "@tests/fixtures/pglite-wire-server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const ROWS = 10_000;
const NOOP_MAX = 3;
const WINDOW_CONTROL_MAX = 3;
const DDL = /^(ALTER TABLE|CREATE (UNIQUE )?INDEX|CREATE TABLE|DROP )/i;
const COMMIT = /^COMMIT\b/i;

const fields = () => ({
  id: s.string().id(),
  email: s.string().unique(),
  name: s.string(),
  status: s.enum(["trial", "active", "churned"]).default("trial"),
  balance: s.int().default(0),
  score: s.number().nullable(),
  settings: s.json().nullable(),
  country: s.string().default("FR"),
  age: s.int().nullable(),
  verified: s.boolean().default(false),
  notes: s.string().nullable(),
  lastSeenAt: s.dateTime().nullable(),
  deletedAt: s.dateTime().nullable(),
  createdAt: s.dateTime().now(),
  updatedAt: s.dateTime().updatedAt(),
});
const v1 = { account: s.model(fields()).map("accounts") };
/** Two proven operations: a column and an index. */
const v2 = {
  account: s
    .model({ ...fields(), nickname: s.string().nullable() })
    .index(["country"])
    .map("accounts"),
};
/** Four: two columns and two indexes, so a cost per operation would show. */
const v3 = {
  account: s
    .model({
      ...fields(),
      nickname: s.string().nullable(),
      referrer: s.string().nullable(),
      tier: s.int().default(0),
    })
    .index(["country"])
    .index(["createdAt"])
    .index(["tier"])
    .map("accounts"),
};
type Versions = typeof v1 | typeof v2 | typeof v3;

const decoder = new TextDecoder();

/** Every statement `command` makes PGlite run, in order. */
async function statementsOf<T>(
  database: PGlite,
  command: () => Promise<T>
): Promise<{ readonly result: T; readonly statements: string[] }> {
  const send = database.execProtocolStream;
  const statements: string[] = [];
  database.execProtocolStream = (message, options) => {
    if (message[0] === 0x50 || message[0] === 0x51) {
      const start = message[0] === 0x50 ? message.indexOf(0, 5) + 1 : 5;
      statements.push(
        decoder
          .decode(message.subarray(start, message.indexOf(0, start)))
          .replace(/\s+/g, " ")
          .trim()
      );
    }
    return send.call(database, message, options);
  };
  try {
    return { result: await command(), statements };
  } finally {
    database.execProtocolStream = send;
  }
}

/** The statements from the first DDL up to COMMIT, split by kind. */
function ddlWindow(statements: readonly string[]) {
  const first = statements.findIndex((statement) => DDL.test(statement));
  const commit =
    statements.length -
    1 -
    [...statements].reverse().findIndex((statement) => COMMIT.test(statement));
  const window = statements.slice(first, commit);
  const ddl = window.filter((statement) => DDL.test(statement));
  return {
    first,
    commit,
    ddl,
    control: window.filter((statement) => !DDL.test(statement)),
  };
}

async function seed(database: PGlite, table: string): Promise<void> {
  await database.query(
    `INSERT INTO ${table} ("id", "email", "name", "settings", "age", "updatedAt")
     SELECT 'acct-' || g, 'user' || g || '@example.com', 'name-' || g, jsonb_build_object('plan', 'pro', 'seats', g % 50), g % 90, now()
     FROM generate_series(1, ${ROWS}) g`
  );
}

describe("statement hook: a PGlite estate of 10,000 rows", () => {
  const database = openTestPGlite();
  const storage = new MemoryEstateStorage();
  const client = (schema: Versions) =>
    createMigrationClient(createClient({ client: database, schema }), {
      storage,
    });

  beforeAll(async () => {
    const first = client(v1);
    await first.generate({ name: "v1" });
    await first.apply();
    await seed(database, `"accounts"`);
  });

  it("a two-operation change sends only its DDL and 3 control statements between the first DDL and COMMIT", async () => {
    const second = client(v2);
    await second.generate({ name: "v2" });

    const { result, statements } = await statementsOf(database, () =>
      second.apply()
    );

    expect(result.outcome).toBe("applied");
    const window = ddlWindow(statements);
    expect(window.first).toBeGreaterThanOrEqual(0);
    expect(window.ddl).toHaveLength(2);
    // The catalog digest proving the destination, the marker CAS and the one
    // ledger row.
    expect(window.control).toHaveLength(WINDOW_CONTROL_MAX);
  });

  it("a four-operation change costs no more control statements than a two-operation one", async () => {
    const third = client(v3);
    await third.generate({ name: "v3" });

    const { result, statements } = await statementsOf(database, () =>
      third.apply()
    );

    expect(result.outcome).toBe("applied");
    const window = ddlWindow(statements);
    expect(window.ddl).toHaveLength(4);
    expect(window.control).toHaveLength(WINDOW_CONTROL_MAX);
  });

  it(`a no-op apply sends at most ${NOOP_MAX} statements`, async () => {
    const { result, statements } = await statementsOf(database, () =>
      client(v3).apply()
    );

    expect(result.outcome).toBe("noop");
    expect(statements.length).toBeLessThanOrEqual(NOOP_MAX);
  });

  it("a no-op apply still proves there is no drift", async () => {
    await database.exec(`ALTER TABLE "accounts" ADD COLUMN "drift" integer`);
    try {
      await expect(client(v3).apply()).rejects.toMatchObject({
        code: VibORMErrorCode.MIGRATION_DRIFT,
      });
    } finally {
      await database.exec(`ALTER TABLE "accounts" DROP COLUMN "drift"`);
    }
    await expect(client(v3).apply()).resolves.toMatchObject({
      outcome: "noop",
    });
  });
});

describe("round trips: node-postgres over the wire bridge", () => {
  const database = openTestPGlite();
  const server = pgliteWireServer(database);
  const namespace = "round_trips";
  const storage = new MemoryEstateStorage();
  let url: string;
  const disconnects: (() => Promise<void>)[] = [];
  const client = (schema: Versions) => {
    const orm = createPgClient({
      schema,
      databaseUrl: url,
      namespace,
      options: { max: 1 },
    });
    disconnects.push(() => orm.$disconnect());
    return createMigrationClient(orm, { storage });
  };
  /** Round trips the client waited for while `command` ran. */
  const roundTripsOf = async <T>(command: () => Promise<T>) => {
    const from = server.frontend.length;
    const result = await command();
    const roundTrips = server.frontend
      .slice(from)
      .filter(({ type }) => type === "S" || type === "Q").length;
    return { result, roundTrips };
  };

  beforeAll(async () => {
    await database.exec(`CREATE SCHEMA "${namespace}"`);
    url = `postgres://postgres:postgres@127.0.0.1:${await server.start()}/postgres`;
    const migrations = client(v1);
    await migrations.generate({ name: "v1" });
    await migrations.apply();
    await seed(database, `"${namespace}"."accounts"`);
    await client(v2).generate({ name: "v2" });
  });

  afterAll(async () => {
    for (const disconnect of disconnects) await disconnect();
    await server.stop();
  });

  it(`a no-op apply costs at most ${NOOP_MAX} round trips`, async () => {
    // Applying v2 also opens the pool's one connection: the startup
    // handshake is not the measured command's.
    const migrations = client(v2);
    await migrations.apply();

    const { result, roundTrips } = await roundTripsOf(() => migrations.apply());

    expect(result.outcome).toBe("noop");
    expect(roundTrips).toBeLessThanOrEqual(NOOP_MAX);
  });
});
