import { s } from "@schema";
import type { AnyModel } from "@schema/model";
import type { ResolvedJunctionSide } from "@schema/relation/junction-topology";
import { hydrateSchemaNames } from "@src/schema/hydration";
import { SchemaValidator, validateSchema } from "@src/schema/validation";
import type { ResolvedRelationEdge } from "@src/schema/validation/relation-resolution";
import { describe, expect, it } from "vitest";

/**
 * Issue #46 — the resolver puts each declared action on its DIRECTED side.
 *
 * `source` is the declaring endpoint's side and `target` its target's; the
 * resolver orients the one owner's overrides onto the topology's sides exactly
 * once (mirroring swaps them when the owner is the second endpoint), and the
 * sides carry the actions from there. None of this may follow the alphabetical
 * physical order: every fixture below whose owner sorts second would read the
 * wrong key if it did.
 */

type JunctionEdge = Extract<ResolvedRelationEdge, { kind: "junction" }>;

function junctions(schema: Record<string, AnyModel>): JunctionEdge[] {
  hydrateSchemaNames(schema);
  const resolution = new SchemaValidator().registerAll(schema).resolve();
  if (!resolution.ok) {
    throw new Error(
      `fixture did not resolve: ${resolution.issues.map((i) => i.code).join(", ")}`
    );
  }
  const edges = new Set<JunctionEdge>();
  for (const slots of resolution.index.values()) {
    for (const slot of slots.values()) {
      if (slot.edge.kind === "junction") edges.add(slot.edge);
    }
  }
  return [...edges];
}

function onlyJunction(schema: Record<string, AnyModel>): JunctionEdge {
  const [edge, ...rest] = junctions(schema);
  if (edge === undefined || rest.length > 0) {
    throw new Error("expected exactly one junction");
  }
  return edge;
}

/** The side whose foreign key references `modelName`, with its actions. */
function sideTo(edge: JunctionEdge, modelName: string): ResolvedJunctionSide {
  const { source, target } = edge.topology;
  if (source.modelName === target.modelName) {
    throw new Error("a self junction has no side per model");
  }
  if (source.modelName === modelName) return source;
  if (target.modelName === modelName) return target;
  throw new Error(`no side references '${modelName}'`);
}

const actions = (side: ResolvedJunctionSide) => ({
  onDelete: side.onDelete,
  onUpdate: side.onUpdate,
});

function codes(schema: Record<string, AnyModel>): string[] {
  hydrateSchemaNames(schema);
  return validateSchema(schema).errors.map((issue) => issue.code);
}

/** `post` owns the junction and sorts SECOND: `label` is the first endpoint. */
const ownerSortsSecond = () => {
  const label = s.model({ id: s.string().id(), posts: s.toMany(() => post) });
  const post = s.model({
    id: s.string().id(),
    labels: s
      .toMany(() => label)
      .onDelete({ source: "cascade", target: "noAction" })
      .onUpdate({ source: "cascade", target: "restrict" }),
  });
  return { label, post };
};

