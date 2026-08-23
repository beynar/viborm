/**
 * Canonical relation → DDL corpus (plan §9.3).
 *
 * ONE case per relation shape whose physical artifact the unified relation
 * language promises to preserve byte-for-byte: every ordinary cardinality cell,
 * self pairs, compound keys, mapped names, all four variant inverse cells,
 * direct-only variants, `.extends()`, default and explicit physical naming, the
 * one-endpoint-owns-every-override many-to-many spelling, named
 * multi-pair junctions, and the table ORDER a schema mixing an ordinary
 * junction with a later variant carrier produces.
 *
 * This file owns the DECLARATIONS only. The frozen expected artifacts live in
 * `relation-ddl-baseline.ts`, captured from HEAD. The two are separate on
 * purpose: the declarations here are rewritten to the final relation language
 * while the baseline stays frozen, and a rewrite that changes physical output
 * turns the preservation suite red.
 *
 * Every case builds FRESH model objects on each call, so a case may be
 * serialized and pushed independently without two schema keys ever claiming one
 * model object.
 */

import { s } from "@schema";
import type { AnyModel } from "@schema/model";

export type DdlDialect = "postgres" | "mysql" | "sqlite" | "libsql";

export interface RelationDdlCase {
  /** Stable identifier; also the baseline key. Never renamed. */
  readonly id: string;
  /** What relation shape this case is the witness for. */
  readonly title: string;
  /** The physical facts this case exists to pin. */
  readonly pins: readonly string[];
  /**
   * HEAD's definition-validator verdict for this schema. `"invalid"` cases are
   * serializer-only: their DDL is still a preservation target, and `intended`
   * records the verdict the plan gives them.
   */
  readonly headVerdict: "valid" | "invalid";
  /** Error codes HEAD reports; present exactly when `headVerdict` is invalid. */
  readonly headErrorCodes?: readonly string[];
  /** Plan reference for a verdict that deliberately changes later. */
  readonly intended?: string;
  /**
   * The verdict AFTER the plan's deliberate change, when it differs from HEAD's.
   * The suite asserts THIS one — `headVerdict` stays the frozen record of what
   * HEAD said, which is what makes the change readable as a change.
   */
  readonly intendedVerdict?: "valid" | "invalid";
  /** Error codes the final gate reports; empty for a case the plan accepts. */
  readonly intendedErrorCodes?: readonly string[];
  /** Dialects with a frozen baseline. Relation topology is dialect-neutral. */
  readonly dialects: readonly DdlDialect[];
  /** Included in the second-push-is-empty convergence set. */
  readonly converges: boolean;
  readonly build: () => Record<string, AnyModel>;
}

// =============================================================================
// ORDINARY CARDINALITY CELLS (plan §6.3)
// =============================================================================

/** one/one, FK owner carries an explicitly declared unique scalar. */
const oneToOneDeclaredUnique = (): Record<string, AnyModel> => {
  const user = s
    .model({
      id: s.string().id(),
      email: s.string(),
      profile: s.toOne(() => profile),
    })
    .map("o2o_declared_users");
  const profile = s
    .model({
      id: s.string().id(),
      userId: s.string().unique(),
      bio: s.string(),
      user: s
        .toOne(() => user)
        .fields("userId")
        .references("id"),
    })
    .map("o2o_declared_profiles");
  return { user, profile };
};

/**
 * one/one whose FK scalar is NOT declared unique. HEAD refuses it (FK008) while
 * the serializer still emits the derived unique constraint; plan §9.4 makes the
 * declaration valid without changing that constraint.
 */
const oneToOneDerivedUnique = (): Record<string, AnyModel> => {
  const user = s
    .model({
      id: s.string().id(),
      profile: s.toOne(() => profile),
    })
    .map("o2o_derived_users");
  const profile = s
    .model({
      id: s.string().id(),
      userId: s.string(),
      user: s
        .toOne(() => user)
        .fields("userId")
        .references("id"),
    })
    .map("o2o_derived_profiles");
  return { user, profile };
};

/**
 * one/one whose FK IS the owner's primary key: no unique constraint is emitted
 * at all, because the primary key already carries the physical uniqueness.
 */
