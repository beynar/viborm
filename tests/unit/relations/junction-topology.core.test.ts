import { hydrateSchemaNames, s } from "@schema";
import type { Model } from "@schema/model";
import {
  getJunctionTableName,
  JunctionPhysicalNameError,
} from "@schema/relation/helpers";
import {
  resolveJunctionPairActions,
  resolveOrdinaryJunctionTopology,
  resolvePolymorphicMemberJunctionTopology,
  resolvePolymorphicMemberNames,
} from "@schema/relation/junction-topology";

/**
 * Unit pins for the resolved-junction-topology owner. The caller resolves the
 * table first (`getJunctionTableName`) and forwards row keys verbatim; the
 * owner answers tokens, ordered members, canonical side order, pair identity,
 * and the lazily derived constraint names.
 */
describe("resolved junction topology", () => {
  test("resolves a scalar pair from both directions with canonical order and memoized names", () => {
    const forward = s.manyToMany(() => tag);
    const back = s.manyToMany(() => post);
    const post = s.model({ id: s.string().id(), tags: forward });
    const tag = s.model({ id: s.string().id(), posts: back });
    hydrateSchemaNames({ post, tag });

    const table = getJunctionTableName(forward, "post", "tag");
    const topology = resolveOrdinaryJunctionTopology({
      relation: forward,
      table,
      source: { model: post, modelName: "post", rowKey: ["id"] },
      target: { model: tag, modelName: "tag", rowKey: ["id"] },
    });

    expect(topology.table).toBe("post_tag");
    expect(topology.source.model).toBe(post);
    expect(topology.source.modelName).toBe("post");
    expect(topology.source.token).toBe("postId");
    expect(topology.source.members).toEqual([
      { junctionField: "postId", referencedField: "id" },
    ]);
    expect(topology.target.model).toBe(tag);
    expect(topology.target.modelName).toBe("tag");
    expect(topology.target.token).toBe("tagId");
    expect(topology.target.members).toEqual([
      { junctionField: "tagId", referencedField: "id" },
    ]);
    expect(topology.sourceIsFirst).toBe(true);
    expect(topology.pairName).toBeUndefined();
    expect(topology.foreignKeyName("source")).toBe("post_tag_postId_fkey");
    expect(topology.foreignKeyName("target")).toBe("post_tag_tagId_fkey");
    expect(topology.reverseIndexName()).toBe("post_tag_tagId_idx");
    // The unique TARGET side — the fourth derived name, asked last by both
    // consumers. It is named off the target rather than the canonical second
    // side, so on a topology where the target sorts FIRST it deliberately
    // differs from the reverse index (pinned per dialect in the serializer's
    // member-table matrix). Only a member junction with a singular inverse
    // emits it; an ordinary junction never asks.
    expect(topology.uniqueTargetName()).toBe("post_tag_tagId_key");
    // Repeated asks answer from the memo with identical bytes.
    expect(topology.foreignKeyName("source")).toBe("post_tag_postId_fkey");
    expect(topology.foreignKeyName("target")).toBe("post_tag_tagId_fkey");
    expect(topology.reverseIndexName()).toBe("post_tag_tagId_idx");
    expect(topology.uniqueTargetName()).toBe("post_tag_tagId_key");

    const reversed = resolveOrdinaryJunctionTopology({
      relation: back,
      table: getJunctionTableName(back, "tag", "post"),
      source: { model: tag, modelName: "tag", rowKey: ["id"] },
      target: { model: post, modelName: "post", rowKey: ["id"] },
    });
    expect(reversed.table).toBe("post_tag");
    expect(reversed.sourceIsFirst).toBe(false);
    expect(reversed.source.token).toBe("tagId");
    expect(reversed.target.token).toBe("postId");
    // The canonical SECOND side names the same reverse index from either direction.
    expect(reversed.reverseIndexName()).toBe("post_tag_tagId_idx");
    expect(reversed.foreignKeyName("source")).toBe("post_tag_tagId_fkey");
    expect(reversed.foreignKeyName("target")).toBe("post_tag_postId_fkey");
    // The unique side follows the TARGET, so it flips with the direction where
    // the reverse index does not — the two names are distinct facts.
    expect(reversed.uniqueTargetName()).toBe("post_tag_postId_key");
  });

  test("pairs a compound source positionally and derives its generated prefix token", () => {
    const labels = s.manyToMany(() => compoundLabel);
    const docs = s.manyToMany(() => compoundDoc);
    const compoundDoc = s
      .model({ tenantId: s.string(), id: s.string(), labels })
      .id(["tenantId", "id"]);
    const compoundLabel = s.model({ id: s.string().id(), docs });
    hydrateSchemaNames({ compoundDoc, compoundLabel });

    const topology = resolveOrdinaryJunctionTopology({
      relation: labels,
      table: getJunctionTableName(labels, "compoundDoc", "compoundLabel"),
      source: {
        model: compoundDoc,
        modelName: "compoundDoc",
        rowKey: ["tenantId", "id"],
      },
      target: {
        model: compoundLabel,
        modelName: "compoundLabel",
        rowKey: ["id"],
      },
    });

    expect(topology.table).toBe("compounddoc_compoundlabel");
    // A compound source without .A() gets the lowercased model name WITHOUT the
    // scalar `Id` suffix as its prefix token, expanded positionally.
    expect(topology.source.token).toBe("compounddoc");
    expect(topology.source.members).toEqual([
      { junctionField: "compounddoc_1", referencedField: "tenantId" },
      { junctionField: "compounddoc_2", referencedField: "id" },
    ]);
    expect(topology.target.token).toBe("compoundlabelId");
    expect(topology.target.members).toEqual([
      { junctionField: "compoundlabelId", referencedField: "id" },
    ]);
    expect(topology.sourceIsFirst).toBe(true);
  });

  test("derives the serializer's exact constraint-name bytes for explicit compound prefixes", () => {
    const tags = s
      .manyToMany(() => tagModel)
      .A("post")
      .B("tag");
    const posts = s
      .manyToMany(() => postModel)
      .A("tag")
      .B("post");
    const postModel = s
      .model({ tenant: s.string(), slug: s.string(), tags })
      .id(["tenant", "slug"]);
    const tagModel = s
      .model({ locale: s.string(), code: s.int(), posts })
      .id(["locale", "code"]);
    hydrateSchemaNames({ post: postModel, tag: tagModel });

    const topology = resolveOrdinaryJunctionTopology({
      relation: tags,
      table: getJunctionTableName(tags, "post", "tag"),
      source: {
        model: postModel,
        modelName: "post",
        rowKey: ["tenant", "slug"],
      },
      target: { model: tagModel, modelName: "tag", rowKey: ["locale", "code"] },
    });

    expect(topology.table).toBe("post_tag");
    expect(topology.source.members).toEqual([
      { junctionField: "post_1", referencedField: "tenant" },
      { junctionField: "post_2", referencedField: "slug" },
    ]);
    expect(topology.target.members).toEqual([
      { junctionField: "tag_1", referencedField: "locale" },
      { junctionField: "tag_2", referencedField: "code" },
    ]);
    // Byte-equal to the serializer's pinned physical names.
    expect(topology.reverseIndexName()).toBe("post_tag_tag_idx");
    expect(topology.foreignKeyName("source")).toBe("post_tag_post_fkey");
    expect(topology.foreignKeyName("target")).toBe("post_tag_tag_fkey");
  });

  test("orients a self pair by the explicit-column tie-break in both directions", () => {
    const follows = s
      .manyToMany(() => follower)
      .A("followerId")
      .B("followedId");
    const followedBy = s.manyToMany(() => follower);
    const follower: Model<any> = s.model({
      id: s.string().id(),
      follows,
      followedBy,
    });
    hydrateSchemaNames({ follower });

    const table = getJunctionTableName(follows, "follower", "follower");
    expect(table).toBe("follower_follower");

    const fromFollows = resolveOrdinaryJunctionTopology({
      relation: follows,
      table,
      source: { model: follower, modelName: "follower", rowKey: ["id"] },
      target: { model: follower, modelName: "follower", rowKey: ["id"] },
    });
    expect(fromFollows.source.token).toBe("followerId");
    expect(fromFollows.target.token).toBe("followedId");
    expect(fromFollows.source.members).toEqual([
      { junctionField: "followerId", referencedField: "id" },
    ]);
    expect(fromFollows.target.members).toEqual([
      { junctionField: "followedId", referencedField: "id" },
    ]);
    // Same model on both ends: the field tie-break decides, and
    // 'followerId' sorts after 'followedId'.
    expect(fromFollows.sourceIsFirst).toBe(false);

    const fromFollowedBy = resolveOrdinaryJunctionTopology({
      relation: followedBy,
      table: getJunctionTableName(followedBy, "follower", "follower"),
      source: { model: follower, modelName: "follower", rowKey: ["id"] },
      target: { model: follower, modelName: "follower", rowKey: ["id"] },
    });
    // The paired side recovers the same columns swapped, so the tie-break flips.
    expect(fromFollowedBy.source.token).toBe("followedId");
    expect(fromFollowedBy.target.token).toBe("followerId");
    expect(fromFollowedBy.sourceIsFirst).toBe(true);

    // Either orientation derives the identical physical reverse index: the
    // canonical SECOND side is the 'followerId' column both times.
    expect(fromFollows.reverseIndexName()).toBe(
      "follower_follower_followerId_idx"
    );
    expect(fromFollowedBy.reverseIndexName()).toBe(
      "follower_follower_followerId_idx"
    );
  });

  test("refuses invalid derived names only when asked, and re-refuses on repeat", () => {
    const targets = s.manyToMany(() => targetModel);
    const sourceModel = s.model({ id: s.string().id(), targets });
    const targetModel = s.model({ id: s.string().id() });
    hydrateSchemaNames({ sourceModel, targetModel });

    const table = "x".repeat(62);
    const topology = resolveOrdinaryJunctionTopology({
      relation: targets,
      table,
      source: { model: sourceModel, modelName: "source", rowKey: ["id"] },
      target: { model: targetModel, modelName: "target", rowKey: ["id"] },
    });

    // A single-sided relation has no pair identity.
    expect(topology.pairName).toBeUndefined();
    // Construction resolved the sides; only the name derivations refuse.
    expect(topology.source.token).toBe("sourceId");

    expect(() => topology.foreignKeyName("source")).toThrowError(
      `Generated junction fkey name '${table}_sourceId_fkey' is not a valid SQL identifier.`
    );
    // The refusal is not cached: the same ask refuses again.
    expect(() => topology.foreignKeyName("source")).toThrowError(
      JunctionPhysicalNameError
    );
    expect(() => topology.reverseIndexName()).toThrowError(
      `Generated junction idx name '${table}_targetId_idx' is not a valid SQL identifier.`
    );

    let refusal: unknown;
    try {
      topology.foreignKeyName("target");
    } catch (error) {
      refusal = error;
    }
    expect(refusal).toBeInstanceOf(JunctionPhysicalNameError);
    expect(refusal).toHaveProperty("kind", "invalidIdentifier");
  });

  test("forwards empty row keys so the groups resolver stays the single emptiness guard", () => {
    const targets = s.manyToMany(() => targetModel);
    const sourceModel = s.model({ id: s.string().id(), targets });
    const targetModel = s.model({ id: s.string().id() });
    hydrateSchemaNames({ sourceModel, targetModel });

    expect(() =>
      resolveOrdinaryJunctionTopology({
        relation: targets,
        table: "source_target",
        source: { model: sourceModel, modelName: "source", rowKey: [] },
        target: { model: targetModel, modelName: "target", rowKey: ["id"] },
      })
    ).toThrowError(
      "Model 'source' has no primary key; a junction side requires a complete row key."
    );
    expect(() =>
      resolveOrdinaryJunctionTopology({
        relation: targets,
        table: "source_target",
        source: { model: sourceModel, modelName: "source", rowKey: ["id"] },
        target: { model: targetModel, modelName: "target", rowKey: [] },
      })
    ).toThrowError(
      "Model 'target' has no primary key; a junction side requires a complete row key."
    );
  });

  test("surfaces the helpers' invalid raw side token refusal from construction", () => {
    const targets = s.manyToMany(() => targetModel).A("1bad");
    const sourceModel = s.model({ id: s.string().id(), targets });
    const targetModel = s.model({ id: s.string().id() });
    hydrateSchemaNames({ sourceModel, targetModel });

    expect(() =>
      resolveOrdinaryJunctionTopology({
        relation: targets,
        table: "source_target",
        source: { model: sourceModel, modelName: "source", rowKey: ["id"] },
        target: { model: targetModel, modelName: "target", rowKey: ["id"] },
      })
    ).toThrowError(
      "Junction side prefix '1bad' is not a valid SQL identifier."
    );
  });

  test("carries the pair identity declared on either side", () => {
    const ownNamed = s.manyToMany(() => namedTag).name("featured");
    const ownNamedBack = s.manyToMany(() => namedPost).name("featured");
    const namedPost = s.model({ id: s.string().id(), tags: ownNamed });
    const namedTag = s.model({ id: s.string().id(), posts: ownNamedBack });
    hydrateSchemaNames({ namedPost, namedTag });

    const named = resolveOrdinaryJunctionTopology({
      relation: ownNamed,
      table: getJunctionTableName(ownNamed, "namedPost", "namedTag"),
      source: { model: namedPost, modelName: "namedPost", rowKey: ["id"] },
      target: { model: namedTag, modelName: "namedTag", rowKey: ["id"] },
    });
    expect(named.table).toBe("namedpost_namedtag_featured");
    expect(named.pairName).toBe("featured");

    const unnamedForward = s.manyToMany(() => curatedTag);
    const pairedNamed = s.manyToMany(() => curatedPost).name("curated");
    const curatedPost = s.model({ id: s.string().id(), tags: unnamedForward });
    const curatedTag = s.model({ id: s.string().id(), posts: pairedNamed });
    hydrateSchemaNames({ curatedPost, curatedTag });

    const inherited = resolveOrdinaryJunctionTopology({
      relation: unnamedForward,
      table: getJunctionTableName(unnamedForward, "curatedPost", "curatedTag"),
      source: { model: curatedPost, modelName: "curatedPost", rowKey: ["id"] },
      target: { model: curatedTag, modelName: "curatedTag", rowKey: ["id"] },
    });
    expect(inherited.table).toBe("curatedpost_curatedtag_curated");
    expect(inherited.pairName).toBe("curated");
  });
});

