/**
 * viborm/ordering's statements on PostgreSQL, MySQL and SurrealDB, as the
 * client builds them, over a driver that sends nothing: each statement is
 * recorded and answered from the test's script. A golden per case pins the
 * text and the parameters a database receives (`__golden__/ordering-dialects/`);
 * the assertions beside it pin the result the method returns from the rows
 * answered. What those statements do on a real database is proven by the
 * shared behaviour suite (`ordering-behavior.ts`) on each live provider:
 * `tests/providers/docker/pg-ordering.test.ts`,
 * `tests/providers/docker/mysql2-ordering.test.ts` and
 * `tests/providers/docker/surrealdb-extensions.test.ts`.
 */

import { SurrealDriver } from "@drivers/surrealdb";
import {
  createClient,
  NotFoundError,
  QueryError,
  s,
  ValidationError,
} from "@src/index";
import { ordering, orderingKey } from "@src/ordering";
import {
  type ScriptedDialect,
  ScriptedDriver,
  type SentStatement,
} from "@tests/fixtures/drivers/scripted";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const column = s.model({
  id: s.string().id(),
  cards: s.toMany(() => card),
});
const card = s.model({
  id: s.string().id(),
  columnId: s.string().nullable(),
  rank: s.string().schema(orderingKey),
  title: s.string().nullable(),
  column: s
    .toOne(() => column)
    .fields("columnId")
    .references("id"),
});
/** A model of one list. */
const item = s.model({
  id: s.string().id(),
  rank: s.string().schema(orderingKey),
});
/** A list named by an instant, and a key of two fields. */
const slot = s
  .model({
    board: s.string(),
    position: s.int(),
    day: s.dateTime(),
    rank: s.string().schema(orderingKey),
  })
  .id(["board", "position"]);
const schema = { column, card, item, slot };
const config = {
  card: { key: "rank", within: ["columnId"] },
  item: { key: "rank" },
  slot: { key: "rank", within: ["day"] },
} as const;

/** A key between 11 and 13, and one after 13: their random digits vary. */
const KEY_IN_12 = /^12\d+$/;
const KEY_IN_14 = /^14\d*$/;
const KEY_IN_10 = /^10\d+$/;

type Row = Readonly<Record<string, unknown>>;
type Answer =
  | readonly Row[]
  | { readonly rows: readonly Row[]; readonly rowCount: number }
  | Error;

/** The random bytes every draw takes: fixed, so the goldens are. */
beforeEach(() => {
  let next = 0;
  vi.spyOn(crypto, "getRandomValues").mockImplementation((array) => {
    const bytes = array as Uint8Array;
    for (let index = 0; index < bytes.length; index++)
      bytes[index] = (next++ * 37) % 250;
    return array;
  });
});
afterEach(() => {
  vi.restoreAllMocks();
});

/** What a call rejects with (an error carries the instant it was made: compared by class and text). */
const failureOf = (call: PromiseLike<unknown>) =>
  Promise.resolve(call).then(
    () => undefined,
    (caught: unknown) => caught
  );

/** A statement, as a golden holds it: its text, then its parameters. */
const transcript = (sent: readonly SentStatement[]) =>
  `${sent
    .map(
      ({ sql, params }) =>
        `${sql};\n-- ${JSON.stringify(params, (_, value) =>
          value instanceof Date ? value.toISOString() : value
        )}`
    )
    .join("\n\n")}\n`;

/** Where a case's golden is: one file per dialect and case. */
const golden = (dialect: string, name: string) =>
  `./__golden__/ordering-dialects/${dialect}/${name}.sql`;

/**
 * A client over a scripted SQL driver: the n-th statement gets the n-th
 * answer (an Error is thrown as the driver's failure), and every statement
 * past the script gets no row.
 */
/**
 * A client over SurrealDB's own driver, its SDK client scripted: the n-th
 * query gets the n-th answer, as the answer of each statement it holds, and
 * a transaction's commit and cancel are recorded beside the queries.
 */
