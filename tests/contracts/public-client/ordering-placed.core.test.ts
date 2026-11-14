/**
 * `placed` is how SurrealDB respaces a list: its UPDATE joins no derived
 * table, so the new keys are computed from the rows read, and must put the
 * list in the order the joined respacing statement puts it on the SQL
 * databases. Each case respaces one list on SQLite with `rekey`, then asks
 * `placed` for the same list as read before, and compares the orders and
 * the keys of the rows left in place. The key texts differ (`placed` spaces
 * its keys as `keysBetween` does, the statement as its SQL arithmetic does),
 * and so does where a NULL sorts (last for `placed`, as on PostgreSQL;
 * first on SQLite): the cases hold no NULL in the order.
 *
 * Runs on in-memory SQLite.
 */

import { createClient } from "@drivers/sqlite3";
import { s } from "@schema";
import { extension, only, rule } from "@src/index";
import { ordering, orderingKey } from "@src/ordering";
import { type PlannedMember, placed } from "@src/ordering/placed";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import { afterEach, describe, expect, test } from "vitest";

const card = s.model({
  id: s.string().id(),
  columnId: s.string(),
  rank: s.string().schema(orderingKey),
  title: s.string().nullable(),
  owner: s.string(),
});
const schema = { card };

type Row = {
  id: string;
  rank: string;
  title: string | null;
  owner: string;
};
interface Delegate {
  create(args: object): Promise<Row>;
  findMany(args?: object): Promise<Row[]>;
  rekey(args?: object): Promise<{ count: number }>;
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

/**
 * One list, its rows written with the keys given; `mine` rows are the ones
 * a rule lets the call update (movable), the others keep their keys.
 */
async function list(
  rows: readonly (Omit<Row, "id"> & { readonly id: string })[]
): Promise<{ base: Loose; db: Loose }> {
  const base = createClient({ schema, dataDir: ":memory:" }) as never as Loose;
  opened.push(base);
  await syncLiveSchema(base as never);
  for (const row of rows)
    await base.card.create({ data: { ...row, columnId: "c1" } });
  const db = base
    .$extends(
      extension(
        "mine",
        rule({ card: { update: { where: only({ owner: "me" }) } } })
      )
    )
    .$extends(ordering({ card: { key: "rank", within: ["columnId"] } }));
  return { base, db };
}

/** What SQLite's respacing wrote, and what `placed` gives the same list. */
async function compared(
  rows: readonly Row[],
  orderBy?: Readonly<Record<string, "asc" | "desc">>
) {
  const { base, db } = await list(rows);
  const before = await base.card.findMany({ orderBy: { id: "asc" } });
  await db.card.rekey({
    where: { columnId: "c1" },
    ...(orderBy && { orderBy }),
  });
  const after = await base.card.findMany({ orderBy: { id: "asc" } });
  const terms = Object.entries(orderBy ?? {});
  const members: PlannedMember[] = before.map((row) => ({
    key: row.rank,
    identity: [row.id],
    order: terms.map(([field]) => row[field as keyof Row] ?? null),
    movable: row.owner === "me",
  }));
  const keys = placed(
    members,
    terms.map(([, way]) => way)
  );
  const placedKeys = before.map((row, at) => keys[at] ?? row.rank);
  const orderOf = (ranks: readonly string[]) =>
    before
      .map((row, at) => ({ id: row.id, rank: ranks[at]! }))
      .sort((x, y) => (x.rank < y.rank ? -1 : 1))
      .map(({ id }) => id);
  const fixed = (ranks: readonly string[]) =>
    before.flatMap((row, at) => (row.owner === "me" ? [] : [ranks[at]]));
  const written = after.map((row) => row.rank);
  return {
    written: { order: orderOf(written), fixed: fixed(written) },
    placed: { order: orderOf(placedKeys), fixed: fixed(placedKeys) },
  };
}

describe("placed computes the keys the respacing statement writes", () => {
  test("every row movable: short keys in the list's order", async () => {
    const { written, placed: computed } = await compared([
      { id: "a", rank: "13", title: "a", owner: "me" },
      { id: "b", rank: "11", title: "b", owner: "me" },
      { id: "c", rank: "12", title: "c", owner: "me" },
    ]);
    expect(computed).toEqual(written);
  });

  test("fixed rows keep their keys; the movable ones fit between them", async () => {
    const { written, placed: computed } = await compared([
      { id: "a", rank: "11", title: "a", owner: "me" },
      { id: "b", rank: "12", title: "b", owner: "other" },
      { id: "c", rank: "14", title: "c", owner: "me" },
      { id: "d", rank: "15", title: "d", owner: "me" },
      { id: "e", rank: "17", title: "e", owner: "other" },
      { id: "f", rank: "18", title: "f", owner: "me" },
    ]);
    expect(computed).toEqual(written);
  });

  test("with an order, the movable rows take the places in it, both ways", async () => {
    const rows = [
      { id: "a", rank: "10", title: "b", owner: "me" },
      { id: "b", rank: "11", title: "c", owner: "me" },
      { id: "c", rank: "12", title: "a", owner: "other" },
      { id: "d", rank: "13", title: "a", owner: "me" },
    ];
    for (const way of ["asc", "desc"] as const) {
      const { written, placed: computed } = await compared(rows, {
        title: way,
      });
      expect(computed).toEqual(written);
    }
  });

  test("no key between two equal fixed keys: the row between them is not written", () => {
    const members: PlannedMember[] = [
      { key: "15", identity: ["a"], order: [], movable: false },
      { key: "15", identity: ["b"], order: [], movable: true },
      { key: "15", identity: ["c"], order: [], movable: false },
    ];
    expect(placed(members, [])).toEqual([null, null, null]);
  });
});
