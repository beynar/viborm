/**
 * Adversarial review of the split of the rows reader (filters, `Judge`,
 * `Projection`): each test states what an application's end users rely on
 * and holds on the base of the split as after it.
 */

import { createClient } from "@drivers/sqlite3";
import { ClientInitializationError } from "@errors";
import { s } from "@schema";
import {
  arg,
  check,
  exists,
  gate,
  lazy,
  nothing,
  oneOf,
  only,
  parts,
  provided,
  when,
} from "@src/index";
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
// The extensions are written apart from the client they are applied to.
const typed = parts<typeof schema>();
const extArgs = typed.args;

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
  const ghost = { ownerId: arg("ghost") };
  const db = base.$extends(
    typed.extension(
      "lazy",
      extArgs({ user: v.string() }),
      typed.rule({
        node: lazy(() => ({
          read: { where: ghost },
          update: { where: only(nothing) },
          delete: { where: only(nothing) },
        })),
        note: lazy(() => ({
          read: { where: exists({ node: ghost }) },
          update: { where: only(nothing) },
          delete: { where: only(nothing) },
        })),
      })
    )
  );
  for (const model of ["node", "note"]) {
    const call = db[model]!.findMany({ user: "alice" } as object);
    await expect(call).rejects.toBeInstanceOf(ClientInitializationError);
    await expect(call).rejects.toThrow(
      'Extension "lazy" references undeclared control "ghost".'
    );
  }
});

test("a lazy entry shared by two chains is checked against each chain's own controls, in either order", async () => {
  const tenant = arg("tenant");
  const declaration = typed.extension(
    "lazy",
    extArgs({ user: v.string() }),
    typed.rule({
      note: lazy(() => ({
        read: { where: { ownerId: tenant } },
        update: { where: only(nothing) },
        delete: { where: only(nothing) },
      })),
    })
  );
  const tenancy = typed.extension("tenant", extArgs({ tenant: v.string() }));
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
  const ghost = arg("ghost");
  const filters: object[] = [
    { NOT: { ownerId: ghost } },
    { OR: [provided(ghost, { exists: true })] },
    exists({ note: { ownerId: ghost } }),
    { children: { recurse: { depth: 2 }, some: { ownerId: ghost } } },
  ];
  // Rules read from the schema are untyped: the refusal is the runtime's.
  const definitions: [string, object][] = [
    ...filters.map((where): [string, object] => [
      "root",
      typed.extension(
        "named",
        typed.rule(() => ({ node: { root: where } }))
      ),
    ]),
    ...filters.map((where): [string, object] => [
      "read.where",
      typed.extension(
        "named",
        typed.rule(() => ({ node: { read: { where } } }))
      ),
    ]),
    [
      "confine",
      typed.extension(
        "named",
        typed.rule(() => ({ node: { confine: { ownerId: ghost } } }))
      ),
    ],
    [
      "stamp",
      typed.extension(
        "named",
        typed.defaults({ note: { create: { ownerId: ghost } } })
      ),
    ],
  ];
  for (const [label, definition] of definitions) {
    const apply = () => base.$extends(definition);
    expect(apply, label).toThrow(ClientInitializationError);
    expect(apply, label).toThrow(
      'Extension "named" references undeclared control "ghost".'
    );
  }
});

test("one predicate object shared by two modes and two models filters under each; an absent optional control drops only the layers that name it", async () => {
  const owned = { ownerId: arg("owner") };
  const db = base.$extends(
    typed.extension(
      "scoped",
      extArgs({ owner: v.string(), as: oneOf("a", "b").default("a") }),
      typed.rule({
        node: {
          root: [when(arg("as"), "a", owned), when(arg("as"), "b", owned)],
        },
        note: {
          root: [
            when(arg("as"), "a", owned),
            when(arg("as"), "b", { ownerId: "alice" }),
          ],
        },
      })
    )
  );
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
  const own = { ownerId: arg("user") };
  const declaration = typed.extension(
    "gates",
    extArgs({ user: v.string() }),
    typed.rule({
      node: {
        read: { where: own, fields: { secret: gate(own) } },
        root: { secret: { not: "" } },
        update: { where: only(nothing) },
        delete: { where: only(nothing) },
      },
    })
  );
  // Admitted against the schema that holds `secret` first.
  base.$extends(declaration);
  expect(() => other.$extends(declaration)).toThrow(ClientInitializationError);
  await other.$disconnect();
});

const own = { ownerId: arg("user") };
/** Hides a gated field, refuses a created row its `place` refuses. */
const judged = typed.extension(
  "judged",
  extArgs({ user: v.string() }),
  typed.rule({
    node: {
      read: { where: {}, fields: { secret: gate(own) } },
      create: { check: check(own) },
      update: { where: only(nothing) },
      delete: { where: only(nothing) },
    },
  })
);
const filtering = typed.extension(
  "filtering",
  extArgs({ filteringAs: oneOf("live").default("live") }),
  typed.rule({
    node: { root: when(arg("filteringAs"), "live", { deletedAt: null }) },
  })
);

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
  const db = base.$extends(
    typed.extension(
      "lazy",
      extArgs({ user: v.string() }),
      typed.rule({
        note: () => {
          calls++;
          throw new Error("compile failed");
        },
      })
    )
  );
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
