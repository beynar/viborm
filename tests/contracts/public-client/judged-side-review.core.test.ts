/**
 * Review of the judged side written with less code (2026-11-15, nine commits
 * on 8edb90997): what `only`, `check`, `gate`, `facts` and `lazy` bring. Each
 * test pins what 8edb90997 answers, attacked where a commit changed how the
 * answer is made:
 *
 * - an entry given lazily admits and reads itself, and the arguments it
 *   names are checked by its extension's place in each chain;
 * - `acyclic` relations are always named lazily, a list included;
 * - `gate` asks the schema's key catalog which fields it may not hide;
 * - what a rule prepares is no longer frozen;
 * - a layer's call reads walk a relation's link by its body's branch.
 *
 * Runs on SQLite, in memory.
 */

import { createClient } from "@drivers/sqlite3";
import { ClientInitializationError, ForbiddenError } from "@errors";
import { s } from "@schema";
import {
  accepts,
  arg,
  check,
  args as extArgs,
  extension,
  facts,
  gate,
  lazy,
  nothing,
  only,
  rule,
} from "@src/index";
import { ordering } from "@src/ordering";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import { v } from "@validation";
import { afterEach, describe, expect, test } from "vitest";

type Row = Record<string, unknown>;
interface Loose {
  // Entries, arguments and calls the types refuse are what is tested.
  [model: string]: any;
  $extends(definition: unknown): Loose;
  $disconnect(): Promise<void>;
}
type Entry = Readonly<Record<string, unknown>>;

const NESTED_REFUSAL =
  /^Cannot (connect|set|update) relation '(children|parent)': the record it writes is not permitted\.$/;

const opened: Loose[] = [];
afterEach(async () => {
  for (const client of opened.splice(0)) await client.$disconnect();
});

async function open(schema: object): Promise<Loose> {
  const client = createClient({
    schema: schema as never,
    dataDir: ":memory:",
  }) as unknown as Loose;
  opened.push(client);
  await syncLiveSchema(client as never);
  return client;
}

