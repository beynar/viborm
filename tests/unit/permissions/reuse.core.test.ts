import { ClientInitializationError } from "@errors";
import { s } from "@schema";
import { createModelFieldRefs, isFieldRef } from "@schema/field-ref";
import { permissions } from "@src/permissions";
import { compilePolicy, policyCompiler } from "@src/permissions/compile";
import {
  declarationRevision,
  declarationSnapshot,
  plainFreezer,
} from "@src/permissions/reuse";
import { schema } from "@tests/package/fixtures/permissions-app/schema";
import { policy } from "@tests/types/permissions/acceptance-policy";
import { v } from "@validation";
import { expect, test } from "vitest";

test("frozen copies preserve dictionary prototypes and shared values without freezing callers", () => {
  const shared = { id: { in: ["one", "two"] } };
  Object.setPrototypeOf(shared, null);
  const declaration = { left: shared, right: shared, __proto__: null };
  Object.defineProperty(declaration, "__proto__", {
    value: "a key",
    enumerable: true,
  });

  const freeze = plainFreezer();
  const copy = freeze(declaration);
  expect(copy).toBeDefined();
  if (!copy) throw new Error("A plain declaration must have a frozen copy");
  expect(copy).not.toBe(declaration);
  expect(copy.left).toBe(copy.right);
  expect(copy.left).not.toBe(shared);
  expect(Object.getPrototypeOf(copy.left)).toBeNull();
  expect(Object.hasOwn(copy, "__proto__")).toBe(true);
  expect(Object.isFrozen(copy)).toBe(true);
  expect(Object.isFrozen(copy.left)).toBe(true);
  expect(Object.isFrozen(copy.left.id.in)).toBe(true);
  expect(Object.isFrozen(declaration)).toBe(false);
  expect(Object.isFrozen(shared)).toBe(false);
  expect(Object.isFrozen(shared.id.in)).toBe(false);
  // One copy per original across calls: predicates inlined in several
  // models stay shared, so core admits each once.
  expect(freeze({ other: shared })?.other).toBe(copy.left);

  shared.id.in.push("three");
  expect(copy.left.id.in).toEqual(["one", "two"]);
});

test("sparse and inherited arrays retain their original uncached admission path", () => {
  const sparse = new Array<string>(2);
  sparse[0] = "one";
  const inherited = ["one"];
  Object.setPrototypeOf(inherited, Object.create(Array.prototype));

  for (const values of [sparse, inherited]) {
    const declaration = { id: { in: values } };
    expect(declarationRevision([declaration], new Set())).toBeUndefined();
    expect(plainFreezer()(declaration)).toBeUndefined();
    expect(Object.isFrozen(values)).toBe(false);
  }
});

test("opaque literals and getter declarations cannot become reusable snapshots", () => {
  const cutoff = new Date("2026-01-01T00:00:00Z");
  const dated = { createdAt: { lt: cutoff } };
  expect(declarationRevision([dated], new Set())).toBeUndefined();
  expect(plainFreezer()(dated)).toBeUndefined();
  expect(Object.isFrozen(cutoff)).toBe(false);
  cutoff.setUTCFullYear(2027);
  expect(dated.createdAt.lt.getUTCFullYear()).toBe(2027);

  let reads = 0;
  const dynamic = {
    get read() {
      reads++;
      return true;
    },
  };
  expect(declarationRevision([dynamic], new Set())).toBeUndefined();
  expect(plainFreezer()(dynamic)).toBeUndefined();
  expect(reads).toBe(0);
});

test("a property replaced with a getter invalidates its previous revision", () => {
  const declaration = { read: true };
  const current = declarationRevision([declaration], new Set());
  expect(current?.()).toBe(true);
  Object.defineProperty(declaration, "read", { get: () => false });
  expect(current?.()).toBe(false);
});

test("callback-produced proxy operands are copied as they read, never frozen", () => {
  const values = new Proxy(["one"], {});
  const proxied = permissions({
    actor: v.object({ userId: v.string() }),
    models: { post: { read: () => ({ id: { in: values } }) } },
  });
  const compiled = proxied.compile({ post: s.model({ id: s.string().id() }) });

  const copy = plainFreezer()(compiled);
  expect(copy).toBeDefined();
  expect(Object.isFrozen(values)).toBe(false);
  values.push("two");
  expect(values).toEqual(["one", "two"]);
  expect(JSON.stringify(copy)).not.toContain("two");
});