function surrealClient(answers: readonly Answer[]) {
  const sent: SentStatement[] = [];
  const query = async (
    sql: string,
    values: Readonly<Record<string, unknown>>
  ) => {
    sent.push({ sql, params: [values] });
    const answer =
      answers[sent.filter(({ params }) => params.length > 0).length - 1] ?? [];
    if (answer instanceof Error) throw answer;
    const rows = "rows" in answer ? answer.rows : answer;
    // One answer per statement the text holds: the driver reads its own.
    return sql.split(";").map(() => rows);
  };
  const end = (sql: string) => async () => {
    sent.push({ sql, params: [] });
  };
  const sdk = {
    query,
    beginTransaction: async () => ({
      query,
      commit: end("COMMIT"),
      cancel: end("CANCEL"),
    }),
  };
  // The SDK's client, as far as the driver calls it.
  const driver = new SurrealDriver({ client: sdk as never });
  const db = createClient({ schema, driver }).$extends(ordering(config));
  return { db, sent };
}

function sqlClient(dialect: ScriptedDialect, answers: readonly Answer[]) {
  const driver = new ScriptedDriver(dialect, (_, sent) => {
    const answer = answers[sent.length - 1] ?? [];
    if (answer instanceof Error) throw answer;
    return answer;
  });
  const db = createClient({ schema, driver }).$extends(ordering(config));
  return { db, sent: driver.sent };
}

describe("PostgreSQL", () => {
  test("a create appends: its key is computed by the INSERT", async () => {
    const row = { id: "b", columnId: "c1", rank: "11", title: null };
    const { db, sent } = sqlClient("postgresql", [[row]]);
    await expect(
      db.card.create({ data: { id: "b", columnId: "c1" } })
    ).resolves.toEqual(row);
    await expect(transcript(sent)).toMatchFileSnapshot(
      golden("postgresql", "create-append")
    );
  });

  test("a move after an anchor is one UPDATE computing the key", async () => {
    const row = { id: "b", columnId: "c1", rank: "1155", title: null };
    const { db, sent } = sqlClient("postgresql", [[row]]);
    await expect(
      db.card.move({ where: { id: "b" }, after: { id: "a" } })
    ).resolves.toEqual(row);
    expect(sent).toHaveLength(1);
    await expect(transcript(sent)).toMatchFileSnapshot(
      golden("postgresql", "move-after")
    );
  });

  test("a move's random digits fall back to 5 where every byte drawn is refused", async () => {
    vi.mocked(crypto.getRandomValues).mockImplementationOnce((array) => {
      (array as Uint8Array).fill(255);
      return array;
    });
    const row = { id: "b", columnId: "c1", rank: "1155", title: null };
    const { db, sent } = sqlClient("postgresql", [[row]]);
    await db.card.move({ where: { id: "b" }, before: { id: "a" } });
    expect(sent[0]!.params.slice(0, 6)).toEqual(
      Array.from({ length: 6 }, () => "55")
    );
    await expect(transcript(sent)).toMatchFileSnapshot(
      golden("postgresql", "move-before-jitter-fallback")
    );
  });

  test("a move to another list tries the move, then the key alone; a NULL list is IS NULL", async () => {
    const row = { id: "b", columnId: null, rank: "09", title: null };
    // The row is in that list already: the UPDATE that moves it matches nothing.
    const { db, sent } = sqlClient("postgresql", [[], [row]]);
    await expect(
      db.card.move({ where: { id: "b" }, first: true, to: { columnId: null } })
    ).resolves.toEqual(row);
    expect(sent).toHaveLength(2);
    await expect(transcript(sent)).toMatchFileSnapshot(
      golden("postgresql", "move-first-to-null-list")
    );
  });

  test("an anchor's NULL condition is IS NULL in the statement", async () => {
    const row = { id: "b", columnId: "c1", rank: "1155", title: null };
    const { db, sent } = sqlClient("postgresql", [[row]]);
    await expect(
      db.card.move({
        where: { id: "b" },
        after: { id: "a", title: null },
        omit: { title: true },
      })
    ).resolves.toEqual({ id: "b", columnId: "c1", rank: "1155" });
    expect(sent[0]!.sql).toContain('"a"."title" IS NULL');
    await expect(transcript(sent)).toMatchFileSnapshot(
      golden("postgresql", "move-after-null-condition")
    );
  });

  test("a move with a computed key writes it as given, and a driver failure is the caller's", async () => {
    const { db, sent } = sqlClient("postgresql", [
      new Error("connection reset"),
    ]);
    const moved = db.card.move({
      where: { id: "b" },
      key: "15",
      include: { column: true },
    });
    const error = await failureOf(moved);
    expect(error).toBeInstanceOf(QueryError);
    expect(error).not.toBeInstanceOf(NotFoundError);
    // The driver's failure, redacted as every driver failure is.
    expect(error).toHaveProperty("message", "Query execution failed");
    await expect(transcript(sent)).toMatchFileSnapshot(
      golden("postgresql", "move-key-failure")
    );
  });

  test("rekey of a model of one list: one UPDATE joining the respaced keys, its order an array", async () => {
    const { db, sent } = sqlClient("postgresql", [{ rows: [], rowCount: 2 }]);
    await expect(
      db.item.rekey({ where: { id: "a" }, orderBy: [{ id: "desc" }] })
    ).resolves.toEqual({ count: 2 });
    expect(sent).toHaveLength(1);
    await expect(transcript(sent)).toMatchFileSnapshot(
      golden("postgresql", "rekey-one-list")
    );
  });

  test("an anchor named by a filter, not a value, is refused by the read that names it, before any write", async () => {
    const { db, sent } = sqlClient("postgresql", []);
    const error = await failureOf(
      db.card.move({
        where: { id: "b" },
        after: { id: { equals: "a" } },
      } as never)
    );
    expect(error).toBeInstanceOf(ValidationError);
    expect(error).toHaveProperty(
      "message",
      "Validation failed for card.findUnique: where.id: Expected string"
    );
    expect(sent).toHaveLength(0);
  });
});

