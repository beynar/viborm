import { s } from "@src/schema";
import { validateSchema } from "@src/schema/validation";
import { describe, expect, it } from "vitest";

function codes(result: ReturnType<typeof validateSchema>): string[] {
  return result.errors.map((issue) => issue.code);
}

function warnings(result: ReturnType<typeof validateSchema>): string[] {
  return result.warnings.map((issue) => issue.code);
}

describe("relation definition rules", () => {
  it("reports the one-to-one inverse code", () => {
    const user = s.model({ id: s.string().id() });
    const profile = s.model({
      id: s.string().id(),
      userId: s.string().unique(),
      user: s
        .toOne(() => user)
        .fields("userId")
        .references("id"),
    });

    expect(codes(validateSchema({ user, profile }))).toContain("R002");
  });

  it("skips junction pairing when an M:N target is not registered", () => {
    const tag = s.model({ id: s.string().id() });
    const post = s.model({
      id: s.string().id(),
      tags: s.toMany(() => tag),
    });

    const result = validateSchema({ post });

    expect(codes(result)).toContain("R006");
    expect(codes(result)).not.toContain("JT004");
  });

  it("accepts junction configuration supplied on only one side", () => {
    const post = s.model({
      id: s.string().id(),
      tags: s
        .toMany(() => tag)
        .through("post_tags")
        .source("post_fk")
        .target("tag_fk"),
    });
    const tag = s.model({
      id: s.string().id(),
      posts: s.toMany(() => post),
    });

    expect(codes(validateSchema({ post, tag }))).not.toContain("JT004");
  });

  it("rejects implicit junction columns that collapse to one SQL name", () => {
    // `Post` and `post` generate the same default side token, so the two sides
    // would derive the same `${table}_${token}_fkey` constraint name.
    const upper = s.model({
      id: s.string().id(),
      peers: s.toMany(() => lower),
    });
    const lower = s.model({
      id: s.string().id(),
      peers: s.toMany(() => upper),
    });

    expect(codes(validateSchema({ Post: upper, post: lower }))).toContain(
      "JT003"
    );
  });

  it("fills in the other side of a partly configured self junction", () => {
    // HEAD refused this with JT004 because a self junction had to spell BOTH
    // side tokens explicitly. The default side token is now the endpoint FIELD
    // key (§6.4), which separates the two sides on its own, so configuring one
    // side is enough.
    const node = s.model({
      id: s.string().id(),
      parents: s.toMany(() => node).source("parent_id"),
      children: s.toMany(() => node),
    });

    expect(validateSchema({ node }).valid).toBe(true);
  });

  it("uses the shared identifier contract for junction columns", () => {
    // Two guards, one contract, split by WHO wrote the name. A DECLARED token
    // is judged by the modifier that owns it; a GENERATED one is judged where
    // it is expanded, which is the JT002 case beside this one.
    const tag = s.model({ id: s.string().id() });

    expect(() => s.toMany(() => tag).source("constructor")).toThrow(
      "valid schema identifier"
    );
  });

  it("validates expanded compound fields", () => {
    const longPrefix = "x".repeat(62);
    const post = s
      .model({
        tenant: s.string(),
        slug: s.string(),
        tags: s
          .toMany(() => tag)
          .through("post_tag")
          .source(longPrefix)
          .target("tag"),
      })
      .id(["tenant", "slug"]);
    const tag = s.model({ id: s.string().id(), posts: s.toMany(() => post) });

    expect(codes(validateSchema({ post, tag }))).toContain("JT002");
  });

  it("refuses an empty compound-side prefix where it is written", () => {
    // The token is judged by the modifier that owns it, not by the gate: an
    // empty string is not a schema identifier and never becomes state.
    expect(() =>
      s.toMany(() => s.model({ id: s.string().id() })).source("")
    ).toThrow("valid schema identifier");
  });

  it("validates generated compound-side constraint names", () => {
    const table = "j".repeat(55);
    const post = s
      .model({
        tenant: s.string(),
        slug: s.string(),
        tags: s
          .toMany(() => tag)
          .through(table)
          .source("post")
          .target("tag"),
      })
      .id(["tenant", "slug"]);
    const tag = s.model({ id: s.string().id(), posts: s.toMany(() => post) });

    expect(codes(validateSchema({ post, tag }))).toContain("JT002");
  });

  it("rejects portable collisions after positional prefix expansion", () => {
    const post = s.model({
      id: s.string().id(),
      tags: s
        .toMany(() => tag)
        .source("post_1")
        .target("Post"),
    });
    const tag = s
      .model({
        tenant: s.string(),
        code: s.string(),
        posts: s.toMany(() => post),
      })
      .id(["tenant", "code"]);

    expect(codes(validateSchema({ post, tag }))).toContain("JT003");
  });

  it("warns for unbound snake-case and camel-case polymorphic pairs", () => {
    const comment = s.model({
      id: s.string().id(),
      commentable_type: s.string(),
      commentable_id: s.string(),
      ownerType: s.string(),
      ownerId: s.string(),
    });
    const result = validateSchema({ comment });

    expect(warnings(result).filter((code) => code === "CM004")).toHaveLength(2);
  });

  it("does not warn for a type field without an ID partner", () => {
    const comment = s.model({
      id: s.string().id(),
      commentableType: s.string(),
    });

    expect(warnings(validateSchema({ comment }))).not.toContain("CM004");
  });

  it("does not warn when the matching ID belongs to a real relation", () => {
    const post = s.model({
      id: s.string().id(),
      comments: s.toMany(() => comment),
    });
    const comment = s.model({
      id: s.string().id(),
      commentableType: s.string(),
      commentableId: s.string(),
      post: s
        .toOne(() => post)
        .fields("commentableId")
        .references("id"),
    });

    expect(warnings(validateSchema({ post, comment }))).not.toContain("CM004");
  });

  it("ignores an owning one-to-one whose target is not registered", () => {
    const user = s.model({ id: s.string().id() });
    const profile = s.model({
      id: s.string().id(),
      userId: s.string().unique(),
      user: s
        .toOne(() => user)
        .fields("userId")
        .references("id"),
    });

    const result = validateSchema({ profile });

    expect(codes(result)).toContain("R006");
    expect(warnings(result)).not.toContain("CM003");
  });

  it("ignores unrelated target relations while checking one-to-one ownership", () => {
    const user = s.model({
      id: s.string().id(),
      unrelated: s.toMany(() => profile),
      profile: s.toOne(() => profile),
    });
    const profile = s.model({
      id: s.string().id(),
      userId: s.string().unique(),
      user: s
        .toOne(() => user)
        .fields("userId")
        .references("id"),
    });

    expect(warnings(validateSchema({ profile, user }))).not.toContain("CM003");
  });

  it("deduplicates the same required cycle reached through parallel edges", () => {
    const a = s.model({
      id: s.string().id(),
      b1Id: s.string(),
      b2Id: s.string(),
      b1: s
        .toOne(() => b)
        .fields("b1Id")
        .references("id")
        .name("first"),
      b2: s
        .toOne(() => b)
        .fields("b2Id")
        .references("id")
        .name("second"),
      fromB: s.toMany(() => b).name("back"),
      // The SECOND back edge. Both directions must carry two required keys, or
      // the walk reaches the cycle once and the deduplication never runs: the
      // second arrival at a node already on the stack is what this pins.
      alsoFromB: s.toMany(() => b).name("other"),
    });
    const b = s.model({
      id: s.string().id(),
      a1Id: s.string(),
      a2Id: s.string(),
      a1: s
        .toOne(() => a)
        .fields("a1Id")
        .references("id")
        .name("back"),
      a2: s
        .toOne(() => a)
        .fields("a2Id")
        .references("id")
        .name("other"),
      first: s.toMany(() => a).name("first"),
      second: s.toMany(() => a).name("second"),
    });
    const result = validateSchema({ a, b });
    const cycleCodes = codes(result).filter((code) => code === "CM002");

    // Every slot pairs, so the only refusal is the cycle itself — reported ONCE
    // even though four required edges close it.
    expect(codes(result)).toEqual(["CM002"]);
    expect(cycleCodes).toEqual(["CM002"]);
  });
});
