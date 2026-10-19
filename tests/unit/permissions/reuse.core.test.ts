import { s } from "@schema";
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
      { actor, models: { post: { read: true, operations: { list: "read" } } } },
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