test("a declaration snapshot copies plain data and keeps functions and opaque values", () => {
  const actor = v.object({ userId: v.string() });
  const rule = () => true;
  const shared = { ownerId: { actor: "userId" } };
  const config = {
    actor,
    models: { post: { read: shared, update: shared, delete: rule } },
  };
  const snapshot = declarationSnapshot(config, new Set([actor]));
  expect(snapshot).not.toBe(config);
  expect(snapshot.actor).toBe(actor);
  expect(snapshot.models.post.delete).toBe(rule);
  expect(snapshot.models.post.read).toBe(snapshot.models.post.update);
  expect(snapshot.models.post.read).toEqual(shared);
  expect(Object.isFrozen(snapshot.models.post)).toBe(true);
  expect(Object.isFrozen(config.models.post)).toBe(false);
  shared.ownerId.actor = "other";
  expect(snapshot.models.post.read.ownerId.actor).toBe("userId");
});

test("models compiled one at a time, in any order, are the policy compiled at once", () => {
  const whole = JSON.stringify(compilePolicy(policy.config, schema));
  const names = Object.keys(schema);
  for (const order of [[...names].reverse(), [...names].sort()]) {
    const compiler = policyCompiler(policy.config, schema);
    for (const name of order) compiler.model(name);
    expect(JSON.stringify(compiler.policy())).toBe(whole);
  }
});

test("a compiler checks the declaration's names when built, and a rule when its model compiles, every time", () => {
  const post = s.model({ id: s.string().id(), ownerId: s.string() });
  const note = s.model({ id: s.string().id() });
  const actor = v.object({ userId: v.string() });
  expect(() =>
    policyCompiler(
      {
        actor,
        models: { post: { read: true, operations: { list: "read" } } },
      } as never,
      { post, note }
    )
  ).toThrow("models.post.operations.list: not a configurable operation");
  expect(() =>
    policyCompiler(
      { actor, models: { post: { read: true, domains: { default: {} } } } },
      { post, note }
    )
  ).toThrow('"default" is the mode a call takes by default');
  const compiler = policyCompiler(
    {
      actor,
      models: {
        post: { read: { ownerId: { actor: "usrId" } } },
        note: { read: true },
      },
    },
    { post, note }
  );
  for (let attempt = 0; attempt < 2; attempt++)
    expect(() => compiler.model("post")).toThrow('actor path "usrId"');
  expect(compiler.model("note").read).toBe("read");
  expect(compiler.declared.post).toEqual({
    read: "read",
    modes: { read: "read" },
  });
});

test("a snapshot keeps instances and opaque values by reference and copies cycles once", () => {
  class Opaque {
    readonly value = 1;
  }
  const opaque = new Opaque();
  const cyclic: Record<string, unknown> = { opaque };
  cyclic.self = cyclic;
  const snapshot = declarationSnapshot(cyclic, new Set());
  expect(snapshot).not.toBe(cyclic);
  expect(snapshot.self).toBe(snapshot);
  expect(snapshot.opaque).toBe(opaque);
});

test("the freezer declines what is not plain data", () => {
  const freeze = plainFreezer();
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  for (const value of [
    { rule: () => true },
    { tag: Symbol("tag") },
    { [Symbol("key")]: 1 },
    cyclic,
    Object.defineProperty({}, "hidden", { value: 1, enumerable: false }),
  ])
    expect(freeze(value)).toBeUndefined();
});

test("acyclic relations are found across the models that compile, past a refused one", () => {
  const folder = s.model({
    id: s.string().id(),
    ownerId: s.string(),
    parentId: s.string().nullable(),
    parent: s
      .toOne(() => folder)
      .fields("parentId")
      .references("id")
      .name("tree"),
    children: s.toMany(() => folder).name("tree"),
  });
  const note = s.model({ id: s.string().id(), ownerId: s.string() });
  const prototypeNamed = s.model({ id: s.string().id() });
  const actor = v.object({ userId: v.string() });
  const compiler = policyCompiler(
    {
      actor,
      models: {
        folder: {
          read: {
            parent: {
              recurse: { depth: false },
              self: true,
              some: { ownerId: { actor: "userId" } },
            },
          },
        },
        note: { read: { ownerId: { actor: "usrId" } } },
        constructor: { read: true },
      },
    },
    { folder, note, constructor: prototypeNamed }
  );
  expect(compiler.acyclic("folder")).toEqual(["parent"]);
  expect(() => compiler.model("note")).toThrow('actor path "usrId"');
  // A model may be named like an Object.prototype member.
  expect(compiler.model("constructor").read).toBe("read");
  expect(() => compiler.policy()).toThrow('actor path "usrId"');
});

