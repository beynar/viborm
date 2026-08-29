import { s } from "@schema";
import { validateSchema } from "@schema/validation";
import { resolveSchemaOrThrow } from "@schema/validation/validator";
import { describe, expect, it } from "vitest";

const MONEY = { precision: 12, scale: 2 } as const;
const DECIMAL_DOMAIN_REPAIR_PATTERN = /same.*decimal.*precision.*scale/i;

function decimalCarrier(second: { precision: number; scale: number } = MONEY) {
  const postId = s.decimal(MONEY).id();
  const videoId = s.decimal(second).id();
  const post = s.model({ id: postId });
  const video = s.model({ id: videoId });
  const comment = s.model({
    id: s.string().id(),
    subject: s.toOne(
      { post: () => post, video: () => video },
      { values: { post: "decimal.post.v1", video: "decimal.video.v1" } }
    ),
  });
  return { schema: { post, video, comment }, postId, comment };
}

describe("decimal identities in row-held variant storage", () => {
  it("admits one exact descriptor and carries its scalar into private storage", () => {
    const { schema, postId, comment } = decimalCarrier();
    const resolution = resolveSchemaOrThrow(schema);
    const edge = resolution.get(comment)?.get("subject")?.edge;

    expect(edge?.kind).toBe("variantRowCarrier");
    if (edge?.kind !== "variantRowCarrier") {
      throw new Error("Expected a resolved row-held variant carrier.");
    }
    expect(edge.storage.idColumn.scalar).toBe(postId);
    expect(edge.storage.idColumn.scalar["~"].state.decimal).toBe(
      postId["~"].state.decimal
    );
  });

  it.each([
    ["precision", { precision: 13, scale: 2 }],
    ["scale", { precision: 12, scale: 3 }],
  ] as const)("refuses a different decimal %s with P002", (_name, second) => {
    const result = validateSchema(decimalCarrier(second).schema);
    const mismatch = result.errors.find((issue) => issue.code === "P002");

    expect(mismatch?.repair).toMatch(DECIMAL_DOMAIN_REPAIR_PATTERN);
  });

  it("keeps mixed scalar identity types under P002", () => {
    const decimal = s.model({ id: s.decimal(MONEY).id() });
    const string = s.model({ id: s.string().id() });
    const owner = s.model({
      id: s.string().id(),
      target: s.toOne({ decimal: () => decimal, string: () => string }),
    });

    expect(
      validateSchema({ decimal, string, owner }).errors.map(
        (issue) => issue.code
      )
    ).toContain("P002");
  });
});
