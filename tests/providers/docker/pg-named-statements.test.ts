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
import { vi } from "vitest";
import { TEST_CONNECTION_STRING } from "./pg-fixtures";

const describeIf = TEST_CONNECTION_STRING ? describe : describe.skip;

const TABLE = "named_statements_person";
const NAME = /^v[0-9a-z]+$/;
const REFUSED =
  /namedStatements must be true, "explicit" or \{ max, auto\? \}, max a positive integer/;
const TOLD_MAX = /all namedStatements\.max \(1\) names are given/;
const SELECT = /^SELECT/;

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
  /** Everything the query object holds but its name, as JSON. */
  readonly sent: string;
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
      const { name, ...rest } = query as { text: string; name?: string };
      const { text } = rest;
      const json = JSON.stringify(rest);
      sent.push(
        name === undefined ? { text, sent: json } : { text, name, sent: json }
      );
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

  test("raw SQL is never named, and takes no name a generated statement could have", async () => {
    const { pool, wrapped, sent } = recordingPool();
    const db = createClient({
      schema: { person },
      pool: wrapped as never,
      namedStatements: { max: 1 },
    });
    // A tagged raw statement with values runs as a typed statement does.
    for (let i = 0; i < 3; i++) {
      expect(await db.$queryRaw`SELECT ${1}::int AS "raw_one"`).toEqual([
        { raw_one: 1 },
      ]);
      await db.$executeRaw`UPDATE "named_statements_person" SET "name" = "name" WHERE "id" = ${"none"}`;
    }
    for (let i = 0; i < 2; i++)
      await db.$transaction([
        db.$queryRaw`SELECT ${2}::int AS "raw_two"`,
        db.$executeRaw`UPDATE "named_statements_person" SET "name" = "name" WHERE "id" = ${"gone"}`,
      ]);
    const raw = sent.filter(
      (query) => query.text.includes("raw_") || query.text.startsWith("UPDATE")
    );
    expect(raw.length).toBe(10);
    expect(raw.every((query) => query.name === undefined)).toBe(true);
    expect(await preparedNames(pool)).toEqual([]);
    // The one name is still there for a generated statement.
    await db.person.findUnique({ where: { id: "a" } });
    await db.person.findUnique({ where: { id: "b" } });
    expect((await preparedNames(pool)).length).toBe(1);
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
    ).toThrow(REFUSED);
  });

  test('a mode that is not `true`, `"explicit"` or `{ max, auto }` is refused', () => {
    const refused = (namedStatements: unknown) => () =>
      createClient({
        schema: { person },
        databaseUrl: TEST_CONNECTION_STRING,
        namedStatements: namedStatements as never,
      });
    expect(refused("auto")).toThrow(REFUSED);
    expect(refused({ max: 10, auto: "no" })).toThrow(REFUSED);
  });
});

const PETS = "named_statements_pet";
const owner = s
  .model({
    id: s.string().id(),
    email: s.string().unique(),
    name: s.string().nullable(),
    pets: s.toMany(() => pet),
  })
  .map(TABLE);
const pet = s
  .model({
    id: s.string().id(),
    name: s.string(),
    ownerId: s.string(),
    owner: s
      .toOne(() => owner)
      .fields("ownerId")
      .references("id"),
  })
  .map(PETS);

/** The texts a run sent named, and those it sent unnamed, of this test's tables. */
const split = (sent: readonly Sent[]) => ({
  named: sent.filter((query) => query.name !== undefined),
  unnamed: sent.filter(
    (query) => query.name === undefined && query.text.includes(TABLE)
  ),
});