describe("orientation onto the directed sides (witness: owner on either endpoint)", () => {
  it("puts `source` on the declaring model's side when that model sorts second", () => {
    const edge = onlyJunction(ownerSortsSecond());
    // The first endpoint is label, so the topology's SOURCE side is label's —
    // the mirrored view of post's `target`.
    expect(edge.topology.source.modelName).toBe("label");
    expect(actions(sideTo(edge, "post"))).toEqual({
      onDelete: "cascade",
      onUpdate: "cascade",
    });
    expect(actions(sideTo(edge, "label"))).toEqual({
      onDelete: "noAction",
      onUpdate: "restrict",
    });
  });

  it("puts `source` on the declaring model's side when that model sorts first", () => {
    const post = s.model({
      id: s.string().id(),
      topics: s
        .toMany(() => topic)
        .onDelete({ source: "cascade", target: "noAction" })
        .onUpdate({ source: "cascade", target: "restrict" }),
    });
    const topic = s.model({ id: s.string().id(), posts: s.toMany(() => post) });
    const edge = onlyJunction({ post, topic });
    expect(edge.topology.source.modelName).toBe("post");
    expect(actions(sideTo(edge, "post"))).toEqual({
      onDelete: "cascade",
      onUpdate: "cascade",
    });
    expect(actions(sideTo(edge, "topic"))).toEqual({
      onDelete: "noAction",
      onUpdate: "restrict",
    });
  });

  it("resolves the configuration moved to the other endpoint, sides swapped, to the same sides", () => {
    const label = s.model({
      id: s.string().id(),
      posts: s
        .toMany(() => post)
        .onDelete({ source: "noAction", target: "cascade" })
        .onUpdate({ source: "restrict", target: "cascade" }),
    });
    const post = s.model({
      id: s.string().id(),
      labels: s.toMany(() => label),
    });
    const moved = onlyJunction({ label, post });
    const original = onlyJunction(ownerSortsSecond());
    for (const model of ["label", "post"]) {
      expect(actions(sideTo(moved, model))).toEqual(
        actions(sideTo(original, model))
      );
    }
  });

  it("does not depend on the order the models are registered in", () => {
    const { label, post } = ownerSortsSecond();
    const reversed = onlyJunction({ post, label });
    expect(actions(sideTo(reversed, "post"))).toEqual({
      onDelete: "cascade",
      onUpdate: "cascade",
    });
    expect(actions(sideTo(reversed, "label"))).toEqual({
      onDelete: "noAction",
      onUpdate: "restrict",
    });
  });

  it("leaves an unstated action to the default on both sides", () => {
    const label = s.model({ id: s.string().id(), posts: s.toMany(() => post) });
    const post = s.model({
      id: s.string().id(),
      labels: s
        .toMany(() => label)
        .onDelete({ source: "cascade", target: "restrict" }),
    });
    const edge = onlyJunction({ label, post });
    expect(sideTo(edge, "post").onUpdate).toBeUndefined();
    expect(sideTo(edge, "label").onUpdate).toBeUndefined();
    expect("onUpdate" in sideTo(edge, "label")).toBe(false);
    expect(sideTo(edge, "label").onDelete).toBe("restrict");
  });

  it("publishes no action beside the topology: the sides are the one authority", () => {
    const edge = onlyJunction(ownerSortsSecond());
    expect(Object.keys(edge).sort()).toEqual(["endpoints", "kind", "topology"]);
  });
});

