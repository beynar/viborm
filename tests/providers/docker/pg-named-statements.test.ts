/**
 * pg Driver Tests - `namedStatements` on a real PostgreSQL server.
 *
 * Without the option, every statement is sent as it always was: no name. With
 * it, a generated statement with values is named the second time it is sent,
 * under a name its text decides, and a connection holds at most `max` names.
 * A name the server lost (a DEALLOCATE, a pooler) or whose plan no longer fits
 * the table is sent again unnamed, once, outside a transaction; in one, the
 * server's failure is the answer, and the next transaction parses again.
 *
 * NOTE: These tests require a running PostgreSQL database.
 */

import { createClient } from "@drivers/pg";
import { s } from "@schema";
import pg from "pg";
import { TEST_CONNECTION_STRING } from "./pg-fixtures";

const describeIf = TEST_CONNECTION_STRING ? describe : describe.skip;

const TABLE = "named_statements_person";
const NAME = /^v[0-9a-z]+$/;
const REFUSED_MAX = /namedStatements\.max must be a positive integer/;

const person = s
  .model({
    id: s.string().id(),
    email: s.string().unique(),
    name: s.string().nullable(),
  })
  .map(TABLE);

interface Sent {
  readonly text: string;
  readonly name?: string;
}

/**
 * A node-postgres pool of one connection, recording what each query asks of
 * it: one connection, so `pg_prepared_statements` reads the session every
 * statement ran on.
 */
function recordingPool() {
  const pool = new pg.Pool({
    connectionString: TEST_CONNECTION_STRING,
    max: 1,
  });
  const sent: Sent[] = [];
  const note = (query: unknown) => {
    if (typeof query === "object" && query !== null && "text" in query) {
      const { text, name } = query as { text: string; name?: string };
      sent.push(name === undefined ? { text } : { text, name });
    }
    return query;
  };
  const wrapped = {
    query: (query: never, values?: never) =>
      pool.query(note(query) as never, values),
    connect: async () => {
      const client = await pool.connect();
      return {
        query: (query: never, values?: never) =>
          client.query(note(query) as never, values),
        release: (error?: Error | boolean) => client.release(error),
        on: client.on.bind(client),
        off: client.off.bind(client),
      };
    },
    end: () => pool.end(),
    on: pool.on.bind(pool),
    off: pool.off.bind(pool),
  };
  return { pool, wrapped, sent };
}

/** The statements of this test's table the session holds, by name. */
const preparedNames = async (pool: pg.Pool): Promise<string[]> => {
  const { rows } = await pool.query<{ name: string }>(
    `SELECT name FROM pg_prepared_statements WHERE statement LIKE '%${TABLE}%' ORDER BY name`
  );
  return rows.map((row) => row.name);
};