describe("MySQL", () => {
  test("a create appends: the list's last key read first, the key computed here", async () => {
    const row = { id: "b", columnId: "c1", rank: "12", title: null };
    const { db, sent } = sqlClient("mysql", [
      [{ g0: "11" }],
      { rows: [], rowCount: 1 },
      [row],
    ]);
    await expect(
      db.card.create({ data: { id: "b", columnId: "c1" } })
    ).resolves.toEqual(row);
    await expect(transcript(sent)).toMatchFileSnapshot(
      golden("mysql", "create-append")
    );
  });

  test("rekey: one UPDATE joining the respaced keys, in MySQL's spellings", async () => {
    const { db, sent } = sqlClient("mysql", [{ rows: [], rowCount: 3 }]);
    await expect(db.card.rekey()).resolves.toEqual({ count: 3 });
    expect(sent[0]!.sql).toContain("CONCAT(");
    await expect(transcript(sent)).toMatchFileSnapshot(
      golden("mysql", "rekey")
    );
  });

  // A move on MySQL reads its neighbours, then writes the key (`inStatement`
  // answers MISSED there): each case below scripts those reads.
  const a = { id: "a", columnId: "c1", rank: "13" };
  const x = { id: "x", columnId: "c1", rank: "11" };
  const b = { id: "b", columnId: "c1", rank: "15", title: null };

  test("a move before an anchor reads it, its neighbours, then locks and writes the row", async () => {
    const written = { ...b, rank: "12" };
    const { db, sent } = sqlClient("mysql", [
      [a],
      // Read backwards from the anchor: the anchor, then the row before it.
      [a, x],
      [b],
      { rows: [], rowCount: 1 },
      [written],
    ]);
    await expect(
      db.card.move({ where: { id: "b" }, before: { id: "a" } })
    ).resolves.toEqual(written);
    expect(sent[3]!.params[0]).toMatch(KEY_IN_12);
    await expect(transcript(sent)).toMatchFileSnapshot(
      golden("mysql", "move-before")
    );
  });

  test("a move last of a model of one list reads the list's end, and writes the key alone", async () => {
    const written = { id: "b", rank: "14" };
    const { db, sent } = sqlClient("mysql", [
      // The list's two last rows, last first.
      [
        { id: "z", rank: "13" },
        { id: "y", rank: "12" },
      ],
      [{ id: "b", rank: "11" }],
      { rows: [], rowCount: 1 },
      [written],
    ]);
    await expect(
      db.item.move({ where: { id: "b" }, last: true })
    ).resolves.toEqual(written);
    expect(sent[2]!.params[0]).toMatch(KEY_IN_14);
    await expect(transcript(sent)).toMatchFileSnapshot(
      golden("mysql", "move-last-one-list")
    );
  });

  test("a move to another list writes the list and the key, guarded by the caller's NOT, then the key alone", async () => {
    const written = { ...b, columnId: "c2", rank: "1055" };
    const { db, sent } = sqlClient("mysql", [
      [
        { id: "y", columnId: "c2", rank: "11" },
        { id: "z", columnId: "c2", rank: "13" },
      ],
      // Not outside the list: the row is in it already.
      [],
      [{ ...b, columnId: "c2" }],
      { rows: [], rowCount: 1 },
      [written],
    ]);
    await expect(
      db.card.move({
        where: { id: "b", NOT: { title: "x" } },
        first: true,
        to: { columnId: "c2" },
      })
    ).resolves.toEqual(written);
    await expect(transcript(sent)).toMatchFileSnapshot(
      golden("mysql", "move-first-to-list")
    );
  });

  test("a move to another list without a NOT guards by the list alone; a driver failure is the caller's", async () => {
    const { db, sent } = sqlClient("mysql", [
      [{ id: "y", columnId: "c2", rank: "11" }],
      new Error("lock wait timeout"),
    ]);
    const error = await failureOf(
      db.card.move({ where: { id: "b" }, last: true, to: { columnId: "c2" } })
    );
    expect(error).toBeInstanceOf(QueryError);
    expect(error).not.toBeInstanceOf(NotFoundError);
    expect(sent).toHaveLength(2);
    await expect(transcript(sent)).toMatchFileSnapshot(
      golden("mysql", "move-last-to-list-failure")
    );
  });

  test("a row already before its anchor writes only its data; a failure of that write is the caller's", async () => {
    const { db, sent } = sqlClient("mysql", [
      [a],
      // The row before the anchor is the moved one.
      [a, { id: "b", columnId: "c1", rank: "12" }],
      new Error("lock wait timeout"),
    ]);
    const error = await failureOf(
      db.card.move({
        where: { id: "b" },
        before: { id: "a" },
        data: { title: "t" },
      })
    );
    expect(error).toBeInstanceOf(QueryError);
    expect(error).not.toBeInstanceOf(NotFoundError);
    await expect(transcript(sent)).toMatchFileSnapshot(
      golden("mysql", "move-in-place-data-failure")
    );
  });

  test("a row already before its anchor that is gone when read back is not found", async () => {
    const { db, sent } = sqlClient("mysql", [
      [a],
      [a, { id: "b", columnId: "c1", rank: "12" }],
      [],
    ]);
    const error = await failureOf(
      db.card.move({ where: { id: "b" }, before: { id: "a" } })
    );
    expect(error).toBeInstanceOf(NotFoundError);
    expect(error).toHaveProperty("message", "No card record found for move");
    await expect(transcript(sent)).toMatchFileSnapshot(
      golden("mysql", "move-in-place-gone")
    );
  });

  test("an anchor that leaves its list on every read is given up after three passes", async () => {
    // The anchor read, then a cursor that lands on another row: the anchor
    // moved between the two reads.
    const pass = [[a], [x]];
    const { db, sent } = sqlClient("mysql", [...pass, ...pass, ...pass]);
    const error = await failureOf(
      db.card.move({ where: { id: "b" }, before: { id: "a" } })
    );
    expect(error).toBeInstanceOf(QueryError);
    expect(error).toHaveProperty(
      "message",
      "card.move: the list kept changing under concurrent writes; try again."
    );
    expect(sent).toHaveLength(6);
  });

  test("an anchor named by a compound key and a condition, in a list named by an instant", async () => {
    const day = "2026-11-15 00:00:00.000";
    const written = { board: "k", position: 2, day, rank: "12" };
    const { db, sent } = sqlClient("mysql", [
      [{ board: "k", position: 1, day, rank: "11" }],
      [
        { board: "k", position: 1, day, rank: "11" },
        { board: "k", position: 3, day, rank: "13" },
      ],
      [{ board: "k", position: 2, day, rank: "15" }],
      { rows: [], rowCount: 1 },
      [written],
    ]);
    await expect(
      db.slot.move({
        where: { board_position: { board: "k", position: 2 } },
        after: { board_position: { board: "k", position: 1 }, rank: "11" },
      })
    ).resolves.toEqual({ ...written, day: new Date("2026-11-15T00:00:00Z") });
    expect(sent[3]!.params[0]).toMatch(KEY_IN_12);
    await expect(transcript(sent)).toMatchFileSnapshot(
      golden("mysql", "move-after-compound-anchor")
    );
  });

  test("a move's data naming the key of a model of one list is refused", async () => {
    const { db, sent } = sqlClient("mysql", []);
    await expect(
      db.item.move({
        where: { id: "b" },
        first: true,
        data: { rank: "11" },
      } as never)
    ).rejects.toThrow(
      "item.move: data writes the model's own fields beside the key: not rank, nor a relation."
    );
    expect(sent).toHaveLength(0);
  });

  test("a move first into an empty list takes the list's first key", async () => {
    const written = { ...b, columnId: "c3", rank: "1055" };
    const { db, sent } = sqlClient("mysql", [
      [],
      [{ ...b }],
      { rows: [], rowCount: 1 },
      [written],
    ]);
    await expect(
      db.card.move({ where: { id: "b" }, first: true, to: { columnId: "c3" } })
    ).resolves.toEqual(written);
    // No key around the place: the list's first, 10 and a random part.
    expect(sent[2]!.params).toContainEqual(expect.stringMatching(KEY_IN_10));
    await expect(transcript(sent)).toMatchFileSnapshot(
      golden("mysql", "move-first-to-empty-list")
    );
  });
});

