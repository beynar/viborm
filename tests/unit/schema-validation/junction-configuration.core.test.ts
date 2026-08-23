import { s } from "@schema";
import type { AnyModel } from "@schema/model";
import { hydrateSchemaNames } from "@src/schema/hydration";
import { SchemaValidator, validateSchema } from "@src/schema/validation";
import type { ResolvedRelationEdge } from "@src/schema/validation/relation-resolution";
import { describe, expect, it } from "vitest";

/**
 * ONE JUNCTION, ONE CONFIGURATION OWNER (plan §6.4, §6.6, §9.4; falsifiers
 * §11.2.11, 17, 18).
 *
 * HEAD required both endpoints to spell a self junction's side tokens and
 * reconciled the two declarations, refusing any disagreement. The physical fact
 * has one owner now: overrides are oriented from the declaring endpoint and the
 * other side consumes the mirrored view, so a second configuration is not a
 * disagreement to reconcile — it is a second owner, which is the error.
 */

function junctionEdge(schema: Record<string, AnyModel>): ResolvedRelationEdge {
  hydrateSchemaNames(schema);
  const resolution = new SchemaValidator().registerAll(schema).resolve();
  if (!resolution.ok) {
    throw new Error(
      `fixture did not resolve: ${resolution.issues.map((i) => i.code).join(", ")}`
    );
  }
  for (const slots of resolution.index.values()) {
    for (const slot of slots.values()) {
      if (slot.edge.kind === "junction") return slot.edge;
    }
  }
  throw new Error("no junction edge");
}

function codes(schema: Record<string, AnyModel>): string[] {
  hydrateSchemaNames(schema);
  return validateSchema(schema).errors.map((issue) => issue.code);
}

describe("default self-junction orientation (§11.2.11)", () => {
  it("takes each side token from its own FIELD key", () => {
    // The model name is the same on both sides of a self junction and cannot
    // separate them; the field keys can, which is why §6.4 makes the default
    // `${field}Id` for a scalar row key.
    const node = s.model({
      id: s.string().id(),
      following: s.toMany(() => node).name("Follows"),
      followers: s.toMany(() => node).name("Follows"),
    });
    const edge = junctionEdge({ node });

    if (edge.kind !== "junction") throw new Error("wrong kind");
    expect(edge.topology.source.token).toBe("followingId");
    expect(edge.topology.target.token).toBe("followersId");
  });

  it("is stable, and reverse traversal reads the opposite side", () => {
    const node = s.model({
      id: s.string().id(),
      following: s.toMany(() => node).name("Follows"),
      followers: s.toMany(() => node).name("Follows"),
    });
    const schema = { node };
    hydrateSchemaNames(schema);
    const resolution = new SchemaValidator().registerAll(schema).resolve();
    if (!resolution.ok) throw new Error("did not resolve");

    // ONE stored topology, oriented from `endpoints[0]`. The other endpoint
    // reads the same object with its sides swapped; nothing is duplicated.
    const forward = resolution.index.get(node)?.get("following");
    const back = resolution.index.get(node)?.get("followers");
    expect(forward?.edge).toBe(back?.edge);
    if (forward?.edge.kind !== "junction") throw new Error("wrong kind");
    expect(forward.edge.endpoints.map((slot) => slot.field)).toEqual([
      "following",
      "followers",
    ]);
  });

  it("uses a positional prefix, without the `Id`, for a compound row key", () => {
    const node = s
      .model({
        tenantId: s.string(),
        id: s.string(),
        following: s.toMany(() => node).name("Follows"),
        followers: s.toMany(() => node).name("Follows"),
      })
      .id(["tenantId", "id"]);
    const edge = junctionEdge({ node });

    if (edge.kind !== "junction") throw new Error("wrong kind");
    expect(edge.topology.source.members).toEqual([
      { junctionField: "following_1", referencedField: "tenantId" },
      { junctionField: "following_2", referencedField: "id" },
    ]);
  });
});

