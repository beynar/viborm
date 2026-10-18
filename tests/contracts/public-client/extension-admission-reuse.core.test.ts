import { createClient } from "@drivers/sqlite3";
import { ClientInitializationError } from "@errors";
import { normalizeExtensionDefinition } from "@extensions/definition";
import { s } from "@schema";
import { v } from "@validation";
import { createSchemaRegistry } from "@validation/builder";
import { expect, test } from "vitest";

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

test("mutable predicates, frozen opaque leaves, and custom schemas are read afresh", () => {
  const schema = { post: s.model({ id: s.string().id(), at: s.dateTime() }) };
  const registry = createSchemaRegistry(schema);
  const predicate = { id: "one" };
  const definition = { name: "filter", rows: frozenRows(predicate) };
  const first = normalizeExtensionDefinition(definition, schema, registry);
  predicate.id = "two";
  const second = normalizeExtensionDefinition(definition, schema, registry);
  expect(second.rows).not.toBe(first.rows);
  expect(second.rows?.models.post?.visible?.root).toEqual({
    id: { equals: "two" },
  });
  const instant = Object.freeze(new Date("2025-01-01T00:00:00Z"));
  const dated = {
    name: "dated",
    rows: frozenRows(Object.freeze({ at: instant })),
  };
  const earlier = normalizeExtensionDefinition(dated, schema, registry);
  instant.setUTCFullYear(2026);
  expect(normalizeExtensionDefinition(dated, schema, registry).rows).not.toBe(
    earlier.rows
  );
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

test("schema edits and invalid predicates never inherit an earlier admission", () => {
  const schema = { post: s.model({ id: s.string().id() }) };
  const registry = createSchemaRegistry(schema);
  const definition = {
    name: "filter",
    rows: frozenRows(Object.freeze({ id: "one" })),
  };
  const first = normalizeExtensionDefinition(definition, schema, registry);
  schema.post = s.model({ id: s.string().id() });
  expect(
    normalizeExtensionDefinition(definition, schema, registry).rows
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

test("a frozen sparse array with inherited values is not an immutable predicate", () => {
  const schema = { post: s.model({ id: s.string().id() }) };
  const registry = createSchemaRegistry(schema);
  const prototype = Object.create(Array.prototype);
  prototype[0] = "one";
  const values = new Array<string>(1);
  Object.setPrototypeOf(values, prototype);
  Object.freeze(values);
  const definition = {
    name: "filter",
    rows: frozenRows(Object.freeze({ id: Object.freeze({ in: values }) })),
  };
  const first = normalizeExtensionDefinition(definition, schema, registry);
  prototype[0] = "two";
  const next = normalizeExtensionDefinition(definition, schema, registry);
  expect(next.rows).not.toBe(first.rows);
  expect(next.rows?.models.post?.visible?.root).toEqual({
    id: { in: ["two"] },
  });
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
