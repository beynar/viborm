import { createClient } from "@drivers/sqlite3";
import { ClientInitializationError } from "@errors";
import { normalizeExtensionDefinition } from "@extensions/definition";
import { withRows, withVerbs } from "@extensions/rows-runtime";
import { s } from "@schema";
import { v } from "@validation";
import { createSchemaRegistry } from "@validation/builder";
import { expect, test } from "vitest";

// These definitions are stated as plain objects: what reads their rows is brought here.
withRows();
withVerbs();

function frozenRows(predicate: Readonly<Record<string, unknown>>) {
  return Object.freeze({
    control: "visibility",
    default: "visible",
    models: Object.freeze({
      post: Object.freeze({ visible: Object.freeze({ root: predicate }) }),
    }),
  });
}

test("immutable row admission reuses facts within one registry only", () => {
  const schema = { post: s.model({ id: s.string().id() }) };
  const registry = createSchemaRegistry(schema);
  const definition = {
    name: "filter",
    rows: frozenRows(Object.freeze({ id: "one" })),
  };
  const first = normalizeExtensionDefinition(definition, schema, registry);
  expect(normalizeExtensionDefinition(definition, schema, registry).rows).toBe(
    first.rows
  );
  expect(
    normalizeExtensionDefinition(
      definition,
      schema,
      createSchemaRegistry(schema)
    ).rows
  ).not.toBe(first.rows);
});

test("a declaration changed after it was applied is not read again; a field's own schema reads it at each application", () => {
  const schema = { post: s.model({ id: s.string().id() }) };
  const registry = createSchemaRegistry(schema);
  const predicate = { id: "one" };
  const definition = {
    name: "filter",
    rows: {
      control: "visibility",
      default: "visible",
      models: { post: { visible: { root: predicate } } },
    },
  };
  const first = normalizeExtensionDefinition(definition, schema, registry);
  predicate.id = "two";
  const second = normalizeExtensionDefinition(definition, schema, registry);
  expect(second.rows).toBe(first.rows);
  expect(second.rows?.models.post?.visible?.root).toEqual({
    id: { equals: "one" },
  });
  const custom = {
    post: s.model({
      id: s.string().id(),
      value: s.string().schema(v.string()),
    }),
  };
  const customRegistry = createSchemaRegistry(custom);
  const immutable = {
    name: "custom",
    rows: frozenRows(Object.freeze({ id: "one" })),
  };
  const admitted = normalizeExtensionDefinition(
    immutable,
    custom,
    customRegistry
  );
  expect(
    normalizeExtensionDefinition(immutable, custom, customRegistry).rows
  ).not.toBe(admitted.rows);
});

test("an edited schema, prepared again, and invalid predicates never inherit an earlier admission", () => {
  const schema = { post: s.model({ id: s.string().id() }) };
  const registry = createSchemaRegistry(schema);
  const definition = {
    name: "filter",
    rows: frozenRows(Object.freeze({ id: "one" })),
  };
  const first = normalizeExtensionDefinition(definition, schema, registry);
  schema.post = s.model({ id: s.string().id() });
  expect(
    normalizeExtensionDefinition(
      definition,
      schema,
      createSchemaRegistry(schema)
    ).rows
  ).not.toBe(first.rows);
  const invalid = frozenRows(Object.freeze({ misspelled: true }));
  for (const name of ["first", "second"]) {
    expect(() =>
      normalizeExtensionDefinition({ name, rows: invalid }, schema, registry)
    ).toThrow(ClientInitializationError);
    expect(() =>
      normalizeExtensionDefinition({ name, rows: invalid }, schema, registry)
    ).toThrow(name);
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
  const definition = {
    name: "filter",
    rows: {
      control: "visibility",
      default: "visible",
      models: { post: { visible: { root: predicate } } },
    },
  };
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
  const definition = {
    name: "filter",
    rows: frozenRows(
      Object.freeze({ id: Object.freeze({ control: "tenant" }) })
    ),
  };
  const scoped = base.$extends({
    name: "tenant",
    controls: { tenant: { schema: v.string(), bound: true } },
  });
  expect(() => scoped.$extends(definition)).not.toThrow();
  expect(() => scoped.$extends(definition)).not.toThrow();
  expect(() => base.$extends(definition)).toThrow(
    'references undeclared control "tenant"'
  );
});
