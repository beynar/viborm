import { s } from "@schema";
import type { AnyModel } from "@schema/model";
import {
  expandJunctionFieldGroups,
  getJunctionConstraintName,
  JunctionPhysicalNameError,
  junctionSourceSideIsFirst,
  resolveOrdinaryJunctionNames,
} from "@schema/relation/helpers";
import {
  resolveJunctionTopology,
  resolveVariantMemberNames,
} from "@schema/relation/junction-topology";
import { describe, expect, test } from "vitest";

/**
 * Unit pins for the TWO physical junction owners, on the relation-free surface
 * they now have.
 *
 * Neither owner reads a relation, discovers a pair, or looks at a second
 * endpoint's declaration any more: the full-schema resolver decides which two
 * slots share a junction and which single endpoint owns the overrides, then
 * hands these owners already-oriented facts. That is the whole point of the
 * cutover, and it is why every input below is a plain name or row key.
 *
 * The GRAPH-level behaviour these names feed — mirroring a sole override owner,
 * refusing a second one, default self tokens — is pinned at the gate, in
 * `tests/unit/schema-validation/junction-configuration.core.test.ts`.
 */

const model = (): AnyModel => s.model({ id: s.string().id() });

// =============================================================================
// SIDE EXPANSION — the four guards, all here and only here
// =============================================================================

describe("expandJunctionFieldGroups", () => {
  test("expands a scalar row key to the bare token and a compound one positionally", () => {
    const groups = expandJunctionFieldGroups(
      "post",
      "tag",
      "postId",
      "tag",
      ["id"],
      ["tenantId", "slug"]
    );

    expect(groups.source).toEqual({ token: "postId", fields: ["postId"] });
    expect(groups.target).toEqual({
      token: "tag",
      fields: ["tag_1", "tag_2"],
    });
  });

  test("refuses an empty row key on either side, naming that side", () => {
    expect(() =>
      expandJunctionFieldGroups("post", "tag", "postId", "tagId", [], ["id"])
    ).toThrow("Model 'post' has no primary key");
    expect(() =>
      expandJunctionFieldGroups("post", "tag", "postId", "tagId", ["id"], [])
    ).toThrow("Model 'tag' has no primary key");
  });

  test("refuses a token that is not a schema identifier", () => {
    expect(() =>
      expandJunctionFieldGroups(
        "post",
        "tag",
        "constructor",
        "tagId",
        ["id"],
        ["id"]
      )
    ).toThrow(JunctionPhysicalNameError);
  });

  test("refuses an expanded field that is not a schema identifier", () => {
    const long = "x".repeat(62);
    expect(() =>
      expandJunctionFieldGroups(
        "post",
        "tag",
        long,
        "tagId",
        ["a", "b"],
        ["id"]
      )
    ).toThrow("Expanded junction field");
  });

  test("refuses a cross-side collision that only appears after expansion", () => {
    // `post_1` as an explicit scalar token vs `post` as a compound prefix: the
    // two tokens differ, their expansions do not.
    expect(() =>
      expandJunctionFieldGroups(
        "post",
        "tag",
        "post_1",
        "Post",
        ["id"],
        ["tenantId", "code"]
      )
    ).toThrow("collide after compound-prefix expansion");
  });
});

describe("junctionSourceSideIsFirst", () => {
  test("orders by model name, and by expanded fields for a self junction", () => {
    expect(
      junctionSourceSideIsFirst("post", ["postId"], "tag", ["tagId"])
    ).toBe(true);
    expect(
      junctionSourceSideIsFirst("tag", ["tagId"], "post", ["postId"])
    ).toBe(false);
    expect(
      junctionSourceSideIsFirst("node", ["followingId"], "node", [
        "followersId",
      ])
    ).toBe(false);
  });
});

describe("getJunctionConstraintName", () => {
  test("joins table, token and kind, and refuses an over-long result", () => {
    const side = { token: "postId", fields: ["postId"] };

    expect(getJunctionConstraintName("post_tag", side, "fkey")).toBe(
      "post_tag_postId_fkey"
    );
    expect(() =>
      getJunctionConstraintName("j".repeat(60), side, "idx")
    ).toThrow(JunctionPhysicalNameError);
  });
});

// =============================================================================
// ORDINARY PAIR NAMES
// =============================================================================

describe("resolveOrdinaryJunctionNames", () => {
  const base = {
    sourceModelName: "post",
    targetModelName: "tag",
    sourceField: "tags",
    targetField: "posts",
    sourceRowKeyIsCompound: false,
    targetRowKeyIsCompound: false,
    pairName: undefined,
    overrides: undefined,
  };

  test("derives the sorted model-pair table and model-derived side tokens", () => {
    expect(resolveOrdinaryJunctionNames(base)).toEqual({
      table: "post_tag",
      sourceToken: "postId",
      targetToken: "tagId",
    });
  });

  test("suffixes the table with the agreed pair name", () => {
    expect(
      resolveOrdinaryJunctionNames({ ...base, pairName: "Featured" }).table
    ).toBe("post_tag_Featured");
  });

  test("takes SELF side tokens from the field keys, which are what differ", () => {
    expect(
      resolveOrdinaryJunctionNames({
        ...base,
        sourceModelName: "node",
        targetModelName: "node",
        sourceField: "following",
        targetField: "followers",
      })
    ).toEqual({
      table: "node_node",
      sourceToken: "followingId",
      targetToken: "followersId",
    });
  });

  test("drops the `Id` suffix when the token is a positional prefix", () => {
    expect(
      resolveOrdinaryJunctionNames({
        ...base,
        sourceRowKeyIsCompound: true,
        sourceModelName: "node",
        targetModelName: "node",
        sourceField: "following",
        targetField: "followers",
      })
    ).toMatchObject({ sourceToken: "following", targetToken: "followersId" });
  });

  test("keeps the MODEL-name derivation for a non-self compound side", () => {
    // A non-self junction separates its sides by model name, so a compound row
    // key changes only the suffix rule — the token stays model-derived, and it
    // is lowercased because it prefixes column names rather than naming a field.
    expect(
      resolveOrdinaryJunctionNames({
        ...base,
        sourceModelName: "orgUnit",
        sourceRowKeyIsCompound: true,
      })
    ).toMatchObject({ sourceToken: "orgunit", targetToken: "tagId" });
  });

  test("lets the owning endpoint's overrides replace all three names", () => {
    expect(
      resolveOrdinaryJunctionNames({
        ...base,
        overrides: { table: "links", source: "a", target: "b" },
      })
    ).toEqual({ table: "links", sourceToken: "a", targetToken: "b" });
  });
});