test("a field reference or an empty object never stands for a condition (1.3.1 read both as true)", () => {
  const post = s.model({ id: s.string().id(), views: s.int() });
  const refs = createModelFieldRefs("post", post);
  const refused = (read: unknown) => () =>
    policyCompiler(
      {
        actor: v.object({ userId: v.string() }),
        models: { post: { read } },
      } as never,
      { post }
    ).model("post");
  expect(refused({ actor: { userId: refs.views } })).toThrow(
    'tests actor path "userId" against a value that is not a literal'
  );
  expect(refused({ actor: { userId: {} } })).toThrow(
    'tests the actor at "userId" with an empty object'
  );
  expect(refused({ actor: {} })).toThrow(
    "tests the actor with an empty object"
  );
  expect(refused(refs.views)).toThrow(
    "a rule is a boolean, a where object or a function of the action"
  );
  // A same-row reference in a value position stays a reference.
  const compiled = policyCompiler(
    {
      actor: v.object({ userId: v.string() }),
      models: { post: { read: { views: { gt: refs.views } } } },
    },
    { post }
  ).model("post");
  const tokens: unknown[] = [];
  const walk = (node: unknown): void => {
    if (isFieldRef(node)) tokens.push(node);
    else if (node && typeof node === "object")
      for (const member of Object.values(node)) walk(member);
  };
  walk(compiled.predicates.read);
  expect(tokens).toEqual([refs.views]);
});

test("a rule's { $row, up } and $exists are checked where the rule is compiled", () => {
  const folder = s.model({
    id: s.string().id(),
    ownerId: s.string(),
    parentId: s.string().nullable(),
    parent: s
      .toOne(() => folder)
      .fields("parentId")
      .references("id")
      .name("tree"),
    children: s.toMany(() => folder).name("tree"),
  });
  const note = s.model({ id: s.string().id(), ownerId: s.string() });
  const compile = (read: unknown) => () =>
    policyCompiler(
      {
        actor: v.object({ userId: v.string() }),
        models: { folder: { read }, note: { read: true } },
      } as never,
      { folder, note }
    ).model("folder");
  expect(compile({ ownerId: { $row: "ownerId", up: 1 } })).toThrow(
    "reaches past the rule (0 relation bodies deep here)"
  );
  expect(
    compile({
      parent: {
        recurse: { depth: false },
        some: { ownerId: { $row: "ownerId", up: 1 } },
      },
    })
  ).toThrow("across a recursive relation to folder");
  expect(
    compile({ parent: { is: { ownerId: { $row: "owner", up: 1 } } } })
  ).toThrow('folder has no scalar field "owner"');
  expect(compile({ $exists: { note: {}, folder: {} } })).toThrow(
    "$exists names exactly one model"
  );
  // Inside an $exists body, up: 1 is the row that holds it.
  const held = compile({
    $exists: { note: { ownerId: { $row: "ownerId", up: 1 } } },
  })();
  expect(JSON.stringify(held.predicates.read)).toContain(
    '"$exists":{"note":{"ownerId":{"$row":"ownerId","up":1}}}'
  );
});

test("a write of a field a placement compares through { $row, up } is placed again", () => {
  const org = s.model({ id: s.string().id(), members: s.toMany(() => member) });
  const member = s.model({
    id: s.string().id(),
    orgId: s.string(),
    userId: s.string(),
    role: s.string(),
    org: s
      .toOne(() => org)
      .fields("orgId")
      .references("id"),
  });
  const grant = s.model({
    id: s.string().id(),
    orgId: s.string(),
    role: s.string(),
  });
  const compiled = policyCompiler(
    {
      actor: v.object({ userId: v.string() }),
      models: {
        grant: {
          read: true,
          update: true,
          create: {
            $exists: {
              member: {
                userId: { actor: "userId" },
                orgId: { $row: "orgId", up: 1 },
                role: { $row: "role", up: 1 },
              },
            },
          },
        },
      },
    },
    { org, member, grant }
  ).model("grant");
  expect(Object.keys(compiled.moves).sort()).toEqual(["orgId", "role"]);
});