describeIf("pg namedStatements", () => {
  const admin = new pg.Pool({
    connectionString: TEST_CONNECTION_STRING,
    max: 1,
  });

  beforeEach(async () => {
    await admin.query(`DROP TABLE IF EXISTS "${TABLE}"`);
    await admin.query(
      `CREATE TABLE "${TABLE}" ("id" text PRIMARY KEY, "email" text NOT NULL UNIQUE, "name" text)`
    );
    await admin.query(
      `INSERT INTO "${TABLE}" VALUES ('a', 'a@x.io', 'A'), ('b', 'b@x.io', 'B'), ('c', 'c@x.io', null)`
    );
  });

  afterAll(async () => {
    await admin.query(`DROP TABLE IF EXISTS "${TABLE}"`);
    await admin.end();
  });

  test("without the option, no statement is named", async () => {
    const { pool, wrapped, sent } = recordingPool();
    const db = createClient({ schema: { person }, pool: wrapped as never });
    for (let i = 0; i < 3; i++)
      await db.person.findUnique({ where: { id: "a" } });
    expect(sent.length).toBe(3);
    expect(sent.every((query) => query.name === undefined)).toBe(true);
    expect(await preparedNames(pool)).toEqual([]);
    await pool.end();
  });

  test("a statement is named the second time it is sent, under the name its text decides", async () => {
    const one = recordingPool();
    const two = recordingPool();
    const first = createClient({
      schema: { person },
      pool: one.wrapped as never,
      namedStatements: true,
    });
    const second = createClient({
      schema: { person },
      pool: two.wrapped as never,
      namedStatements: true,
    });
    for (let i = 0; i < 3; i++) {
      expect(await first.person.findUnique({ where: { id: "b" } })).toEqual({
        id: "b",
        email: "b@x.io",
        name: "B",
      });
      await second.person.findUnique({ where: { id: "a" } });
    }
    const [unnamed, ...named] = one.sent;
    expect(unnamed?.name).toBeUndefined();
    expect(named.map((query) => query.name)).toEqual([
      named[0]?.name,
      named[0]?.name,
    ]);
    expect(named[0]?.name).toMatch(NAME);
    // Another client of the same text names it the same: one pool can serve both.
    expect(two.sent.map((query) => query.name)).toEqual(
      one.sent.map((query) => query.name)
    );
    expect(await preparedNames(one.pool)).toEqual([named[0]?.name]);
    await one.pool.end();
    await two.pool.end();
  });

  test("a connection holds at most `max` names; a statement without values is never named", async () => {
    const { pool, wrapped, sent } = recordingPool();
    const db = createClient({
      schema: { person },
      pool: wrapped as never,
      namedStatements: { max: 2 },
    });
    for (let i = 0; i < 3; i++) {
      await db.person.findUnique({ where: { id: "a" } });
      await db.person.findUnique({ where: { email: "a@x.io" } });
      await db.person.findMany({ where: { name: "A" } });
      await db.person.count();
    }
    expect((await preparedNames(pool)).length).toBe(2);
    expect(
      new Set(sent.flatMap((query) => (query.name ? [query.name] : []))).size
    ).toBe(2);
    const counted = sent.filter((query) => query.text.includes("COUNT"));
    expect(counted.every((query) => query.name === undefined)).toBe(true);
    await pool.end();
  });

  test("a name the server lost is sent again unnamed, then named anew", async () => {
    const { pool, wrapped, sent } = recordingPool();
    const db = createClient({
      schema: { person },
      pool: wrapped as never,
      namedStatements: true,
    });
    await db.person.findUnique({ where: { id: "a" } });
    await db.person.findUnique({ where: { id: "a" } });
    const lost = sent.at(-1)?.name;
    expect(lost).toBeDefined();
    await pool.query("DEALLOCATE ALL");
    sent.length = 0;
    expect(await db.person.findUnique({ where: { id: "c" } })).toEqual({
      id: "c",
      email: "c@x.io",
      name: null,
    });
    expect(sent.map((query) => query.name)).toEqual([lost, undefined]);
    sent.length = 0;
    await db.person.findUnique({ where: { id: "a" } });
    const renamed = sent.at(-1)?.name;
    expect(renamed).toBeDefined();
    expect(renamed).not.toBe(lost);
    expect(await preparedNames(pool)).toEqual([renamed]);
    await pool.end();
  });

  test("at the bound, a statement whose name went stale stays unnamed", async () => {
    const { pool, wrapped, sent } = recordingPool();
    const db = createClient({
      schema: { person },
      pool: wrapped as never,
      namedStatements: { max: 1 },
    });
    await db.person.findUnique({ where: { id: "a" } });
    await db.person.findUnique({ where: { id: "a" } });
    expect(sent.at(-1)?.name).toBeDefined();
    await pool.query("DEALLOCATE ALL");
    sent.length = 0;
    for (let i = 0; i < 3; i++) {
      expect(await db.person.findUnique({ where: { id: "b" } })).toEqual({
        id: "b",
        email: "b@x.io",
        name: "B",
      });
    }
    // The failed named attempt, its unnamed replay, then unnamed: the one
    // name the bound allows was given, and a connection that kept it may
    // still hold it.
    expect(sent.map((query) => query.name === undefined)).toEqual([
      false,
      true,
      true,
      true,
    ]);
    expect(await preparedNames(pool)).toEqual([]);
    await pool.end();
  });

  test("a plan whose result type changed under it is sent again unnamed", async () => {
    const { pool, wrapped, sent } = recordingPool();
    const db = createClient({
      schema: { person },
      pool: wrapped as never,
      namedStatements: true,
    });
    await db.person.findUnique({ where: { id: "a" } });
    await db.person.findUnique({ where: { id: "a" } });
    await pool.query(
      `ALTER TABLE "${TABLE}" ALTER COLUMN "name" TYPE varchar(64)`
    );
    sent.length = 0;
    expect(await db.person.findUnique({ where: { id: "a" } })).toEqual({
      id: "a",
      email: "a@x.io",
      name: "A",
    });
    expect(sent.length).toBe(2);
    expect(sent[1]?.name).toBeUndefined();
    await pool.end();
  });

  test("a parameter whose enum type a migration replaced is sent again unnamed", async () => {
    const { pool, wrapped, sent } = recordingPool();
    await pool.query(`DROP TYPE IF EXISTS "named_statements_mood"`);
    await pool.query(
      `CREATE TYPE "named_statements_mood" AS ENUM ('calm', 'busy')`
    );
    await pool.query(
      `ALTER TABLE "${TABLE}" ADD COLUMN "mood" "named_statements_mood" NOT NULL DEFAULT 'calm'`
    );
    const moody = s
      .model({
        id: s.string().id(),
        email: s.string().unique(),
        mood: s.enum(["calm", "busy"]),
      })
      .map(TABLE);
    const db = createClient({
      schema: { moody },
      pool: wrapped as never,
      namedStatements: true,
    });
    await db.moody.findMany({
      where: { mood: "calm" },
      orderBy: { id: "asc" },
    });
    await db.moody.findMany({
      where: { mood: "calm" },
      orderBy: { id: "asc" },
    });
    // What a migration that adds a value in the middle does: a new type replaces the old one.
    await pool.query(
      `ALTER TYPE "named_statements_mood" RENAME TO "named_statements_mood_old"`
    );
    await pool.query(
      `CREATE TYPE "named_statements_mood" AS ENUM ('calm', 'idle', 'busy')`
    );
    await pool.query(`ALTER TABLE "${TABLE}" ALTER COLUMN "mood" DROP DEFAULT`);
    await pool.query(
      `ALTER TABLE "${TABLE}" ALTER COLUMN "mood" TYPE "named_statements_mood" USING "mood"::text::"named_statements_mood"`
    );
    await pool.query(`DROP TYPE "named_statements_mood_old"`);
    sent.length = 0;
    const rows = await db.moody.findMany({
      where: { mood: "calm" },
      orderBy: { id: "asc" },
    });
    expect(rows.map((row) => row.id)).toEqual(["a", "b", "c"]);
    expect(sent.map((query) => query.name === undefined)).toEqual([
      false,
      true,
    ]);
    await pool.query(`ALTER TABLE "${TABLE}" DROP COLUMN "mood"`);
    await pool.query(`DROP TYPE "named_statements_mood"`);
    await pool.end();
  });

  test("a failing statement fails the same way named or not", async () => {
    const failure = async (namedStatements: boolean) => {
      const { pool, wrapped } = recordingPool();
      const db = createClient({
        schema: { person },
        pool: wrapped as never,
        namedStatements,
      });
      const errors: unknown[] = [];
      for (let i = 0; i < 3; i++) {
        errors.push(
          await db.person
            .create({ data: { id: `n${i}`, email: "a@x.io" } })
            .catch((error: unknown) => error)
        );
      }
      await pool.end();
      return errors.map((error) => {
        const { name, message, code } = error as {
          name: string;
          message: string;
          code?: unknown;
        };
        // Each call has its own correlation id; the rest is the failure.
        const { correlationId: _, ...meta } = (
          error as { meta: Record<string, unknown> }
        ).meta;
        return { name, message, code, meta };
      });
    };
    const unnamed = await failure(false);
    expect(unnamed[0]?.name).toBe("UniqueConstraintError");
    expect(await failure(true)).toEqual(unnamed);
  });

  test("named statements run in a transaction and its savepoints", async () => {
    const { pool, wrapped, sent } = recordingPool();
    const db = createClient({
      schema: { person },
      pool: wrapped as never,
      namedStatements: true,
    });
    await db.$transaction(async (tx) => {
      await tx.person.update({ where: { id: "a" }, data: { name: "A1" } });
      await tx.person.update({ where: { id: "b" }, data: { name: "B1" } });
      await tx
        .$transaction(async (nested) => {
          await nested.person.update({
            where: { id: "c" },
            data: { name: "C1" },
          });
          await nested.person.create({ data: { id: "d", email: "a@x.io" } });
        })
        .catch(() => undefined);
      await tx.person.update({ where: { id: "c" }, data: { name: "C2" } });
    });
    expect(sent.some((query) => query.name !== undefined)).toBe(true);
    expect(await db.person.findMany({ orderBy: { id: "asc" } })).toEqual([
      { id: "a", email: "a@x.io", name: "A1" },
      { id: "b", email: "b@x.io", name: "B1" },
      { id: "c", email: "c@x.io", name: "C2" },
    ]);
    await pool.end();
  });

  test("in a transaction, a lost name fails the transaction; the next one parses again", async () => {
    const { pool, wrapped, sent } = recordingPool();
    const db = createClient({
      schema: { person },
      pool: wrapped as never,
      namedStatements: true,
    });
    await db.person.findUnique({ where: { id: "a" } });
    await db.person.findUnique({ where: { id: "a" } });
    await pool.query("DEALLOCATE ALL");
    const failed = await db
      .$transaction((tx) => tx.person.findUnique({ where: { id: "a" } }))
      .catch((error: unknown) => error);
    expect(failed).toBeInstanceOf(Error);
    // The server's own failure: the name it no longer has.
    expect(
      (failed as { meta?: { providerSqlState?: unknown } }).meta
        ?.providerSqlState
    ).toBe("26000");
    sent.length = 0;
    expect(
      await db.$transaction((tx) =>
        tx.person.findUnique({ where: { id: "a" } })
      )
    ).toEqual({ id: "a", email: "a@x.io", name: "A" });
    expect(
      sent.find((query) => query.text.includes(TABLE))?.name
    ).toBeDefined();
    await pool.end();
  });

  test("a `max` that is not a positive integer is refused", () => {
    expect(() =>
      createClient({
        schema: { person },
        databaseUrl: TEST_CONNECTION_STRING,
        namedStatements: { max: 0 },
      })
    ).toThrow(REFUSED_MAX);
  });
});