describe("SurrealDB", () => {
  test("a create appends: each list's last key read in the call's unit, the keys computed here", async () => {
    const { db, sent } = surrealClient([
      // The NULL list holds no key; c1's last is 11.
      [],
      [{ key: "11", id: "x" }],
      [{ id: "b" }, { id: "c" }],
    ]);
    await expect(
      db.card.createMany({
        data: [
          { id: "b", columnId: null },
          { id: "c", columnId: "c1" },
        ],
      })
    ).resolves.toEqual({ count: 2 });
    expect(sent[0]!.sql).toContain("columnId = NONE");
    const [inserted] = sent[2]!.params as [{ p1: { rank: string }[] }];
    expect(inserted.p1.map(({ rank }) => rank.slice(0, 2))).toEqual([
      "10",
      "12",
    ]);
    await expect(transcript(sent)).toMatchFileSnapshot(
      golden("surrealql", "create-many-append")
    );
  });

  test("rekey reads each list, places its members as the SQL statement does, and writes them by identity, list and key", async () => {
    const { db, sent } = surrealClient([
      [{ w0: null }, { w0: "c1" }],
      // The NULL list: a title missing sorts last, as PostgreSQL places
      // it; a member without a key is still placed.
      [
        { k: "11", i0: "a", o0: null, v: true },
        { k: "12", i0: "b", o0: "t", v: true },
        { i0: "e", o0: "s", v: true },
        // Tied with a in the order: the current order decides.
        { k: "13", i0: "f", o0: null, v: true },
      ],
      // c1: a member the call may not update keeps its key and bounds; one
      // whose key is no key bounds nothing.
      [
        { k: "11", i0: "c", o0: "u", v: false },
        { k: "13", i0: "d", o0: null, v: true },
        { k: "zz", i0: "g", o0: "v", v: false },
      ],
      [{ id: "a" }, { id: "b" }, { id: "e" }, { id: "f" }, { id: "d" }],
    ]);
    await expect(
      db.card.rekey({ orderBy: { title: "desc" } })
    ).resolves.toEqual({ count: 5 });
    const [written] = sent[3]!.params as [Record<string, unknown>];
    // In the NULL list, by title descending: a and f (none, in their
    // current order), b (t), e (s); written in the order read.
    expect(
      [
        written.p1,
        written.p2,
        written.p4,
        written.p5,
        written.p7,
        written.p8,
        written.p9,
        written.p10,
      ].map(String)
    ).toEqual(["card:a", "10", "card:b", "12", "card:e", "13", "card:f", "11"]);
    // In c1, d alone, after c's key; c and g are not written.
    expect(String(written.p12)).toBe("card:d");
    expect(written.p13).toMatch(KEY_IN_12);
    await expect(transcript(sent)).toMatchFileSnapshot(
      golden("surrealql", "rekey-lists")
    );
  });

  test("rekey of a model of one list respaces it where the call's where matches a row, and writes nothing where it matches none", async () => {
    const { db, sent } = surrealClient([
      [{ id: "a" }],
      // Tied keys: respaced in identity order.
      [
        { k: "11", i0: "a", v: true },
        { k: "11", i0: "b", v: true },
      ],
      [{ id: "a" }, { id: "b" }],
      [],
    ]);
    await expect(db.item.rekey({ where: { id: "a" } })).resolves.toEqual({
      count: 2,
    });
    await expect(db.item.rekey({ where: { id: "zz" } })).resolves.toEqual({
      count: 0,
    });
    await expect(transcript(sent)).toMatchFileSnapshot(
      golden("surrealql", "rekey-one-list")
    );
  });

  test("rekey of a list whose key has two fields breaks a tie by the first field that differs", async () => {
    const day = "2026-11-15T00:00:00.000Z";
    const { db, sent } = surrealClient([
      [{ w0: day }],
      [
        { k: "11", i0: "m", i1: 1, v: true },
        { k: "11", i0: "k", i1: 2, v: true },
        { k: "11", i0: "k", i1: 1, v: true },
      ],
      [{ id: "1" }, { id: "2" }, { id: "3" }],
    ]);
    await expect(db.slot.rekey()).resolves.toEqual({ count: 3 });
    const [written] = sent[2]!.params as [Record<string, unknown>];
    // Written in the order read; placed k/1, k/2, then m/1: the board
    // first, then the position.
    expect(
      [
        written.p1,
        written.p2,
        written.p5,
        written.p6,
        written.p9,
        written.p10,
      ].map(String)
    ).toEqual([
      'slot:[ s"m", 1 ]',
      "12",
      'slot:[ s"k", 2 ]',
      "11",
      'slot:[ s"k", 1 ]',
      "10",
    ]);
    await expect(transcript(sent)).toMatchFileSnapshot(
      golden("surrealql", "rekey-compound-identity")
    );
  });
});
