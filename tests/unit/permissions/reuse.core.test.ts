import { s } from "@schema";
import { permissions } from "@src/permissions";
import {
  declarationRevision,
  immutablePlainCopy,
} from "@src/permissions/reuse";
import { v } from "@validation";
import { expect, test, vi } from "vitest";

test("owned copies preserve dictionary prototypes and shared values without freezing callers", () => {
  const shared = { id: { in: ["one", "two"] } };
  Object.setPrototypeOf(shared, null);
  const declaration = { left: shared, right: shared };

  const copy = immutablePlainCopy(declaration);
  expect(copy).toBeDefined();
  if (!copy) throw new Error("A plain declaration must have an owned copy");
  expect(copy).not.toBe(declaration);
  expect(copy.left).toBe(copy.right);
  expect(copy.left).not.toBe(shared);
  expect(Object.getPrototypeOf(copy.left)).toBeNull();
  expect(Object.isFrozen(copy)).toBe(true);
  expect(Object.isFrozen(copy.left)).toBe(true);
  expect(Object.isFrozen(copy.left.id.in)).toBe(true);
  expect(Object.isFrozen(declaration)).toBe(false);
  expect(Object.isFrozen(shared)).toBe(false);
  expect(Object.isFrozen(shared.id.in)).toBe(false);

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
    expect(immutablePlainCopy(declaration)).toBeUndefined();
    expect(Object.isFrozen(values)).toBe(false);
  }
});

test("opaque literals and getter declarations cannot become reusable snapshots", () => {
  const cutoff = new Date("2026-01-01T00:00:00Z");
  const dated = { createdAt: { lt: cutoff } };
  expect(declarationRevision([dated], new Set())).toBeUndefined();
  expect(immutablePlainCopy(dated)).toBeUndefined();
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
  expect(immutablePlainCopy(dynamic)).toBeUndefined();
  expect(reads).toBe(0);
});

test("a property replaced with a getter invalidates its previous revision", () => {
  const declaration = { read: true };
  const current = declarationRevision([declaration], new Set());
  expect(current?.()).toBe(true);
  Object.defineProperty(declaration, "read", { get: () => false });
  expect(current?.()).toBe(false);
});

test("callback-produced proxy operands decline copying without failing compilation", () => {
  const values = new Proxy(["one"], {});
  const policy = permissions({
    actor: v.object({ userId: v.string() }),
    models: { post: { read: () => ({ id: { in: values } }) } },
  });
  const compiled = policy.compile({ post: s.model({ id: s.string().id() }) });

  expect(immutablePlainCopy(compiled)).toBeUndefined();
  expect(Object.isFrozen(values)).toBe(false);
  values.push("two");
  expect(values).toEqual(["one", "two"]);
});

test("unexpected cloning failures propagate instead of silently rebuilding", () => {
  const failure = new Error("clone infrastructure failed");
  const clone = vi
    .spyOn(globalThis, "structuredClone")
    .mockImplementation(() => {
      throw failure;
    });
  try {
    expect(() => immutablePlainCopy({ read: true })).toThrow(failure);
  } finally {
    clone.mockRestore();
  }
});