test("$exists is lowered, summarised, guarded, proved and walked like a relation's body", () => {
  const folder = s.model({
    id: s.string().id(),
    ownerId: s.string(),
    parentId: s.string().nullable(),
    parent: s
      .toOne(() => folder)
      .fields("parentId")
      .references("id")
      .name("tree"),
    children: s.toMany(() => folder).name("tree"),
  });
  const note = s.model({
    id: s.string().id(),
    ownerId: s.string(),
    teamId: s.string(),
  });
  const actor = v.object({
    userId: v.string(),
    teamId: v.optional(v.string()),
  });
  const compiler = (read: unknown) =>
    policyCompiler(
      { actor, models: { folder: { read }, note: { read: true } } } as never,
      { folder, note }
    );
  const read = (rule: unknown) =>
    JSON.stringify(compiler(rule).model("folder").predicates.read);
  expect(() => compiler({ $exists: "note" }).model("folder")).toThrow(
    "$exists names exactly one model"
  );
  // A body that holds nowhere: the rule holds nowhere.
  expect(read({ $exists: { note: false } })).toBe(read(false));
  // A narrower body is absorbed by a wider one of the same model, never by
  // another model's.
  expect(
    read({
      OR: [{ $exists: { note: { ownerId: "x" } } }, { $exists: { note: {} } }],
    })
  ).not.toContain('"ownerId":"x"');
  expect(
    read({
      OR: [
        { $exists: { note: { ownerId: "x" } } },
        { $exists: { folder: {} } },
      ],
    })
  ).toContain('"ownerId":"x"');
  // An optional actor value inside a body disables only its alternative.
  expect(
    read({
      $exists: {
        note: { OR: [{ teamId: { actor: "teamId" } }, { ownerId: "x" }] },
      },
    })
  ).toContain('"path":"teamId","exists":true');
  // A body the summaries cannot read (an unknown field, refused by core when
  // admitted) keeps its rule as written.
  expect(read({ $exists: { note: { nope: 1 } } })).toContain('"nope":1');
  // A recursion inside a body keeps that relation acyclic.
  expect(
    compiler({
      $exists: {
        folder: {
          parent: { recurse: { depth: false }, some: { ownerId: "x" } },
        },
      },
    }).acyclic("folder")
  ).toEqual(["parent"]);
  // A relation filtered with a value that is not a filter is refused.
  const refs = createModelFieldRefs("folder", folder);
  expect(() => compiler({ parent: refs.ownerId }).model("folder")).toThrow(
    "filters parent with a value that is not a filter object"
  );
});

test("a placement compares the row through a to-one shorthand, or through another action's predicate it shares: both are placed again", () => {
  const user = s.model({ id: s.string().id(), orgId: s.string() });
  const post = s.model({
    id: s.string().id(),
    title: s.string(),
    orgId: s.string(),
    authorId: s.string(),
    author: s
      .toOne(() => user)
      .fields("authorId")
      .references("id"),
  });
  const sameOrg = { author: { orgId: { $row: "orgId", up: 1 } } };
  const moves = (declaration: object) =>
    Object.keys(
      policyCompiler(
        {
          actor: v.object({ userId: v.string() }),
          models: { user: { read: true }, post: declaration },
        } as never,
        { user, post }
      ).model("post").moves
    ).sort();
  expect(moves({ read: true, update: true, create: sameOrg })).toEqual([
    "authorId",
    "orgId",
  ]);
  // `manage` implies `create`: its predicate is a branch of the placement.
  expect(
    moves({
      actions: { read: [], update: ["read"], create: [], manage: ["create"] },
      read: true,
      update: true,
      create: { title: "draft" },
      manage: sameOrg,
    })
  ).toEqual(["authorId", "orgId", "title"]);
});

test("an undefined operand or relation filter is refused: it would hold for every row (1.3.1 granted them)", () => {
  const user = s.model({ id: s.string().id() });
  const post = s.model({
    id: s.string().id(),
    ownerId: s.string(),
    owner: s
      .toOne(() => user)
      .fields("ownerId")
      .references("id"),
  });
  const compile = (read: unknown) => () =>
    policyCompiler(
      {
        actor: v.object({ userId: v.string() }),
        models: { user: { read: true }, post: { read } },
      } as never,
      { user, post }
    ).model("post");
  expect(compile({ ownerId: undefined })).toThrow(
    "ownerId is compared with undefined, which holds for every row"
  );
  expect(compile(() => ({ ownerId: undefined }))).toThrow(
    "ownerId is compared with undefined"
  );
  expect(compile({ owner: undefined })).toThrow(
    "owner is filtered with undefined, which holds for every row"
  );
});

test("a rule function that throws refuses its own model, with what it threw as the cause", () => {
  const post = s.model({ id: s.string().id() });
  const note = s.model({ id: s.string().id() });
  const failure = new TypeError("no such key");
  const compiler = policyCompiler(
    {
      actor: v.object({}),
      models: {
        post: {
          read: () => {
            throw failure;
          },
        },
        note: { read: true },
      },
    },
    { post, note }
  );
  let caught: unknown;
  try {
    compiler.model("post");
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(ClientInitializationError);
  expect((caught as Error).message).toContain(
    'models.post.read: the rule function threw at "read"'
  );
  // Kept as the cause, its details redacted like any underlying error.
  expect((caught as Error).cause).toBeInstanceOf(Error);
  expect(compiler.model("note").read).toBe("read");
  expect(compiler.acyclic("note")).toEqual([]);
});
