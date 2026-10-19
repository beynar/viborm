/**
 * A `rows.verbs` entry declared as a function (permissions 1.3.2: a policy
 * compiled a model at a time): resolved and admitted when a call first needs
 * its model, once per schema when it returns frozen data; its refusals,
 * control references and projection keys judged then, as `$extends` judges
 * an eager entry; a lazy `acyclic` resolved only for an update writing a
 * self key. The produced row's behaviour with every entry lazy is
 * extension-produced.core.test.ts's "verbs declared lazily" run.
 */

import { createClient } from "@drivers/sqlite3";
import { ClientInitializationError } from "@errors";
import { s } from "@schema";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import { v } from "@validation";
import { afterEach, beforeEach, expect, test } from "vitest";

const node = s.model({
  id: s.string().id(),
  ownerId: s.string(),
  parentId: s.string().nullable(),
  parent: s
    .toOne(() => node)
    .fields("parentId")
    .references("id")
    .name("tree"),
  children: s.toMany(() => node).name("tree"),
});
const note = s.model({ id: s.string().id(), ownerId: s.string() });
const schema = { node, note };

type Row = Record<string, unknown>;
interface Delegate {
  findMany(args?: object): Promise<Row[]>;
  update(args: object): Promise<Row>;
}
type Loose = Record<string, Delegate> & {
  $extends(definition: object): Loose;
  $disconnect(): Promise<void>;
};

const me = { control: "user" };
const frozen = <T>(value: T): T => {
  if (value && typeof value === "object") {
    for (const member of Object.values(value)) frozen(member);
    Object.freeze(value);
  }
  return value;
};
/** A governed definition whose `verbs` entries are the given functions. */
const governed = (
  verbs: Record<string, () => object>,
  extra: { name?: string; models?: object; control?: string } = {}
) => ({
  name: extra.name ?? "lazy",
  controls: { [extra.control ?? "user"]: { schema: v.string() } },
  rows: {
    control: extra.control === undefined ? "as" : `${extra.control}As`,
    default: "all",
    models: extra.models ?? {},
    verbs,
  },
});
const own = () => ({
  predicates: { own: { ownerId: me } },
  read: "own",
  update: "own",
});

let base: Loose;
beforeEach(async () => {
  base = createClient({ schema, dataDir: ":memory:" }) as unknown as Loose;
  await syncLiveSchema(base as never);
  const plain = base as unknown as Record<
    string,
    { createMany(args: object): Promise<unknown> }
  >;
  await plain.node!.createMany({
    data: [
      { id: "a", ownerId: "alice", parentId: null },
      { id: "b", ownerId: "alice", parentId: "a" },
      { id: "x", ownerId: "bob", parentId: null },
    ],
  });
  await plain.note!.createMany({
    data: [
      { id: "n1", ownerId: "alice" },
      { id: "n2", ownerId: "bob" },
    ],
  });
});
afterEach(async () => {
  await base.$disconnect();
});

const ids = (rows: Row[]) => rows.map((row) => row.id).sort();

test("an entry is resolved when a call first needs its model, never when the extension is applied", async () => {
  const calls: string[] = [];
  const db = base.$extends(
    governed({
      node: () => {
        calls.push("node");
        return own();
      },
      note: () => {
        calls.push("note");
        return own();
      },
    })
  );
  expect(calls).toEqual([]);
  expect(ids(await db.note!.findMany({ user: "alice" } as object))).toEqual([
    "n1",
  ]);
  expect(calls).toEqual(["note"]);
  expect(ids(await db.note!.findMany({ user: "bob" } as object))).toEqual([
    "n2",
  ]);
  expect(calls).toEqual(["note"]);
});

test("an entry returning frozen data is admitted once per schema; another, at each admission", async () => {
  let frozenCalls = 0;
  let plainCalls = 0;
  const once = frozen(own());
  const verbs = {
    node: () => {
      frozenCalls++;
      return once;
    },
    note: () => {
      plainCalls++;
      return own();
    },
  };
  // A fresh (mutable) definition is admitted at every `$extends`.
  for (let client = 0; client < 3; client++) {
    const db = base.$extends(governed(verbs));
    await db.node!.findMany({ user: "alice" } as object);
    await db.note!.findMany({ user: "alice" } as object);
  }
  expect(frozenCalls).toBe(1);
  expect(plainCalls).toBe(3);
});

