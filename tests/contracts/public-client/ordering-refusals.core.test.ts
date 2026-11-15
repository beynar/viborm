/**
 * viborm/ordering, what it refuses and what it lets through: a model it
 * cannot order, a `move` or `rekey` written wrong, an error another part
 * raises during a move, and the lazy value `move` returns.
 *
 * Runs on in-memory SQLite.
 */

import { createClient } from "@drivers/sqlite3";
import {
  ClientInitializationError,
  ForbiddenError,
  ValidationError,
} from "@errors";
import { s } from "@schema";
import { call, extension, target } from "@src/index";
import { isKeyFormat, keyBetween, ordering, orderingKey } from "@src/ordering";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import { afterEach, describe, expect, test } from "vitest";

const card = s.model({
  id: s.string().id(),
  columnId: s.string(),
  rank: s.string().schema(orderingKey),
  title: s.string(),
  tags: s.string().array(),
});
/** No primary or unique key. */
const note = s.model({ rank: s.string(), text: s.string() });
/** A key that may be absent. */
const draft = s.model({ id: s.string().id(), rank: s.string().nullable() });
/** The ordering key is part of the row's key. */
const pinned = s
  .model({ tenant: s.string(), rank: s.string() })
  .id(["tenant", "rank"]);
const schema = { card, note, draft, pinned };

type Row = Record<string, unknown>;
interface Delegate {
  create(args: object): Promise<Row>;
  findMany(args?: object): Promise<Row[]>;
  move(args: object): PromiseLike<Row> & {
    catch(onRejected: (reason: unknown) => unknown): Promise<unknown>;
    finally(onFinally: () => void): Promise<Row>;
  };
  rekey(args?: object): Promise<unknown>;
}
interface Loose {
  card: Delegate;
  $extends(definition: unknown): Loose;
  $disconnect(): Promise<void>;
}

const opened: Loose[] = [];
afterEach(async () => {
  for (const client of opened.splice(0)) await client.$disconnect();
});

async function base(): Promise<Loose> {
  const client = createClient({
    schema,
    dataDir: ":memory:",
  }) as never as Loose;
  opened.push(client);
  // A model with no key is refused by a migration (M001), not by a client.
  await syncLiveSchema(client as never, { skipValidation: true });
  return client;
}

async function ordered(): Promise<Loose> {
  const db = (await base()).$extends(
    ordering({ card: { key: "rank", within: ["columnId"] } })
  );
  for (const id of ["a", "b", "c"])
    await db.card.create({
      data: { id, columnId: "c1", title: id, tags: [] },
    });
  return db;
}

const titles = async (db: Loose) =>
  (await db.card.findMany({ where: { columnId: "c1" } })).map(
    (row) => row.title
  );

describe("ordering refuses a model it cannot order", () => {
  test.each([
    [
      "a model with no key",
      { note: { key: "rank" } },
      "note needs a primary or unique key",
    ],
    [
      "a key that may be absent",
      { draft: { key: "rank" } },
      "draft.rank must be a required string field",
    ],
    [
      "a key inside the row's key",
      { pinned: { key: "rank" } },
      "pinned.rank cannot be part of the model's key",
    ],
    [
      "a list field that is a list",
      { card: { key: "rank", within: ["tags"] } },
      'card.within names "tags", a list field',
    ],
  ])("%s", async (_, config, message) => {
    const client = await base();
    let refused: unknown;
    try {
      client.$extends(ordering(config as never));
    } catch (error) {
      refused = error;
    }
    expect(refused).toBeInstanceOf(ClientInitializationError);
    expect((refused as Error).message).toContain(message);
  });
});

describe("move and rekey refuse what they cannot read", () => {
  test("to goes with first, last or key", async () => {
    const db = await ordered();
    await expect(
      db.card.move({
        where: { id: "a" },
        to: { columnId: "c2" },
        after: { id: "b" },
      })
    ).rejects.toThrow(
      "to goes with first, last or key, not with after or before"
    );
  });

  test("first and last take true", async () => {
    const db = await ordered();
    await expect(
      db.card.move({ where: { id: "a" }, first: "yes" })
    ).rejects.toThrow("first and last take true");
  });

  test("to names exactly the list's fields", async () => {
    const db = await ordered();
    await expect(
      db.card.move({ where: { id: "a" }, to: { title: "x" }, first: true })
    ).rejects.toThrow("to names the list's fields: columnId");
    expect(await titles(db)).toEqual(["a", "b", "c"]);
  });

  test("rekey orders by the model's scalar fields, asc or desc", async () => {
    const db = await ordered();
    const refused = await db.card.rekey({ orderBy: { title: "up" } }).then(
      () => undefined,
      (error: unknown) => error
    );
    expect(refused).toBeInstanceOf(ValidationError);
    expect((refused as Error).message).toContain("rekey: orderBy takes");
    await expect(db.card.rekey({ orderBy: { nope: "asc" } })).rejects.toThrow(
      ValidationError
    );
    await db.card.rekey({ orderBy: { title: "desc" } });
    expect(await titles(db)).toEqual(["c", "b", "a"]);
  });
});

