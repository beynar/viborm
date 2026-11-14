import { ClientInitializationError } from "@errors";
import { appendResolvedExtension } from "@extensions/chain";
import { controlsPart } from "@extensions/controls";
import { defineExtension, defineFilters, defineWith } from "@extensions/define";
import type { ExtensionDefinitionInput } from "@extensions/definition";
import { methodsPart } from "@extensions/methods";
import { filtersPart } from "@extensions/rows";
import { s } from "@schema";
import { expect, test } from "vitest";

const schema = { post: s.model({ id: s.string().id() }) };
const rows = {
  control: "visibility",
  default: "visible",
  models: { post: { visible: { root: { id: "one" } } } },
};
const judged = [
  { verbs: { post: { predicates: {} } } },
  { confine: { post: { id: "one" } } },
].map((member) => ({ name: "judged", rows: { ...rows, ...member } }));

const applied = (definition: ExtensionDefinitionInput) =>
  appendResolvedExtension(undefined, definition, schema);

test("what is built with the filters part admits its rows where it is applied", () => {
  const chain = applied(defineWith(filtersPart)({ name: "filter", rows }));
  expect(chain.rows?.[0]?.models.post?.visible?.root).toEqual({
    id: { equals: "one" },
  });
  expect(
    chain.callRows?.call("post", undefined).domain.root.get("post")
  ).toEqual([{ id: { equals: "one" } }]);
});

test("rows built without the filters part are refused, not ignored", () => {
  expect(() =>
    applied(defineWith(controlsPart, methodsPart)({ name: "filter", rows }))
  ).toThrow("declares rows, which none of the parts it was built with reads");
});

test("verbs and confinements built without what reads them are refused, not read as filters alone", () => {
  for (const definition of judged) {
    expect(() => applied(defineWith(filtersPart)(definition))).toThrow(
      ClientInitializationError
    );
    expect(() => applied(defineFilters(definition))).toThrow(
      "must be built with defineExtension()"
    );
    expect(applied(defineExtension(definition)).rows).toHaveLength(1);
  }
});