describeIf("pg named, the call option", () => {
  const admin = new pg.Pool({
    connectionString: TEST_CONNECTION_STRING,
    max: 1,
  });

  beforeEach(async () => {
    await admin.query(`DROP TABLE IF EXISTS "${PETS}"`);
    await admin.query(`DROP TABLE IF EXISTS "${TABLE}"`);
    await admin.query(
      `CREATE TABLE "${TABLE}" ("id" text PRIMARY KEY, "email" text NOT NULL UNIQUE, "name" text)`
    );
    await admin.query(
      `INSERT INTO "${TABLE}" VALUES ('a', 'a@x.io', 'A'), ('b', 'b@x.io', 'B'), ('c', 'c@x.io', null)`
    );
    await admin.query(
      `CREATE TABLE "${PETS}" ("id" text PRIMARY KEY, "name" text NOT NULL, "ownerId" text NOT NULL REFERENCES "${TABLE}" ("id"))`
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await admin.query(`DROP TABLE IF EXISTS "${PETS}"`);
    await admin.query(`DROP TABLE IF EXISTS "${TABLE}"`);
    await admin.end();
  });

  test("`named: true` names a statement at its first sending, in either mode", async () => {
    for (const namedStatements of [true, "explicit"] as const) {
      const { pool, wrapped, sent } = recordingPool();
      const db = createClient({
        schema: { person },
        pool: wrapped as never,
        namedStatements,
      });
      expect(
        await db.person.findUnique({ where: { id: "b" }, named: true })
      ).toEqual({ id: "b", email: "b@x.io", name: "B" });
      expect(sent.length).toBe(1);
      expect(sent[0]?.name).toMatch(NAME);
      expect(await preparedNames(pool)).toEqual([sent[0]?.name]);
      await pool.end();
    }
  });

  test("`named: false` is never named, even in the automatic mode, and is no sighting", async () => {
    const { pool, wrapped, sent } = recordingPool();
    const db = createClient({
      schema: { person },
      pool: wrapped as never,
      namedStatements: true,
    });
    for (let i = 0; i < 3; i++)
      await db.person.findUnique({ where: { id: "a" }, named: false });
    expect(sent.every((query) => query.name === undefined)).toBe(true);
    // The automatic mode counts from the first call that does not refuse.
    await db.person.findUnique({ where: { id: "a" } });
    expect(sent.at(-1)?.name).toBeUndefined();
    await db.person.findUnique({ where: { id: "a" } });
    expect(sent.at(-1)?.name).toMatch(NAME);
    // And a name given does not reach a call that refuses one.
    await db.person.findUnique({ where: { id: "a" }, named: false });
    expect(sent.at(-1)?.name).toBeUndefined();
    await pool.end();
  });

  test("the explicit mode, in both spellings, names only the calls that pass `named: true`", async () => {
    for (const namedStatements of [
      "explicit",
      { max: 100, auto: false },
    ] as const) {
      const { pool, wrapped, sent } = recordingPool();
      const db = createClient({
        schema: { person },
        pool: wrapped as never,
        namedStatements,
      });
      for (let i = 0; i < 3; i++) {
        await db.person.findUnique({ where: { id: "a" } });
        await db.person.findMany({ where: { name: "A" } });
      }
      expect(sent.every((query) => query.name === undefined)).toBe(true);
      sent.length = 0;
      await db.person.findMany({ where: { name: "A" }, named: true });
      await db.person.findMany({ where: { name: "B" } });
      expect(sent.map((query) => query.name === undefined)).toEqual([
        false,
        true,
      ]);
      expect((await preparedNames(pool)).length).toBe(1);
      await pool.end();
    }
  });

  test("`max` counts every name; a `named: true` call past it is sent unnamed, and told once per text", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { pool, wrapped, sent } = recordingPool();
    const db = createClient({
      schema: { person },
      pool: wrapped as never,
      namedStatements: { max: 1 },
    });
    // The automatic mode takes the one place.
    await db.person.findUnique({ where: { id: "a" } });
    await db.person.findUnique({ where: { id: "a" } });
    sent.length = 0;
    for (let i = 0; i < 3; i++) {
      await db.person.findMany({ where: { name: "A" }, named: true });
      await db.person.findMany({ where: { email: "a@x.io" }, named: true });
    }
    expect(sent.length).toBe(6);
    expect(sent.every((query) => query.name === undefined)).toBe(true);
    expect((await preparedNames(pool)).length).toBe(1);
    expect(warn).toHaveBeenCalledTimes(2);
    const told = warn.mock.calls.map(([message]) => String(message));
    expect(told[0]).toMatch(TOLD_MAX);
    expect(told[0]).toContain(`"q0"."name" = $1`);
    expect(told[1]).toContain(`"q0"."email" = $1`);
    await pool.end();
  });

  test("an array transaction and an interactive one: each call carries its own", async () => {
    const { pool, wrapped, sent } = recordingPool();
    const db = createClient({
      schema: { person },
      pool: wrapped as never,
      namedStatements: "explicit",
    });
    await db.$transaction([
      db.person.findUnique({ where: { id: "a" }, named: true }),
      db.person.findMany({ where: { name: "B" }, named: false }),
      db.person.findMany({ where: { email: "c@x.io" } }),
    ]);
    const array = split(sent);
    expect(array.named.map((query) => query.text)).toEqual([
      expect.stringContaining(`"q0"."id" = $1`),
    ]);
    expect(array.unnamed.length).toBe(2);
    sent.length = 0;
    await db.$transaction(async (tx) => {
      await tx.person.update({
        where: { id: "a" },
        data: { name: "A1" },
        named: true,
      });
      await tx.person.findMany({ where: { name: "A1" } });
    });
    const interactive = split(sent);
    expect(interactive.named.length).toBeGreaterThan(0);
    expect(
      interactive.named.every((query) => query.text.startsWith("UPDATE"))
    ).toBe(true);
    expect(interactive.unnamed.map((query) => query.text)).toEqual([
      expect.stringMatching(SELECT),
    ]);
    await pool.end();
  });

  test("every statement with values of a nested write is named", async () => {
    const { pool, wrapped, sent } = recordingPool();
    const db = createClient({
      schema: { owner, pet },
      pool: wrapped as never,
      namedStatements: "explicit",
    });
    await db.owner.create({
      data: {
        id: "d",
        email: "d@x.io",
        pets: {
          create: [
            { id: "p1", name: "Rex" },
            { id: "p2", name: "Tom" },
          ],
        },
      },
      include: { pets: true },
      named: true,
    });
    const withValues = sent.filter((query) =>
      Array.isArray(JSON.parse(query.sent).values)
        ? JSON.parse(query.sent).values.length > 0
        : false
    );
    expect(withValues.length).toBeGreaterThan(1);
    expect(withValues.every((query) => NAME.test(query.name ?? ""))).toBe(true);
    expect(
      sent.some(
        (query) => query.text.includes(PETS) && query.name !== undefined
      )
    ).toBe(true);
    await pool.end();
  });

  test("without `namedStatements`, `named` changes nothing that is sent", async () => {
    const run = async (named: boolean | undefined) => {
      const { pool, wrapped, sent } = recordingPool();
      const db = createClient({
        schema: { owner, pet },
        pool: wrapped as never,
      });
      await db.owner.findUnique({ where: { id: "a" }, named });
      await db.owner.findMany({
        where: { name: "A" },
        include: { pets: true },
        named,
      });
      await db.owner.update({
        where: { id: "b" },
        data: { name: "B" },
        named,
      });
      await db.$transaction([
        db.owner.findMany({ where: { email: "c@x.io" }, named }),
      ]);
      await pool.end();
      return sent;
    };
    const plain = await run(undefined);
    expect(plain.every((query) => query.name === undefined)).toBe(true);
    expect(await run(true)).toEqual(plain);
    expect(await run(false)).toEqual(plain);
  });

  test("`named` changes neither the text nor the values sent", async () => {
    const { pool, wrapped, sent } = recordingPool();
    const db = createClient({
      schema: { owner, pet },
      pool: wrapped as never,
      namedStatements: true,
    });
    const call = { where: { name: "A" }, include: { pets: true } } as const;
    await db.owner.findMany(call);
    await db.owner.findMany({ ...call, named: false });
    await db.owner.findMany({ ...call, named: true });
    expect(new Set(sent.map((query) => query.sent)).size).toBe(1);
    expect(sent.map((query) => query.name === undefined)).toEqual([
      true,
      true,
      false,
    ]);
    await pool.end();
  });
});
