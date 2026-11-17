/**
 * postgres.js Driver Tests - `namedStatements` on a real PostgreSQL server.
 *
 * Without the option nothing is prepared. With it, a generated statement with
 * values is prepared the second time it is sent, at most `max` of them per
 * connection; postgres.js itself sends again, once, a statement the server
 * lost. Errors and transactions answer as they do unprepared.
 *
 * NOTE: These tests require a running PostgreSQL database.
 */

import { createClient, vibormTypes } from "@drivers/postgres";
import { s } from "@schema";
import postgres from "postgres";
import { vi } from "vitest";

const TEST_CONNECTION_STRING = process.env.PG_TEST_CONNECTION_STRING;
const describeIf = TEST_CONNECTION_STRING ? describe : describe.skip;

const TABLE = "named_statements_member";
const TOLD_MAX =
  /^VibORM \(postgres\): named: true, but all namedStatements\.max \(1\) names are given/;

const member = s
  .model({
    id: s.string().id(),
    email: s.string().unique(),
    name: s.string().nullable(),
  })
  .map(TABLE);

/** One connection, so `pg_prepared_statements` reads the session every statement ran on. */
const connection = () =>
  postgres(TEST_CONNECTION_STRING ?? "", {
    max: 1,
    types: vibormTypes,
    onnotice: () => undefined,
  });

const prepared = async (
  sql: ReturnType<typeof connection>
): Promise<number> => {
  const [row] = await sql.unsafe(
    `SELECT count(*)::int AS n FROM pg_prepared_statements WHERE statement LIKE '%${TABLE}%'`
  );
  return row?.n as number;
};