describe("junction referential actions (§11.2.17)", () => {
  it("refuses `setNull` at the modifier that owns it", () => {
    // A junction's membership key columns are never nullable, so `setNull`
    // could only ever destroy the row it claims to preserve. The type surface
    // hides it; this is the hostile-runtime route.
    const tag = s.model({ id: s.string().id() });
    const junction = () => s.toMany(() => tag);

    expect(() =>
      // @ts-expect-error §9.4: a junction action is cascade/restrict/noAction.
      junction().onDelete("setNull")
    ).toThrow("cannot null a membership-key member");
    expect(() =>
      // @ts-expect-error §9.4: same rule for onUpdate.
      junction().onUpdate("setNull")
    ).toThrow("cannot null a membership-key member");
  });

  it("carries the surviving actions onto the resolved edge", () => {
    const post = s.model({
      id: s.string().id(),
      tags: s
        .toMany(() => tag)
        .onDelete("cascade")
        .onUpdate("restrict"),
    });
    const tag = s.model({ id: s.string().id(), posts: s.toMany(() => post) });
    const edge = junctionEdge({ post, tag });

    if (edge.kind !== "junction") throw new Error("wrong kind");
    expect(edge.onDelete).toBe("cascade");
    expect(edge.onUpdate).toBe("restrict");
  });
});

describe("one configuration owner (§11.2.18)", () => {
  it("mirrors a sole owner's orientation onto the other endpoint", () => {
    const post = s.model({
      id: s.string().id(),
      tags: s
        .toMany(() => tag)
        .through("post_tag_links")
        .source("postRef")
        .target("tagRef"),
    });
    const tag = s.model({ id: s.string().id(), posts: s.toMany(() => post) });
    const edge = junctionEdge({ post, tag });

    if (edge.kind !== "junction") throw new Error("wrong kind");
    expect(edge.topology.table).toBe("post_tag_links");
    expect(edge.topology.source.token).toBe("postRef");
    expect(edge.topology.target.token).toBe("tagRef");
  });

  it("mirrors it in the OTHER direction when the owner sorts second", () => {
    // `tag` declares the overrides but `post` is the canonically first
    // endpoint, so resolution swaps source and target before handing them to
    // the physical owner — the same table, the same two columns.
    const post = s.model({ id: s.string().id(), tags: s.toMany(() => tag) });
    const tag = s.model({
      id: s.string().id(),
      posts: s
        .toMany(() => post)
        .through("post_tag_links")
        .source("tagRef")
        .target("postRef"),
    });
    const edge = junctionEdge({ post, tag });

    if (edge.kind !== "junction") throw new Error("wrong kind");
    expect(edge.topology.table).toBe("post_tag_links");
    expect(edge.topology.source.token).toBe("postRef");
    expect(edge.topology.target.token).toBe("tagRef");
  });

  it("mirrors only the facts the second-sorting owner actually stated", () => {
    // The mirror swaps source and target; it does not INVENT the three name
    // overrides. An owner that states only actions leaves the table and both
    // tokens to the default derivation, exactly as if it sorted first.
    const post = s.model({ id: s.string().id(), tags: s.toMany(() => tag) });
    const tag = s.model({
      id: s.string().id(),
      posts: s
        .toMany(() => post)
        .onDelete("cascade")
        .onUpdate("restrict"),
    });
    const edge = junctionEdge({ post, tag });

    if (edge.kind !== "junction") throw new Error("wrong kind");
    expect(edge.topology.table).toBe("post_tag");
    expect(edge.topology.source.token).toBe("postId");
    expect(edge.topology.target.token).toBe("tagId");
    expect(edge.onDelete).toBe("cascade");
    expect(edge.onUpdate).toBe("restrict");
  });

  it("refuses configuration on BOTH endpoints, agreeing or not", () => {
    const mirrored = () => {
      const post = s.model({
        id: s.string().id(),
        tags: s
          .toMany(() => tag)
          .through("post_tag_links")
          .source("postRef")
          .target("tagRef"),
      });
      const tag = s.model({
        id: s.string().id(),
        posts: s
          .toMany(() => post)
          .through("post_tag_links")
          .source("tagRef")
          .target("postRef"),
      });
      return { post, tag };
    };
    const contradicting = () => {
      const post = s.model({
        id: s.string().id(),
        tags: s.toMany(() => tag).through("a"),
      });
      const tag = s.model({
        id: s.string().id(),
        posts: s.toMany(() => post).through("b"),
      });
      return { post, tag };
    };

    expect(codes(mirrored())).toEqual(["R011"]);
    expect(codes(contradicting())).toEqual(["R011"]);
  });

  it("refuses junction configuration on a non-junction edge", () => {
    const user = s.model({
      id: s.string().id(),
      posts: s.toMany(() => post).through("nope"),
    });
    const post = s.model({
      id: s.string().id(),
      authorId: s.string(),
      author: s
        .toOne(() => user)
        .fields("authorId")
        .references("id"),
    });

    expect(codes({ user, post })).toEqual(["R012"]);
  });
});