const oneToOneFkIsPrimaryKey = (): Record<string, AnyModel> => {
  const user = s
    .model({
      id: s.string().id(),
      profile: s.toOne(() => profile),
    })
    .map("o2o_pk_users");
  const profile = s
    .model({
      userId: s.string().id(),
      user: s
        .toOne(() => user)
        .fields("userId")
        .references("id"),
    })
    .map("o2o_pk_profiles");
  return { user, profile };
};

/** one/many with a required FK: RESTRICT default and a derived FK index. */
const oneToManyRequiredFk = (): Record<string, AnyModel> => {
  const user = s
    .model({
      id: s.string().id(),
      posts: s.toMany(() => post),
    })
    .map("o2m_required_users");
  const post = s
    .model({
      id: s.string().id(),
      title: s.string(),
      authorId: s.string(),
      author: s
        .toOne(() => user)
        .fields("authorId")
        .references("id"),
    })
    .map("o2m_required_posts");
  return { user, post };
};

/** one/many with a nullable FK: SET NULL default. */
const oneToManyNullableFk = (): Record<string, AnyModel> => {
  const user = s
    .model({
      id: s.string().id(),
      posts: s.toMany(() => post),
    })
    .map("o2m_nullable_users");
  const post = s
    .model({
      id: s.string().id(),
      authorId: s.string().nullable(),
      author: s
        .toOne(() => user)
        .fields("authorId")
        .references("id"),
    })
    .map("o2m_nullable_posts");
  return { user, post };
};

/** many/many with no configuration: sorted-model table and default tokens. */
const manyToManyDefaultNames = (): Record<string, AnyModel> => {
  const post = s.model({
    id: s.string().id(),
    tags: s.toMany(() => tag),
  });
  const tag = s.model({
    id: s.string().id(),
    posts: s.toMany(() => post),
  });
  return { m2mdefpost: post, m2mdeftag: tag };
};

/** many/many configured on ONE endpoint only — the canonical final spelling. */
const manyToManyOneSidedOverrides = (): Record<string, AnyModel> => {
  const post = s
    .model({
      id: s.string().id(),
      tags: s
        .toMany(() => tag)
        .through("m2m_one_sided_join")
        .source("post_ref")
        .target("tag_ref")
        .onDelete("restrict")
        .onUpdate("cascade"),
    })
    .map("m2m_one_sided_posts");
  const tag = s
    .model({
      id: s.string().id(),
      posts: s.toMany(() => post),
    })
    .map("m2m_one_sided_tags");
  return { post, tag };
};

/**
 * many/many where BOTH endpoints repeat the same overrides (plan §9.3). The
 * final API rejects two configuration owners; conversion consolidates onto one
 * endpoint and must reproduce exactly this table.
 */
const manyToManyBothEndpointsEqualOverrides = (): Record<string, AnyModel> => {
  // CONSOLIDATED onto the canonically first endpoint (§9.1, R011): HEAD spelled
  // the same override on both sides and reconciled them; exactly one endpoint
  // owns every override now. The tokens are the FIRST endpoint's, so the
  // resolved topology — and every physical name derived from it — is unchanged.
  const post = s
    .model({
      id: s.string().id(),
      tags: s
        .toMany(() => tag)
        .through("m2m_mirrored_join")
        .source("post_ref")
        .target("tag_ref")
        .onDelete("restrict"),
    })
    .map("m2m_mirrored_posts");
  const tag = s
    .model({
      id: s.string().id(),
      posts: s.toMany(() => post),
    })
    .map("m2m_mirrored_tags");
  return { post, tag };
};

/** Two NAMED many/many pairs between the same models. */
const manyToManyNamedMultiPair = (): Record<string, AnyModel> => {
  const alpha = s.model({
    id: s.string().id(),
    primary: s.toMany(() => beta).name("primary"),
    secondary: s.toMany(() => beta).name("secondary"),
  });
  const beta = s.model({
    id: s.string().id(),
    primary: s.toMany(() => alpha).name("primary"),
    secondary: s.toMany(() => alpha).name("secondary"),
  });
  return { m2mnamedalpha: alpha, m2mnamedbeta: beta };
};

/**
 * many/many between two COMPOUND-key models: positional side prefixes. The
 * generated junction table and its constraint names derive from the SCHEMA KEYS
 * (`compoundpost`, `compoundtag`), not from the mapped SQL table names.
 */
