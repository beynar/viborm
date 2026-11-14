import type { Schema } from "@client/types";
import { createClient } from "@drivers/sqlite3";
import { ClientInitializationError } from "@errors";
import { admitRows } from "@extensions/admission";
import type { RowsContribution } from "@extensions/controls";
import { s } from "@schema";
import { arg, args, bound, extension, oneOf, rule, when } from "@src/index";
import { v } from "@validation";
import { createSchemaRegistry } from "@validation/builder";
import type { SchemaRegistryLookup } from "@validation/types";
import { expect, test } from "vitest";

/** A definition's `rows` as applying it admits them. */
const admitted = (
  definition: { readonly name: string; readonly rows: RowsContribution },
  schema: Schema,
  registry: SchemaRegistryLookup<Schema>
) => admitRows(definition.rows, schema, definition.name, registry);

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
  const first = admitted(definition, schema, registry);
  expect(admitted(definition, schema, registry)).toBe(first);
  expect(admitted(definition, schema, createSchemaRegistry(schema))).not.toBe(
    first
  );
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
  const first = admitted(definition, schema, registry);
  predicate.id = "two";
  const second = admitted(definition, schema, registry);
  expect(second).toBe(first);
  expect(second.models.post?.visible?.root).toEqual({
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
  const once = admitted(immutable, custom, customRegistry);
  expect(admitted(immutable, custom, customRegistry)).not.toBe(once);
});

test("an edited schema, prepared again, and invalid predicates never inherit an earlier admission", () => {
  const schema = { post: s.model({ id: s.string().id() }) };
  const registry = createSchemaRegistry(schema);
  const definition = {
    name: "filter",
    rows: frozenRows(Object.freeze({ id: "one" })),
  };
  const first = admitted(definition, schema, registry);
  schema.post = s.model({ id: s.string().id() });
  expect(admitted(definition, schema, createSchemaRegistry(schema))).not.toBe(
    first
  );
  const invalid = frozenRows(Object.freeze({ misspelled: true }));
  for (const name of ["first", "second"]) {
    expect(() => admitted({ name, rows: invalid }, schema, registry)).toThrow(
      ClientInitializationError
    );
    expect(() => admitted({ name, rows: invalid }, schema, registry)).toThrow(
      name
    );
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
    'references undeclared control "tenant"'
  );
});
