/**
 * pg Driver Tests - collection reads as positional rows, on a real PostgreSQL
 * server.
 *
 * A `findMany` is sent with node-postgres's `rowMode: "array"` and decoded by
 * position; every other statement keeps keyed rows. The answers are the ones
 * keyed rows give, for every scalar kind and for relations read as JSON. A
 * driver whose surface a caller replaced, and a supplied pool that ignores
 * `rowMode`, keep keyed rows.
 *
 * NOTE: These tests require a running PostgreSQL database.
 */

import { createClient as createDriverClient } from "@client/client";
import { createClient, PgDriver } from "@drivers/pg";
import { s } from "@schema";
import pg from "pg";
import { TEST_CONNECTION_STRING } from "./pg-fixtures";

const describeIf = TEST_CONNECTION_STRING ? describe : describe.skip;

const OWNER = "positional_reads_owner";
const ITEM = "positional_reads_item";

const owner = s
  .model({
    id: s.string().id(),
    name: s.string(),
    items: s.toMany(() => item),
  })
  .map(OWNER);
const item = s
  .model({
    id: s.string().id(),
    label: s.string().nullable(),
    count: s.int(),
    big: s.bigInt(),
    amount: s.decimal({ precision: 30, scale: 3 }),
    ratio: s.number(),
    flag: s.boolean(),
    at: s.dateTime(),
    doc: s.json(),
    ownerId: s.string(),
    owner: s
      .toOne(() => owner)
      .fields("ownerId")
      .references("id"),
  })
  .map(ITEM);
const schema = { owner, item };

interface Sent {
  readonly text: string;
  readonly rowMode?: string;
}

/** A node-postgres pool recording each query's `rowMode`, or dropping it when `ignore` is set. */
function recordingPool(ignore = false) {
  const pool = new pg.Pool({
    connectionString: TEST_CONNECTION_STRING,
    max: 2,
  });
  const sent: Sent[] = [];
  const note = (query: unknown) => {
    if (typeof query !== "object" || query === null || !("text" in query))
      return query;
    const { rowMode, ...rest } = query as { text: string; rowMode?: string };
    sent.push(
      rowMode === undefined ? { text: rest.text } : { text: rest.text, rowMode }
    );
    return ignore ? rest : query;
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

/** A client of the schema over a pool, for typing the reads below. */
const open = (pool: unknown) => createClient({ schema, pool: pool as never });

const reads = async (db: ReturnType<typeof open>) => [
  await db.item.findMany({ orderBy: { id: "asc" } }),
  await db.owner.findMany({
    orderBy: { id: "asc" },
    include: { items: { orderBy: { id: "asc" } } },
  }),
  await db.item.findMany({
    where: { flag: true },
    select: { id: true, owner: { select: { name: true } } },
  }),
  await db.item.findMany({ where: { id: "none" } }),
];

describeIf("pg positional reads", () => {
  const admin = new pg.Pool({
    connectionString: TEST_CONNECTION_STRING,
    max: 1,
  });

  beforeAll(async () => {
    await admin.query(`DROP TABLE IF EXISTS "${ITEM}"`);
    await admin.query(`DROP TABLE IF EXISTS "${OWNER}"`);
    await admin.query(
      `CREATE TABLE "${OWNER}" ("id" text PRIMARY KEY, "name" text NOT NULL)`
    );
    await admin.query(
      `CREATE TABLE "${ITEM}" ("id" text PRIMARY KEY, "label" text, "count" integer NOT NULL, "big" bigint NOT NULL, "amount" numeric(30, 3) NOT NULL, "ratio" double precision NOT NULL, "flag" boolean NOT NULL, "at" timestamp(3) NOT NULL, "doc" jsonb NOT NULL, "ownerId" text NOT NULL REFERENCES "${OWNER}"("id"))`
    );
    await admin.query(
      `INSERT INTO "${OWNER}" VALUES ('o1', 'One'), ('o2', 'Two')`
    );
    await admin.query(
      `INSERT INTO "${ITEM}" VALUES
        ('i1', 'first', 1, 9007199254740993, 12.50, 0.25, true, '2026-01-02 03:04:05.678', '{"a": [1, 2]}', 'o1'),
        ('i2', null, -2, -5, 0.001, -1.5, false, '1999-12-31 23:59:59.999', '"text"', 'o1'),
        ('i3', 'third', 3, 0, 1e20, 3, true, '2026-11-15 00:00:00', 'null', 'o2')`
    );
  });

  afterAll(async () => {
    await admin.query(`DROP TABLE IF EXISTS "${ITEM}"`);
    await admin.query(`DROP TABLE IF EXISTS "${OWNER}"`);
    await admin.end();
  });

  test("a collection read is sent as positional rows, other statements as keyed rows", async () => {
    const { pool, wrapped, sent } = recordingPool();
    const db = createClient({ schema, pool: wrapped as never });
    await db.item.findMany({ orderBy: { id: "asc" } });
    await db.item.findUnique({ where: { id: "i1" } });
    await db.owner.update({ where: { id: "o2" }, data: { name: "Two" } });
    expect(sent.map((query) => query.rowMode)).toEqual([
      "array",
      undefined,
      undefined,
    ]);
    await pool.end();
  });

  test("positional rows answer what keyed rows answer", async () => {
    const positional = recordingPool();
    const keyed = recordingPool();
    // A driver class a caller derived is not the shipped surface: it keeps keyed rows.
    class Derived extends PgDriver {}
    const db = createClient({ schema, pool: positional.wrapped as never });
    const reference = createDriverClient({
      schema,
      driver: new Derived({ pool: keyed.wrapped as never }),
    });
    const answers = await reads(db);
    expect(positional.sent.every((query) => query.rowMode === "array")).toBe(
      true
    );
    expect(keyed.sent.every((query) => query.rowMode === undefined)).toBe(true);
    expect(answers).toEqual(await reads(reference as never));
    expect(answers[0]?.[0]).toMatchObject({
      big: 9_007_199_254_740_993n,
      doc: { a: [1, 2] },
    });
    await positional.pool.end();
    await keyed.pool.end();
  });

  test("a supplied pool that ignores rowMode still answers by name", async () => {
    const ignoring = recordingPool(true);
    const keyed = recordingPool();
    const db = createClient({ schema, pool: ignoring.wrapped as never });
    const reference = createDriverClient({
      schema,
      driver: new (class extends PgDriver {})({ pool: keyed.wrapped as never }),
    });
    expect(await reads(db)).toEqual(await reads(reference as never));
    await ignoring.pool.end();
    await keyed.pool.end();
  });

  test("named statements read positional rows too", async () => {
    const { pool, wrapped, sent } = recordingPool();
    const db = createClient({
      schema,
      pool: wrapped as never,
      namedStatements: true,
    });
    const first = await db.item.findMany({ orderBy: { id: "asc" } });
    expect(await db.item.findMany({ orderBy: { id: "asc" } })).toEqual(first);
    expect(sent.map((query) => query.rowMode)).toEqual(["array", "array"]);
    await pool.end();
  });
});
