/**
 * Adversarial review of the split of the rows reader (filters, `Judge`,
 * `Projection`): each test states what an application's end users rely on
 * and holds on the base of the split as after it.
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
  secret: s.string(),
  deletedAt: s.dateTime().nullable(),
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
  create(args: object): Promise<Row>;
  delete(args: object): Promise<Row>;
}
type Loose = Record<string, Delegate> & {
  $extends(definition: object): Loose;
  $disconnect(): Promise<void>;
};

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
      { id: "a", ownerId: "alice", secret: "sa", parentId: null },
      { id: "x", ownerId: "bob", secret: "sx", parentId: null },
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

test("two lazy entries sharing a sub-predicate that names an undeclared control are each refused", async () => {
  // One `where` of node, read by node's entry and, under `$exists`, by note's.
  const ghost = { ownerId: { control: "ghost" } };
  const db = base.$extends({
    name: "lazy",
    controls: { user: { schema: v.string() } },
    rows: {
      control: "as",
      default: "all",
      models: {},
      verbs: {
        node: () => ({ predicates: { own: ghost }, read: "own" }),
        note: () => ({
          predicates: { own: { $exists: { node: ghost } } },
          read: "own",
        }),
      },
    },
  });
  for (const model of ["node", "note"]) {
    const call = db[model]!.findMany({ user: "alice" } as object);
    await expect(call).rejects.toBeInstanceOf(ClientInitializationError);
    await expect(call).rejects.toThrow(
      'Extension "lazy" references undeclared control "ghost".'
    );
  }
});

test("a lazy entry shared by two chains is checked against each chain's own controls, in either order", async () => {
  const declaration = {
    name: "lazy",
    controls: { user: { schema: v.string() } },
    rows: {
      control: "as",
      default: "all",
      models: {},
      verbs: {
        note: () => ({
          predicates: { own: { ownerId: { control: "tenant" } } },
          read: "own",
        }),
      },
    },
  };
  const tenancy = {
    name: "tenant",
    controls: { tenant: { schema: v.string() } },
  };
  const bare = () => base.$extends(declaration);
  const declared = () => base.$extends(tenancy).$extends(declaration);
  for (const order of [
    [bare, declared],
    [declared, bare],
  ])
    for (const make of order) {
      const db = make();
      const call = db.note!.findMany({ user: "u", tenant: "bob" } as object);
      if (make === bare)
        await expect(call).rejects.toThrow(
          'Extension "lazy" references undeclared control "tenant".'
        );
      else expect(ids(await call)).toEqual(["n2"]);
    }
});

test("a control named only under NOT, $if, $exists, recurse, in confine or in a stamp is refused at $extends when undeclared", () => {
  const ghost = { control: "ghost" };
  const filters: object[] = [
    { NOT: { ownerId: ghost } },
    { OR: [{ $if: { control: "ghost", exists: true } }] },
    { $exists: { note: { ownerId: ghost } } },
    { children: { recurse: { depth: 2 }, some: { ownerId: ghost } } },
  ];
  const definitions: object[] = [
    ...filters.map((where) => ({
      rows: {
        control: "as",
        default: "m",
        models: { node: { m: { root: where } } },
      },
    })),
    ...filters.map((where) => ({
      rows: {
        control: "as",
        default: "m",
        models: {},
        verbs: { node: { predicates: { p: where }, read: "p" } },
      },
    })),
    {
      rows: {
        control: "as",
        default: "m",
        models: {},
        confine: { node: { ownerId: ghost } },
      },
    },
    { data: { models: { note: { create: { ownerId: ghost } } } } },
  ];
  for (const definition of definitions) {
    const apply = () => base.$extends({ name: "named", ...definition });
    expect(apply, JSON.stringify(definition)).toThrow(
      ClientInitializationError
    );
    expect(apply, JSON.stringify(definition)).toThrow(
      'Extension "named" references undeclared control "ghost".'
    );
  }
});

test("one predicate object shared by two modes and two models filters under each; an absent optional control drops only the layers that name it", async () => {
  const owned = { ownerId: { control: "owner" } };
  const db = base.$extends({
    name: "scoped",
    controls: { owner: { schema: v.string() } },
    rows: {
      control: "as",
      default: "a",
      models: {
        node: { a: { root: owned }, b: { root: owned } },
        note: { a: { root: owned }, b: { root: { ownerId: "alice" } } },
      },
    },
  });
  for (const as of ["a", "b"]) {
    expect(
      ids(await db.node!.findMany({ as, owner: "bob" } as object))
    ).toEqual(["x"]);
    expect(ids(await db.node!.findMany({ as } as object))).toEqual(["a", "x"]);
  }
  expect(
    ids(await db.note!.findMany({ as: "a", owner: "bob" } as object))
  ).toEqual(["n2"]);
  expect(ids(await db.note!.findMany({ as: "b" } as object))).toEqual(["n1"]);
});

test("one declaration applied to two schemas whose models share names is admitted against each", async () => {
  const thin = s.model({ id: s.string().id(), ownerId: s.string() });
  const other = createClient({
    schema: { node: thin, note },
    dataDir: ":memory:",
  }) as unknown as Loose;
  const declaration = {
    name: "gates",
    controls: { user: { schema: v.string() } },
    rows: {
      control: "as",
      default: "all",
      models: { node: { all: { root: { secret: { not: "" } } } } },
      verbs: {
        node: {
          predicates: { own: { ownerId: { control: "user" } } },
          read: "own",
          reads: { secret: "own" },
        },
      },
    },
  };
  // Admitted against the schema that holds `secret` first.
  base.$extends(declaration);
  expect(() => other.$extends(declaration)).toThrow(ClientInitializationError);
  await other.$disconnect();
});

/** Hides a gated field, refuses a created row its `place` refuses. */
const judged = {
  name: "judged",
  controls: { user: { schema: v.string() } },
  rows: {
    control: "judgedAs",
    default: "all",
    models: {},
    verbs: {
      node: {
        predicates: { own: { ownerId: { control: "user" } }, any: {} },
        read: "any",
        place: "own",
        reads: { secret: "own" },
      },
    },
  },
};
const filtering = {
  name: "filtering",
  rows: {
    control: "filteringAs",
    default: "live",
    models: { node: { live: { root: { deletedAt: null } } } },
  },
};

