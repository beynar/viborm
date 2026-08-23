/**
 * Canonical relation TOPOLOGY corpus (plan §6.3, §6.5, §9.4, §10 A items 4-6).
 *
 * ONE named case per topology cell the unified relation language has to answer
 * for. Where `relation-ddl-corpus.ts` pins what a schema SERIALIZES TO, this
 * corpus pins what the definition gate SAYS ABOUT IT: accepted or refused, with
 * which codes, at which model and relation.
 *
 * The two are deliberately different objects. A schema can be physically
 * preserved and verdict-changed at once (`one-one-derived-unique-missing` is
 * both), and the plan's preservation promise (§9.3) and its deliberate-break
 * list (§9.4) are separate claims that must not be provable by the same
 * assertion.
 *
 * DECLARATIONS ONLY. The frozen HEAD verdicts live in
 * `relation-topology-baseline.ts`. Package F rewrites the declarations below
 * into the final relation language; the baseline stays frozen, and a rewrite
 * that changes any cell's verdict turns the matrix suite red.
 *
 * Every case builds FRESH model objects on each call, so no model object is
 * ever hydrated under two schema keys (ruling D13).
 */

import { s } from "@schema";
import type { AnyModel } from "@schema/model";

/**
 * What the plan does with this case's CURRENT verdict.
 *
 * `preserved` — the verdict must survive the cutover unchanged.
 * `break-becomes-error` — §9.4: HEAD accepts it, the plan refuses it.
 * `break-becomes-valid` — §9.4/§7.1: HEAD refuses it, the plan accepts it.
 * `break-semantics` — both accept it; the derived meaning changes.
 */
export type TopologyDisposition =
  | "preserved"
  | "break-becomes-error"
  | "break-becomes-valid"
  | "break-semantics";

export interface RelationTopologyCase {
  /** Stable identifier; also the baseline key. Never renamed. */
  readonly id: string;
  readonly title: string;
  /** The plan clause whose cell this case occupies. */
  readonly cell: string;
  /** The question HEAD's verdict answers here. */
  readonly asks: readonly string[];
  readonly disposition: TopologyDisposition;
  /**
   * The verdict the plan gives this case, with its clause. Required for every
   * disposition except `preserved`; it is metadata, never an assertion, so the
   * corpus stays green on HEAD (plan §10 A exit evidence).
   */
  readonly intended?: string;
  readonly build: () => Record<string, AnyModel>;
}

// =============================================================================
// ORDINARY CARDINALITY CELLS (plan §6.3)
// =============================================================================