describe("resolved junction pair actions", () => {
  test("merges configured actions across the pair and defaults to undefined", () => {
    // Unpaired and unconfigured: nothing to merge.
    const looseTargets = s.manyToMany(() => looseTarget);
    const looseSource = s.model({ id: s.string().id(), targets: looseTargets });
    const looseTarget = s.model({ id: s.string().id() });
    hydrateSchemaNames({ looseSource, looseTarget });
    expect(
      resolveJunctionPairActions(looseTargets, "loosesource_loosetarget")
    ).toEqual({ onDelete: undefined, onUpdate: undefined });

    // Unpaired: the own side is the only carrier.
    const soloTargets = s
      .manyToMany(() => soloTarget)
      .onDelete("restrict")
      .onUpdate("noAction");
    const soloSource = s.model({ id: s.string().id(), targets: soloTargets });
    const soloTarget = s.model({ id: s.string().id() });
    hydrateSchemaNames({ soloSource, soloTarget });
    expect(
      resolveJunctionPairActions(soloTargets, "solosource_solotarget")
    ).toEqual({ onDelete: "restrict", onUpdate: "noAction" });

    // Paired with nothing configured on either side.
    const bareForward = s.manyToMany(() => bareTag);
    const bareBack = s.manyToMany(() => barePost);
    const barePost = s.model({ id: s.string().id(), tags: bareForward });
    const bareTag = s.model({ id: s.string().id(), posts: bareBack });
    hydrateSchemaNames({ barePost, bareTag });
    expect(resolveJunctionPairActions(bareForward, "barepost_baretag")).toEqual(
      { onDelete: undefined, onUpdate: undefined }
    );

    // The own side wins where configured; the paired side fills the rest.
    const crossForward = s.manyToMany(() => crossTag).onDelete("restrict");
    const crossBack = s.manyToMany(() => crossPost).onUpdate("setNull");
    const crossPost = s.model({ id: s.string().id(), tags: crossForward });
    const crossTag = s.model({ id: s.string().id(), posts: crossBack });
    hydrateSchemaNames({ crossPost, crossTag });
    expect(
      resolveJunctionPairActions(crossForward, "crosspost_crosstag")
    ).toEqual({ onDelete: "restrict", onUpdate: "setNull" });

    // Agreement on both sides is not a disagreement.
    const agreeForward = s
      .manyToMany(() => agreeTag)
      .onDelete("cascade")
      .onUpdate("restrict");
    const agreeBack = s
      .manyToMany(() => agreePost)
      .onDelete("cascade")
      .onUpdate("restrict");
    const agreePost = s.model({ id: s.string().id(), tags: agreeForward });
    const agreeTag = s.model({ id: s.string().id(), posts: agreeBack });
    hydrateSchemaNames({ agreePost, agreeTag });
    expect(
      resolveJunctionPairActions(agreeForward, "agreepost_agreetag")
    ).toEqual({ onDelete: "cascade", onUpdate: "restrict" });
  });

  test("refuses an onDelete disagreement with the serializer's exact message", () => {
    const forward = s.manyToMany(() => tag).onDelete("cascade");
    const back = s.manyToMany(() => post).onDelete("restrict");
    const post = s.model({ id: s.string().id(), tags: forward });
    const tag = s.model({ id: s.string().id(), posts: back });
    hydrateSchemaNames({ post, tag });

    expect(() => resolveJunctionPairActions(forward, "post_tag")).toThrowError(
      `Many-to-many relation pair for junction "post_tag" disagrees on onDelete: 'cascade' vs 'restrict'.`
    );
  });

  test("refuses an onUpdate disagreement with the serializer's exact message", () => {
    const forward = s.manyToMany(() => tag).onUpdate("cascade");
    const back = s.manyToMany(() => post).onUpdate("noAction");
    const post = s.model({ id: s.string().id(), tags: forward });
    const tag = s.model({ id: s.string().id(), posts: back });
    hydrateSchemaNames({ post, tag });

    expect(() => resolveJunctionPairActions(forward, "post_tag")).toThrowError(
      `Many-to-many relation pair for junction "post_tag" disagrees on onUpdate: 'cascade' vs 'noAction'.`
    );
  });
});