const manyToManyCompoundKeys = (): Record<string, AnyModel> => {
  const post = s
    .model({
      tenant: s.string().map("post_tenant"),
      slug: s.string().map("post_slug"),
      // CONSOLIDATED onto the canonically first endpoint (§9.1, R011).
      tags: s
        .toMany(() => tag)
        .source("post")
        .target("tag"),
    })
    .id(["tenant", "slug"])
    .map("m2m_compound_posts");
  const tag = s
    .model({
      locale: s.string().map("tag_locale"),
      code: s.int().map("tag_code"),
      posts: s.toMany(() => post),
    })
    .id(["locale", "code"])
    .map("m2m_compound_tags");
  return { compoundPost: post, compoundTag: tag };
};

/** Self parent/children FK pair. */
const selfToOnePair = (): Record<string, AnyModel> => {
  const node = s
    .model({
      id: s.string().id(),
      parentId: s.string().nullable(),
      parent: s
        .toOne(() => node)
        .fields("parentId")
        .references("id"),
      children: s.toMany(() => node),
    })
    .map("self_fk_nodes");
  return { node };
};

/**
 * Self many/many. HEAD requires both side tokens explicitly (an unconfigured
 * self junction collapses to one column name); plan §9.4 makes the field-derived
 * defaults sufficient without changing this configured table.
 *
 * The generated junction is `node_node` — from the SCHEMA KEY, while the model
 * itself maps to `self_m2m_nodes`. Renaming a schema key renames junction
 * storage; renaming a mapped table does not.
 */
const selfManyToManyExplicitTokens = (): Record<string, AnyModel> => {
  const node = s
    .model({
      id: s.string().id(),
      // CONSOLIDATED onto the canonically first endpoint (§9.1, R011). A self
      // junction reaches the same tokens from one side: `following` is the
      // topology's source, so its `.source`/`.target` are the physical ones and
      // `followers` reads the same table with the sides swapped.
      following: s
        .toMany(() => node)
        .source("follower_id")
        .target("following_id"),
      followers: s.toMany(() => node),
    })
    .map("self_m2m_nodes");
  return { node };
};

/**
 * Compound FK with MIXED nullability — `(tenantId required, parentId nullable)`.
 * Plan §9.4 keeps the DDL and changes only the write-side clearing rule.
 *
 * HEAD also emits two FK005 WARNINGS here ("'tenantId' in 'node' should be
 * unique/ID", same for 'id') because `fkReferencesUnique` tests each referenced
 * scalar for its own `isId`/`isUnique` flag and a `.id([...])` compound key sets
 * neither. The reference IS the primary key, so the advice is wrong; it stays a
 * warning today and must not be promoted to an error without teaching that rule
 * about compound keys.
 */
const compoundFkMixedNullability = (): Record<string, AnyModel> => {
  const node = s
    .model({
      tenantId: s.string(),
      id: s.string(),
      parentId: s.string().nullable(),
      parent: s
        .toOne(() => node)
        .fields("tenantId", "parentId")
        .references("tenantId", "id"),
      children: s.toMany(() => node),
    })
    .id(["tenantId", "id"])
    .map("mixed_fk_nodes");
  return { node };
};

/** Mapped table/column names plus explicit referential actions. */
const mappedNamesAndFkActions = (): Record<string, AnyModel> => {
  const author = s
    .model({
      id: s.string().id().map("author_pk"),
      books: s.toMany(() => book),
    })
    .map("mapped_authors");
  const book = s
    .model({
      id: s.string().id().map("book_pk"),
      authorRef: s.string().map("book_author_fk"),
      author: s
        .toOne(() => author)
        .fields("authorRef")
        .references("id")
        .onDelete("cascade")
        .onUpdate("cascade"),
    })
    .map("mapped_books");
  return { author, book };
};

/**
 * `.extends()` — image and video share ONE relation terminal under two source
 * models, and each derived table serializes its own foreign key.
 */
const extendsSharedRelation = (): Record<string, AnyModel> => {
  const media = s.model({
    id: s.string().id(),
    ownerId: s.string(),
    owner: s
      .toOne(() => user)
      .fields("ownerId")
      .references("id"),
  });
  const image = media.extends({ width: s.int() }).map("ext_images");
  const video = media.extends({ duration: s.int() }).map("ext_videos");
  const user = s
    .model({
      id: s.string().id(),
      images: s.toMany(() => image),
      videos: s.toMany(() => video),
    })
    .map("ext_users");
  return { user, image, video };
};

