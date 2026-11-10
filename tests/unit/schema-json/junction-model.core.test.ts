/**
 * A declared model as the junction, in the schema document: `junction.model`
 * names it by schema key, beside the `source` / `target` that name its to-ones.
 */

import { ValidationError } from "@errors";
import { s } from "@schema";
import { parseSchema, serializeSchema } from "@schema/json";
import { describe, expect, it } from "vitest";

const NEVER_BOTH = /never both/;
const NOT_IN_THE_RECORD = /J006/;

const declared = () => {
  const link = s
    .model({
      childId: s.string(),
      parentId: s.string(),
      child: s
        .toOne(() => node)
        .fields("childId")
        .references("id"),
      parent: s
        .toOne(() => node)
        .fields("parentId")
        .references("id"),
    })
    .id(["childId", "parentId"]);
  const node = s.model({
    id: s.string().id(),
    parents: s
      .toMany(() => node)
      .name("graph")
      .through(() => link)
      .source("child")
      .target("parent"),
    children: s.toMany(() => node).name("graph"),
  });
  return { link, node };
};

const refusal = (input: object): ValidationError => {
  try {
    parseSchema(input);
  } catch (thrown) {
    if (thrown instanceof ValidationError) return thrown;
    throw thrown;
  }
  throw new Error("parseSchema accepted a document it must refuse");
};

describe("the schema document", () => {
  it("writes the model by its schema key, and reads it back unchanged", () => {
    const document = serializeSchema(declared());
    const node = document.models.node!.fields.parents as unknown as {
      junction: Record<string, string>;
    };
    expect(node.junction).toEqual({
      model: "link",
      source: "child",
      target: "parent",
    });
    expect(serializeSchema(parseSchema(document))).toEqual(document);
  });

  it("settles to the model the document names", () => {
    const schema = parseSchema(serializeSchema(declared())) as Record<
      string,
      any
    >;
    const state = schema.node["~"].state.relations.parents["~"];
    expect(state.settleJunctionModel()).toBe(schema.link);
  });

  it("refuses a model it does not declare, and a table beside a model", () => {
    const document = serializeSchema(declared()) as any;
    document.models.node.fields.parents.junction.model = "absent";
    expect(refusal(document).issues.map((issue) => issue.path)).toContain(
      "/models/node/fields/parents/junction/model"
    );
    const both = serializeSchema(declared()) as any;
    both.models.node.fields.parents.junction.table = "links";
    expect(refusal(both).message).toMatch(NEVER_BOTH);
  });

  it("a through model outside the record is the serializer's J006", () => {
    const stray = s.model({ id: s.string().id() });
    const node = s.model({
      id: s.string().id(),
      parents: s
        .toMany(() => node)
        .name("graph")
        .through(() => stray),
      children: s.toMany(() => node).name("graph"),
    });
    expect(() => serializeSchema({ node })).toThrow(NOT_IN_THE_RECORD);
  });
});
