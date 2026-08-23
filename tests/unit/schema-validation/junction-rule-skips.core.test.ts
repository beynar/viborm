import { hydrateSchemaNames, s } from "@src/schema";
import { validateSchema } from "@src/schema/validation";
import { describe, expect, it } from "vitest";

function codes(result: ReturnType<typeof validateSchema>): string[] {
  return result.errors.map((issue) => issue.code);
}

/**
 * NOTHING IS DEFERRED ANY MORE.
 *
 * This suite used to pin three deliberate SILENT SKIPS: a junction whose target
 * getter resolved to nothing, a pair whose two endpoints disagreed about the
 * table, and a junction endpoint with no row key were each waved through by
 * definition validation and refused later — by the serializer or the engine
 * binder, each with its own wording, each after the caller had already been told
 * the schema was fine.
 *
 * Plan §6.1/§7.3 delete that deferral: the definition gate publishes a complete
 * trusted index or no index at all, and "no query or migration is allowed to
 * guess an edge or trust an unchecked field name". So the three shapes below are
 * the SAME three schemas, and each one is now a definition error — the pin is
 * that the deferral is gone, not that the code changed.
 */
describe("junction shapes that used to be deferred", () => {
  it("refuses a target getter that resolves to no model", () => {
    const orphan = s.model({
      id: s.string().id(),
      ghosts: s.toMany(() => undefined),
    });

    const result = validateSchema({ orphan });

    expect(result.valid).toBe(false);
    expect(codes(result)).toContain("R006");
  });

  it("refuses a junction configured from both endpoints", () => {
    // HEAD reconciled the two declarations and swallowed the disagreement here,
    // leaving the serializer and the binder to refuse it in their own words.
    // One physical junction now has one configuration owner (§9.4).
    const post = s.model({
      id: s.string().id(),
      tags: s.toMany(() => tag).through("posts_tags"),
    });
    const tag = s.model({
      id: s.string().id(),
      posts: s.toMany(() => post).through("tags_posts"),
    });
    const schema = { post, tag };
    hydrateSchemaNames(schema);

    const result = validateSchema(schema);

    expect(result.valid).toBe(false);
    expect(codes(result)).toEqual(["R011"]);
  });

  it("refuses a junction endpoint that has no row key to expand", () => {
    // Both skip directions ran here: `keyless.others` had no source row key and
    // `keyed.keyless` had no target row key. A junction side without a complete
    // row key has no columns, so the pair has no physical membership at all.
    const keyless = s.model({
      label: s.string(),
      others: s.toMany(() => keyed),
    });
    const keyed = s.model({
      id: s.string().id(),
      keyless: s.toMany(() => keyless),
    });

    const result = validateSchema({ keyless, keyed });

    expect(result.valid).toBe(false);
    expect(codes(result)).toContain("JT002");
  });
});
