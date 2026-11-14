/**
 * A `rule` entry declared as a function (permissions 1.3.2: a policy
 * compiled a model at a time): resolved and admitted when a call first needs
 * its model, once per schema and declaration; its refusals, argument
 * references and projection keys judged then, as `$extends` judges an eager
 * entry; a lazy `acyclic` resolved only for an update writing a self key.
 * The produced row's behaviour with every entry lazy is
 * extension-produced.core.test.ts's "rules declared lazily" run.
 */

import { MemoryCache } from "@cache/drivers/memory";
import { cache } from "@cache/extension";
import { createClient } from "@drivers/sqlite3";
import { ClientInitializationError } from "@errors";
import { s } from "@schema";
import {
  arg,
  check,
  args as extArgs,
  extension,
  facts,
  lazy,
  nothing,
  now,
  oneOf,
  only,
  parts,
  when,
} from "@src/index";
import { appendResolvedExtension } from "@tests/fixtures/host-definition";
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

const me = arg("user");
const typed = parts<typeof schema>();
/** A rule entry, untyped: some are refused, which is what is tested. */
type Entry = Readonly<Record<string, unknown>>;
/**
 * A governed extension whose rule entries are the given functions, each
 * given lazily. The entries are handed through a rule read from the schema,
 * the one form that takes them untyped; it applies them as the same entries
 * written directly.
 */
/** `lazy` of an untyped entry, written apart from the rule: held. */
const held = (read: () => unknown) => lazy(read);
const governed = (
  entries: Record<string, (() => unknown) | ReturnType<typeof lazy>>,
  extra: { name?: string; control?: string } = {}
) =>
  typed.extension(
    extra.name ?? "lazy",
    extArgs({ [extra.control ?? "user"]: v.string() }),
    typed.rule(() =>
      Object.fromEntries(
        Object.entries(entries).map(([model, entry]) => [
          model,
          typeof entry === "function" ? held(entry) : entry,
        ])
      )
    )
  );