test("a refused entry fails every call on its model, and only on its model", async () => {
  const db = base.$extends(
    governed({
      node: () => ({ ...own(), read: "missing" }),
      note: own,
    })
  );
  for (let attempt = 0; attempt < 2; attempt++) {
    const refused = db.node!.findMany({ user: "alice" } as object);
    await expect(refused).rejects.toBeInstanceOf(ClientInitializationError);
    await expect(
      db.node!.findMany({ user: "alice" } as object)
    ).rejects.toThrow(
      'Extension "lazy" rows.verbs.node at "read": names unknown predicate "missing".'
    );
  }
  expect(ids(await db.note!.findMany({ user: "alice" } as object))).toEqual([
    "n1",
  ]);
});

test("a mode naming a lazy entry's predicate narrows by it; an unknown one is refused on first use", async () => {
  const db = base.$extends(
    governed(
      {
        node: () => ({
          predicates: { all: {}, roots: { parentId: null } },
          read: "all",
        }),
      },
      { models: { node: { all: {}, roots: { root: "roots" } } } }
    )
  );
  expect(
    ids(await db.node!.findMany({ user: "alice", as: "roots" } as object))
  ).toEqual(["a", "x"]);
  const unknown = base.$extends(
    governed(
      { node: () => ({ predicates: { all: {} }, read: "all" }) },
      { models: { node: { all: {}, roots: { root: "nope" } } } }
    )
  );
  await expect(
    unknown.node!.findMany({ user: "alice", as: "roots" } as object)
  ).rejects.toThrow(
    'Extension "lazy" rows.node.roots.root at "root": names unknown predicate "nope".'
  );
});

test("a lazy entry's control references are checked against the chain where it was applied", async () => {
  const db = base.$extends(
    governed({
      note: () => ({
        predicates: { own: { ownerId: { control: "tenant" } } },
        read: "own",
      }),
    })
  );
  await expect(db.note!.findMany({ user: "alice" } as object)).rejects.toThrow(
    'Extension "lazy" references undeclared control "tenant".'
  );
  // Declared earlier in the chain: admitted.
  const tenant = base
    .$extends({
      name: "tenant",
      controls: { tenant: { schema: v.string() } },
    })
    .$extends(
      governed({
        note: () => ({
          predicates: { own: { ownerId: { control: "tenant" } } },
          read: "own",
        }),
      })
    );
  expect(
    ids(await tenant.note!.findMany({ user: "alice", tenant: "bob" } as object))
  ).toEqual(["n2"]);
});

test("two extensions declaring one projection key on a model are refused when the model is first read", async () => {
  const evidence = (name: string, control?: string) =>
    governed(
      {
        note: () => ({
          ...own(),
          evidence: { as: "$access", names: ["own"] },
        }),
      },
      { name, ...(control && { control }) }
    );
  const db = base
    .$extends(evidence("first"))
    .$extends(evidence("second", "other"));
  await expect(db.note!.findMany({ user: "alice" } as object)).rejects.toThrow(
    'rows.verbs.note.evidence.as "$access" is declared by two extensions of the chain.'
  );
});

test("a lazy acyclic list is resolved only for an update writing a self key, and keeps the tree acyclic", async () => {
  let resolved = 0;
  const db = base.$extends(
    governed({
      node: () => ({
        predicates: { all: {} },
        read: "all",
        update: "all",
        acyclic: () => {
          resolved++;
          return ["parent"];
        },
      }),
    })
  );
  await db.node!.update({
    where: { id: "x" },
    data: { ownerId: "carol" },
    user: "alice",
  } as object);
  expect(resolved).toBe(0);
  await expect(
    db.node!.update({
      where: { id: "a" },
      data: { parentId: "b" },
      user: "alice",
    } as object)
  ).rejects.toThrow();
  expect(resolved).toBe(1);
  await db.node!.update({
    where: { id: "x" },
    data: { parentId: "a" },
    user: "alice",
  } as object);
  expect(resolved).toBe(1);
});