// =============================================================================
// VARIANT TOPOLOGY CELLS (plan §6.5)
// =============================================================================

const variantRowDirectOnly = (): Record<string, AnyModel> => {
  const post = s
    .model({ id: s.string().id(), title: s.string() })
    .map("vrow_direct_posts");
  const video = s
    .model({ id: s.string().id(), title: s.string() })
    .map("vrow_direct_videos");
  const comment = s
    .model({
      id: s.string().id(),
      subject: s.toOne(
        { post: () => post, video: () => video },
        { values: { post: "content.post.v1", video: "content.video.v1" } }
      ),
    })
    .map("vrow_direct_comments");
  return { post, video, comment };
};

/** Row carrier + to-ONE inverses: one unique composite index for the group. */
const variantRowToOneInverse = (): Record<string, AnyModel> => {
  const post = s
    .model({
      id: s.string().id(),
      featured: s.toOne(() => comment).name("subject"),
    })
    .map("vrow_one_posts");
  const video = s
    .model({
      id: s.string().id(),
      featured: s.toOne(() => comment).name("subject"),
    })
    .map("vrow_one_videos");
  const comment = s
    .model({
      id: s.string().id(),
      subject: s
        .toOne({ post: () => post, video: () => video })
        .name("subject"),
    })
    .map("vrow_one_comments");
  return { post, video, comment };
};

/** Row carrier + to-MANY inverses: the same group index, non-unique. */
const variantRowToManyInverse = (): Record<string, AnyModel> => {
  const post = s
    .model({
      id: s.string().id(),
      comments: s.toMany(() => comment).name("subject"),
    })
    .map("vrow_many_posts");
  const video = s
    .model({
      id: s.string().id(),
      comments: s.toMany(() => comment).name("subject"),
    })
    .map("vrow_many_videos");
  const comment = s
    .model({
      id: s.string().id(),
      subject: s
        .toOne({ post: () => post, video: () => video })
        .name("subject"),
    })
    .map("vrow_many_comments");
  return { post, video, comment };
};

/** `.optional()` row carrier: both private storage columns become nullable. */
const variantRowOptional = (): Record<string, AnyModel> => {
  const post = s.model({ id: s.string().id() }).map("vrow_opt_posts");
  const video = s.model({ id: s.string().id() }).map("vrow_opt_videos");
  const comment = s
    .model({
      id: s.string().id(),
      subject: s
        .toOne(
          { post: () => post, video: () => video },
          { values: { post: "opt.post.v1", video: "opt.video.v1" } }
        )
        .optional(),
    })
    .map("vrow_opt_comments");
  return { post, video, comment };
};

/** One target model under TWO variant keys, direct-only (plan §4.2). */
const variantRowRepeatedTarget = (): Record<string, AnyModel> => {
  const doc = s
    .model({ id: s.string().id(), title: s.string() })
    .map("vrow_repeat_docs");
  const audit = s
    .model({
      id: s.string().id(),
      subject: s.toOne(
        { draft: () => doc, published: () => doc },
        { values: { draft: "doc.draft.v1", published: "doc.published.v1" } }
      ),
    })
    .map("vrow_repeat_audits");
  return { doc, audit };
};

const variantMemberDirectOnly = (): Record<string, AnyModel> => {
  const book = s
    .model({ id: s.string().id(), title: s.string() })
    .map("vmem_direct_books");
  const video = s
    .model({ id: s.string().id(), title: s.string() })
    .map("vmem_direct_videos");
  const shelf = s
    .model({
      id: s.string().id(),
      items: s.toMany(
        { book: () => book, video: () => video },
        { values: { book: "shelf.book.v1", video: "shelf.video.v1" } }
      ),
    })
    .map("vmem_direct_shelves");
  return { book, video, shelf };
};

/** Member junctions with a to-ONE inverse on every variant: unique target. */
const variantMemberToOneInverse = (): Record<string, AnyModel> => {
  const book = s
    .model({
      id: s.string().id(),
      shelf: s.toOne(() => shelf),
    })
    .map("vmem_one_books");
  const video = s
    .model({
      id: s.string().id(),
      shelf: s.toOne(() => shelf),
    })
    .map("vmem_one_videos");
  const shelf = s
    .model({
      id: s.string().id(),
      items: s.toMany(
        { book: () => book, video: () => video },
        { values: { book: "one.book.v1", video: "one.video.v1" } }
      ),
    })
    .map("vmem_one_shelves");
  return { book, video, shelf };
};

