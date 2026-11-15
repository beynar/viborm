import type { Schema } from "@client/types";
import { createClient } from "@drivers/sqlite3";
import { ClientInitializationError } from "@errors";
import { s } from "@schema";
import { arg, args, bound, extension, oneOf, rule, when } from "@src/index";
import { appendExtension } from "@tests/fixtures/extension-chain";
import { v } from "@validation";
import { expect, test } from "vitest";

/** The admitted rule layers `value` puts on a chain over `schema`. */
const rulesOf = (value: unknown, schema: Schema) =>
  appendExtension(undefined, value, schema).rules ?? [];

test("a rule is admitted once per schema: every application over it reuses the admitted layer", () => {
  const schema = { post: s.model({ id: s.string().id() }) };
  const value = extension("filter", rule({ post: { root: { id: "one" } } }));
  const [first] = rulesOf(value, schema);
  expect(first).toBeDefined();
  expect(rulesOf(value, schema)[0]).toBe(first);
});

test("a declaration changed after it was applied is not read again; a field's own schema reads it at each application", () => {
  const schema = { post: s.model({ id: s.string().id() }) };
  const predicate = { id: "one" };
  const value = extension("filter", rule({ post: { root: predicate } }));
  const [first] = rulesOf(value, schema);
  predicate.id = "two";
  const [second] = rulesOf(value, schema);
  expect(second).toBe(first);
  expect(second?.models.post?.root).toEqual({ id: { equals: "one" } });
  const custom = {
    post: s.model({
      id: s.string().id(),
      value: s.string().schema(v.string()),
    }),
  };
  const own = extension("custom", rule({ post: { root: { id: "one" } } }));
  const [once] = rulesOf(own, custom);
  expect(rulesOf(own, custom)[0]).not.toBe(once);
});

test("an edited schema, prepared again, and invalid predicates never inherit an earlier admission", () => {
  const schema: Schema = { post: s.model({ id: s.string().id() }) };
  const value = extension("filter", rule({ post: { root: { id: "one" } } }));
  const [first] = rulesOf(value, schema);
  schema.post = s.model({ id: s.string().id() });
  expect(rulesOf(value, schema)[0]).not.toBe(first);
  for (const name of ["first", "second"]) {
    const invalid = extension(
      name,
      // A field the types refuse: applied anyway, as JavaScript would.
      rule({ post: { root: { misspelled: true } } } as never)
    );
    expect(() => rulesOf(invalid, schema)).toThrow(ClientInitializationError);
    expect(() => rulesOf(invalid, schema)).toThrow(name);
  }
});

test("a client created per request applies one declaration without reading its predicates again", async () => {
  const schema = { post: s.model({ id: s.string().id() }) };
  let reads = 0;
  const predicate = {
    get id() {
      reads++;
      return "one";
    },
  };
  const definition = extension(
    "filter",
    args({ visibility: oneOf("visible").default("visible") }),
    rule({ post: { root: when(arg("visibility"), "visible", predicate) } })
  );
  const counts: number[] = [];
  for (let request = 0; request < 3; request++) {
    const client = createClient({ schema, dataDir: ":memory:" });
    try {
      client.$extends(definition);
    } finally {
      await client.$disconnect();
    }
    counts.push(reads);
  }
  expect(counts[0]).toBeGreaterThan(0);
  expect(counts).toEqual([counts[0], counts[0], counts[0]]);
});

test("cached row references are checked against each receiving chain", () => {
  const base = createClient({
    schema: { post: s.model({ id: s.string().id() }) },
    dataDir: ":memory:",
  });
  const tenant = arg("tenant");
  const definition = extension(
    "filter",
    rule({ post: { root: { id: tenant } } })
  );
  const scoped = base.$extends(
    extension("tenant", args({ tenant: bound(v.string()) }))
  );
  expect(() => scoped.$extends(definition)).not.toThrow();
  expect(() => scoped.$extends(definition)).not.toThrow();
  expect(() => base.$extends(definition)).toThrow(
    'references undeclared argument "tenant"'
  );
});
