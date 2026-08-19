import { hydrateSchemaNames, s } from "@src/schema";
import { validateSchema } from "@src/schema/validation";
import { describe, expect, it } from "vitest";

function codes(result: ReturnType<typeof validateSchema>): string[] {
  return result.errors.map((issue) => issue.code);
}

// Junction rules never guess at half-resolvable configuration: a pair the
// helpers cannot fully resolve is skipped silently here and refused later by
// the consumer that needs it (the serializer and the engine binder each carry
// their own no-primary-key wording). These tests pin the two silent-skip
// gates so the deferral stays deliberate.
describe("junction rule silent skips", () => {
  it("skips junction physical-name validation for a many-to-many whose getter resolves to no model", () => {
    // Simulates a broken target reference (e.g. an import that resolved to
    // undefined). The getter returns no model, so junction rules must skip
    // the relation instead of probing physical names against nothing.
    const orphan = s.model({
      id: s.string().id(),
      ghosts: s.manyToMany(() => undefined),
    });

    const result = validateSchema({ orphan });

    expect(codes(result)).not.toContain("JT002");
    expect(codes(result)).not.toContain("JT003");
  });

  it("stays silent on junction reconciliation failures the helpers refuse at build time", () => {
    // Validating a hydrated schema is a real flow (`push` validates
    // `client.$schema`, whose relation sources are bound), and only there
    // can pair reconciliation fire inside the junction probe. This pair
    // disagrees on .through(), so getJunctionTableName throws a plain Error
    // (not JunctionPhysicalNameError). Junction rules swallow it:
    // reconciliation refusals keep their own wording at the serializer and
    // the engine binder, and never surface as JT codes.
    const post = s.model({
      id: s.string().id(),
      tags: s.manyToMany(() => tag).through("posts_tags"),
    });
    const tag = s.model({
      id: s.string().id(),
      posts: s.manyToMany(() => post).through("tags_posts"),
    });
    const schema = { post, tag };
    hydrateSchemaNames(schema);

    const result = validateSchema(schema);

    expect(codes(result)).not.toContain("JT002");
    expect(codes(result)).not.toContain("JT003");
  });

  it("reserves no junction physical names when either junction endpoint has no row key", () => {
    // Schema validation does not require a primary key on ordinary models;
    // the serializer refuses this pair with its own wording instead. Both
    // skip directions run: keyless.others has no source row key, and
    // keyed.keyless has no target row key.
    const keyless = s.model({
      label: s.string(),
      others: s.manyToMany(() => keyed),
    });
    const keyed = s.model({
      id: s.string().id(),
      keyless: s.manyToMany(() => keyless),
    });

    const result = validateSchema({ keyless, keyed });

    expect(codes(result)).not.toContain("JT002");
    expect(codes(result)).not.toContain("JT003");
    expect(codes(result)).not.toContain("P008");
  });
});