/** Member junctions with a to-MANY inverse on every variant: non-unique target. */
const variantMemberToManyInverse = (): Record<string, AnyModel> => {
  const book = s
    .model({
      id: s.string().id(),
      shelves: s.toMany(() => shelf),
    })
    .map("vmem_many_books");
  const video = s
    .model({
      id: s.string().id(),
      shelves: s.toMany(() => shelf),
    })
    .map("vmem_many_videos");
  const shelf = s
    .model({
      id: s.string().id(),
      items: s.toMany(
        { book: () => book, video: () => video },
        { values: { book: "many.book.v1", video: "many.video.v1" } }
      ),
    })
    .map("vmem_many_shelves");
  return { book, video, shelf };
};

/** Member junctions may MIX inverse cardinalities across variants (§6.5). */
const variantMemberMixedInverses = (): Record<string, AnyModel> => {
  const book = s
    .model({
      id: s.string().id(),
      shelf: s.toOne(() => shelf),
    })
    .map("vmem_mixed_books");
  const video = s
    .model({
      id: s.string().id(),
      shelves: s.toMany(() => shelf),
    })
    .map("vmem_mixed_videos");
  const shelf = s
    .model({
      id: s.string().id(),
      items: s.toMany(
        { book: () => book, video: () => video },
        { values: { book: "mixed.book.v1", video: "mixed.video.v1" } }
      ),
    })
    .map("vmem_mixed_shelves");
  return { book, video, shelf };
};

/** Explicit per-variant member junction names through `.through(map)`. */
const variantMemberExplicitThrough = (): Record<string, AnyModel> => {
  const post = s.model({ id: s.string().id() }).map("vmem_through_posts");
  const video = s.model({ id: s.string().id() }).map("vmem_through_videos");
  const mention = s
    .model({
      id: s.string().id(),
      targets: s.toMany({ post: () => post, video: () => video }).through({
        post: {
          table: "vmem_through_mention_post",
          source: "mentionRef",
          target: "postRef",
        },
        video: {
          table: "vmem_through_mention_video",
          source: "mentionRef",
          target: "videoRef",
        },
      }),
    })
    .map("vmem_through_mentions");
  return { post, video, mention };
};

/** A member junction whose variant target has a COMPOUND row key. */
const variantMemberCompoundTargetKey = (): Record<string, AnyModel> => {
  const article = s
    .model({
      tenant: s.string().map("article_tenant"),
      slug: s.string().map("article_slug"),
    })
    .id(["tenant", "slug"])
    .map("vmem_compound_articles");
  const clip = s.model({ id: s.string().id() }).map("vmem_compound_clips");
  const feed = s
    .model({
      id: s.string().id(),
      entries: s.toMany({
        article: () => article,
        clip: () => clip,
      }),
    })
    .map("vmem_compound_feeds");
  return { article, clip, feed };
};

// =============================================================================
// TABLE-ORDER WITNESSES (plan §11.5.11, §11.5.12)
// =============================================================================

/**
 * One schema whose ordinary junction anchor sorts BEFORE a later variant
 * carrier. HEAD appends every junction-shaped table after every model table,
 * member junctions first (registered during the model walk) and ordinary
 * junctions second. The baseline pins the complete ordered table list.
 */
const ordinaryJunctionBeforeVariantCarrier = (): Record<string, AnyModel> => {
  const archive = s
    .model({
      id: s.string().id(),
      tags: s.toMany(() => tag),
    })
    .map("ord_first_archives");
  const tag = s
    .model({
      id: s.string().id(),
      archives: s.toMany(() => archive),
    })
    .map("ord_first_tags");
  const book = s.model({ id: s.string().id() }).map("ord_first_books");
  const clip = s.model({ id: s.string().id() }).map("ord_first_clips");
  const shelf = s
    .model({
      id: s.string().id(),
      items: s.toMany({ book: () => book, clip: () => clip }),
    })
    .map("ord_first_shelves");
  return { archive, tag, shelf, book, clip };
};

/**
 * The inverse models sort BEFORE their variant carrier; row storage and member
 * tables still serialize at the carrier anchor.
 */