describeIf("postgres.js namedStatements", () => {
  const admin = connection();

  beforeEach(async () => {
    await admin.unsafe(`DROP TABLE IF EXISTS "${TABLE}"`);
    await admin.unsafe(
      `CREATE TABLE "${TABLE}" ("id" text PRIMARY KEY, "email" text NOT NULL UNIQUE, "name" text)`
    );
    await admin.unsafe(
      `INSERT INTO "${TABLE}" VALUES ('a', 'a@x.io', 'A'), ('b', 'b@x.io', 'B'), ('c', 'c@x.io', null)`
    );
  });

  afterAll(async () => {
    await admin.unsafe(`DROP TABLE IF EXISTS "${TABLE}"`);
    await admin.end();
  });

  test("without the option, nothing is prepared", async () => {
    const sql = connection();
    const db = createClient({ schema: { member }, client: sql as never });
    for (let i = 0; i < 3; i++)
      await db.member.findUnique({ where: { id: "a" } });
    expect(await prepared(sql)).toBe(0);
    await sql.end();
  });

  test("a statement is prepared the second time it is sent, at most `max` per connection", async () => {
    const sql = connection();
    const db = createClient({
      schema: { member },
      client: sql as never,
      namedStatements: { max: 2 },
    });
    await db.member.findUnique({ where: { id: "a" } });
    expect(await prepared(sql)).toBe(0);
    for (let i = 0; i < 3; i++) {
      expect(await db.member.findUnique({ where: { id: "b" } })).toEqual({
        id: "b",
        email: "b@x.io",
        name: "B",
      });
      await db.member.findUnique({ where: { email: "a@x.io" } });
      await db.member.findMany({ where: { name: "A" } });
    }
    expect(await prepared(sql)).toBe(2);
    await sql.end();
  });

  test("raw SQL is never prepared, and takes no place a generated statement could have", async () => {
    const sql = connection();
    const db = createClient({
      schema: { member },
      client: sql as never,
      namedStatements: { max: 1 },
    });
    for (let i = 0; i < 3; i++) {
      expect(await db.$queryRaw`SELECT ${1}::int AS "raw_one"`).toEqual([
        { raw_one: 1 },
      ]);
      await db.$executeRaw`UPDATE "named_statements_member" SET "name" = "name" WHERE "id" = ${"none"}`;
    }
    for (let i = 0; i < 2; i++)
      await db.$transaction([
        db.$queryRaw`SELECT ${2}::int AS "raw_two"`,
        db.$executeRaw`UPDATE "named_statements_member" SET "name" = "name" WHERE "id" = ${"gone"}`,
      ]);
    const [held] = await sql.unsafe(
      "SELECT count(*)::int AS n FROM pg_prepared_statements WHERE statement LIKE '%raw_%' OR statement LIKE 'UPDATE%'"
    );
    expect(held?.n).toBe(0);
    // The one place is still there for a generated statement.
    await db.member.findUnique({ where: { id: "a" } });
    await db.member.findUnique({ where: { id: "b" } });
    expect(await prepared(sql)).toBe(1);
    await sql.end();
  });

  test("a statement the server lost is sent again", async () => {
    const sql = connection();
    const db = createClient({
      schema: { member },
      client: sql as never,
      namedStatements: true,
    });
    await db.member.findUnique({ where: { id: "a" } });
    await db.member.findUnique({ where: { id: "a" } });
    await sql.unsafe("DEALLOCATE ALL");
    expect(await db.member.findUnique({ where: { id: "c" } })).toEqual({
      id: "c",
      email: "c@x.io",
      name: null,
    });
    expect(await prepared(sql)).toBe(1);
    await sql.end();
  });

  test("a parameter whose enum type a migration replaced is sent unprepared from then on", async () => {
    const sql = connection();
    await sql.unsafe(`DROP TYPE IF EXISTS "named_statements_tone"`);
    await sql.unsafe(
      `CREATE TYPE "named_statements_tone" AS ENUM ('calm', 'busy')`
    );
    await sql.unsafe(
      `ALTER TABLE "${TABLE}" ADD COLUMN "tone" "named_statements_tone" NOT NULL DEFAULT 'calm'`
    );
    const toned = s
      .model({
        id: s.string().id(),
        email: s.string().unique(),
        tone: s.enum(["calm", "busy"]),
      })
      .map(TABLE);
    const db = createClient({
      schema: { toned },
      client: sql as never,
      namedStatements: true,
    });
    const read = () =>
      db.toned.findMany({ where: { tone: "calm" }, orderBy: { id: "asc" } });
    await read();
    await read();
    expect(await prepared(sql)).toBe(1);
    // What a migration that adds a value in the middle does: a new type replaces the old one.
    await sql.unsafe(
      `ALTER TYPE "named_statements_tone" RENAME TO "named_statements_tone_old"`
    );
    await sql.unsafe(
      `CREATE TYPE "named_statements_tone" AS ENUM ('calm', 'idle', 'busy')`
    );
    await sql.unsafe(`ALTER TABLE "${TABLE}" ALTER COLUMN "tone" DROP DEFAULT`);
    await sql.unsafe(
      `ALTER TABLE "${TABLE}" ALTER COLUMN "tone" TYPE "named_statements_tone" USING "tone"::text::"named_statements_tone"`
    );
    await sql.unsafe(`DROP TYPE "named_statements_tone_old"`);
    // postgres.js keys its statements by text: the same text prepared again
    // would meet the stale entry, so it is no longer prepared.
    for (let i = 0; i < 3; i++) {
      expect((await read()).map((row) => row.id)).toEqual(["a", "b", "c"]);
    }
    // Inside a transaction too, once the text is no longer prepared.
    expect(
      (
        await db.$transaction((tx) =>
          tx.toned.findMany({ where: { tone: "calm" } })
        )
      ).length
    ).toBe(3);
    await sql.unsafe(`ALTER TABLE "${TABLE}" DROP COLUMN "tone"`);
    await sql.unsafe(`DROP TYPE "named_statements_tone"`);
    await sql.end();
  });

  test("a failing statement fails the same way prepared or not", async () => {
    const failure = async (namedStatements: boolean) => {
      const sql = connection();
      const db = createClient({
        schema: { member },
        client: sql as never,
        namedStatements,
      });
      const errors: unknown[] = [];
      for (let i = 0; i < 3; i++) {
        errors.push(
          await db.member
            .create({ data: { id: `n${i}`, email: "a@x.io" } })
            .catch((error: unknown) => error)
        );
      }
      await sql.end();
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
    const unprepared = await failure(false);
    expect(unprepared[0]?.name).toBe("UniqueConstraintError");
    expect(await failure(true)).toEqual(unprepared);
  });

  test("prepared statements run in a transaction and its savepoints", async () => {
    const sql = connection();
    const db = createClient({
      schema: { member },
      client: sql as never,
      namedStatements: true,
    });
    for (let round = 0; round < 2; round++) {
      await db.$transaction(async (tx) => {
        await tx.member.update({
          where: { id: "a" },
          data: { name: `A${round}` },
        });
        await tx.member.update({
          where: { id: "b" },
          data: { name: `B${round}` },
        });
        await tx
          .$transaction(async (nested) => {
            await nested.member.update({
              where: { id: "c" },
              data: { name: "lost" },
            });
            // A database failure caught here fails the outer transaction on
            // postgres.js, with or without the option: the savepoint is left
            // by a thrown error instead.
            throw new Error("rolled back to the savepoint");
          })
          .catch(() => undefined);
        await tx.member.update({
          where: { id: "c" },
          data: { name: `C${round}` },
        });
      });
    }
    expect(await prepared(sql)).toBeGreaterThan(0);
    expect(await db.member.findMany({ orderBy: { id: "asc" } })).toEqual([
      { id: "a", email: "a@x.io", name: "A1" },
      { id: "b", email: "b@x.io", name: "B1" },
      { id: "c", email: "c@x.io", name: "C1" },
    ]);
    await sql.end();
  });
});

const PETS = "named_statements_member_pet";
const keeper = s
  .model({
    id: s.string().id(),
    email: s.string().unique(),
    name: s.string().nullable(),
    pets: s.toMany(() => kept),
  })
  .map(TABLE);
const kept = s
  .model({
    id: s.string().id(),
    name: s.string(),
    keeperId: s.string(),
    keeper: s
      .toOne(() => keeper)
      .fields("keeperId")
      .references("id"),
  })
  .map(PETS);

/** The statements of this test's tables the session holds, by text. */
const preparedTexts = async (
  sql: ReturnType<typeof connection>
): Promise<string[]> =>
  (
    await sql.unsafe(
      `SELECT statement FROM pg_prepared_statements WHERE statement LIKE '%named_statements_member%' ORDER BY statement`
    )
  ).map((row) => String(row.statement));

describeIf("postgres.js named, the call option", () => {
  const admin = connection();

  beforeEach(async () => {
    await admin.unsafe(`DROP TABLE IF EXISTS "${PETS}"`);
    await admin.unsafe(`DROP TABLE IF EXISTS "${TABLE}"`);
    await admin.unsafe(
      `CREATE TABLE "${TABLE}" ("id" text PRIMARY KEY, "email" text NOT NULL UNIQUE, "name" text)`
    );
    await admin.unsafe(
      `INSERT INTO "${TABLE}" VALUES ('a', 'a@x.io', 'A'), ('b', 'b@x.io', 'B'), ('c', 'c@x.io', null)`
    );
    await admin.unsafe(
      `CREATE TABLE "${PETS}" ("id" text PRIMARY KEY, "name" text NOT NULL, "keeperId" text NOT NULL REFERENCES "${TABLE}" ("id"))`
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await admin.unsafe(`DROP TABLE IF EXISTS "${PETS}"`);
    await admin.unsafe(`DROP TABLE IF EXISTS "${TABLE}"`);
    await admin.end();
  });

  test("`named: true` prepares a statement at its first sending, in either mode", async () => {
    for (const namedStatements of [true, "explicit"] as const) {
      const sql = connection();
      const db = createClient({
        schema: { member },
        client: sql as never,
        namedStatements,
      });
      expect(
        await db.member.findUnique({ where: { id: "b" }, named: true })
      ).toEqual({ id: "b", email: "b@x.io", name: "B" });
      expect(await prepared(sql)).toBe(1);
      await sql.end();
    }
  });

  test("`named: false` is never prepared, in the automatic mode nor under `prepare: true`", async () => {
    const sql = connection();
    const db = createClient({
      schema: { member },
      client: sql as never,
      namedStatements: true,
    });
    for (let i = 0; i < 3; i++)
      await db.member.findUnique({ where: { id: "a" }, named: false });
    expect(await prepared(sql)).toBe(0);
    await db.member.findUnique({ where: { id: "a" } });
    expect(await prepared(sql)).toBe(0);
    await db.member.findUnique({ where: { id: "a" } });
    expect(await prepared(sql)).toBe(1);
    await sql.end();

    const always = connection();
    const everything = createClient({
      schema: { member },
      client: always as never,
      options: { prepare: true },
    });
    for (let i = 0; i < 3; i++)
      await everything.member.findMany({ where: { name: "A" }, named: false });
    expect(await prepared(always)).toBe(0);
    await everything.member.findMany({ where: { name: "A" } });
    expect(await prepared(always)).toBe(1);
    await always.end();
  });

  test("the explicit mode, in both spellings, prepares only the calls that pass `named: true`", async () => {
    for (const namedStatements of [
      "explicit",
      { max: 100, auto: false },
    ] as const) {
      const sql = connection();
      const db = createClient({
        schema: { member },
        client: sql as never,
        namedStatements,
      });
      for (let i = 0; i < 3; i++) {
        await db.member.findUnique({ where: { id: "a" } });
        await db.member.findMany({ where: { name: "A" } });
      }
      expect(await prepared(sql)).toBe(0);
      await db.member.findMany({ where: { email: "a@x.io" }, named: true });
      expect(await preparedTexts(sql)).toEqual([
        expect.stringContaining(`"q0"."email" = $1`),
      ]);
      await sql.end();
    }
  });

  test("`max` counts every prepared statement; a `named: true` call past it is sent unprepared, and told once per text", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const sql = connection();
    const db = createClient({
      schema: { member },
      client: sql as never,
      namedStatements: { max: 1 },
    });
    await db.member.findUnique({ where: { id: "a" } });
    await db.member.findUnique({ where: { id: "a" } });
    for (let i = 0; i < 3; i++) {
      await db.member.findMany({ where: { name: "A" }, named: true });
      await db.member.findMany({ where: { email: "a@x.io" }, named: true });
    }
    expect(await prepared(sql)).toBe(1);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(String(warn.mock.calls[0]?.[0])).toMatch(TOLD_MAX);
    await sql.end();
  });

  test("an array transaction, an interactive one and a nested write: each call carries its own", async () => {
    const sql = connection();
    const db = createClient({
      schema: { keeper, kept },
      client: sql as never,
      namedStatements: "explicit",
    });
    await db.$transaction([
      db.keeper.findUnique({ where: { id: "a" }, named: true }),
      db.keeper.findMany({ where: { name: "B" }, named: false }),
      db.keeper.findMany({ where: { email: "c@x.io" } }),
    ]);
    expect(await preparedTexts(sql)).toEqual([
      expect.stringContaining(`"q0"."id" = $1`),
    ]);
    await db.$transaction(async (tx) => {
      await tx.keeper.findMany({ where: { email: "a@x.io" }, named: true });
      await tx.keeper.findMany({ where: { name: "A" } });
    });
    expect((await preparedTexts(sql)).length).toBe(2);
    await db.keeper.create({
      data: {
        id: "d",
        email: "d@x.io",
        pets: { create: [{ id: "p1", name: "Rex" }] },
      },
      named: true,
    });
    const texts = await preparedTexts(sql);
    expect(texts.some((text) => text.startsWith("INSERT INTO"))).toBe(true);
    expect(texts.some((text) => text.includes(PETS))).toBe(true);
    await sql.end();
  });

  test("without `namedStatements`, `named` prepares nothing", async () => {
    const sql = connection();
    const db = createClient({ schema: { member }, client: sql as never });
    for (let i = 0; i < 3; i++) {
      await db.member.findUnique({ where: { id: "a" }, named: true });
      await db.member.findMany({ where: { name: "A" }, named: false });
    }
    expect(await prepared(sql)).toBe(0);
    await sql.end();
  });
});