describe("polymorphic member junction topology", () => {
  test("derives declaration-shaped names and resolves the fixed-target topology", () => {
    const owner = s.model({ id: s.string().id() });
    const post = s.model({ id: s.string().id() });
    hydrateSchemaNames({ owner, post });

    const names = resolvePolymorphicMemberNames({
      ownerTableName: "owner",
      ownerModelName: "owner",
      relationField: "items",
      publicType: "post",
      ownerRowKeyIsCompound: false,
      targetRowKeyIsCompound: false,
      through: undefined,
    });
    // Declaration-shaped, NOT the sorted-alphabetical ordinary generator: a
    // member junction has an owner side and a variant side, not two peers.
    expect(names).toEqual({
      table: "owner_items_post",
      sourceToken: "ownerId",
      targetToken: "postId",
    });

    const topology = resolvePolymorphicMemberJunctionTopology({
      table: names.table,
      source: {
        model: owner,
        modelName: "owner",
        rowKey: ["id"],
        token: names.sourceToken,
      },
      target: {
        model: post,
        modelName: "post",
        rowKey: ["id"],
        token: names.targetToken,
      },
      pairName: "owner.items.post",
    });

    expect(topology.table).toBe("owner_items_post");
    expect(topology.source.members).toEqual([
      { junctionField: "ownerId", referencedField: "id" },
    ]);
    expect(topology.target.members).toEqual([
      { junctionField: "postId", referencedField: "id" },
    ]);
    expect(topology.sourceIsFirst).toBe(true);
    expect(topology.pairName).toBe("owner.items.post");
    // The three name methods in the validator's order…
    expect(topology.foreignKeyName("source")).toBe(
      "owner_items_post_ownerId_fkey"
    );
    expect(topology.foreignKeyName("target")).toBe(
      "owner_items_post_postId_fkey"
    );
    expect(topology.reverseIndexName()).toBe("owner_items_post_postId_idx");
  });

  test("asks the lazy name methods in the serializer's opposite order too", () => {
    const owner = s.model({ id: s.string().id() });
    const post = s.model({ id: s.string().id() });
    hydrateSchemaNames({ owner, post });
    const build = () =>
      resolvePolymorphicMemberJunctionTopology({
        table: "owner_items_post",
        source: {
          model: owner,
          modelName: "owner",
          rowKey: ["id"],
          token: "ownerId",
        },
        target: {
          model: post,
          modelName: "post",
          rowKey: ["id"],
          token: "postId",
        },
        pairName: undefined,
      });

    // idx → target fkey → source fkey (the reverse of the validator's asks),
    // then repeat asks for the memoized answers.
    const reversedAsks = build();
    expect(reversedAsks.reverseIndexName()).toBe("owner_items_post_postId_idx");
    expect(reversedAsks.foreignKeyName("target")).toBe(
      "owner_items_post_postId_fkey"
    );
    expect(reversedAsks.foreignKeyName("source")).toBe(
      "owner_items_post_ownerId_fkey"
    );
    expect(reversedAsks.foreignKeyName("source")).toBe(
      "owner_items_post_ownerId_fkey"
    );
    expect(reversedAsks.pairName).toBeUndefined();
  });

  test("derives compound prefixes per side and variant-derived self-target tokens", () => {
    const compoundNames = resolvePolymorphicMemberNames({
      ownerTableName: "workspaces",
      ownerModelName: "Workspace",
      relationField: "pinned",
      publicType: "Doc",
      ownerRowKeyIsCompound: true,
      targetRowKeyIsCompound: true,
      through: undefined,
    });
    expect(compoundNames).toEqual({
      table: "workspaces_pinned_Doc",
      sourceToken: "workspace",
      targetToken: "doc",
    });

    // A self target stays naturally distinct because the target token derives
    // from the VARIANT, not the model name.
    const selfNames = resolvePolymorphicMemberNames({
      ownerTableName: "node",
      ownerModelName: "node",
      relationField: "children",
      publicType: "child",
      ownerRowKeyIsCompound: false,
      targetRowKeyIsCompound: false,
      through: undefined,
    });
    expect(selfNames).toEqual({
      table: "node_children_child",
      sourceToken: "nodeId",
      targetToken: "childId",
    });

    // A variant spelling the owner's own name collides — refused through the
    // ONE cross-side collision guard, escaped via `.through()`.
    const collidingNames = resolvePolymorphicMemberNames({
      ownerTableName: "node",
      ownerModelName: "node",
      relationField: "twins",
      publicType: "node",
      ownerRowKeyIsCompound: false,
      targetRowKeyIsCompound: false,
      through: undefined,
    });
    expect(collidingNames.sourceToken).toBe(collidingNames.targetToken);
    const node = s.model({ id: s.string().id() });
    hydrateSchemaNames({ node });
    expect(() =>
      resolvePolymorphicMemberJunctionTopology({
        table: collidingNames.table,
        source: {
          model: node,
          modelName: "node",
          rowKey: ["id"],
          token: collidingNames.sourceToken,
        },
        target: {
          model: node,
          modelName: "node",
          rowKey: ["id"],
          token: collidingNames.targetToken,
        },
        pairName: undefined,
      })
    ).toThrowError("collide after compound-prefix expansion");
  });

  test("an explicit .through() entry overrides all three names", () => {
    expect(
      resolvePolymorphicMemberNames({
        ownerTableName: "owner",
        ownerModelName: "owner",
        relationField: "items",
        publicType: "post",
        ownerRowKeyIsCompound: true,
        targetRowKeyIsCompound: true,
        through: {
          table: "custom_members",
          source: "holderRef",
          target: "entryRef",
        },
      })
    ).toEqual({
      table: "custom_members",
      sourceToken: "holderRef",
      targetToken: "entryRef",
    });
  });

  test("refuses equal side tokens lazily on the first foreign-key ask", () => {
    const owner = s.model({ id: s.string().id() });
    const compound = s
      .model({ tenantId: s.string(), localId: s.string() })
      .id(["tenantId", "localId"]);
    hydrateSchemaNames({ owner, compound });

    // Scalar token vs generated compound prefix: the EXPANSIONS differ in
    // arity (`shared` vs `shared_1`/`shared_2`), so the field-collision guard
    // never sees them — only the fkey derivation would collide.
    const topology = resolvePolymorphicMemberJunctionTopology({
      table: "owner_items_pair",
      source: {
        model: owner,
        modelName: "owner",
        rowKey: ["id"],
        token: "shared",
      },
      target: {
        model: compound,
        modelName: "compound",
        rowKey: ["tenantId", "localId"],
        token: "shared",
      },
      pairName: undefined,
    });
    // Construction and the reverse index stay serviceable…
    expect(topology.source.members).toEqual([
      { junctionField: "shared", referencedField: "id" },
    ]);
    expect(topology.target.members).toEqual([
      { junctionField: "shared_1", referencedField: "tenantId" },
      { junctionField: "shared_2", referencedField: "localId" },
    ]);
    expect(topology.reverseIndexName()).toBe("owner_items_pair_shared_idx");
    // …and BOTH fkey asks refuse with the collision kind.
    for (const side of ["source", "target"] as const) {
      let refusal: unknown;
      try {
        topology.foreignKeyName(side);
      } catch (error) {
        refusal = error;
      }
      expect(refusal).toBeInstanceOf(JunctionPhysicalNameError);
      expect(refusal).toMatchObject({
        kind: "collision",
        message: `Junction sides of 'owner_items_pair' share naming token 'shared' and would derive the same foreign-key constraint name.`,
      });
    }
  });

  test("the same-token refusal covers the ordinary pair's JT004 blind spot", () => {
    // The recorded hazard: an explicit scalar token on one side equal to the
    // GENERATED compound prefix of the other. JT004's raw check cannot see the
    // generated prefix, and the differing expansion arity dodges the
    // field-collision guard — the topology's lazy fkey refusal is the sole
    // owner, surfaced by `junctionFieldsValid` as JT003.
    const forward = s.manyToMany(() => compoundTag).A("compoundtag");
    const post = s.model({ id: s.string().id(), tags: forward });
    const compoundTag = s
      .model({
        tenantId: s.string(),
        localId: s.string(),
        posts: s.manyToMany(() => post),
      })
      .id(["tenantId", "localId"]);
    hydrateSchemaNames({ post, compoundtag: compoundTag });

    const table = getJunctionTableName(forward, "post", "compoundtag");
    const topology = resolveOrdinaryJunctionTopology({
      relation: forward,
      table,
      source: { model: post, modelName: "post", rowKey: ["id"] },
      target: {
        model: compoundTag,
        modelName: "compoundtag",
        rowKey: ["tenantId", "localId"],
      },
    });
    expect(() => topology.foreignKeyName("source")).toThrowError(
      JunctionPhysicalNameError
    );
  });
});