const variantCarrierAfterInverseModels = (): Record<string, AnyModel> => {
  const post = s
    .model({
      id: s.string().id(),
      featured: s.toOne(() => comment).name("subject"),
      shelf: s.toOne(() => board),
    })
    .map("anchor_posts");
  const video = s
    .model({
      id: s.string().id(),
      featured: s.toOne(() => comment).name("subject"),
    })
    .map("anchor_videos");
  const comment = s
    .model({
      id: s.string().id(),
      subject: s
        .toOne({ post: () => post, video: () => video })
        .name("subject"),
    })
    .map("anchor_comments");
  const board = s
    .model({
      id: s.string().id(),
      items: s.toMany({ post: () => post, video: () => video }),
    })
    .map("anchor_boards");
  return { post, video, comment, board };
};

// =============================================================================
// DIALECT WITNESS
// =============================================================================

/**
 * Every relation-derived physical artifact in ONE schema, pinned on all four
 * migration drivers: a derived one-to-one unique constraint (MySQL rewrites it
 * into a unique index), a many-to-one FK index, an ordinary junction, a variant
 * row carrier's private columns and index, and a member junction.
 */
const dialectWitness = (): Record<string, AnyModel> => {
  const user = s
    .model({
      id: s.string().id(),
      profile: s.toOne(() => profile),
      posts: s.toMany(() => post),
      teams: s.toMany(() => team),
    })
    .map("dw_users");
  const profile = s
    .model({
      id: s.string().id(),
      userId: s.string().unique(),
      user: s
        .toOne(() => user)
        .fields("userId")
        .references("id"),
    })
    .map("dw_profiles");
  const post = s
    .model({
      id: s.string().id(),
      authorId: s.string(),
      author: s
        .toOne(() => user)
        .fields("authorId")
        .references("id"),
    })
    .map("dw_posts");
  const team = s
    .model({
      id: s.string().id(),
      members: s.toMany(() => user),
    })
    .map("dw_teams");
  const comment = s
    .model({
      id: s.string().id(),
      subject: s.toOne({ post: () => post, team: () => team }),
    })
    .map("dw_comments");
  const board = s
    .model({
      id: s.string().id(),
      items: s.toMany({ post: () => post, team: () => team }),
    })
    .map("dw_boards");
  return { user, profile, post, team, comment, board };
};

// =============================================================================
// CORPUS
// =============================================================================

const PG_ONLY: readonly DdlDialect[] = ["postgres"];