// =============================================================================
// RESOLVED TOPOLOGY
// =============================================================================

describe("resolveJunctionTopology", () => {
  test("zips both sides against their row keys and derives canonical order", () => {
    const post = model();
    const tag = model();
    const topology = resolveJunctionTopology({
      table: "post_tag",
      source: {
        model: post,
        modelName: "post",
        rowKey: ["id"],
        token: "postId",
      },
      target: { model: tag, modelName: "tag", rowKey: ["id"], token: "tagId" },
      pairName: undefined,
    });

    expect(topology.source.model).toBe(post);
    expect(topology.source.members).toEqual([
      { junctionField: "postId", referencedField: "id" },
    ]);
    expect(topology.target.members).toEqual([
      { junctionField: "tagId", referencedField: "id" },
    ]);
    expect(topology.sourceIsFirst).toBe(true);
    expect(topology.pairName).toBeUndefined();
  });

  test("derives and memoizes all four constraint names", () => {
    const topology = resolveJunctionTopology({
      table: "post_tag",
      source: {
        model: model(),
        modelName: "post",
        rowKey: ["id"],
        token: "postId",
      },
      target: {
        model: model(),
        modelName: "tag",
        rowKey: ["id"],
        token: "tagId",
      },
      pairName: "Featured",
    });

    expect(topology.foreignKeyName("source")).toBe("post_tag_postId_fkey");
    expect(topology.foreignKeyName("target")).toBe("post_tag_tagId_fkey");
    expect(topology.reverseIndexName()).toBe("post_tag_tagId_idx");
    expect(topology.uniqueTargetName()).toBe("post_tag_tagId_key");
    expect(topology.pairName).toBe("Featured");
    // Memoized: the same string object comes back, and the refusal below stays
    // attached to the first ask rather than to construction.
    expect(topology.foreignKeyName("source")).toBe("post_tag_postId_fkey");
  });

  test("refuses equal side tokens on the first foreign-key ask", () => {
    // The expanded-field collision guard never sees this pair: an explicit
    // scalar token and a generated compound prefix expand to different FIELDS
    // while deriving the same `${table}_${token}_fkey` name.
    const topology = resolveJunctionTopology({
      table: "post_tag",
      source: {
        model: model(),
        modelName: "post",
        rowKey: ["id"],
        token: "shared",
      },
      target: {
        model: model(),
        modelName: "tag",
        rowKey: ["a", "b"],
        token: "shared",
      },
      pairName: undefined,
    });

    expect(() => topology.foreignKeyName("source")).toThrow(
      "share naming token"
    );
    // …and re-refuses on repeat, rather than memoizing a name it never derived.
    expect(() => topology.foreignKeyName("target")).toThrow(
      "share naming token"
    );
  });

  test("forwards an empty row key so the groups resolver stays the one guard", () => {
    expect(() =>
      resolveJunctionTopology({
        table: "post_tag",
        source: { model: model(), modelName: "post", rowKey: [], token: "p" },
        target: {
          model: model(),
          modelName: "tag",
          rowKey: ["id"],
          token: "t",
        },
        pairName: undefined,
      })
    ).toThrow("Model 'post' has no primary key");
  });
});

// =============================================================================
// VARIANT MEMBER NAMES
// =============================================================================

describe("resolveVariantMemberNames", () => {
  const base = {
    ownerTableName: "shelf",
    ownerModelName: "shelf",
    relationField: "items",
    publicType: "book",
    ownerRowKeyIsCompound: false,
    targetRowKeyIsCompound: false,
    junction: undefined,
  };

  test("derives a declaration-shaped table and a VARIANT-derived target token", () => {
    // Not the sorted-alphabetical ordinary generator: a member junction has an
    // owner side and a variant side, not two peers. The variant-derived target
    // token is what keeps two variants over the same model distinct.
    expect(resolveVariantMemberNames(base)).toEqual({
      table: "shelf_items_book",
      sourceToken: "shelfId",
      targetToken: "bookId",
    });
  });

  test("uses positional prefixes per side for compound row keys", () => {
    expect(
      resolveVariantMemberNames({
        ...base,
        ownerRowKeyIsCompound: true,
        targetRowKeyIsCompound: true,
      })
    ).toMatchObject({ sourceToken: "shelf", targetToken: "book" });
  });

  test("lets an explicit .through() entry override all three names", () => {
    expect(
      resolveVariantMemberNames({
        ...base,
        junction: { table: "t", source: "s", target: "g" },
      })
    ).toEqual({ table: "t", sourceToken: "s", targetToken: "g" });
  });
});