describe("names never decide the side (witness: mapped names, compound keys, self, multiple junctions)", () => {
  it("follows the declaring model through mapped tables and explicit tokens", () => {
    // Mapped SQL tables sort the OTHER way from the schema keys, and the
    // explicit tokens sort the other way again: none of them may choose.
    const zebra = s
      .model({
        id: s.string().id(),
        apples: s
          .toMany(() => apple)
          .through("links")
          .source("a_zebra")
          .target("z_apple")
          .onDelete({ source: "cascade", target: "restrict" }),
      })
      .map("aaa_zebras");
    const apple = s
      .model({ id: s.string().id(), zebras: s.toMany(() => zebra) })
      .map("zzz_apples");
    const edge = onlyJunction({ zebra, apple });
    const zebraSide = sideTo(edge, "zebra");
    expect(zebraSide.members.map((member) => member.junctionField)).toEqual([
      "a_zebra",
    ]);
    expect(zebraSide.onDelete).toBe("cascade");
    expect(sideTo(edge, "apple").onDelete).toBe("restrict");
  });

  it("carries one action for every member of a compound side", () => {
    const tenantPost = s
      .model({
        tenantId: s.string(),
        id: s.string(),
        tags: s
          .toMany(() => tag)
          .onDelete({ source: "restrict", target: "cascade" }),
      })
      .id(["tenantId", "id"]);
    const tag = s.model({
      id: s.string().id(),
      posts: s.toMany(() => tenantPost),
    });
    const edge = onlyJunction({ tenantPost, tag });
    const postSide = sideTo(edge, "tenantPost");
    expect(postSide.members).toHaveLength(2);
    expect(postSide.onDelete).toBe("restrict");
    expect(sideTo(edge, "tag").onDelete).toBe("cascade");
  });

  it("orients a self junction by its declaring SLOT, from either slot", () => {
    const declaredOn = (owner: "following" | "followers") => {
      const following = s.toMany(() => node).name("Follows");
      const followers = s.toMany(() => node).name("Follows");
      const node = s.model({
        id: s.string().id(),
        following:
          owner === "following"
            ? following.onDelete({ source: "cascade", target: "restrict" })
            : following,
        followers:
          owner === "followers"
            ? followers.onDelete({ source: "restrict", target: "cascade" })
            : followers,
      });
      return onlyJunction({ node });
    };
    const byColumn = (edge: JunctionEdge) =>
      Object.fromEntries(
        [edge.topology.source, edge.topology.target].map((side) => [
          side.members[0]?.junctionField,
          side.onDelete,
        ])
      );
    // Declared on `following`: its own side is the `followingId` column.
    expect(byColumn(declaredOn("following"))).toEqual({
      followingId: "cascade",
      followersId: "restrict",
    });
    // The same physical policy declared on `followers`, sides swapped.
    expect(byColumn(declaredOn("followers"))).toEqual({
      followingId: "cascade",
      followersId: "restrict",
    });
    // An unstated action is absent from both sides, not an `undefined` key.
    const { source, target } = declaredOn("following").topology;
    expect("onUpdate" in source || "onUpdate" in target).toBe(false);
  });

  it("keeps each of several junctions between the same models to its own policy", () => {
    const post = s.model({
      id: s.string().id(),
      tagged: s
        .toMany(() => topic)
        .name("tagged")
        .onDelete({ source: "cascade", target: "noAction" }),
      featured: s
        .toMany(() => topic)
        .name("featured")
        .onDelete({ source: "restrict", target: "cascade" }),
    });
    const topic = s.model({
      id: s.string().id(),
      taggedIn: s.toMany(() => post).name("tagged"),
      featuredIn: s.toMany(() => post).name("featured"),
    });
    const byTable = Object.fromEntries(
      junctions({ post, topic }).map((edge) => [
        edge.topology.table,
        {
          post: sideTo(edge, "post").onDelete,
          topic: sideTo(edge, "topic").onDelete,
        },
      ])
    );
    expect(byTable).toEqual({
      post_topic_tagged: { post: "cascade", topic: "noAction" },
      post_topic_featured: { post: "restrict", topic: "cascade" },
    });
  });
});

describe("one owner, junction storage only (witness: both endpoints, non-junction storage)", () => {
  it("refuses a side map on one endpoint beside any configuration on the other", () => {
    const label = s.model({
      id: s.string().id(),
      posts: s.toMany(() => post).onDelete("noAction"),
    });
    const post = s.model({
      id: s.string().id(),
      labels: s
        .toMany(() => label)
        .onDelete({ source: "cascade", target: "noAction" }),
    });
    expect(codes({ label, post })).toEqual(["R011"]);
  });

  it("refuses a side map on a collection that resolves to a row reference", () => {
    const author = s.model({
      id: s.string().id(),
      books: s
        .toMany(() => book)
        .onDelete({ source: "cascade", target: "restrict" }),
    });
    const book = s.model({
      id: s.string().id(),
      authorId: s.string(),
      author: s
        .toOne(() => author)
        .fields("authorId")
        .references("id"),
    });
    expect(codes({ author, book })).toEqual(["R012"]);
  });

  it("leaves a variant member junction's sides without actions (its storage default stands)", () => {
    const article = s.model({
      id: s.string().id(),
      notes: s.toMany(() => note).name("subject"),
    });
    const note = s.model({
      id: s.string().id(),
      subject: s.toMany({ article: () => article }).name("subject"),
    });
    const schema = { article, note };
    hydrateSchemaNames(schema);
    const resolution = new SchemaValidator().registerAll(schema).resolve();
    if (!resolution.ok) throw new Error("did not resolve");
    const carrier = resolution.index.get(note)?.get("subject")?.edge;
    if (carrier?.kind !== "variantJunctionCarrier") {
      throw new Error("expected a variant junction carrier");
    }
    for (const member of carrier.members) {
      for (const side of [member.topology.source, member.topology.target]) {
        expect("onDelete" in side || "onUpdate" in side).toBe(false);
      }
    }
  });
});