const ids = (rows: Row[]) => rows.map((row) => row.id).sort();
/** What a call fails with: the test fails where it does not. */
const failure = async (call: Promise<unknown>): Promise<Error> => {
  try {
    await call;
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected the call to be refused");
};
/** What applying a definition fails with. */
const refusal = (apply: () => unknown): Error => {
  try {
    apply();
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected the definition to be refused");
};
/** An untyped rule: its entries are the ones the types refuse. */
const rules = (entries: Record<string, unknown>) => rule(entries as never);
/** Rows read where `where` holds: none is updated or deleted. */
const readOnly = (where: object): Entry => ({
  read: { where },
  update: { where: only(nothing) },
  delete: { where: only(nothing) },
});

describe("an entry given lazily: its arguments by its extension's place in each chain", () => {
  const note = s.model({ id: s.string().id(), ownerId: s.string() });
  const seeded = async () => {
    const base = await open({ note });
    await base.note.createMany({
      data: [
        { id: "n1", ownerId: "alice" },
        { id: "n2", ownerId: "bob" },
      ],
    });
    return base;
  };
  const UNDECLARED =
    'Extension "reader" references undeclared argument "tenant".';
  /** An extension whose entry of `note`, given lazily, reads `tenant`: it declares none. */
  const reader = (calls: string[] = []) =>
    extension(
      "reader",
      rules({
        note: lazy(() => {
          calls.push("note");
          return readOnly({ ownerId: arg("tenant") });
        }),
      })
    );
  const declaring = (name: string, argument = "tenant") =>
    extension(name, extArgs({ [argument]: accepts(v.string()) }));

  test("an argument an extension applied after it declares is refused, on every call; applied before, admitted", async () => {
    const base = await seeded();
    const after = base.$extends(reader()).$extends(declaring("tenancy"));
    for (let attempt = 0; attempt < 2; attempt++) {
      const refused = await failure(after.note.findMany({ tenant: "bob" }));
      expect(refused).toBeInstanceOf(ClientInitializationError);
      expect(refused.message).toBe(UNDECLARED);
    }
    const before = base.$extends(declaring("tenancy")).$extends(reader());
    expect(ids(await before.note.findMany({ tenant: "bob" }))).toEqual(["n2"]);
    // An extension applied after it that binds the chain's rows again, with
    // a rule of its own: the entry is read by the chain that declares the
    // argument, and still refused by its extension's place in it.
    const ruling = (name: string, entry: unknown) =>
      extension(
        name,
        extArgs({ tenant: accepts(v.string()) }),
        rules({ note: entry })
      );
    for (const [form, entry] of Object.entries({
      "a filter": { root: { id: { not: "none" } } },
      "a judged entry": { update: { where: only(nothing) } },
      "a lazy entry": lazy(() => readOnly({ ownerId: arg("tenant") })),
    })) {
      const rebound = base.$extends(reader()).$extends(ruling("ruling", entry));
      for (let attempt = 0; attempt < 2; attempt++)
        expect(
          (await failure(rebound.note.findMany({ tenant: "bob" }))).message,
          form
        ).toBe(UNDECLARED);
      const admitted = base
        .$extends(ruling("ruling", entry))
        .$extends(reader());
      expect(
        ids(await admitted.note.findMany({ tenant: "bob" })),
        form
      ).toEqual(["n2"]);
    }
  });

  test("one extension value on two chains of a schema is checked against each, whichever reads first", async () => {
    for (const first of ["declared", "undeclared"] as const) {
      const base = await seeded();
      const calls: string[] = [];
      const value = reader(calls);
      const declared = base.$extends(declaring("tenancy")).$extends(value);
      const after = base.$extends(value).$extends(declaring("tenancy"));
      const none = base.$extends(value);
      const read = async () =>
        expect(
          ids(await declared.note.findMany({ tenant: "alice" })),
          first
        ).toEqual(["n1"]);
      const refuse = async () => {
        for (const client of [after, none])
          expect(
            (await failure(client.note.findMany({ tenant: "alice" }))).message,
            first
          ).toBe(UNDECLARED);
      };
      for (const step of first === "declared"
        ? [read, refuse, read]
        : [refuse, read, refuse])
        await step();
      // One declaration over one schema: read once, whatever refused it.
      expect(calls, first).toEqual(["note"]);
    }
  });

  test("an extension of the same name that declares another argument, on another client, declares nothing for it", async () => {
    const base = await seeded();
    const value = reader();
    const other = base.$extends(declaring("tenancy", "region")).$extends(value);
    const own = base.$extends(declaring("tenancy")).$extends(value);
    expect((await failure(other.note.findMany({ region: "eu" }))).message).toBe(
      UNDECLARED
    );
    expect(ids(await own.note.findMany({ tenant: "bob" }))).toEqual(["n2"]);
    expect((await failure(other.note.findMany({ region: "eu" }))).message).toBe(
      UNDECLARED
    );
    // The name declared after it, under an extension named as the one before it elsewhere.
    const late = base
      .$extends(declaring("first", "region"))
      .$extends(value)
      .$extends(declaring("tenancy"));
    expect(
      (await failure(late.note.findMany({ tenant: "bob", region: "eu" })))
        .message
    ).toBe(UNDECLARED);
  });

  test("its own extension's arguments are its own wherever the parts stand, and a later extension keeps it bound", async () => {
    const base = await seeded();
    const own = extension(
      "reader",
      rules({ note: lazy(() => readOnly({ ownerId: arg("tenant") })) }),
      extArgs({ tenant: accepts(v.string()) })
    );
    const db = base.$extends(own);
    expect(ids(await db.note.findMany({ tenant: "alice" }))).toEqual(["n1"]);
    const more = db.$extends(declaring("more", "region"));
    expect(
      ids(await more.note.findMany({ tenant: "bob", region: "eu" }))
    ).toEqual(["n2"]);
    await expect(
      more.note.update({
        where: { id: "n2" },
        data: { ownerId: "alice" },
        tenant: "bob",
      })
    ).rejects.toThrow();
  });

  test("one extension value on two schemas whose models share a name is admitted by each schema's own model", async () => {
    const titled = s.model({ id: s.string().id(), title: s.string() });
    const calls: string[] = [];
    const value = extension(
      "reader",
      extArgs({ tenant: accepts(v.string()) }),
      rules({
        note: lazy(() => {
          calls.push("note");
          return readOnly({ ownerId: arg("tenant") });
        }),
      })
    );
    const owned = (await seeded()).$extends(value);
    const other = await open({ note: titled });
    await other.note.create({ data: { id: "t1", title: "alice" } });
    const unowned = other.$extends(value);
    for (let attempt = 0; attempt < 2; attempt++) {
      expect(
        (await failure(unowned.note.findMany({ tenant: "alice" }))).message
      ).toBe(
        'Extension "reader" rule.note.read: at "ownerId": Unknown key: ownerId.'
      );
      expect(ids(await owned.note.findMany({ tenant: "alice" }))).toEqual([
        "n1",
      ]);
    }
    // Read once where it was admitted, and again each time it was refused.
    expect(calls).toEqual(["note", "note", "note"]);
  });

  test("its filters by purpose are its own, and an entry that gives none filters nothing", async () => {
    const author = s.model({
      id: s.string().id(),
      notes: s.toMany(() => authored),
    });
    const authored = s.model({
      id: s.string().id(),
      ownerId: s.string(),
      authorId: s.string(),
      author: s
        .toOne(() => author)
        .fields("authorId")
        .references("id"),
    });
    const base = await open({ author, note: authored });
    await base.author.create({ data: { id: "a" } });
    await base.note.createMany({
      data: [
        { id: "n1", ownerId: "alice", authorId: "a" },
        { id: "n2", ownerId: "bob", authorId: "a" },
      ],
    });
    const through = async (db: Loose) =>
      ids(
        (
          (await db.author.findMany({
            include: { notes: true },
            tenant: "alice",
          })) as Row[]
        ).flatMap((row) => row.notes as Row[])
      );
    const tenancy = extArgs({ tenant: accepts(v.string()) });
    const mine = { ownerId: arg("tenant") };
    const split = base.$extends(
      extension(
        "reader",
        tenancy,
        rules({
          note: lazy(() => ({
            related: mine,
            update: { where: only(nothing) },
          })),
        })
      )
    );
    expect(ids(await split.note.findMany({ tenant: "alice" }))).toEqual([
      "n1",
      "n2",
    ]);
    expect(await through(split)).toEqual(["n1"]);
    const rooted = base.$extends(
      extension(
        "reader",
        tenancy,
        rules({ note: lazy(() => ({ root: [mine, {}] })) })
      )
    );
    expect(ids(await rooted.note.findMany({ tenant: "alice" }))).toEqual([
      "n1",
    ]);
    expect(await through(rooted)).toEqual(["n1", "n2"]);
    const none = base.$extends(
      extension(
        "reader",
        tenancy,
        rules({ note: lazy(() => ({ update: { where: only(nothing) } })) })
      )
    );
    expect(ids(await none.note.findMany({ tenant: "alice" }))).toEqual([
      "n1",
      "n2",
    ]);
    expect(await through(none)).toEqual(["n1", "n2"]);
    await expect(
      none.note.update({
        where: { id: "n1" },
        data: { ownerId: "bob" },
        tenant: "alice",
      })
    ).rejects.toThrow();
  });
});

describe("acyclic relations, named lazily whatever their form", () => {
  const node = s.model({
    id: s.string().id(),
    ownerId: s.string(),
    rank: s.string().default(""),
    parentId: s.string().nullable(),
    mentorId: s.string().nullable(),
    parent: s
      .toOne(() => node)
      .fields("parentId")
      .references("id")
      .name("tree"),
    children: s.toMany(() => node).name("tree"),
    mentor: s
      .toOne(() => node)
      .fields("mentorId")
      .references("id")
      .name("mentoring"),
    mentees: s.toMany(() => node).name("mentoring"),
  });
  /** a < b < c (each the next one's parent), and x apart. */
  const seeded = async () => {
    const base = await open({ node });
    await base.node.createMany({
      data: [
        { id: "a", ownerId: "alice", rank: "1" },
        { id: "b", ownerId: "alice", rank: "1", parentId: "a" },
        { id: "c", ownerId: "alice", rank: "1", parentId: "b" },
        { id: "x", ownerId: "alice", rank: "2" },
      ],
    });
    return base;
  };
  const open_ = (acyclic: unknown): Entry => ({
    read: { where: {} },
    create: { check: check({}) },
    update: { where: only({}), check: check({}) },
    delete: { where: only({}) },
    acyclic,
  });
  const FORMS: Record<string, (acyclic: unknown) => unknown> = {
    "a list": (acyclic) => open_(acyclic),
    "a function": (acyclic) => open_(() => acyclic),
    "a list in a lazy entry": (acyclic) => lazy(() => open_(acyclic)),
    "a function in a lazy entry": (acyclic) => lazy(() => open_(() => acyclic)),
  };
  const tree = async (base: Loose) =>
    ((await base.node.findMany({ orderBy: { id: "asc" } })) as Row[])
      .map((row) => `${row.id}<${row.parentId ?? ""}`)
      .join(" ");
  const SEEDED = "a< b<a c<b x<";

  for (const [form, entry] of Object.entries(FORMS))
    test(`${form}: no write of the key closes a loop, by any spelling of the write`, async () => {
      const base = await seeded();
      const db = base.$extends(
        extension("tree", rules({ node: entry(["parent"]) }))
      );
      const loops: Record<string, () => Promise<unknown>> = {
        "its own parent": () =>
          db.node.update({ where: { id: "a" }, data: { parentId: "a" } }),
        "under its child": () =>
          db.node.update({ where: { id: "a" }, data: { parentId: "b" } }),
        "under its grandchild": () =>
          db.node.update({ where: { id: "a" }, data: { parentId: "c" } }),
        "connected under its grandchild": () =>
          db.node.update({
            where: { id: "a" },
            data: { parent: { connect: { id: "c" } } },
          }),
        "many rows under one of them": () =>
          db.node.updateMany({
            where: { id: { in: ["a", "x"] } },
            data: { parentId: "c" },
          }),
        "an upsert that finds its row": () =>
          db.node.upsert({
            where: { id: "a" },
            create: { id: "a", ownerId: "alice" },
            update: { parentId: "c" },
          }),
      };
      for (const [name, loop] of Object.entries(loops)) {
        expect(await failure(loop()), name).toBeInstanceOf(ForbiddenError);
        expect(await tree(base), name).toBe(SEEDED);
      }
      // A write that closes none is taken, a key the list leaves out included.
      await db.node.update({ where: { id: "x" }, data: { parentId: "c" } });
      await db.node.update({ where: { id: "a" }, data: { mentorId: "a" } });
      expect(await tree(base)).toBe("a< b<a c<b x<c");
    });

  test("a loop closed through a relation is refused as the nested write it is: from the other end, or on the row above", async () => {
    for (const [form, entry] of Object.entries(FORMS)) {
      const base = await seeded();
      const db = base
        .$extends(
          ordering({ models: { node: { key: "rank", within: ["parentId"] } } })
        )
        .$extends(extension("tree", rules({ node: entry(["parent"]) })));
      const loops: Record<string, () => Promise<unknown>> = {
        // c takes a for child: a's key is written through c's relation.
        "a child connected": () =>
          db.node.update({
            where: { id: "c" },
            data: { children: { connect: { id: "a" } } },
          }),
        "the children set": () =>
          db.node.update({
            where: { id: "c" },
            data: { children: { set: [{ id: "a" }] } },
          }),
        "the parent's key written through the child": () =>
          db.node.update({
            where: { id: "b" },
            data: { parent: { update: { parentId: "c" } } },
          }),
      };
      for (const [name, loop] of Object.entries(loops)) {
        const refused = await failure(loop());
        expect(refused.message, `${form}: ${name}`).toMatch(NESTED_REFUSAL);
        expect(await tree(base), `${form}: ${name}`).toBe(SEEDED);
      }
      // A move to the list of its own grandchild's children writes no row.
      await failure(
        db.node.move({ where: { id: "a" }, to: { parentId: "c" } })
      );
      expect(await tree(base), form).toBe(SEEDED);
    }
  });

  test("a list that is none, or names another relation, is refused where it is admitted: with the extension, or at the first read of a lazy entry", async () => {
    const MALFORMED: readonly (readonly [unknown, string])[] = [
      [
        "parent",
        'Extension "tree" rule.node.acyclic: lists relations, or is a function returning them.',
      ],
      [
        ["children"],
        'Extension "tree" rule.node.acyclic.children: names no to-one relation of the model to itself holding its key.',
      ],
      [
        ["parent", "missing"],
        'Extension "tree" rule.node.acyclic.missing: names no to-one relation of the model to itself holding its key.',
      ],
    ];
    for (const [acyclic, message] of MALFORMED) {
      const base = await seeded();
      const eager = refusal(() =>
        base.$extends(extension("tree", rules({ node: open_(acyclic) })))
      );
      expect(eager).toBeInstanceOf(ClientInitializationError);
      expect(eager.message).toBe(message);
      const later = base.$extends(
        extension("tree", rules({ node: lazy(() => open_(acyclic)) }))
      );
      for (let attempt = 0; attempt < 2; attempt++)
        expect((await failure(later.node.findMany())).message).toBe(message);
    }
  });

  test("a function's list is read and refused only by an update that writes a self key, each time", async () => {
    for (const within of ["an entry", "a lazy entry"]) {
      const base = await seeded();
      let read = 0;
      const entry = open_(() => {
        read++;
        return ["children"];
      });
      const db = base.$extends(
        extension(
          "tree",
          rules({ node: within === "an entry" ? entry : lazy(() => entry) })
        )
      );
      expect(ids(await db.node.findMany())).toEqual(["a", "b", "c", "x"]);
      await db.node.update({ where: { id: "x" }, data: { ownerId: "bob" } });
      expect(read, within).toBe(0);
      for (let attempt = 1; attempt < 3; attempt++) {
        const refused = await failure(
          db.node.update({ where: { id: "x" }, data: { mentorId: "a" } })
        );
        expect(refused, within).toBeInstanceOf(ClientInitializationError);
        expect(refused.message, within).toBe(
          'Extension "tree" rule.node.acyclic.children: names no to-one relation of the model to itself holding its key.'
        );
        expect(read, within).toBe(attempt);
      }
      expect(await tree(base), within).toBe(SEEDED);
    }
  });
});

describe("a gate never hides a field a key, a unique constraint or a foreign key reads", () => {
  const owner = s.model({
    id: s.string().id(),
    accounts: s.toMany(() => account),
  });
  const region = s
    .model({
      zone: s.string(),
      code: s.string(),
      accounts: s.toMany(() => account),
    })
    .id(["zone", "code"]);
  const alpha = s.model({ id: s.string().id() });
  const beta = s.model({ id: s.string().id() });
  const account = s
    .model({
      id: s.string().id(),
      email: s.string().unique(),
      slug: s.string(),
      tenant: s.string(),
      ownerId: s.string(),
      zone: s.string().nullable(),
      code: s.string().nullable(),
      name: s.string(),
      owner: s
        .toOne(() => owner)
        .fields("ownerId")
        .references("id"),
      region: s
        .toOne(() => region)
        .fields("zone", "code")
        .references("zone", "code"),
      subject: s.toOne({ alpha: () => alpha, beta: () => beta }),
    })
    .unique(["tenant", "slug"]);
  const membership = s
    .model({ orgId: s.string(), userId: s.string(), role: s.string() })
    .id(["orgId", "userId"]);
  const schema = { owner, region, alpha, beta, account, membership };
  const gated = (model: string, field: string) =>
    extension(
      "gates",
      rules({ [model]: { read: { fields: { [field]: gate({}) } } } })
    );

  test("a key, each member of a compound key or unique, a unique field and each field of a foreign key are refused; a relation is no scalar", async () => {
    const base = await open(schema);
    const KEYS: readonly (readonly [string, string])[] = [
      ["account", "id"],
      ["account", "email"],
      ["account", "tenant"],
      ["account", "slug"],
      ["account", "ownerId"],
      ["account", "zone"],
      ["account", "code"],
      ["membership", "orgId"],
      ["membership", "userId"],
      ["region", "zone"],
      ["region", "code"],
    ];
    for (const [model, field] of KEYS) {
      const refused = refusal(() => base.$extends(gated(model, field)));
      expect(refused, `${model}.${field}`).toBeInstanceOf(
        ClientInitializationError
      );
      expect(refused.message, `${model}.${field}`).toBe(
        `Extension "gates" rule.${model}: read.fields.${field} names a key, a unique or a foreign key field.`
      );
    }
    for (const relation of ["owner", "region", "subject", "missing"])
      expect(
        refusal(() => base.$extends(gated("account", relation))).message,
        relation
      ).toBe(
        `Extension "gates" rule.account: read.fields.${relation} names no scalar of the model.`
      );
    for (const [model, field] of [
      ["account", "name"],
      ["membership", "role"],
    ] as const)
      base.$extends(gated(model, field));
  });
});

describe("what a rule prepares is read-only by its type: nothing a caller or an author holds reaches it", () => {
  const doc = s.model({
    id: s.string().id(),
    ownerId: s.string(),
    secret: s.string(),
    parentId: s.string().nullable(),
    parent: s
      .toOne(() => doc)
      .fields("parentId")
      .references("id")
      .name("tree"),
    children: s.toMany(() => doc).name("tree"),
  });
  const seeded = async () => {
    const base = await open({ doc });
    await base.doc.createMany({
      data: [
        { id: "d1", ownerId: "alice", secret: "s1" },
        { id: "d2", ownerId: "bob", secret: "s2", parentId: "d1" },
      ],
    });
    return base;
  };
  /** What the author wrote, kept to be changed after the extension is applied. */
  const written = () => {
    const mine = { ownerId: arg("user") };
    const access = { mine: { ownerId: arg("user") }, all: {} };
    const acyclic = ["parent"];
    const root: unknown[] = [{}];
    const entry = {
      root,
      read: {
        where: {},
        fields: { secret: gate(mine) },
        select: { $access: facts(access) },
      },
      create: { check: check(mine) },
      update: { where: only(mine), check: check(mine) },
      delete: { where: only(nothing) },
      acyclic,
    };
    const definition = extension(
      "policy",
      extArgs({ user: accepts(v.string()) }),
      rules({ doc: entry })
    );
    return { mine, access, acyclic, root, entry, definition };
  };
  /** Every answer of a client that this file's hostile calls could change. */
  const answers = async (db: Loose) => {
    const out: unknown[] = [];
    for (const user of ["alice", "bob"]) {
      out.push(
        await db.doc.findMany({ user, orderBy: { id: "asc" } }),
        await db.doc.findMany({
          user,
          orderBy: { id: "asc" },
          select: { id: true, $access: true },
        }),
        await db.doc.findMany({
          user,
          orderBy: { id: "asc" },
          select: { id: true, $access: ["mine"] },
          include: undefined,
        }),
        await db.doc.findMany({
          user,
          where: { secret: "s2" },
          select: { id: true },
        }),
        await db.doc.findMany({
          user,
          orderBy: { id: "asc" },
          select: {
            id: true,
            children: { select: { id: true, $access: true } },
          },
        }),
        (
          await failure(
            db.doc.findMany({ user, select: { id: true, secret: true } })
          )
        ).message,
        (
          await failure(
            db.doc.update({
              where: { id: user === "alice" ? "d2" : "d1" },
              data: { secret: "taken" },
              user,
            })
          )
        ).constructor.name,
        (
          await failure(
            db.doc.update({
              where: { id: user === "alice" ? "d1" : "d2" },
              data: { parentId: user === "alice" ? "d2" : "d2" },
              user,
            })
          )
        ).constructor.name
      );
    }
    return JSON.parse(JSON.stringify(out)) as unknown;
  };
  /** Everything reachable from `value` changed in place, as far as it lets itself be. */
  const spoil = (value: unknown, seen = new Set<unknown>()): void => {
    if (value === null || typeof value !== "object" || seen.has(value)) return;
    seen.add(value);
    for (const key of Object.keys(value)) {
      const held = (value as Row)[key];
      spoil(held, seen);
      try {
        if (typeof held === "boolean") (value as Row)[key] = !held;
        else if (typeof held === "string") (value as Row)[key] = "spoiled";
      } catch {
        // Frozen: what it was written to protect.
      }
    }
    try {
      if (Array.isArray(value)) value.push("all", "parent", "children");
      else (value as Row).spoiled = true;
    } catch {
      // Frozen.
    }
  };

  test("a caller that changes the rows, the facts and the arguments of its calls changes no later answer, on its client or another", async () => {
    const base = await seeded();
    const { definition } = written();
    const control = await answers(base.$extends(written().definition));
    const db = base.$extends(definition);
    const twin = base.$extends(definition);
    expect(await answers(db)).toEqual(control);
    for (const user of ["alice", "bob"])
      for (const select of [
        undefined,
        { id: true, $access: true },
        { id: true, $access: ["mine", "all"] },
        { id: true, children: { select: { id: true, $access: ["all"] } } },
      ]) {
        const args = {
          user,
          orderBy: { id: "asc" },
          ...(select && { select }),
        };
        const rows = await db.doc.findMany(args);
        spoil(rows);
        spoil(args);
      }
    expect(await answers(db)).toEqual(control);
    expect(await answers(twin)).toEqual(control);
    expect(await answers(base.$extends(definition))).toEqual(control);
  });

  test("an author that changes what it wrote once the extension is applied changes what 8edb90997 lets it change, and no more", async () => {
    const base = await seeded();
    const control = await answers(base.$extends(written().definition));
    const held = written();
    const db = base.$extends(held.definition);
    expect(await answers(db)).toEqual(control);
    // The predicates and the names a word was given, and the filter list.
    spoil(held.mine);
    spoil(held.access);
    held.root.push({ id: "none" });
    spoil(held.entry.read);
    spoil(held.entry.update);
    expect(await answers(db)).toEqual(control);
    expect(await answers(base.$extends(held.definition))).toEqual(control);
  });
});

describe("a rule that reads its call in a link's condition alone", () => {
  const tag = s.model({
    id: s.string().id(),
    posts: s.toMany(() => post).name("tagging"),
  });
  const postTag = s
    .model({
      postId: s.string(),
      tagId: s.string(),
      role: s.string(),
      post: s
        .toOne(() => post)
        .fields("postId")
        .references("id"),
      tag: s
        .toOne(() => tag)
        .fields("tagId")
        .references("id"),
    })
    .id(["postId", "tagId"]);
  const post = s.model({
    id: s.string().id(),
    tags: s
      .toMany(() => tag)
      .name("tagging")
      .through(() => postTag)
      .source("post")
      .target("tag"),
  });

  test("an absent argument drops the layer, or closes it where it is required: the link's parameter is one of the layer's", async () => {
    const base = await open({ tag, postTag, post });
    await base.tag.create({ data: { id: "t" } });
    await base.post.createMany({ data: [{ id: "p1" }, { id: "p2" }] });
    await base.postTag.createMany({
      data: [
        { postId: "p1", tagId: "t", role: "lead" },
        { postId: "p2", tagId: "t", role: "guest" },
      ],
    });
    const linked = { tags: { some: { $through: { role: arg("role") } } } };
    const through = async (db: Loose, args: object = {}) =>
      ids(
        (
          (await db.tag.findMany({
            include: { posts: true },
            ...args,
          })) as Row[]
        ).flatMap((row) => row.posts as Row[])
      );
    const optional = base.$extends(
      extension(
        "links",
        extArgs({ role: accepts(v.string()) }),
        rules({ post: { read: { where: linked } } })
      )
    );
    expect(ids(await optional.post.findMany({ role: "lead" }))).toEqual(["p1"]);
    expect(ids(await optional.post.findMany())).toEqual(["p1", "p2"]);
    expect(await through(optional, { role: "guest" })).toEqual(["p2"]);
    expect(await through(optional)).toEqual(["p1", "p2"]);
    // Required on `post` alone: a call on `tag` may leave it out.
    const required = base.$extends(
      extension(
        "links",
        extArgs({ role: accepts(v.string()).required(["post"]) }),
        rules({ post: { read: { where: linked } } })
      )
    );
    expect(ids(await required.post.findMany({ role: "guest" }))).toEqual([
      "p2",
    ]);
    expect(await through(required, { role: "lead" })).toEqual(["p1"]);
    expect(await through(required)).toEqual([]);
  });
});