/** one/one, exactly one FK owner, uniqueness declared on the owner's scalar. */
const oneOneSingleOwner = (): Record<string, AnyModel> => {
  const user = s.model({
    id: s.string().id(),
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
  return { user, profile };
};

/** one/one whose FK scalar carries no declared uniqueness. */
const oneOneDerivedUniqueMissing = (): Record<string, AnyModel> => {
  const user = s.model({
    id: s.string().id(),
    profile: s.toOne(() => profile),
  });
  const profile = s.model({
    id: s.string().id(),
    userId: s.string(),
    user: s
      .toOne(() => user)
      .fields("userId")
      .references("id"),
  });
  return { user, profile };
};

/** one/one where NEITHER endpoint completed a foreign key. */
const oneOneZeroOwners = (): Record<string, AnyModel> => {
  const user = s.model({
    id: s.string().id(),
    profile: s.toOne(() => profile),
  });
  const profile = s.model({
    id: s.string().id(),
    user: s.toOne(() => user),
  });
  return { user, profile };
};

/**
 * one/one where BOTH endpoints completed a foreign key. Both are `.optional()`
 * so the pair does not also trip the circular-required-chain rule, which would
 * hide the ownership verdict behind an unrelated code.
 */
const oneOneTwoOwners = (): Record<string, AnyModel> => {
  const user = s.model({
    id: s.string().id(),
    profileId: s.string().unique(),
    profile: s
      .toOne(() => profile)
      .fields("profileId")
      .references("id"),
  });
  const profile = s.model({
    id: s.string().id(),
    userId: s.string().unique(),
    user: s
      .toOne(() => user)
      .fields("userId")
      .references("id"),
  });
  return { user, profile };
};

/** one/many with a required foreign key on the `one` endpoint. */
const oneManyRequiredFk = (): Record<string, AnyModel> => {
  const user = s.model({
    id: s.string().id(),
    posts: s.toMany(() => post),
  });
  const post = s.model({
    id: s.string().id(),
    authorId: s.string(),
    author: s
      .toOne(() => user)
      .fields("authorId")
      .references("id"),
  });
  return { user, post };
};

/** one/many whose nullable foreign key AGREES with a declared `.optional()`. */
const oneManyNullableFkOptional = (): Record<string, AnyModel> => {
  const user = s.model({
    id: s.string().id(),
    posts: s.toMany(() => post),
  });
  const post = s.model({
    id: s.string().id(),
    authorId: s.string().nullable(),
    author: s
      .toOne(() => user)
      .fields("authorId")
      .references("id"),
  });
  return { user, post };
};

/**
 * A nullable foreign key with NO `.optional()`: the declared flag says required
 * while the scalar tuple says the membership can be absent. HEAD believes the
 * flag (see `relation-nullability-parity.core.test.ts` for the behavior this
 * produces today).
 */
const toOneNullableFkWithoutOptional = (): Record<string, AnyModel> => {
  const user = s.model({
    id: s.string().id(),
    posts: s.toMany(() => post),
  });
  const post = s.model({
    id: s.string().id(),
    authorId: s.string().nullable(),
    author: s
      .toOne(() => user)
      .fields("authorId")
      .references("id"),
  });
  return { user, post };
};

/** A required `.optional()`-free tuple contradicted by an `.optional()` flag. */
const toOneRequiredFkWithOptional = (): Record<string, AnyModel> => {
  const user = s.model({
    id: s.string().id(),
    posts: s.toMany(() => post),
  });
  const post = s.model({
    id: s.string().id(),
    authorId: s.string(),
    author: s
      .toOne(() => user)
      .fields("authorId")
      .references("id"),
  });
  return { user, post };
};

/** A to-one endpoint that never states a foreign key at all. */
const manyOneWithoutFields = (): Record<string, AnyModel> => {
  const user = s.model({
    id: s.string().id(),
    posts: s.toMany(() => post),
  });
  const post = s.model({
    id: s.string().id(),
    author: s.toOne(() => user),
  });
  return { user, post };
};

/**
 * `.fields()` called with NO arguments — the malformed ownership spelling.
 *
 * The refusal is a CONSTRUCTION refusal now, so this case never reaches the
 * definition gate; `@ts-expect-error` is the type half of the same witness.
 */
const zeroArgumentFields = (): Record<string, AnyModel> => {
  const user = s.model({
    id: s.string().id(),
    posts: s.toMany(() => post),
  });
  const post = s.model({
    id: s.string().id(),
    // @ts-expect-error §11.1.8: `.fields()` requires a non-empty tuple.
    author: s.toOne(() => user).fields(),
  });
  return { user, post };
};

/** A required non-owning to-one that never called `.optional()`. */
const oneOneInverseWithoutOptional = (): Record<string, AnyModel> => {
  const user = s.model({
    id: s.string().id(),
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
  return { user, profile };
};

/** many/many: one junction, no row foreign key on either endpoint. */
const manyManyDefault = (): Record<string, AnyModel> => {
  const post = s.model({
    id: s.string().id(),
    tags: s.toMany(() => tag),
  });
  const tag = s.model({
    id: s.string().id(),
    posts: s.toMany(() => post),
  });
  return { post, tag };
};

/** The mirrored spelling where BOTH endpoints repeat the same junction facts. */
const manyManyEqualOverridesOnBothEndpoints = (): Record<string, AnyModel> => {
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

/** The same spelling with CONTRADICTING facts on the two endpoints. */
const manyManyConflictingOverrides = (): Record<string, AnyModel> => {
  const post = s.model({
    id: s.string().id(),
    tags: s.toMany(() => tag).through("post_tag_links"),
  });
  const tag = s.model({
    id: s.string().id(),
    posts: s.toMany(() => post).through("tag_post_links"),
  });
  return { post, tag };
};

/**
 * `setNull` on a junction whose membership-key columns are non-null.
 *
 * The refusal moved to the modifier itself (§4.4), so this case never reaches
 * the definition gate either.
 */
const manyManyJunctionSetNull = (): Record<string, AnyModel> => {
  const post = s.model({
    id: s.string().id(),
    // @ts-expect-error §9.4: a junction action is cascade/restrict/noAction.
    tags: s.toMany(() => tag).onDelete("setNull"),
  });
  const tag = s.model({
    id: s.string().id(),
    posts: s.toMany(() => post),
  });
  return { post, tag };
};

/** A unique foreign key tuple facing a remote to-MANY declaration. */
const uniqueFkFacingRemoteToMany = (): Record<string, AnyModel> => {
  const user = s.model({
    id: s.string().id(),
    posts: s.toMany(() => post),
  });
  const post = s.model({
    id: s.string().id(),
    authorId: s.string().unique(),
    author: s
      .toOne(() => user)
      .fields("authorId")
      .references("id"),
  });
  return { user, post };
};

/** A mixed-nullability compound foreign key: required context, nullable member. */
const mixedNullabilityCompoundFk = (): Record<string, AnyModel> => {
  const author = s
    .model({
      tenantId: s.string(),
      id: s.string(),
      posts: s.toMany(() => post),
    })
    .id(["tenantId", "id"]);
  const post = s.model({
    id: s.string().id(),
    tenantId: s.string(),
    authorId: s.string().nullable(),
    author: s
      .toOne(() => author)
      .fields("tenantId", "authorId")
      .references("tenantId", "id"),
  });
  return { author, post };
};

// =============================================================================
// MISSING INVERSES — one case per current code (ruling D6 keeps ONE of them)
// =============================================================================

const missingInverseOneToOne = (): Record<string, AnyModel> => {
  const user = s.model({
    id: s.string().id(),
    profile: s.toOne(() => profile),
  });
  const profile = s.model({ id: s.string().id(), bio: s.string() });
  return { user, profile };
};

const missingInverseOneToMany = (): Record<string, AnyModel> => {
  const user = s.model({
    id: s.string().id(),
    posts: s.toMany(() => post),
  });
  const post = s.model({ id: s.string().id(), title: s.string() });
  return { user, post };
};

const missingInverseManyToOne = (): Record<string, AnyModel> => {
  const user = s.model({ id: s.string().id(), name: s.string() });
  const post = s.model({
    id: s.string().id(),
    authorId: s.string(),
    author: s
      .toOne(() => user)
      .fields("authorId")
      .references("id"),
  });
  return { user, post };
};

const missingInverseManyToMany = (): Record<string, AnyModel> => {
  const post = s.model({
    id: s.string().id(),
    tags: s.toMany(() => tag),
  });
  const tag = s.model({ id: s.string().id(), label: s.string() });
  return { post, tag };
};

// =============================================================================
// PAIRING NAMES (plan §6.2) — the exact-label partition HEAD does not have
// =============================================================================

/** Two candidate back-references and no name to choose between them. */
const ambiguousUnnamedCandidates = (): Record<string, AnyModel> => {
  const user = s.model({
    id: s.string().id(),
    posts: s.toMany(() => post),
  });
  const post = s.model({
    id: s.string().id(),
    authorId: s.string(),
    editorId: s.string(),
    author: s
      .toOne(() => user)
      .fields("authorId")
      .references("id"),
    editor: s
      .toOne(() => user)
      .fields("editorId")
      .references("id"),
  });
  return { user, post };
};

/** Two pairs between the same models, each with one matching name on both sides. */
const namedMultiPair = (): Record<string, AnyModel> => {
  const user = s.model({
    id: s.string().id(),
    written: s.toMany(() => post).name("PostAuthor"),
    edited: s.toMany(() => post).name("PostEditor"),
  });
  const post = s.model({
    id: s.string().id(),
    authorId: s.string(),
    editorId: s.string(),
    author: s
      .toOne(() => user)
      .name("PostAuthor")
      .fields("authorId")
      .references("id"),
    editor: s
      .toOne(() => user)
      .name("PostEditor")
      .fields("editorId")
      .references("id"),
  });
  return { user, post };
};

/** A sole candidate pair where only ONE endpoint states a name. */
const nameOnOneSideOnly = (): Record<string, AnyModel> => {
  const user = s.model({
    id: s.string().id(),
    posts: s.toMany(() => post).name("PostAuthor"),
  });
  const post = s.model({
    id: s.string().id(),
    authorId: s.string(),
    author: s
      .toOne(() => user)
      .fields("authorId")
      .references("id"),
  });
  return { user, post };
};

/** A sole candidate pair whose two endpoints state DIFFERENT names. */
const namesMismatchedOnBothSides = (): Record<string, AnyModel> => {
  const user = s.model({
    id: s.string().id(),
    posts: s.toMany(() => post).name("WrittenPosts"),
  });
  const post = s.model({
    id: s.string().id(),
    authorId: s.string(),
    author: s
      .toOne(() => user)
      .name("PostAuthor")
      .fields("authorId")
      .references("id"),
  });
  return { user, post };
};

/**
 * One ordinary candidate and one variant member candidate on the same target,
 * with no name to separate them.
 */
const ambiguousOrdinaryVersusVariant = (): Record<string, AnyModel> => {
  const post = s.model({
    id: s.string().id(),
    comments: s.toMany(() => comment),
  });
  const note = s.model({ id: s.string().id(), body: s.string() });
  const comment = s.model({
    id: s.string().id(),
    postId: s.string(),
    post: s
      .toOne(() => post)
      .fields("postId")
      .references("id"),
    subject: s.toOne({ post: () => post, note: () => note }),
  });
  return { post, note, comment };
};

// =============================================================================
// SELF EDGES (plan §6.4)
// =============================================================================

const selfParentChildren = (): Record<string, AnyModel> => {
  const node = s.model({
    id: s.string().id(),
    parentId: s.string().nullable(),
    parent: s
      .toOne(() => node)
      .fields("parentId")
      .references("id"),
    children: s.toMany(() => node),
  });
  return { node };
};

/** A self to-many with no second slot to pair with. */
const selfManyToManyLone = (): Record<string, AnyModel> => {
  const node = s.model({
    id: s.string().id(),
    links: s.toMany(() => node),
  });
  return { node };
};

/** Two paired self to-many slots that do NOT configure their side tokens. */
const selfManyToManyPairedDefaultTokens = (): Record<string, AnyModel> => {
  const node = s.model({
    id: s.string().id(),
    following: s.toMany(() => node).name("Follows"),
    followers: s.toMany(() => node).name("Follows"),
  });
  return { node };
};

/** The same pair with explicit mirrored side tokens. */
const selfManyToManyPairedExplicitTokens = (): Record<string, AnyModel> => {
  const node = s.model({
    id: s.string().id(),
    following: s
      .toMany(() => node)
      .name("Follows")
      .source("followerId")
      .target("followingId"),
    followers: s
      .toMany(() => node)
      .name("Follows")
      .source("followingId")
      .target("followerId"),
  });
  return { node };
};

/** Two distinctly named self pairs on one model. */
const twoNamedSelfPairs = (): Record<string, AnyModel> => {
  const person = s.model({
    id: s.string().id(),
    parentId: s.string().nullable(),
    managerId: s.string().nullable(),
    parent: s
      .toOne(() => person)
      .name("Lineage")
      .fields("parentId")
      .references("id"),
    children: s.toMany(() => person).name("Lineage"),
    manager: s
      .toOne(() => person)
      .name("Reporting")
      .fields("managerId")
      .references("id"),
    reports: s.toMany(() => person).name("Reporting"),
  });
  return { person };
};

// =============================================================================
// `.extends()` — one relation instance under two contextual slots
// =============================================================================

const extendsSharedRelation = (): Record<string, AnyModel> => {
  const media = s.model({
    id: s.string().id(),
    ownerId: s.string(),
    owner: s
      .toOne(() => user)
      .fields("ownerId")
      .references("id"),
  });
  const image = media.extends({ width: s.int() });
  const video = media.extends({ duration: s.int() });
  const user = s.model({
    id: s.string().id(),
    images: s.toMany(() => image),
    videos: s.toMany(() => video),
  });
  return { user, image, video };
};

// =============================================================================
// VARIANT TOPOLOGY CELLS (plan §6.5)
// =============================================================================

const variantRowDirectOnly = (): Record<string, AnyModel> => {
  const post = s.model({ id: s.string().id(), title: s.string() });
  const video = s.model({ id: s.string().id(), title: s.string() });
  const comment = s.model({
    id: s.string().id(),
    subject: s.toOne({ post: () => post, video: () => video }),
  });
  return { post, video, comment };
};

/** Cell 1: row carrier bound to to-ONE inverses. */
const variantRowToOneInverse = (): Record<string, AnyModel> => {
  const post = s.model({
    id: s.string().id(),
    featured: s.toOne(() => comment).name("subject"),
  });
  const video = s.model({
    id: s.string().id(),
    featured: s.toOne(() => comment).name("subject"),
  });
  const comment = s.model({
    id: s.string().id(),
    subject: s.toOne({ post: () => post, video: () => video }).name("subject"),
  });
  return { post, video, comment };
};

/** Cell 2: row carrier bound to to-MANY inverses. */
const variantRowToManyInverse = (): Record<string, AnyModel> => {
  const post = s.model({
    id: s.string().id(),
    comments: s.toMany(() => comment).name("subject"),
  });
  const video = s.model({
    id: s.string().id(),
    comments: s.toMany(() => comment).name("subject"),
  });
  const comment = s.model({
    id: s.string().id(),
    subject: s.toOne({ post: () => post, video: () => video }).name("subject"),
  });
  return { post, video, comment };
};

/** One portable index, two disagreeing inverse cardinalities. */
const variantRowMixedInverses = (): Record<string, AnyModel> => {
  const post = s.model({
    id: s.string().id(),
    featured: s.toOne(() => comment).name("subject"),
  });
  const video = s.model({
    id: s.string().id(),
    comments: s.toMany(() => comment).name("subject"),
  });
  const comment = s.model({
    id: s.string().id(),
    subject: s.toOne({ post: () => post, video: () => video }).name("subject"),
  });
  return { post, video, comment };
};

/** An `.optional()` row carrier: its private storage columns accept null. */
const variantRowOptional = (): Record<string, AnyModel> => {
  const post = s.model({ id: s.string().id() });
  const video = s.model({ id: s.string().id() });
  const comment = s.model({
    id: s.string().id(),
    subject: s.toOne({ post: () => post, video: () => video }).optional(),
  });
  return { post, video, comment };
};

/** One target model under two variant keys, read and written directly. */
const variantRepeatedTargetDirectOnly = (): Record<string, AnyModel> => {
  const doc = s.model({ id: s.string().id(), title: s.string() });
  const audit = s.model({
    id: s.string().id(),
    subject: s.toOne(
      { draft: () => doc, published: () => doc },
      { values: { draft: "doc.draft.v1", published: "doc.published.v1" } }
    ),
  });
  return { doc, audit };
};

/** The same repeated target with an inverse that cannot choose a member. */
const variantRepeatedTargetWithInverse = (): Record<string, AnyModel> => {
  const doc = s.model({
    id: s.string().id(),
    audits: s.toMany(() => audit).name("subject"),
  });
  const audit = s.model({
    id: s.string().id(),
    subject: s
      .toOne(
        { draft: () => doc, published: () => doc },
        { values: { draft: "doc.draft.v1", published: "doc.published.v1" } }
      )
      .name("subject"),
  });
  return { doc, audit };
};

/** Variant targets whose row identities cannot share one private id column. */
const variantRowIncompatibleIdentity = (): Record<string, AnyModel> => {
  const post = s.model({ id: s.string().id() });
  const clip = s.model({ id: s.int().id() });
  const comment = s.model({
    id: s.string().id(),
    subject: s.toOne({ post: () => post, clip: () => clip }),
  });
  return { post, clip, comment };
};

const variantMemberDirectOnly = (): Record<string, AnyModel> => {
  const book = s.model({ id: s.string().id(), title: s.string() });
  const video = s.model({ id: s.string().id(), title: s.string() });
  const shelf = s.model({
    id: s.string().id(),
    items: s.toMany({ book: () => book, video: () => video }),
  });
  return { book, video, shelf };
};

/** Cell 3: member junctions with a to-ONE inverse on every variant. */
const variantMemberToOneInverse = (): Record<string, AnyModel> => {
  const book = s.model({
    id: s.string().id(),
    shelf: s.toOne(() => shelf),
  });
  const video = s.model({
    id: s.string().id(),
    shelf: s.toOne(() => shelf),
  });
  const shelf = s.model({
    id: s.string().id(),
    items: s.toMany({ book: () => book, video: () => video }),
  });
  return { book, video, shelf };
};

/** Cell 4: member junctions with a to-MANY inverse on every variant. */
const variantMemberToManyInverse = (): Record<string, AnyModel> => {
  const book = s.model({
    id: s.string().id(),
    shelves: s.toMany(() => shelf),
  });
  const video = s.model({
    id: s.string().id(),
    shelves: s.toMany(() => shelf),
  });
  const shelf = s.model({
    id: s.string().id(),
    items: s.toMany({ book: () => book, video: () => video }),
  });
  return { book, video, shelf };
};

/** Member junctions derive uniqueness per variant, so mixing is legal. */
const variantMemberMixedInverses = (): Record<string, AnyModel> => {
  const book = s.model({
    id: s.string().id(),
    shelf: s.toOne(() => shelf),
  });
  const video = s.model({
    id: s.string().id(),
    shelves: s.toMany(() => shelf),
  });
  const shelf = s.model({
    id: s.string().id(),
    items: s.toMany({ book: () => book, video: () => video }),
  });
  return { book, video, shelf };
};

/** Two inverse relations on one variant model, both binding the same member. */
const variantMemberTwoInverses = (): Record<string, AnyModel> => {
  const book = s.model({
    id: s.string().id(),
    shelf: s.toOne(() => shelf),
    shelves: s.toMany(() => shelf),
  });
  const video = s.model({ id: s.string().id(), title: s.string() });
  const shelf = s.model({
    id: s.string().id(),
    items: s.toMany({ book: () => book, video: () => video }),
  });
  return { book, video, shelf };
};

/** A bound inverse that tries to configure the carrier's member junction. */
const variantMemberInverseConfiguresJunction = (): Record<string, AnyModel> => {
  const book = s.model({
    id: s.string().id(),
    shelves: s.toMany(() => shelf).through("book_shelf_links"),
  });
  const video = s.model({ id: s.string().id(), title: s.string() });
  const shelf = s.model({
    id: s.string().id(),
    items: s.toMany({ book: () => book, video: () => video }),
  });
  return { book, video, shelf };
};

/** A singular inverse of a member junction that never called `.optional()`. */
const variantMemberSingularInverseRequired = (): Record<string, AnyModel> => {
  const book = s.model({
    id: s.string().id(),
    shelf: s.toOne(() => shelf),
  });
  const video = s.model({ id: s.string().id(), title: s.string() });
  const shelf = s.model({
    id: s.string().id(),
    items: s.toMany({ book: () => book, video: () => video }),
  });
  return { book, video, shelf };
};

/** A one-key variant map. */
const variantSingleKeyMap = (): Record<string, AnyModel> => {
  const post = s.model({ id: s.string().id(), title: s.string() });
  const comment = s.model({
    id: s.string().id(),
    subject: s.toOne({ post: () => post }),
  });
  return { post, comment };
};

/**
 * An ordinary slot that completed a foreign key and ALSO faces a variant
 * carrier containing its source model.
 */
const variantInverseWithCompletedFk = (): Record<string, AnyModel> => {
  const book = s.model({
    id: s.string().id(),
    shelfId: s.string(),
    shelf: s
      .toOne(() => shelf)
      .fields("shelfId")
      .references("id"),
  });
  const video = s.model({ id: s.string().id(), title: s.string() });
  const shelf = s.model({
    id: s.string().id(),
    items: s.toMany({ book: () => book, video: () => video }),
  });
  return { book, video, shelf };
};

/** A member-junction inverse whose target ALSO declares an ordinary junction. */
const variantMemberInverseWithOrdinaryPartner = (): Record<
  string,
  AnyModel
> => {
  const book = s.model({
    id: s.string().id(),
    shelves: s.toMany(() => shelf),
  });
  const video = s.model({ id: s.string().id(), title: s.string() });
  const shelf = s.model({
    id: s.string().id(),
    books: s.toMany(() => book),
    items: s.toMany({ book: () => book, video: () => video }),
  });
  return { book, video, shelf };
};

// =============================================================================
// THE CORPUS
// =============================================================================

export const relationTopologyCorpus: readonly RelationTopologyCase[] = [
  {
    id: "one-one-single-owner",
    title: "one/one with exactly one completed foreign key",
    cell: "§6.3 one|one",
    asks: ["does the canonical 1:1 spelling pass every definition rule"],
    disposition: "preserved",
    build: oneOneSingleOwner,
  },
  {
    id: "one-one-derived-unique-missing",
    title: "one/one whose foreign key is not separately declared unique",
    cell: "§6.3 one|one, §9.4 fourth becomes-valid bullet",
    asks: ["is a declared unique key REQUIRED beside the 1:1 declaration"],
    disposition: "break-becomes-valid",
    intended:
      "§9.4: valid. The paired to-one slots derive the physical unique constraint, so FK008's demand disappears; the constraint bytes do not change (see relation-ddl-corpus `one-to-one-derived-unique`).",
    build: oneOneDerivedUniqueMissing,
  },
  {
    id: "one-one-zero-owners",
    title: "one/one with no foreign key owner at all",
    cell: "§6.3 refused shapes, §9.4 ownerless bullet",
    asks: ["does HEAD accept a 1:1 edge that stores nothing"],
    disposition: "break-becomes-error",
    intended:
      "§6.3/§9.4: a definition error — 'two to-one endpoints with zero or two completed FK owners'. HEAD accepts it silently and fails later at query time.",
    build: oneOneZeroOwners,
  },
  {
    id: "one-one-two-owners",
    title: "one/one with a completed foreign key on BOTH endpoints",
    cell: "§6.3 refused shapes, §9.4 two-FK-owners bullet",
    asks: ["what severity does HEAD give a doubly-owned 1:1"],
    disposition: "break-becomes-error",
    intended:
      "§6.3/§9.4: a definition error. HEAD warns (CM003) and only from the alphabetically-first model (rules/relation.ts:492).",
    build: oneOneTwoOwners,
  },
  {
    id: "one-many-required-fk",
    title: "one/many with a required foreign key",
    cell: "§6.3 one|many",
    asks: ["does the canonical 1:N spelling pass every definition rule"],
    disposition: "preserved",
    build: oneManyRequiredFk,
  },
  {
    id: "one-many-nullable-fk-optional",
    title: "one/many whose nullable tuple agrees with its `.optional()` flag",
    cell: "§6.3 one|many, §8.4",
    asks: ["is the agreeing spelling accepted"],
    disposition: "preserved",
    build: oneManyNullableFkOptional,
  },
  {
    id: "to-one-nullable-fk-without-optional",
    title: "a nullable foreign key whose slot never called `.optional()`",
    cell: "§9.4 second truthful-semantics bullet",
    asks: ["does HEAD read requiredness from the flag or from the tuple"],
    disposition: "break-semantics",
    intended:
      "§8.1/§9.4: the result becomes nullable because a nullable member can make the membership absent. The definition verdict does not change; the derived nullability does.",
    build: toOneNullableFkWithoutOptional,
  },
  {
    id: "to-one-required-fk-with-optional",
    title: "an all-required foreign key carrying an `.optional()` flag",
    cell: "§9.4 second truthful-semantics bullet",
    asks: ["does HEAD accept a flag that contradicts a non-null tuple"],
    disposition: "break-semantics",
    intended:
      "§4.3/§9.1: `.optional()` stops existing on model-target relations, and the result becomes non-null because every member is required. §9.1 records this public type-shape change in the conversion manifest.",
    build: toOneRequiredFkWithOptional,
  },
  {
    id: "many-one-without-fields",
    title: "a to-one endpoint that never states a foreign key",
    cell: "§6.3 refused shapes, §9.4 ownerless bullet",
    asks: ["what severity does HEAD give a missing FK owner"],
    disposition: "break-becomes-error",
    intended:
      "§6.3/§9.4: a definition error ('an ordinary slot without an inverse … ownerless ordinary relations'). HEAD warns FK004.",
    build: manyOneWithoutFields,
  },
  {
    id: "zero-argument-fields",
    title: "`.fields()` called with no arguments",
    cell: "§9.4 malformed zero-argument bullet, §11.1.8",
    asks: ["does HEAD notice an empty foreign-key tuple at all"],
    disposition: "break-becomes-error",
    intended:
      "§4.3/§11.1.8: `.fields()` requires a non-empty tuple and returns a transient stage that is not a relation, so the call fails at construction and the model boundary refuses the stage (ruling D8). HEAD accepts it and treats it as fields-less, which even silences FK004.",
    build: zeroArgumentFields,
  },
  {
    id: "one-one-inverse-without-optional",
    title: "a required non-owning to-one",
    cell: "§9.4 third becomes-valid bullet, §7.1",
    asks: ["does HEAD demand a duplicated `.optional()` on the non-owner"],
    disposition: "break-becomes-valid",
    intended:
      "§7.1: valid, and R008 has no replacement — a non-owner is nullable by derivation, so there is no invalid state left for that guard to reject.",
    build: oneOneInverseWithoutOptional,
  },
  {
    id: "many-many-default",
    title: "many/many with default physical naming",
    cell: "§6.3 many|many",
    asks: ["does the canonical N:M spelling pass every definition rule"],
    disposition: "preserved",
    build: manyManyDefault,
  },
  {
    id: "many-many-equal-overrides-on-both-endpoints",
    title: "junction facts repeated identically on both endpoints",
    cell: "§9.3 consolidation, §9.4 both-endpoints bullet",
    asks: ["does HEAD accept a mirrored junction configuration"],
    disposition: "break-becomes-error",
    intended:
      "§9.3/§9.4: conversion consolidates the equal duplicate onto one canonical owner with an identical TableDef, and a NEWLY WRITTEN final-API schema that configures both endpoints is refused. The accepted-then-converted half is why this case is not simply an error.",
    build: manyManyEqualOverridesOnBothEndpoints,
  },
  {
    id: "many-many-conflicting-overrides",
    title: "junction facts that contradict across the two endpoints",
    cell: "§6.3 refused shapes",
    asks: ["is a contradicting mirrored junction refused"],
    disposition: "preserved",
    build: manyManyConflictingOverrides,
  },
  {
    id: "many-many-junction-set-null",
    title: "`setNull` on a junction membership key",
    cell: "§4.4, §9.4 setNull bullet",
    asks: ["does HEAD refuse setNull on a non-null junction column"],
    disposition: "break-becomes-error",
    intended:
      "§4.4/§9.4: junction actions accept only cascade/restrict/noAction; `setNull` is absent from the type and refused for hostile runtime input before DDL. HEAD's RA004 only inspects `.fields()`, which a junction never has.",
    build: manyManyJunctionSetNull,
  },
  {
    id: "unique-fk-facing-remote-to-many",
    title: "a unique foreign key facing a remote to-many slot",
    cell: "§6.3 refused shapes, §9.4 contradicting-uniqueness bullet",
    asks: ["does HEAD compare declared uniqueness against the paired slot"],
    disposition: "break-becomes-error",
    intended:
      "§6.3/§9.4: 'a physical unique constraint that contradicts a remote to-many declaration' is a definition error. HEAD has no rule for it.",
    build: uniqueFkFacingRemoteToMany,
  },
  {
    id: "mixed-nullability-compound-fk",
    title: "compound foreign key with one required and one nullable member",
    cell: "§9.4 first truthful-semantics bullet, §11.2.13",
    asks: [
      "is a mixed tuple accepted at definition time",
      "which advisory codes a compound primary key attracts",
    ],
    disposition: "break-semantics",
    intended:
      "§9.4: the slot is nullable and disconnectable by clearing only its nullable members; database `setNull` stays refused. The verdict does not change. FK005's blindness to compound keys (it tests each referenced scalar's own isId/isUnique) must be fixed BEFORE any package promotes it (see `relation-ddl-corpus`).",
    build: mixedNullabilityCompoundFk,
  },
  {
    id: "missing-inverse-one-to-one",
    title: "a lone to-one slot with no inverse",
    cell: "§6.3 refused shapes, ruling D6",
    asks: ["which code HEAD gives a missing 1:1 inverse"],
    disposition: "preserved",
    intended:
      "D6: R002 survives as the ONE missing/incomplete-inverse code; R003/R004/R005 are absorbed into it.",
    build: missingInverseOneToOne,
  },
  {
    id: "missing-inverse-one-to-many",
    title: "a lone to-many slot with no inverse",
    cell: "§6.3 refused shapes, ruling D6",
    asks: ["which code HEAD gives a missing 1:N inverse"],
    disposition: "preserved",
    intended: "D6: absorbed into R002.",
    build: missingInverseOneToMany,
  },
  {
    id: "missing-inverse-many-to-one",
    title: "a lone owning to-one slot with no inverse",
    cell: "§6.3 refused shapes, ruling D6",
    asks: ["which code HEAD gives a missing N:1 inverse"],
    disposition: "preserved",
    intended: "D6: absorbed into R002.",
    build: missingInverseManyToOne,
  },
  {
    id: "missing-inverse-many-to-many",
    title: "a lone junction slot with no inverse",
    cell: "§6.3 refused shapes, ruling D6",
    asks: ["which code HEAD gives a missing N:M inverse"],
    disposition: "preserved",
    intended: "D6: absorbed into R002.",
    build: missingInverseManyToMany,
  },
  {
    id: "ambiguous-unnamed-candidates",
    title: "two unnamed candidate back-references",
    cell: "§6.2 ambiguity, §9.4 loose-name bullet",
    asks: ["what severity does HEAD give an ambiguous inverse"],
    disposition: "break-becomes-error",
    intended:
      "§6.2: `ambiguousPartner` — a definition error, with no first-candidate fallback. HEAD warns R007 and every consumer silently takes candidate[0] (relation/types.ts:281-285).",
    build: ambiguousUnnamedCandidates,
  },
  {
    id: "named-multi-pair",
    title: "two pairs between the same models, both names matching",
    cell: "§6.2 exact label partition",
    asks: ["do two matching-name pairs stay separated"],
    disposition: "preserved",
    build: namedMultiPair,
  },
  {
    id: "name-on-one-side-only",
    title: "a sole candidate pair named on one endpoint only",
    cell: "§6.2 rule 3, §9.1 conversion",
    asks: ["does HEAD's sole-candidate rule ignore a one-sided name"],
    disposition: "break-becomes-error",
    intended:
      "§6.2: `nameMismatch` — 'a one-sided or mismatched name is nameMismatch, not permission to fall back'. §9.1 repairs it by copying the same name to the resolved partner. HEAD resolves a SOLE candidate whatever either side is named (inverse.ts:257-259, documented at relation/types.ts:206-207).",
    build: nameOnOneSideOnly,
  },
  {
    id: "names-mismatched-on-both-sides",
    title: "a sole candidate pair whose endpoints state different names",
    cell: "§6.2 rule 3, §9.4 loose-name bullet",
    asks: ["does HEAD's sole-candidate rule ignore two disagreeing names"],
    disposition: "break-becomes-error",
    intended:
      "§6.2: `nameMismatch`. §9.1 stops such an edge for manual repair when it cannot be converted to one exact matching-name pair.",
    build: namesMismatchedOnBothSides,
  },
  {
    id: "ambiguous-ordinary-versus-variant",
    title: "one ordinary and one variant candidate, no name to separate them",
    cell: "§6.2 rule 6, §9.4 ambiguous-candidates bullet, §11.2.9",
    asks: ["does HEAD prefer the ordinary candidate by precedence"],
    disposition: "break-becomes-error",
    intended:
      "§6.2: ambiguous — 'Do not prefer variant, ordinary, first, or sole-variant candidates.' HEAD's composed ladder tries a named polymorphic match, then ORDINARY, then the sole-group convenience rule (inverse.ts:79-112).",
    build: ambiguousOrdinaryVersusVariant,
  },
  {
    id: "self-parent-children",
    title: "a self parent/children pair",
    cell: "§6.4",
    asks: ["does the canonical self to-one pair pass every definition rule"],
    disposition: "preserved",
    build: selfParentChildren,
  },
  {
    id: "self-many-to-many-lone",
    title: "a self junction slot with no second slot",
    cell: "§6.4, §9.4 lone-self bullet",
    asks: ["does HEAD accept a self relation that pairs with itself"],
    disposition: "break-becomes-error",
    intended:
      "§6.4/§9.4: 'a lone self to-many declaration is refused' and 'one slot never pairs with itself'. HEAD's inverse probe walks the TARGET model's relations, which for a self edge includes the asking slot, so the slot satisfies its own inverse requirement (rules/relation.ts:649-651).",
    build: selfManyToManyLone,
  },
  {
    id: "self-many-to-many-paired-default-tokens",
    title: "two paired self junction slots with no explicit side tokens",
    cell: "§6.4, §9.4 second becomes-valid bullet",
    asks: ["does HEAD force explicit side tokens on a paired self junction"],
    disposition: "break-becomes-valid",
    intended:
      "§6.4/§9.4: valid — the default side token becomes the endpoint field key plus `Id` for a scalar row key. Because HEAD has no bytes for this shape, it is deliberately ABSENT from the DDL preservation corpus; there is nothing to preserve.",
    build: selfManyToManyPairedDefaultTokens,
  },
  {
    id: "self-many-to-many-paired-explicit-tokens",
    title: "two paired self junction slots with mirrored explicit tokens",
    cell: "§6.4, §9.3 consolidation, §9.4 both-endpoints bullet",
    asks: ["is the currently mandatory explicit self-junction spelling valid"],
    disposition: "break-becomes-error",
    intended:
      "§9.3/§9.4: the self instance of the both-endpoints bullet. HEAD REQUIRES the mirrored spelling on both slots (JT004 refuses anything else); the final API refuses it, because one physical junction has one configuration owner. Conversion consolidates the mirrored pair onto one endpoint with an identical TableDef — the same treatment as `many-many-equal-overrides-on-both-endpoints`, of which A classified this cell as `preserved` by reading only its §6.4 half.",
    build: selfManyToManyPairedExplicitTokens,
  },
  {
    id: "two-named-self-pairs",
    title: "two distinctly named self pairs on one model",
    cell: "§6.4, §11.2.10",
    asks: ["do two named self pairs stay separated"],
    disposition: "preserved",
    build: twoNamedSelfPairs,
  },
  {
    id: "extends-shared-relation",
    title: "one relation instance reused by two `.extends()` models",
    cell: "§5.3, §6.4 last bullet",
    asks: ["is a shared relation instance valid under two contextual slots"],
    disposition: "preserved",
    build: extendsSharedRelation,
  },
  {
    id: "variant-row-direct-only",
    title: "a row-held variant carrier with no inverse",
    cell: "§6.5 unbound row carrier",
    asks: ["is a wholly direct-only row carrier valid"],
    disposition: "preserved",
    build: variantRowDirectOnly,
  },
  {
    id: "variant-row-to-one-inverse",
    title: "row carrier bound to to-one inverses",
    cell: "§6.5 cell 1",
    asks: ["is the unique-composite-index cell valid"],
    disposition: "preserved",
    build: variantRowToOneInverse,
  },
  {
    id: "variant-row-to-many-inverse",
    title: "row carrier bound to to-many inverses",
    cell: "§6.5 cell 2",
    asks: ["is the non-unique-composite-index cell valid"],
    disposition: "preserved",
    build: variantRowToManyInverse,
  },
  {
    id: "variant-row-mixed-inverses",
    title: "row carrier bound to one to-one and one to-many inverse",
    cell: "§6.5 uniformity rule, §11.3.3",
    asks: ["is a mixed row-held inverse group refused"],
    disposition: "preserved",
    build: variantRowMixedInverses,
  },
  {
    id: "variant-row-optional",
    title: "an `.optional()` row carrier",
    cell: "§4.3, §8.4",
    asks: ["is the one legal variant optionality flag accepted"],
    disposition: "preserved",
    build: variantRowOptional,
  },
  {
    id: "variant-repeated-target-direct-only",
    title: "one target model under two variant keys, read directly",
    cell: "§4.2 last paragraph, §11.3.6",
    asks: ["is a repeated target model valid without an inverse"],
    disposition: "preserved",
    build: variantRepeatedTargetDirectOnly,
  },
  {
    id: "variant-repeated-target-with-inverse",
    title: "a repeated target model whose inverse cannot choose a member",
    cell: "§4.2, §9.4 repeated-variant bullet",
    asks: ["is an unchoosable variant inverse refused"],
    disposition: "preserved",
    intended:
      "§6.2: still refused, and the repair is unchanged — split the inverse-bearing variants onto separate carrier fields with matching `.name(...)` values. No member-selector API is introduced (§13).",
    build: variantRepeatedTargetWithInverse,
  },
  {
    id: "variant-row-incompatible-identity",
    title: "row-held variants whose identities cannot share one id column",
    cell: "§6.5 last paragraph, §11.3.8",
    asks: ["is the portable single-scalar identity restriction enforced"],
    disposition: "preserved",
    build: variantRowIncompatibleIdentity,
  },
  {
    id: "variant-member-direct-only",
    title: "member junctions with no inverse",
    cell: "§6.5 unbound member junction",
    asks: ["are direct-only member junctions valid"],
    disposition: "preserved",
    build: variantMemberDirectOnly,
  },
  {
    id: "variant-member-to-one-inverse",
    title: "member junctions bound to to-one inverses",
    cell: "§6.5 cell 3",
    asks: ["is the unique-target-tuple cell valid"],
    disposition: "preserved",
    build: variantMemberToOneInverse,
  },
  {
    id: "variant-member-to-many-inverse",
    title: "member junctions bound to to-many inverses",
    cell: "§6.5 cell 4",
    asks: ["is the non-unique-target-tuple cell valid"],
    disposition: "preserved",
    build: variantMemberToManyInverse,
  },
  {
    id: "variant-member-mixed-inverses",
    title: "member junctions with mixed inverse cardinalities",
    cell: "§6.5 independence rule, §11.3.4",
    asks: ["may member junctions mix inverse cardinalities"],
    disposition: "preserved",
    build: variantMemberMixedInverses,
  },
  {
    id: "variant-member-two-inverses",
    title: "two inverse relations binding one variant member",
    cell: "§11.3.5",
    asks: ["is a doubly bound member refused"],
    disposition: "preserved",
    build: variantMemberTwoInverses,
  },
  {
    id: "variant-member-inverse-configures-junction",
    title: "a bound inverse that configures the carrier's junction",
    cell: "§6.5 'it never configures carrier storage', §11.3.7",
    asks: ["is junction configuration on a variant inverse refused"],
    disposition: "preserved",
    build: variantMemberInverseConfiguresJunction,
  },
  {
    id: "variant-member-singular-inverse-required",
    title: "a required singular inverse of a member junction",
    cell: "§7.1 deleted guards, ruling D6",
    asks: [
      "how many codes HEAD emits for the one optional-inverse invariant",
      "does HEAD demand `.optional()` on a member-junction inverse",
    ],
    disposition: "break-becomes-valid",
    intended:
      "§7.1: valid. 'The old required non-owning inverse must call .optional() guards have no replacement.' D6: R008 and P021 are two spellings of ONE invariant and exactly one survivor code exists — this case is the witness that HEAD spells it twice.",
    build: variantMemberSingularInverseRequired,
  },
  {
    id: "variant-single-key-map",
    title: "a one-key variant map",
    cell: "§4.2 last bullet, §9.4 first becomes-valid bullet",
    asks: ["does HEAD warn about a single-variant carrier"],
    disposition: "break-becomes-valid",
    intended:
      "§4.2/§9.4: 'a one-key map is valid and has no warning.' The verdict is already `valid`; what changes is that the P011 warning disappears.",
    build: variantSingleKeyMap,
  },
  {
    id: "variant-inverse-with-completed-fk",
    title: "an ordinary slot with a completed foreign key facing a carrier",
    cell: "§6.5 'it has no completed fields/references', §11.3.7",
    asks: ["can a fields-bearing slot bind as a variant inverse"],
    disposition: "preserved",
    build: variantInverseWithCompletedFk,
  },
  {
    id: "variant-member-inverse-with-ordinary-partner",
    title: "a member-junction inverse whose target also declares a junction",
    cell: "§6.5, §6.2 rule 4",
    asks: ["is the ordinary/variant junction half-pair refused"],
    disposition: "preserved",
    build: variantMemberInverseWithOrdinaryPartner,
  },
];

// =============================================================================
// DELIBERATE-BREAK LEDGER (plan §9.4)
// =============================================================================

/**
 * Every §9.4 bullet, mapped to the corpus cases that witness it. The matrix
 * suite proves the mapping is total in both directions: no bullet without a
 * witness, no witness naming a bullet that does not exist.
 *
 * `model-object-registered-under-two-keys` has no schema-shaped witness — it is
 * a REGISTRATION fact, not a topology cell, and its witness is the hydration
 * pin in `relation-topology-matrix.core.test.ts`.
 */
export const deliberateBreakLedger: Readonly<
  Record<string, readonly string[]>
> = {
  "ordinary-slot-without-complete-inverse": [
    "missing-inverse-one-to-one",
    "missing-inverse-one-to-many",
    "missing-inverse-many-to-one",
    "missing-inverse-many-to-many",
  ],
  "ownerless-ordinary-relations": [
    "one-one-zero-owners",
    "many-one-without-fields",
  ],
  "two-fk-owners": ["one-one-two-owners"],
  "ambiguous-ordinary-versus-variant-candidates": [
    "ambiguous-ordinary-versus-variant",
  ],
  "loose-or-mismatched-mirrored-names": [
    "ambiguous-unnamed-candidates",
    "name-on-one-side-only",
    "names-mismatched-on-both-sides",
  ],
  "lone-self-relations": ["self-many-to-many-lone"],
  "final-api-junction-configured-on-both-endpoints": [
    "many-many-equal-overrides-on-both-endpoints",
    "self-many-to-many-paired-explicit-tokens",
  ],
  "set-null-on-a-junction-membership-key": ["many-many-junction-set-null"],
  "uniqueness-contradicting-paired-cardinality": [
    "unique-fk-facing-remote-to-many",
  ],
  "malformed-zero-argument-fk-ownership": ["zero-argument-fields"],
  "variant-inverse-matching-repeated-target-variants": [
    "variant-repeated-target-with-inverse",
  ],
  "model-object-registered-under-two-keys": [],
  "mixed-nullability-compound-fk-becomes-truthful": [
    "mixed-nullability-compound-fk",
  ],
  "owner-nullability-follows-the-scalar-tuple": [
    "to-one-nullable-fk-without-optional",
    "to-one-required-fk-with-optional",
  ],
  "one-key-variant-map-no-longer-warns": ["variant-single-key-map"],
  "paired-self-to-many-may-use-default-side-tokens": [
    "self-many-to-many-paired-default-tokens",
  ],
  "non-owning-to-one-needs-no-optional": [
    "one-one-inverse-without-optional",
    "variant-member-singular-inverse-required",
  ],
  "one-to-one-owner-needs-no-declared-unique": [
    "one-one-derived-unique-missing",
  ],
};
