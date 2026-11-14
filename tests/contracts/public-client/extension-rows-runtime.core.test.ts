import { ClientInitializationError } from "@errors";
import { defineExtension } from "@extensions/define";
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

// The order of these two tests is the contract: nothing has brought what reads
// `rows` when the first one runs.
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

test("defineExtension() brings what reads rows, for every later definition", () => {
  const registry = createSchemaRegistry(schema);
  const built = defineExtension({ name: "filter", rows });
  expect(
    normalizeExtensionDefinition(built, schema, registry).rows?.models.post
      ?.visible?.root
  ).toEqual({ id: { equals: "one" } });
});
