import { ClientInitializationError } from "@errors";
import { defineExtension, defineFilters } from "@extensions/define";
import { normalizeExtensionDefinition } from "@extensions/definition";
import { s } from "@schema";
import { createSchemaRegistry } from "@validation/builder";
import { expect, test } from "vitest";

const schema = { post: s.model({ id: s.string().id() }) };
const rows = {
  control: "visibility",
  default: "visible",
  models: { post: { visible: { root: { id: "one" } } } },
};

// The order of these tests is the contract: nothing has brought what reads
// `rows` when the first one runs, nor what reads `verbs` when the second does.
test("a plain object that declares rows is refused until something brings what reads them", () => {
  const registry = createSchemaRegistry(schema);
  expect(() =>
    normalizeExtensionDefinition({ name: "filter", rows }, schema, registry)
  ).toThrow(ClientInitializationError);
  expect(() =>
    normalizeExtensionDefinition({ name: "filter", rows }, schema, registry)
  ).toThrow("must be built with defineExtension()");
  // A definition that declares none of them needs nothing brought.
  expect(
    normalizeExtensionDefinition({ name: "plain" }, schema, registry).name
  ).toBe("plain");
});

test("defineFilters() brings what reads rows but not what reads verbs and confinements, which defineExtension() brings", () => {
  const registry = createSchemaRegistry(schema);
  const filtered = defineFilters({ name: "filter", rows });
  expect(
    normalizeExtensionDefinition(filtered, schema, registry).rows?.models.post
      ?.visible?.root
  ).toEqual({ id: { equals: "one" } });
  const bound = defineFilters<typeof schema>();
  expect(bound({ name: "bound", rows }).name).toBe("bound");
  const judged = [
    { verbs: { post: { predicates: {} } } },
    { confine: { post: { id: "one" } } },
  ].map((member) => ({ name: "judged", rows: { ...rows, ...member } }));
  for (const definition of judged)
    expect(() =>
      normalizeExtensionDefinition(definition, schema, registry)
    ).toThrow("must be built with defineExtension()");
  defineExtension();
  for (const definition of judged)
    expect(
      normalizeExtensionDefinition(definition, schema, registry).rows
    ).toBeDefined();
});

test("defineExtension() brings what reads rows, for every later definition", () => {
  const registry = createSchemaRegistry(schema);
  const built = defineExtension({ name: "filter", rows });
  expect(
    normalizeExtensionDefinition(built, schema, registry).rows?.models.post
      ?.visible?.root
  ).toEqual({ id: { equals: "one" } });
});