/** Rows read where `where` holds: no row is updated or deleted. */
const readOnly = (where: object): Entry => ({
  read: { where },
  update: { where: only(nothing) },
  delete: { where: only(nothing) },
});
/** Rows the caller owns: read and updated, never deleted. */
const own = (): Entry => ({
  read: { where: { ownerId: me } },
  update: { where: only({ ownerId: me }), check: check({ ownerId: me }) },
  delete: { where: only(nothing) },
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

test("an entry is admitted once per schema and declaration; a fresh declaration, at its own admission", async () => {
  let nodeCalls = 0;
  let noteCalls = 0;
  const verbs = {
    node: () => {
      nodeCalls++;
      return own();
    },
    note: () => {
      noteCalls++;
      return own();
    },
  };
  // One declaration, applied three times over one schema: admitted once.
  const definition = governed(verbs);
  for (let client = 0; client < 3; client++) {
    const db = base.$extends(definition);
    await db.node!.findMany({ user: "alice" } as object);
    await db.note!.findMany({ user: "alice" } as object);
  }
  expect([nodeCalls, noteCalls]).toEqual([1, 1]);
  // A fresh declaration is another one, read at its own admission.
  await base.$extends(governed(verbs)).node!.findMany({
    user: "alice",
  } as object);
  expect([nodeCalls, noteCalls]).toEqual([2, 1]);
});

test("a refused entry fails every call on its model, and only on its model", async () => {
  const db = base.$extends(
    governed({
      node: lazy(() => ({ ...own(), read: { where: { missing: "x" } } })),
      note: own,
    })
  );
  for (let attempt = 0; attempt < 2; attempt++) {
    const refused = db.node!.findMany({ user: "alice" } as object);
    await expect(refused).rejects.toBeInstanceOf(ClientInitializationError);
    await expect(
      db.node!.findMany({ user: "alice" } as object)
    ).rejects.toThrow(
      'Extension "lazy" rule.node.read: at "missing": Unknown key: missing.'
    );
  }
  expect(ids(await db.note!.findMany({ user: "alice" } as object))).toEqual([
    "n1",
  ]);
});

test("a lazy entry's control references are checked against the chain where it was applied", async () => {
  const db = base.$extends(
    governed({
      note: () => readOnly({ ownerId: arg("tenant") }),
    })
  );
  await expect(db.note!.findMany({ user: "alice" } as object)).rejects.toThrow(
    'Extension "lazy" references undeclared control "tenant".'
  );
  // Declared earlier in the chain: admitted.
  const tenant = base
    .$extends(extension("tenant", extArgs({ tenant: v.string() })))
    .$extends(
      governed({
        note: () => readOnly({ ownerId: arg("tenant") }),
      })
    );
  expect(
    ids(await tenant.note!.findMany({ user: "alice", tenant: "bob" } as object))
  ).toEqual(["n2"]);
});

test("a projection key may not take a link row's name", async () => {
  const db = base.$extends(
    governed({
      note: lazy(() => ({
        ...own(),
        read: {
          where: { ownerId: me },
          select: { $through: facts({ own: { ownerId: me } }) },
        },
      })),
    })
  );
  await expect(db.note!.findMany({ user: "alice" } as object)).rejects.toThrow(
    'rule.note.read.select "$through" is reserved'
  );
});

test("two extensions declaring one projection key on a model are refused when the model is first read", async () => {
  const evidence = (name: string, control?: string) =>
    governed(
      {
        note: lazy(() => ({
          ...own(),
          read: {
            where: { ownerId: me },
            select: { $access: facts({ own: { ownerId: me } }) },
          },
        })),
      },
      { name, ...(control && { control }) }
    );
  const db = base
    .$extends(evidence("first"))
    .$extends(evidence("second", "other"));
  await expect(db.note!.findMany({ user: "alice" } as object)).rejects.toThrow(
    'rule.note.read.select "$access" is declared by two extensions of the chain.'
  );
});

test("a lazy acyclic list is resolved only for an update writing a self key, and keeps the tree acyclic", async () => {
  let resolved = 0;
  const db = base.$extends(
    governed({
      node: lazy(() => ({
        read: { where: {} },
        update: { where: only({}), check: check({}) },
        delete: { where: only(nothing) },
        acyclic: () => {
          resolved++;
          return ["parent"];
        },
      })),
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

test("an entry that resolves to anything but an object is refused on first use", async () => {
  const db = base.$extends(governed({ note: () => null as never }));
  await expect(db.note!.findMany({ user: "alice" } as object)).rejects.toThrow(
    'Extension "lazy" rule.note: an entry is an object.'
  );
});

test("reading a model's verbs resolves its entry alone", () => {
  const resolved: string[] = [];
  const entry = (model: string) => () => {
    resolved.push(model);
    return readOnly({});
  };
  const chain = appendResolvedExtension(
    undefined,
    extension(
      "lazy",
      typed.rule({ node: lazy(entry("node")), note: lazy(entry("note")) })
    ),
    schema
  );
  const { domain } = chain.callRows!.call("node", undefined);
  const verbs = domain.verbs!;
  expect(verbs.has("node")).toBe(true);
  expect(verbs.has("missing")).toBe(false);
  expect(resolved).toEqual([]);
  expect(verbs.get("note")?.[0]?.read).toEqual({});
  expect(resolved).toEqual(["note"]);
});

test("one function serving two models is admitted for each against its own model", async () => {
  const roots = readOnly({ parentId: null });
  const shared = () => roots;
  const db = base.$extends(governed({ node: shared, note: shared }));
  expect(ids(await db.node!.findMany({ user: "alice" } as object))).toEqual([
    "a",
    "x",
  ]);
  // `note` has no `parentId`: its admission refuses what `node`'s accepted.
  await expect(db.note!.findMany({ user: "alice" } as object)).rejects.toThrow(
    'rule.note.read: at "parentId"'
  );
});

test("a cached read keys an eager entry's function acyclic, and lazy rows by their digest once", async () => {
  let resolved = 0;
  const cached = base.$extends(cache({ driver: new MemoryCache() })).$extends(
    governed({
      note: () => {
        resolved++;
        return own();
      },
    })
  ) as unknown as Loose & { $withCache(options: object): Loose };
  const eager = base.$extends(cache({ driver: new MemoryCache() })).$extends(
    typed.extension(
      "lazy",
      extArgs({ user: v.string() }),
      typed.rule({
        node: {
          read: { where: { ownerId: me } },
          update: {
            where: only({ ownerId: me }),
            check: check({ ownerId: me }),
          },
          delete: { where: only(nothing) },
          acyclic: () => ["parent"],
        },
      })
    )
  ) as unknown as Loose & { $withCache(options: object): Loose };
  for (let read = 0; read < 2; read++) {
    expect(
      ids(
        await cached
          .$withCache({ ttl: 60_000 })
          .note!.findMany({ user: "alice" } as object)
      )
    ).toEqual(["n1"]);
    expect(
      ids(
        await eager
          .$withCache({ ttl: 60_000 })
          .node!.findMany({ user: "alice" } as object)
      )
    ).toEqual(["a", "b"]);
  }
  expect(resolved).toBe(1);
});

test("a mode and a lazy entry that read only the call's instant name no argument but the mode, and their calls carry their scope", () => {
  const event = s.model({ id: s.string().id(), at: s.dateTime() });
  const past = { at: { lte: now } };
  const instantSchema = { event };
  const instant = parts<typeof instantSchema>();
  const chain = appendResolvedExtension(
    undefined,
    instant.extension(
      "instant",
      instant.args({ when: oneOf("past").default("past") }),
      instant.rule({ event: { root: when(arg("when"), "past", past) } }),
      instant.rule({
        event: lazy(() => ({
          read: { where: past },
          update: { where: only(nothing) },
          delete: { where: only(nothing) },
        })),
      })
    ),
    instantSchema
  );
  const called = chain.callRows!.call("event", undefined);
  expect(called.values).toBeDefined();
  expect(called.domain.verbs!.get("event")).toHaveLength(1);
});
