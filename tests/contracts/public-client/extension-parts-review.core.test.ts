/**
 * Adversarial review of the split of the rows reader in four parts (filters,
 * kept rows, default data, default order) and of the plain domain a chain
 * binds when it only orders and stamps rows. Each test states what an
 * application relies on, compared call by call with the base of the split.
 *
 * Runs on in-memory SQLite.
 */

import { createClient } from "@drivers/sqlite3";
import { s } from "@schema";
import {
  arg,
  bound,
  defaults,
  args as extArgs,
  extension,
  methods,
  oneOf,
  rule,
  when,
} from "@src/index";
import { softDelete } from "@src/soft-delete";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import { v } from "@validation";
import { afterEach, describe, expect, test } from "vitest";

const node = s.model({
  id: s.string().id(),
  ownerId: s.string(),
  rank: s.string(),
  by: s.string().nullable(),
  deletedAt: s.dateTime().nullable(),
  parentId: s.string().nullable(),
  parent: s
    .toOne(() => node)
    .fields("parentId")
    .references("id")
    .name("tree"),
  children: s.toMany(() => node).name("tree"),
});
const schema = { node };

type Row = Record<string, unknown> & { id: string };
interface Delegate {
  findMany(args?: object): Promise<Row[]>;
  create(args: object): Promise<Row>;
}
// The chains below are applied whatever their declared state: only their
// rows are read.
type Loose = { node: Delegate } & {
  $extends(definition: unknown): Loose;
  $transaction<T>(run: (tx: Loose) => Promise<T>): Promise<T>;
  $as(actor: string): Loose;
  $disconnect(): Promise<void>;
};

const opened: Loose[] = [];
afterEach(async () => {
  for (const client of opened.splice(0)) await client.$disconnect();
});

async function seeded(): Promise<Loose> {
  const base = createClient({ schema, dataDir: ":memory:" }) as never as Loose;
  opened.push(base);
  await syncLiveSchema(base as never);
  const rows: Record<string, unknown>[] = [
    { id: "a", ownerId: "alice", rank: "2", parentId: null },
    { id: "b", ownerId: "alice", rank: "1", parentId: "a" },
    { id: "c", ownerId: "alice", rank: "3", parentId: "a" },
    { id: "x", ownerId: "bob", rank: "0", parentId: null },
    { id: "y", ownerId: "bob", rank: "9", parentId: "a" },
    {
      id: "d",
      ownerId: "alice",
      rank: "5",
      parentId: "a",
      deletedAt: new Date("2020-01-01T00:00:00.000Z"),
    },
  ];
  for (const data of rows) await base.node.create({ data });
  return base;
}

const ids = (rows: readonly Row[]) => rows.map((row) => row.id);

const byRank = extension(
  "by-rank",
  defaults({ node: { orderBy: [{ rank: "desc" }] } })
);
const user = extension("user", extArgs({ user: v.string() }));
const ownedRows = extension(
  "owned",
  extArgs({ scope: oneOf("mine", "all").default("mine") }),
  rule({
    node: {
      root: when(arg("scope"), "mine", { ownerId: arg("user") }),
      related: when(arg("scope"), "mine", { ownerId: arg("user") }),
    },
  })
);
const tombstones = softDelete({ models: { node: { deletedAt: "deletedAt" } } });

describe("a chain that orders rows, and filters or keeps them too", () => {
  // Alice's rows by rank, descending; `d` is a tombstone, `x` and `y` Bob's.
  const chains: Record<string, (base: Loose) => Loose> = {
    "order before the filters": (base) =>
      base.$extends(byRank).$extends(user).$extends(ownedRows),
    "order after the filters": (base) =>
      base.$extends(user).$extends(ownedRows).$extends(byRank),
    "order between the filters and soft delete": (base) =>
      base
        .$extends(user)
        .$extends(ownedRows)
        .$extends(byRank)
        .$extends(tombstones),
    "soft delete, order, then the filters": (base) =>
      base
        .$extends(tombstones)
        .$extends(user)
        .$extends(byRank)
        .$extends(ownedRows),
  };

  test.each(
    Object.entries(chains)
  )("%s: filters, keeps and orders every read", async (label, make) => {
    const db = make(await seeded());
    const kept = label.includes("soft delete")
      ? ["c", "a", "b"]
      : ["d", "c", "a", "b"];
    const read = async (client: Loose) => ({
      root: ids(await client.node.findMany({ user: "alice" })),
      children: (
        await client.node.findMany({
          user: "alice",
          where: { id: "a" },
          include: { children: true },
        })
      ).map((row) => ids(row.children as Row[])),
    });
    const expected = {
      root: kept,
      children: [kept.filter((id) => id !== "a")],
    };
    expect(await read(db)).toEqual(expected);
    expect(await db.$transaction(read)).toEqual(expected);
  });

  test("a chain that only ordered rows filters and keeps them once extended again, after its first call", async () => {
    const ordered = (await seeded()).$extends(user).$extends(byRank);
    expect(ids(await ordered.node.findMany({ user: "alice" }))).toEqual([
      "y",
      "d",
      "c",
      "a",
      "b",
      "x",
    ]);
    const filtered = ordered.$extends(ownedRows);
    expect(ids(await filtered.node.findMany({ user: "alice" }))).toEqual([
      "d",
      "c",
      "a",
      "b",
    ]);
    const kept = filtered.$extends(tombstones);
    expect(ids(await kept.node.findMany({ user: "alice" }))).toEqual([
      "c",
      "a",
      "b",
    ]);
    // The client derived from is unchanged.
    expect(ids(await ordered.node.findMany({ user: "alice" }))).toHaveLength(6);
  });
});

describe("default data on a chain that neither filters nor keeps rows", () => {
  const stamping = extension(
    "stamping",
    defaults({ node: { create: { by: arg("actor", "id") } } })
  );

  test("overlapping calls each write their own control's value", async () => {
    const db = (await seeded())
      .$extends(
        extension("actor", extArgs({ actor: v.object({ id: v.string() }) }))
      )
      .$extends(stamping);
    const made = await Promise.all(
      ["p", "q", "r", "s"].map((id, index) =>
        db.node.create({
          actor: { id: `actor-${index}` },
          data: { id, ownerId: "alice", rank: id },
        })
      )
    );
    expect(made.map((row) => row.by)).toEqual([
      "actor-0",
      "actor-1",
      "actor-2",
      "actor-3",
    ]);
  });

  test("overlapping bound views each write their own bound value", async () => {
    const db = (await seeded())
      .$extends(
        extension(
          "bound-actor",
          extArgs({ actor: bound(v.object({ id: v.string() })) }),
          methods((scope) => ({
            $as: (id: string) => scope.$bind({ actor: { id } }),
          }))
        )
      )
      .$extends(stamping);
    const [one, two] = await Promise.all([
      db.$as("one").node.create({ data: { id: "p", ownerId: "a", rank: "p" } }),
      db.$as("two").node.create({ data: { id: "q", ownerId: "a", rank: "q" } }),
    ]);
    expect([one.by, two.by]).toEqual(["one", "two"]);
  });
});
