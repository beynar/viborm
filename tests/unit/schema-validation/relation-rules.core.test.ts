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
  it("rejects a required non-owning one-to-one with R008", () => {
    const user = s.model({
      id: s.string().id(),
      profile: s.oneToOne(() => profile),
    });
    const profile = s.model({
      id: s.string().id(),
      userId: s.string().unique(),
      user: s
        .oneToOne(() => user)
        .fields("userId")
        .references("id"),
    });

    expect(validateSchema({ user, profile }).errors).toContainEqual({
      code: "R008",
      message:
        "Non-owning one-to-one 'profile' in 'user' must call .optional() because this model stores no foreign key fields.",
      severity: "error",
      model: "user",
      relation: "profile",
    });
  });

  it("treats empty fields as non-owning and keeps fields-bearing owners required", () => {
    const target = s.model({ id: s.string().id() });
    const invalid = s.model({
      id: s.string().id(),
      target: s.oneToOne(() => target).fields(),
    });
    const valid = s.model({
      id: s.string().id(),
      targetId: s.string().unique(),
      target: s
        .oneToOne(() => target)
        .fields("targetId")
        .references("id"),
    });

    expect(codes(validateSchema({ invalid, target }))).toContain("R008");
    expect(codes(validateSchema({ valid, target }))).not.toContain("R008");
  });

  it("reports the one-to-one inverse code", () => {
    const user = s.model({ id: s.string().id() });
    const profile = s.model({
      id: s.string().id(),
      userId: s.string().unique(),
      user: s
        .oneToOne(() => user)
        .fields("userId")
        .references("id"),
    });

    expect(codes(validateSchema({ user, profile }))).toContain("R002");
  });

  it("warns when a self-relation has more than its forward/inverse pair", () => {
    const node = s.model({
      id: s.string().id(),
      parentId: s.string().nullable(),
      parent: s
        .manyToOne(() => node)
        .fields("parentId")
        .references("id")
        .optional(),
      children: s.oneToMany(() => node),
      otherChildren: s.oneToMany(() => node),
    });

    expect(warnings(validateSchema({ node }))).toContain("R007");
  });

  it("rejects a junction table disagreement before client hydration", () => {
    const post = s.model({
      id: s.string().id(),
      tags: s.manyToMany(() => tag).through("post_tags"),
    });
    const tag = s.model({
      id: s.string().id(),
      posts: s.manyToMany(() => post).through("tag_posts"),
    });

    expect(codes(validateSchema({ post, tag }))).toContain("JT004");
  });

  it("skips junction pairing when an M:N target is not registered", () => {
    const tag = s.model({ id: s.string().id() });
    const post = s.model({
      id: s.string().id(),
      tags: s.manyToMany(() => tag),
    });

    const result = validateSchema({ post });

    expect(codes(result)).toContain("R006");
    expect(codes(result)).not.toContain("JT004");
  });

  it("accepts junction configuration supplied on only one side", () => {
    const post = s.model({
      id: s.string().id(),
      tags: s
        .manyToMany(() => tag)
        .through("post_tags")
        .A("post_fk")
        .B("tag_fk"),
    });
    const tag = s.model({
      id: s.string().id(),
      posts: s.manyToMany(() => post),
    });

    expect(codes(validateSchema({ post, tag }))).not.toContain("JT004");
  });

  it("rejects implicit junction columns that collapse to one SQL name", () => {
    const upper = s.model({
      id: s.string().id(),
      peers: s.manyToMany(() => lower),
    });
    const lower = s.model({
      id: s.string().id(),
      peers: s.manyToMany(() => upper),
    });

    expect(codes(validateSchema({ Post: upper, post: lower }))).toContain(
      "JT004"
    );
  });

  it("rejects a self-junction with only its first column configured", () => {
    const node = s.model({
      id: s.string().id(),
      parents: s.manyToMany(() => node).A("parent_id"),
      children: s.manyToMany(() => node),
    });

    expect(codes(validateSchema({ node }))).toContain("JT004");
  });

  it("uses the shared identifier contract for junction columns", () => {
    const post = s.model({
      id: s.string().id(),
      tags: s
        .manyToMany(() => tag)
        .A("constructor")
        .B("tagId"),
    });
    const tag = s.model({
      id: s.string().id(),
      posts: s
        .manyToMany(() => post)
        .A("tagId")
        .B("constructor"),
    });

    expect(codes(validateSchema({ post, tag }))).toContain("JT002");
  });

  it("validates expanded compound fields", () => {
    const longPrefix = "x".repeat(62);
    const post = s
      .model({
        tenant: s.string(),
        slug: s.string(),
        tags: s
          .manyToMany(() => tag)
          .through("post_tag")
          .A(longPrefix)
          .B("tag"),
      })
      .id(["tenant", "slug"]);
    const tag = s.model({
      id: s.string().id(),
      posts: s
        .manyToMany(() => post)
        .through("post_tag")
        .A("tag")
        .B(longPrefix),
    });

    expect(codes(validateSchema({ post, tag }))).toContain("JT002");
  });

  it("rejects an empty compound-side prefix", () => {
    const post = s
      .model({
        tenant: s.string(),
        slug: s.string(),
        tags: s
          .manyToMany(() => tag)
          .A("")
          .B("tag"),
      })
      .id(["tenant", "slug"]);
    const tag = s.model({
      id: s.string().id(),
      posts: s
        .manyToMany(() => post)
        .A("tag")
        .B(""),
    });

    expect(codes(validateSchema({ post, tag }))).toContain("JT002");
  });

  it("validates generated compound-side constraint names", () => {
    const table = "j".repeat(55);
    const post = s
      .model({
        tenant: s.string(),
        slug: s.string(),
        tags: s
          .manyToMany(() => tag)
          .through(table)
          .A("post")
          .B("tag"),
      })
      .id(["tenant", "slug"]);
    const tag = s.model({
      id: s.string().id(),
      posts: s
        .manyToMany(() => post)
        .through(table)
        .A("tag")
        .B("post"),
    });

    expect(codes(validateSchema({ post, tag }))).toContain("JT002");
  });

  it("rejects portable collisions after positional prefix expansion", () => {
    const post = s.model({
      id: s.string().id(),
      tags: s
        .manyToMany(() => tag)
        .A("post_1")
        .B("Post"),
    });
    const tag = s
      .model({
        tenant: s.string(),
        code: s.string(),
        posts: s
          .manyToMany(() => post)
          .A("Post")
          .B("post_1"),
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
      comments: s.oneToMany(() => comment),
    });
    const comment = s.model({
      id: s.string().id(),
      commentableType: s.string(),
      commentableId: s.string(),
      post: s
        .manyToOne(() => post)
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
        .oneToOne(() => user)
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
      unrelated: s.oneToMany(() => profile),
      profile: s.oneToOne(() => profile).optional(),
    });
    const profile = s.model({
      id: s.string().id(),
      userId: s.string().unique(),
      user: s
        .oneToOne(() => user)
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
        .manyToOne(() => b)
        .fields("b1Id")
        .references("id")
        .name("first"),
      b2: s
        .manyToOne(() => b)
        .fields("b2Id")
        .references("id")
        .name("second"),
      fromB: s.oneToMany(() => b).name("back"),
    });
    const b = s.model({
      id: s.string().id(),
      a1Id: s.string(),
      a2Id: s.string(),
      a1: s
        .manyToOne(() => a)
        .fields("a1Id")
        .references("id")
        .name("back"),
      a2: s
        .manyToOne(() => a)
        .fields("a2Id")
        .references("id")
        .name("other"),
      first: s.oneToMany(() => a).name("first"),
      second: s.oneToMany(() => a).name("second"),
    });
    const cycleCodes = codes(validateSchema({ a, b })).filter(
      (code) => code === "CM002"
    );

    expect(cycleCodes).toEqual(["CM002"]);
  });
});