test("a chain where only one of two `rows` members declares verbs still judges and gates, in either order", async () => {
  await (
    base as unknown as Record<string, { update(a: object): Promise<unknown> }>
  ).node!.update({
    where: { id: "x" },
    data: { deletedAt: new Date() },
  });
  for (const db of [
    base.$extends(filtering).$extends(judged),
    base.$extends(judged).$extends(filtering),
  ]) {
    const rows = await db.node!.findMany({ user: "alice" } as object);
    expect(rows.map((row) => [row.id, row.secret])).toEqual([["a", "sa"]]);
    const bobs = await db.node!.findMany({ user: "bob" } as object);
    expect(bobs.map((row) => [row.id, row.secret ?? null])).toEqual([
      ["a", null],
    ]);
    await expect(
      db.node!.create({
        data: { id: "c", ownerId: "bob", secret: "s" },
        user: "alice",
      } as object)
    ).rejects.toThrow("The create on node is not permitted");
  }
});

test("a lazy entry function that throws fails the call and every later call on its model", async () => {
  let calls = 0;
  const db = base.$extends({
    name: "lazy",
    controls: { user: { schema: v.string() } },
    rows: {
      control: "as",
      default: "all",
      models: {},
      verbs: {
        note: () => {
          calls++;
          throw new Error("compile failed");
        },
      },
    },
  });
  for (let attempt = 0; attempt < 2; attempt++)
    await expect(
      db.note!.findMany({ user: "alice" } as object)
    ).rejects.toThrow("compile failed");
  expect(calls).toBe(2);
  expect(ids(await db.node!.findMany({ user: "alice" } as object))).toEqual([
    "a",
    "x",
  ]);
});