export const relationDdlCorpus: readonly RelationDdlCase[] = [
  {
    id: "one-to-one-declared-unique",
    title: "one/one, FK owner with a declared unique scalar",
    pins: [
      "the FK lands on the single owning endpoint",
      "the declared unique constraint is NOT duplicated by a relation-derived one",
      "a oneToOne FK emits no separate FK index",
    ],
    headVerdict: "valid",
    dialects: PG_ONLY,
    converges: true,
    build: oneToOneDeclaredUnique,
  },
  {
    id: "one-to-one-fk-is-primary-key",
    title: "one/one whose FK is the owner's primary key",
    pins: [
      "no unique constraint at all: the primary key already carries the uniqueness",
    ],
    headVerdict: "valid",
    dialects: PG_ONLY,
    converges: true,
    build: oneToOneFkIsPrimaryKey,
  },
  {
    id: "one-to-one-derived-unique",
    title: "one/one whose FK scalar is not declared unique",
    pins: [
      "the serializer emits the derived `<table>_<cols>_key` unique constraint",
    ],
    headVerdict: "invalid",
    headErrorCodes: ["FK008"],
    intended:
      "plan §9.4: a one-to-one owner no longer needs a separately declared unique; the emitted constraint is unchanged",
    intendedVerdict: "valid",
    intendedErrorCodes: [],
    dialects: PG_ONLY,
    converges: false,
    build: oneToOneDerivedUnique,
  },
  {
    id: "one-to-many-required-fk",
    title: "one/many with a required FK",
    pins: [
      "onDelete defaults to restrict for an all-required FK tuple",
      "onUpdate defaults to noAction",
      "the derived `<table>_<cols>_idx` FK index is emitted for manyToOne",
    ],
    headVerdict: "valid",
    dialects: PG_ONLY,
    converges: true,
    build: oneToManyRequiredFk,
  },
  {
    id: "one-to-many-nullable-fk",
    title: "one/many with a nullable FK",
    pins: ["onDelete defaults to setNull when every FK member is nullable"],
    headVerdict: "valid",
    dialects: PG_ONLY,
    converges: true,
    build: oneToManyNullableFk,
  },
  {
    id: "many-to-many-default-names",
    title: "many/many with no configuration",
    pins: [
      "the sorted-model junction table name",
      "the default `<model>Id` side tokens and their canonical column order",
      "the reverse index and both cascade foreign keys",
    ],
    headVerdict: "valid",
    dialects: PG_ONLY,
    converges: true,
    build: manyToManyDefaultNames,
  },
  {
    id: "many-to-many-one-sided-overrides",
    title: "many/many configured on one endpoint only",
    pins: [
      "table, both side tokens and both actions resolve from the single configuring endpoint",
      "the unconfigured endpoint consumes the mirrored view",
    ],
    headVerdict: "valid",
    dialects: PG_ONLY,
    converges: true,
    build: manyToManyOneSidedOverrides,
  },
  {
    id: "many-to-many-both-endpoints-equal-overrides",
    title: "many/many with the same overrides repeated on both endpoints",
    pins: [
      "the exact TableDef that conversion onto one configuration owner must reproduce",
    ],
    headVerdict: "valid",
    intended:
      "plan §9.3/§9.4: a newly written final-API schema configuring both endpoints is refused; conversion keeps this table",
    dialects: PG_ONLY,
    converges: true,
    build: manyToManyBothEndpointsEqualOverrides,
  },
  {
    id: "many-to-many-named-multi-pair",
    title: "two named many/many pairs between the same models",
    pins: [
      "each pair derives `<sortedModels>_<relationName>` and neither collides",
    ],
    headVerdict: "valid",
    dialects: PG_ONLY,
    converges: true,
    build: manyToManyNamedMultiPair,
  },
  {
    id: "many-to-many-compound-keys",
    title: "many/many between two compound-key models",
    pins: [
      "positional side prefixes expand to one junction column per row-key member",
      "the junction primary key spans both complete sides",
      "the generated junction name derives from the schema keys, not the mapped table names",
    ],
    headVerdict: "valid",
    dialects: PG_ONLY,
    converges: true,
    build: manyToManyCompoundKeys,
  },
  {
    id: "self-to-one-pair",
    title: "self parent/children FK pair",
    pins: ["the self FK and its derived index"],
    headVerdict: "valid",
    dialects: PG_ONLY,
    converges: true,
    build: selfToOnePair,
  },
  {
    id: "self-many-to-many-explicit-tokens",
    title: "self many/many with both side tokens configured",
    pins: [
      "the self junction table, its two distinct columns, primary key and reverse index",
    ],
    headVerdict: "valid",
    intended:
      "plan §9.4: field-derived default side tokens become sufficient; this configured table is unchanged",
    dialects: PG_ONLY,
    converges: true,
    build: selfManyToManyExplicitTokens,
  },
  {
    id: "compound-fk-mixed-nullability",
    title: "compound FK with one required and one nullable member",
    pins: [
      "a mixed tuple keeps the restrict default (setNull needs every member nullable)",
      "the compound FK index is emitted because the primary key does not cover it",
    ],
    headVerdict: "valid",
    intended:
      "plan §9.4: the membership becomes disconnectable by clearing only the nullable member; DDL is unchanged",
    dialects: PG_ONLY,
    converges: true,
    build: compoundFkMixedNullability,
  },
  {
    id: "mapped-names-and-fk-actions",
    title: "mapped table/column names with explicit referential actions",
    pins: [
      "FK, index and constraint names derive from SQL names, not TS names",
      "explicit cascade actions override both defaults",
    ],
    headVerdict: "valid",
    dialects: PG_ONLY,
    converges: true,
    build: mappedNamesAndFkActions,
  },
  {
    id: "extends-shared-relation",
    title: "`.extends()` sharing one relation terminal under two models",
    pins: [
      "each derived model serializes its own foreign key from the shared terminal",
    ],
    headVerdict: "valid",
    dialects: PG_ONLY,
    converges: true,
    build: extendsSharedRelation,
  },
  {
    id: "variant-row-direct-only",
    title: "row-held variant carrier with no inverse",
    pins: [
      "the private `(type, id)` columns, their non-unique group index and the relationStorage registry entry",
      "the toOne history members and their stored discriminator values",
    ],
    headVerdict: "valid",
    dialects: PG_ONLY,
    converges: true,
    build: variantRowDirectOnly,
  },
  {
    id: "variant-row-to-one-inverse",
    title: "row-held variant carrier bound to to-one inverses",
    pins: ["the group index is UNIQUE for the whole carrier"],
    headVerdict: "valid",
    dialects: PG_ONLY,
    converges: true,
    build: variantRowToOneInverse,
  },
  {
    id: "variant-row-to-many-inverse",
    title: "row-held variant carrier bound to to-many inverses",
    pins: ["the group index stays non-unique"],
    headVerdict: "valid",
    dialects: PG_ONLY,
    converges: true,
    build: variantRowToManyInverse,
  },
  {
    id: "variant-row-optional",
    title: "optional row-held variant carrier",
    pins: ["both private storage columns are nullable"],
    headVerdict: "valid",
    dialects: PG_ONLY,
    converges: true,
    build: variantRowOptional,
  },
  {
    id: "variant-row-repeated-target",
    title: "one target model under two variant keys, direct-only",
    pins: [
      "two history members share one target table and keep distinct stored values",
    ],
    headVerdict: "valid",
    dialects: PG_ONLY,
    converges: true,
    build: variantRowRepeatedTarget,
  },
  {
    id: "variant-member-direct-only",
    title: "member-junction variant carrier with no inverse",
    pins: [
      "one junction table per variant with non-unique target side",
      "the toMany history members and their memberJunctionTable join",
    ],
    headVerdict: "valid",
    dialects: PG_ONLY,
    converges: true,
    build: variantMemberDirectOnly,
  },
  {
    id: "variant-member-to-one-inverse",
    title: "member junctions bound to to-one inverses",
    pins: ["a unique target-side constraint per member table"],
    headVerdict: "valid",
    dialects: PG_ONLY,
    converges: true,
    build: variantMemberToOneInverse,
  },
  {
    id: "variant-member-to-many-inverse",
    title: "member junctions bound to to-many inverses",
    pins: ["a non-unique target side on every member table"],
    headVerdict: "valid",
    dialects: PG_ONLY,
    converges: true,
    build: variantMemberToManyInverse,
  },
  {
    id: "variant-member-mixed-inverses",
    title: "member junctions with mixed inverse cardinalities",
    pins: ["each variant derives its own target-side uniqueness independently"],
    headVerdict: "valid",
    dialects: PG_ONLY,
    converges: true,
    build: variantMemberMixedInverses,
  },
  {
    id: "variant-member-explicit-through",
    title: "member junctions named by an exact per-variant `.through()` map",
    pins: ["explicit member table and both directed side tokens"],
    headVerdict: "valid",
    dialects: PG_ONLY,
    converges: true,
    build: variantMemberExplicitThrough,
  },
  {
    id: "variant-member-compound-target-key",
    title: "member junction whose variant target has a compound row key",
    pins: ["the complete native compound key expands into the member table"],
    headVerdict: "valid",
    dialects: PG_ONLY,
    converges: true,
    build: variantMemberCompoundTargetKey,
  },
  {
    id: "ordinary-junction-before-variant-carrier",
    title: "ordinary junction anchored before a later variant carrier",
    pins: [
      "the COMPLETE ordered table list: model tables, then member junctions, then ordinary junctions",
    ],
    headVerdict: "valid",
    dialects: PG_ONLY,
    converges: true,
    build: ordinaryJunctionBeforeVariantCarrier,
  },
  {
    id: "variant-carrier-after-inverse-models",
    title: "variant carriers whose inverse models sort first",
    pins: [
      "row storage and member tables serialize at the carrier anchor, not the inverse's",
    ],
    headVerdict: "valid",
    dialects: PG_ONLY,
    converges: true,
    build: variantCarrierAfterInverseModels,
  },
  {
    id: "dialect-witness",
    title: "every relation-derived artifact, on all four migration drivers",
    pins: [
      "MySQL rewrites the relation-derived unique constraint into a unique index",
      "column types and the FK/index/constraint names each driver finalizes",
    ],
    headVerdict: "valid",
    dialects: ["postgres", "mysql", "sqlite", "libsql"],
    converges: true,
    build: dialectWitness,
  },
];