describe("a move is one value another part may refuse", () => {
  test("an error another part raises on the move's write reaches the caller unchanged", async () => {
    const failure = new ForbiddenError("card", "update");
    const db = (await ordered()).$extends(
      extension(
        "refuse-updates",
        call(
          () => {
            throw failure;
          },
          target("card", "update")
        )
      )
    );
    await expect(
      db.card.move({ where: { id: "c" }, first: true })
    ).rejects.toBe(failure);
    expect(await titles(db)).toEqual(["a", "b", "c"]);
  });

  test("move's value runs once, whichever of then, catch or finally reads it", async () => {
    const db = await ordered();
    let settled = false;
    const moved = await db.card
      .move({ where: { id: "c" }, first: true })
      .finally(() => {
        settled = true;
      });
    expect(moved.title).toBe("c");
    expect(settled).toBe(true);
    const missing = await db.card
      .move({ where: { id: "nope" }, first: true })
      .catch((error: unknown) => error);
    expect(missing).toBeInstanceOf(Error);
    expect(await titles(db)).toEqual(["c", "a", "b"]);
  });
});

describe("the ends of the key range", () => {
  test("a key past the last append or before the last prepend is refused", () => {
    expect(() => keyBetween("9999999999", null)).toThrow(
      new RangeError("a list holds at most 10^9 appends")
    );
    expect(() => keyBetween(null, "00000000001")).toThrow(
      new RangeError("a list holds at most 10^9 prepends")
    );
  });

  test("a prepended key cut short of its integer part is no key", () => {
    expect(isKeyFormat("0812345678")).toBe(true);
    expect(isKeyFormat("01")).toBe(false);
  });
});

describe("a move between tied keys", () => {
  /** A list whose rows hold the keys given, in that order of creation. */
  async function tied(keys: readonly string[]): Promise<Loose> {
    const db = (await base()).$extends(
      ordering({ card: { key: "rank", within: ["columnId"] } })
    );
    for (const [at, rank] of keys.entries()) {
      const id = String.fromCharCode(97 + at);
      await db.card.create({
        data: { id, columnId: "c1", title: id, tags: [], rank },
      });
    }
    return db;
  }
  const order = async (db: Loose) =>
    (
      await db.card.findMany({
        where: { columnId: "c1" },
        orderBy: [{ rank: "asc" }, { id: "asc" }],
      })
    ).map((row) => row.id);

  test("after an anchor whose next row ties with it, the row lands between them", async () => {
    const db = await tied(["15", "15", "17"]);
    await db.card.move({ where: { id: "c" }, after: { id: "a" } });
    expect(await order(db)).toEqual(["a", "c", "b"]);
  });

  test("first of its list when the first rows tie", async () => {
    const db = await tied(["15", "15", "17"]);
    await db.card.move({ where: { id: "c" }, first: true });
    expect((await order(db))[0]).toBe("c");
  });

  test("into another list, first and last", async () => {
    const db = await tied(["15", "15", "17"]);
    await db.card.create({
      data: { id: "x", columnId: "c2", title: "x", tags: [], rank: "15" },
    });
    await db.card.create({
      data: { id: "y", columnId: "c2", title: "y", tags: [], rank: "15" },
    });
    await db.card.move({
      where: { id: "a" },
      to: { columnId: "c2" },
      first: true,
    });
    await db.card.move({
      where: { id: "b" },
      to: { columnId: "c2" },
      last: true,
    });
    const c2 = (
      await db.card.findMany({
        where: { columnId: "c2" },
        orderBy: [{ rank: "asc" }, { id: "asc" }],
      })
    ).map((row) => row.id);
    expect(c2[0]).toBe("a");
    expect(c2.at(-1)).toBe("b");
  });
});
