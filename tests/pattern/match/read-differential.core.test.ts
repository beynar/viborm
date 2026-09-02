/**
 * G — the read differential (pattern-engine-ideal-state.md §13.5 M3).
 *
 * Every read the byte-pin oracle and the sql-generation contract exercise is
 * compiled twice on every dialect: through today's path (`QueryEngine.build`)
 * and through the pattern (`constructRead` → `buildMatch`). The two statements
 * must be byte-equal — text AND bound parameters. A refusal must be the same
 * refusal.
 */
import type { DatabaseAdapter } from "@adapters/database-adapter";
import { MySQLAdapter } from "@adapters/databases/mysql/mysql-adapter";
import { PostgresAdapter } from "@adapters/databases/postgres/postgres-adapter";
import { SQLiteAdapter } from "@adapters/databases/sqlite/sqlite-adapter";
import type { Dialect } from "@drivers";
import {
  constructRead,
  type ReadOperation,
} from "@query-engine/pattern/construct-read";
import { buildMatch } from "@query-engine/pattern/match";
import { createModelRegistry, QueryEngine } from "@query-engine/query-engine";
import type { Operation } from "@query-engine/types";
import { validate } from "@query-engine/validator";
import { DbNull, hydrateSchemaNames, s } from "@schema";
import type { Model } from "@schema/model";
import { validateSchemaOrThrow } from "@schema/validation";
import { SqlOnlyDriver } from "@tests/fixtures/drivers/sql-only";
import { sqlGenerationUserPostSchema } from "@tests/fixtures/user-post-schema";
import { createSchemaRegistry } from "@validation";
import { describe, expect, test } from "vitest";

// =============================================================================
// SCHEMAS — replicated from the two oracle files (their consts are module-local)
// =============================================================================

const traversalSchema = (() => {
  const user = s
    .model({
      id: s.string().id(),
      name: s.string(),
      follows: s
        .toMany(() => user)
        .name("follows")
        .through("user_follows")
        .source("followerId")
        .target("followedId"),
      followedBy: s.toMany(() => user).name("follows"),
    })
    .map("rtb_users");
  const author = s
    .model({
      id: s.string().id(),
      name: s.string(),
      posts: s.toMany(() => post),
    })
    .map("rtb_authors");
  const post = s
    .model({
      id: s.string().id(),
      title: s.string(),
      authorId: s.string(),
      author: s
        .toOne(() => author)
        .fields("authorId")
        .references("id"),
      tags: s.toMany(() => tag),
    })
    .map("rtb_posts");
  const tag = s
    .model({
      id: s.string().id(),
      name: s.string().unique(),
      posts: s.toMany(() => post),
    })
    .map("rtb_tags");
  const tenant = s
    .model({
      id: s.string().id(),
      region: s.string(),
      slug: s.string(),
      memberships: s.toMany(() => membership),
    })
    .unique(["region", "slug"])
    .map("rtb_tenants");
  const membership = s
    .model({
      id: s.string().id(),
      role: s.string(),
      tenantRegion: s.string(),
      tenantSlug: s.string(),
      tenant: s
        .toOne(() => tenant)
        .fields("tenantRegion", "tenantSlug")
        .references("region", "slug"),
    })
    .map("rtb_memberships");
  return { user, author, post, tag, tenant, membership };
})();
hydrateSchemaNames(traversalSchema);

const polymorphicSchema = (() => {
  const post = s.model({
    id: s.string().id().map("post_pk"),
    comments: s.toMany(() => comment),
    notes: s.toMany(() => note).name("notePost"),
  });
  const video = s.model({ id: s.string().id() });
  const comment = s.model({
    id: s.string().id(),
    body: s.string(),
    subject: s.toOne(
      { post: () => post, video: () => video },
      { values: { post: "content.post.v1", video: "content.video.v1" } }
    ),
  });
  const note = s.model({
    id: s.string().id(),
    postId: s.string().map("post_fk"),
    post: s
      .toOne(() => post)
      .name("notePost")
      .fields("postId")
      .references("id"),
    subject: s.toOne(
      { post: () => post, video: () => video },
      { values: { post: "note.post.v1", video: "note.video.v1" } }
    ),
  });
  const singularPost = s.model({
    id: s.string().id().map("post_pk"),
    featuredComment: s.toOne(() => singularComment).name("featuredCommentable"),
  });
  const singularVideo = s.model({ id: s.string().id() });
  const singularComment = s.model({
    id: s.string().id(),
    body: s.string(),
    commentable: s
      .toOne({ post: () => singularPost, video: () => singularVideo })
      .name("featuredCommentable")
      .optional(),
  });
  return {
    post,
    video,
    comment,
    note,
    singularPost,
    singularVideo,
    singularComment,
  };
})();
hydrateSchemaNames(polymorphicSchema);
validateSchemaOrThrow(polymorphicSchema);

const collectionSchema = (() => {
  const article = s.model({
    id: s.string().id(),
    title: s.string(),
    gallery: s.toOne(() => gallery),
  });
  const clip = s.model({
    id: s.string().id(),
    seconds: s.int(),
    galleries: s.toMany(() => gallery),
  });
  const gallery = s.model({
    id: s.string().id(),
    name: s.string(),
    items: s.toMany(
      { article: () => article, clip: () => clip },
      { values: { article: "rtb.article.v1", clip: "rtb.clip.v1" } }
    ),
  });
  return { article, clip, gallery };
})();
hydrateSchemaNames(collectionSchema);
validateSchemaOrThrow(collectionSchema);

const nestedOrderSchema = (() => {
  const Country = s
    .model({
      id: s.string().id(),
      name: s.string(),
      publishers: s.toMany(() => Publisher),
    })
    .map("nested_order_countries");
  const Publisher = s
    .model({
      id: s.string().id(),
      name: s.string(),
      rank: s.int(),
      countryId: s.string(),
      country: s
        .toOne(() => Country)
        .fields("countryId")
        .references("id"),
      authors: s.toMany(() => Author),
    })
    .map("nested_order_publishers");
  const Author = s
    .model({
      id: s.string().id(),
      name: s.string(),
      publisherId: s.string(),
      publisher: s
        .toOne(() => Publisher)
        .fields("publisherId")
        .references("id"),
      posts: s.toMany(() => NestedPost),
    })
    .map("nested_order_authors");
  const NestedPost = s
    .model({
      id: s.string().id(),
      title: s.string(),
      authorId: s.string(),
      author: s
        .toOne(() => Author)
        .fields("authorId")
        .references("id"),
      comments: s.toMany(() => Comment),
    })
    .map("nested_order_posts");
  const Comment = s
    .model({
      id: s.string().id(),
      text: s.string(),
      postId: s.string(),
      post: s
        .toOne(() => NestedPost)
        .fields("postId")
        .references("id"),
    })
    .map("nested_order_comments");
  const Link = s
    .model({
      id: s.string().id(),
      label: s.string(),
      nextId: s.string().nullable(),
      next: s
        .toOne(() => Link)
        .fields("nextId")
        .references("id"),
      previous: s.toMany(() => Link),
    })
    .map("nested_order_links");
  return { Country, Publisher, Author, NestedPost, Comment, Link };
})();
hydrateSchemaNames(nestedOrderSchema);

const generationSchema = sqlGenerationUserPostSchema;
hydrateSchemaNames(generationSchema);

// =============================================================================
// HARNESS
// =============================================================================

type DialectPin = {
  readonly dialect: Dialect;
  readonly placeholder: "$n" | "?";
  readonly createAdapter: () => DatabaseAdapter;
};

const DIALECTS: readonly DialectPin[] = [
  {
    dialect: "postgresql",
    placeholder: "$n",
    createAdapter: () => new PostgresAdapter(),
  },
  {
    dialect: "sqlite",
    placeholder: "?",
    createAdapter: () => new SQLiteAdapter(),
  },
  {
    dialect: "mysql",
    placeholder: "?",
    createAdapter: () => new MySQLAdapter(),
  },
];

type Schema = Record<string, Model<any>>;

const registries = new Map<Schema, ReturnType<typeof createModelRegistry>>();
const registryFor = (schema: Schema) => {
  let registry = registries.get(schema);
  if (!registry) {
    registry = createModelRegistry(schema, createSchemaRegistry(schema));
    registries.set(schema, registry);
  }
  return registry;
};

interface ReadCase {
  readonly name: string;
  readonly schema: Schema;
  readonly model: Model<any>;
  readonly operation: ReadOperation;
  readonly args: Record<string, unknown>;
}

type Outcome =
  | { readonly kind: "sql"; readonly sql: string; readonly params: unknown[] }
  | { readonly kind: "error"; readonly name: string; readonly message: string };

function outcome(run: () => { sql: string; params: unknown[] }): Outcome {
  try {
    return { kind: "sql", ...run() };
  } catch (error) {
    const e = error as { name?: string; message?: string };
    return {
      kind: "error",
      name: String(e?.name ?? "Error"),
      message: String(e?.message ?? error),
    };
  }
}

function compileBoth(
  pin: DialectPin,
  read: ReadCase
): { readonly oracle: Outcome; readonly pattern: Outcome } {
  const engine = new QueryEngine(
    new SqlOnlyDriver(pin.createAdapter(), pin.dialect),
    registryFor(read.schema)
  );
  const oracle = outcome(() => {
    const statement = engine.build(
      read.model,
      read.operation as Operation,
      read.args
    );
    return {
      sql: statement.toStatement(pin.placeholder),
      params: statement.values,
    };
  });
  const pattern = outcome(() => {
    const validated = validate<Record<string, unknown>>(
      engine.schemaRegistry,
      read.model,
      read.operation as Operation,
      read.args
    );
    const built = constructRead(
      read.model,
      read.operation,
      validated,
      engine.relations
    );
    const statement = buildMatch(built, engine);
    return {
      sql: statement.toStatement(pin.placeholder),
      params: statement.values,
    };
  });
  return { oracle, pattern };
}

// =============================================================================
// CORPUS
// =============================================================================

const { user, author, post, tenant, membership } = traversalSchema;
const { post: subjectPost, singularPost, comment, note } = polymorphicSchema;
const { article, clip, gallery } = collectionSchema;
const { Author, Post, Tag, Membership } = generationSchema;
const { Link, NestedPost, Comment: NestedComment } = nestedOrderSchema;

const on = (
  schema: Schema,
  model: Model<any>,
  operation: ReadOperation,
  name: string,
  args: Record<string, unknown>
): ReadCase => ({ name, schema, model, operation, args });

const T = (
  model: Model<any>,
  operation: ReadOperation,
  name: string,
  args: Record<string, unknown>
) => on(traversalSchema, model, operation, name, args);
const P = (
  model: Model<any>,
  operation: ReadOperation,
  name: string,
  args: Record<string, unknown>
) => on(polymorphicSchema, model, operation, name, args);
const C = (
  model: Model<any>,
  operation: ReadOperation,
  name: string,
  args: Record<string, unknown>
) => on(collectionSchema, model, operation, name, args);
const G = (
  model: Model<any>,
  operation: ReadOperation,
  name: string,
  args: Record<string, unknown>
) => on(generationSchema, model, operation, name, args);
const N = (
  model: Model<any>,
  operation: ReadOperation,
  name: string,
  args: Record<string, unknown>
) => on(nestedOrderSchema, model, operation, name, args);

const CORPUS: readonly ReadCase[] = [
  // --- read-traversal-byte-pins ---------------------------------------------
  T(user, "findMany", "self m2m include forward", {
    include: { follows: true },
  }),
  T(user, "findMany", "self m2m include reversed", {
    include: { followedBy: true },
  }),
  T(user, "findMany", "self m2m some", {
    where: { follows: { some: { name: "Alice" } } },
  }),
  T(user, "findMany", "self m2m none", {
    where: { follows: { none: { name: "Mallory" } } },
  }),
  T(user, "findMany", "self m2m _count", {
    select: { id: true, _count: { select: { follows: true } } },
  }),
  T(post, "findMany", "m2m include", { include: { tags: true } }),
  T(post, "findMany", "m2m some", {
    where: { tags: { some: { name: "typescript" } } },
  }),
  T(post, "findMany", "m2m every", {
    where: { tags: { every: { name: "typescript" } } },
  }),
  T(post, "findMany", "m2m none", {
    where: { tags: { none: { name: "deprecated" } } },
  }),
  T(post, "findMany", "m2m _count", {
    select: { id: true, _count: { select: { tags: true } } },
  }),
  T(post, "findMany", "fk to-one include", { include: { author: true } }),
  T(author, "findMany", "fk to-many include", { include: { posts: true } }),
  T(membership, "findMany", "compound fk to-one include", {
    include: { tenant: true },
  }),
  T(tenant, "findUnique", "findUnique compound unique", {
    where: { region_slug: { region: "eu-west", slug: "acme" } },
  }),
  T(post, "findMany", "to-one order chain", {
    orderBy: { author: { name: "asc" } },
  }),
  T(author, "findMany", "to-many _count order", {
    orderBy: { posts: { _count: "desc" } },
  }),
  P(subjectPost, "findMany", "polymorphic inverse to-many include", {
    include: { comments: true },
  }),
  P(
    singularPost,
    "findMany",
    "polymorphic fields-less singular inverse include",
    {
      include: { featuredComment: true },
    }
  ),
  T(author, "findMany", "depth-2 include with inner where/order/take", {
    include: {
      posts: {
        include: {
          tags: {
            where: { name: { contains: "type" } },
            orderBy: { name: "desc" },
            take: 3,
          },
        },
      },
    },
  }),
  C(gallery, "findMany", "collection include every variant", {
    include: { items: true },
  }),
  C(gallery, "findMany", "collection include narrowed by only", {
    include: {
      items: {
        only: ["article"],
        variants: { article: { orderBy: { title: "asc" }, take: 2 } },
      },
    },
  }),
  C(gallery, "findMany", "collection some", {
    where: { items: { some: { type: "article", is: { title: "x" } } } },
  }),
  C(gallery, "findMany", "collection every", {
    where: { items: { every: { type: "article", is: { title: "x" } } } },
  }),
  C(gallery, "findMany", "collection _count", {
    select: { id: true, _count: { select: { items: true } } },
  }),
  C(gallery, "findMany", "collection _count order", {
    orderBy: { items: { _count: "desc" } },
  }),
  C(article, "findMany", "singular collection inverse include", {
    include: { gallery: true },
  }),
  C(clip, "findMany", "plural collection inverse include", {
    include: { galleries: true },
  }),
  C(article, "findMany", "order through singular collection inverse", {
    orderBy: { gallery: { name: "asc" } },
  }),
  // --- polymorphic direct reads and filters ---------------------------------
  P(comment, "findMany", "direct polymorphic include", {
    include: { subject: true },
  }),
  P(comment, "findMany", "direct polymorphic select narrowed", {
    select: { id: true, subject: { post: { select: { id: true } } } },
  }),
  P(comment, "findMany", "direct polymorphic filter type only", {
    where: { subject: { type: "post" } },
  }),
  P(comment, "findMany", "direct polymorphic filter type + is", {
    where: { subject: { type: "post", is: { id: "p1" } } },
  }),
  P(comment, "findMany", "direct polymorphic filter type + isNot", {
    where: { subject: { type: "video", isNot: { id: "v1" } } },
  }),
  P(note, "findMany", "ordinary inverse beside a variant member", {
    include: { post: true, subject: true },
  }),
  C(gallery, "findMany", "collection none", {
    where: { items: { none: { type: "clip", isNot: { seconds: 3 } } } },
  }),
  C(gallery, "findMany", "collection every type only", {
    where: { items: { every: { type: "clip" } } },
  }),
  C(gallery, "findMany", "collection filtered _count", {
    select: {
      id: true,
      _count: {
        select: { items: { where: { type: "article", is: { title: "x" } } } },
      },
    },
  }),
  // --- sql-generation: CRUD reads --------------------------------------------
  G(Author, "findFirst", "findFirst simple", {}),
  G(Author, "findFirst", "findFirst where", { where: { name: "Alice" } }),
  G(Author, "findFirst", "findFirst orderBy", { orderBy: { name: "asc" } }),
  G(Author, "findFirst", "findFirst negative take", { take: -1 }),
  G(Author, "findMany", "findMany simple", {}),
  G(Author, "findMany", "take/skip", { take: 10, skip: 5 }),
  G(Author, "findMany", "cursor with orderBy", {
    cursor: { id: "cursor-id" },
    take: 10,
    orderBy: { id: "asc" },
  }),
  G(Author, "findMany", "cursor without orderBy", {
    cursor: { id: "cursor-id" },
    take: 10,
  }),
  G(Author, "findMany", "negative take", {
    cursor: { id: "cursor-id" },
    orderBy: { id: "asc" },
    take: -2,
  }),
  N(Link, "findMany", "negative take reverses relation-order fallback", {
    orderBy: { next: { nextId: { sort: "asc", nulls: "last" } } },
    take: -2,
  }),
  G(Membership, "findMany", "compound unique cursor", {
    cursor: { orgId_memberId: { orgId: "org-1", memberId: "member-2" } },
    take: 2,
  }),
  G(Author, "findMany", "cursor with non-cursor orderBy", {
    cursor: { id: "cursor-id" },
    orderBy: { name: "asc" },
    take: 2,
  }),
  G(Author, "findMany", "nullable scalar order with nulls and take", {
    orderBy: { age: { sort: "desc", nulls: "first" } },
    take: 3,
  }),
  G(Author, "findMany", "json path string contains", {
    where: { metadata: { path: ["status"], string_contains: "active" } },
  }),
  G(Author, "findMany", "json scoped comparisons", {
    where: {
      metadata: {
        path: "$.score",
        lt: 10,
        lte: 11,
        gt: 1,
        gte: 2,
        not: { equals: 5 },
      },
    },
  }),
  G(Author, "findMany", "json insensitive string operators", {
    where: {
      metadata: {
        path: "$.profile.name",
        mode: "insensitive",
        string_contains: "AR",
        string_starts_with: "A",
        string_ends_with: "D",
        not: { string_contains: "BOT" },
      },
    },
  }),
  G(Author, "findMany", "json array predicates", {
    where: {
      metadata: {
        path: ["tags"],
        array_contains: "orm",
        array_starts_with: "typescript",
        array_ends_with: "database",
      },
    },
  }),
  G(Author, "findMany", "json root null", {
    where: { metadata: { equals: null } },
  }),
  G(Author, "findMany", "json root not DbNull", {
    where: { metadata: { not: DbNull } },
  }),
  G(Author, "findMany", "json nested null", {
    where: { metadata: { path: ["deletedAt"], equals: null } },
  }),
  G(Author, "findMany", "empty scalar filter fails closed", {
    where: { name: {} },
  }),
  G(Author, "findMany", "empty relation filter fails closed", {
    where: { posts: {} },
  }),
  G(Author, "findMany", "empty OR", { where: { OR: [] } }),
  G(Author, "findMany", "AND / OR / NOT nesting", {
    where: {
      AND: [{ name: { contains: "a" } }, { age: { gt: 1 } }],
      OR: [{ email: { endsWith: "x" } }, { NOT: { age: { lt: 5 } } }],
      NOT: [{ name: "Bob" }, { age: null }],
    },
  }),
  G(Author, "findMany", "insensitive string operators", {
    where: {
      name: { contains: "AL", mode: "insensitive" },
      email: { startsWith: "a", mode: "insensitive", not: { endsWith: "z" } },
    },
  }),
  G(Author, "findMany", "in / notIn / nested not", {
    where: {
      name: { in: ["a", "b"], notIn: [], not: { in: ["c"] } },
      age: { in: [1, 2], not: null },
    },
  }),
  G(Post, "findMany", "to-one order chain (generation)", {
    orderBy: { author: { name: "asc" } },
  }),
  N(NestedPost, "findMany", "2-hop relation order", {
    orderBy: { author: { publisher: { name: "asc", rank: "desc" } } },
  }),
  N(NestedComment, "findMany", "4-hop relation order", {
    orderBy: { post: { author: { publisher: { country: { name: "asc" } } } } },
  }),
  N(NestedPost, "findMany", "to-many mid-chain order fails closed", {
    orderBy: { author: { posts: { _count: "desc" } } },
  }),
  G(Author, "findMany", "to-many _count order (generation)", {
    orderBy: { posts: { _count: "desc" } },
  }),
  G(Author, "findMany", "to-many scalar order fails closed", {
    orderBy: { posts: { title: "asc" } },
  }),
  G(Author, "findMany", "distinct with order and window", {
    distinct: ["name"],
    orderBy: [{ name: "asc" }, { age: "desc" }],
    take: 5,
    skip: 2,
  }),
  G(Author, "findUnique", "findUnique by id", { where: { id: "author-1" } }),
  G(Author, "findUnique", "findUnique by unique field", {
    where: { email: "alice@example.com" },
  }),
  G(Author, "findUnique", "findUnique extended where", {
    where: { id: "author-1", age: { gt: 3 }, NOT: { name: "x" } },
  }),
  G(Membership, "findUnique", "findUnique compound id", {
    where: { orgId_memberId: { orgId: "org-1", memberId: "member-1" } },
  }),
  G(Membership, "findUnique", "findUnique compound unique", {
    where: {
      email_tenantId: { email: "alice@example.com", tenantId: "tenant-1" },
    },
  }),
  G(Author, "findUnique", "findUnique with include and select", {
    where: { id: "a" },
    select: { id: true, posts: { select: { id: true }, take: 2 } },
  }),
  // --- sql-generation: select/include --------------------------------------
  G(Author, "findMany", "select scalars", { select: { id: true, name: true } }),
  G(Post, "findMany", "select to-one", {
    select: {
      id: true,
      title: true,
      author: { select: { id: true, name: true } },
    },
  }),
  G(Author, "findMany", "select to-many", {
    select: {
      id: true,
      name: true,
      posts: { select: { id: true, title: true } },
    },
  }),
  G(Author, "findMany", "nested selects 3 deep", {
    select: {
      id: true,
      name: true,
      posts: {
        select: {
          id: true,
          title: true,
          comments: { select: { id: true, text: true } },
        },
      },
    },
  }),
  G(Author, "findMany", "select posts with where", {
    select: {
      id: true,
      posts: { where: { published: true }, select: { id: true, title: true } },
    },
  }),
  G(Author, "findMany", "select posts ordered", {
    select: {
      id: true,
      posts: { orderBy: { title: "asc" }, select: { id: true, title: true } },
    },
  }),
  G(Author, "findMany", "select posts take/skip", {
    select: {
      id: true,
      posts: { take: 5, skip: 10, select: { id: true, title: true } },
    },
  }),
  G(Author, "findMany", "nested negative take and cursor", {
    select: {
      id: true,
      posts: {
        take: -2,
        cursor: { id: "p" },
        orderBy: { views: "desc" },
        select: { id: true },
      },
    },
  }),
  G(Author, "findMany", "nested distinct", {
    include: {
      posts: { distinct: ["title"], orderBy: { title: "asc" }, take: 2 },
    },
  }),
  G(Author, "findMany", "nested relation filter inside include", {
    include: {
      posts: {
        where: { tags: { some: { name: "x" } }, author: { is: { name: "y" } } },
      },
    },
  }),
  G(Post, "findMany", "include to-one with where", {
    include: { author: { where: { name: "x" } } },
  }),
  G(Author, "findMany", "include with _count inside", {
    include: {
      posts: {
        include: { _count: { select: { comments: true, tags: true } } },
      },
    },
  }),
  // --- sql-generation: relation filters --------------------------------------
  G(Author, "findMany", "some", {
    where: { posts: { some: { published: true } } },
  }),
  G(Author, "findMany", "every", {
    where: { posts: { every: { published: true } } },
  }),
  G(Author, "findMany", "none", {
    where: { posts: { none: { published: true } } },
  }),
  G(Author, "findMany", "some/every/none reordered", {
    where: {
      posts: {
        none: { title: "none-title" },
        every: { title: "every-title" },
        some: { title: "some-title" },
      },
    },
  }),
  G(Author, "findMany", "empty every", { where: { posts: { every: {} } } }),
  G(Author, "findMany", "normalized empty every", {
    where: { posts: { every: { AND: [{}] } } },
  }),
  G(Post, "findMany", "is", { where: { author: { is: { name: "Alice" } } } }),
  G(Post, "findMany", "isNot", {
    where: { author: { isNot: { name: "Admin" } } },
  }),
  G(Post, "findMany", "is and isNot reordered", {
    where: { author: { isNot: { name: "Admin" }, is: { name: "Alice" } } },
  }),
  G(Post, "findMany", "required slot refuses null form", {
    where: { author: { is: null } },
  }),
  N(Link, "findMany", "is null", { where: { next: { is: null } } }),
  N(Link, "findMany", "isNot null", { where: { next: { isNot: null } } }),
  N(Link, "findMany", "null and object forms", {
    where: { next: { is: null, isNot: { label: "a" } } },
  }),
  N(Link, "findMany", "isNot null through NOT", {
    where: { NOT: { next: { isNot: null } } },
  }),
  N(Link, "findMany", "previous some through self fk", {
    where: { previous: { some: { label: "a" } } },
  }),
  G(Post, "findMany", "m2m select", {
    select: {
      id: true,
      title: true,
      tags: { select: { id: true, name: true } },
    },
  }),
  G(Tag, "findMany", "m2m select reverse", {
    select: {
      id: true,
      name: true,
      posts: { select: { id: true, title: true } },
    },
  }),
  G(Post, "findMany", "m2m some/every/none reordered", {
    where: {
      tags: {
        none: { name: "none-tag" },
        every: { name: "every-tag" },
        some: { name: "some-tag" },
      },
    },
  }),
  G(Post, "findMany", "m2m empty every", { where: { tags: { every: {} } } }),
  G(Author, "findMany", "_count posts", {
    select: { id: true, name: true, _count: { select: { posts: true } } },
  }),
  G(Author, "findMany", "_count with filter", {
    select: {
      id: true,
      _count: { select: { posts: { where: { published: true } } } },
    },
  }),
  G(Author, "findMany", "include _count", {
    include: { _count: { select: { posts: true } } },
  }),
  // --- aggregates --------------------------------------------------------------
  G(Author, "count", "count simple", {}),
  G(Author, "count", "count where", { where: { name: "Alice" } }),
  G(Author, "count", "count with order and pagination", {
    orderBy: { age: "desc" },
    skip: 1,
    take: 2,
  }),
  G(Author, "count", "count with cursor", {
    cursor: { id: "author-1" },
    skip: 1,
    take: 2,
  }),
  G(Post, "count", "count with relation order", {
    orderBy: { author: { name: "asc" } },
    take: 1,
  }),
  G(Author, "count", "count select fields", {
    select: { _all: true, name: true, age: true },
  }),
  G(Author, "exist", "exist", { where: { name: "x" } }),
  G(Post, "aggregate", "aggregate count members", {
    _count: { _all: true, id: true, views: false },
  }),
  G(Post, "aggregate", "aggregate sum/avg/min/max", {
    _sum: { views: true },
    _avg: { views: true },
    _min: { views: true },
    _max: { views: true },
  }),
  G(Post, "aggregate", "aggregate with window", {
    _count: true,
    _sum: { views: true },
    orderBy: { views: "desc" },
    take: 1,
    skip: 1,
  }),
  G(Post, "aggregate", "aggregate with relation order", {
    _count: true,
    orderBy: { author: { name: "asc" } },
    take: 1,
  }),
  G(Post, "groupBy", "groupBy having _count", {
    by: ["authorId"],
    _count: { id: true },
    having: { id: { _count: { gt: 5 } } },
  }),
  G(Post, "groupBy", "groupBy multiple aggregates same field", {
    by: ["authorId"],
    having: { views: { _avg: { gte: 10 }, _sum: { lt: 100 } } },
  }),
  G(Post, "groupBy", "groupBy direct value having", {
    by: ["authorId"],
    having: { authorId: "author-1" },
  }),
  G(Post, "groupBy", "groupBy direct in/notIn having", {
    by: ["authorId"],
    having: { authorId: { in: ["author-1", "author-2"], notIn: ["x"] } },
  }),
  G(Post, "groupBy", "groupBy mixed having", {
    by: ["authorId"],
    having: { id: { _count: { gt: 5 } }, authorId: "author-1" },
  }),
  G(Post, "groupBy", "groupBy having field not in by fails closed", {
    by: ["authorId"],
    having: { title: { equals: "Hello" } },
  }),
  G(Post, "groupBy", "groupBy logical having", {
    by: ["authorId"],
    having: {
      AND: [
        { views: { _sum: { gte: 10, lte: 100 } } },
        { NOT: [{ id: { _count: { equals: 0 } } }] },
      ],
      OR: [{ id: { _count: { gt: 2 } } }, { id: { _count: { lt: 8 } } }],
    },
  }),
  G(Post, "groupBy", "groupBy empty OR having", {
    by: ["authorId"],
    having: { OR: [] },
  }),
  G(Post, "groupBy", "groupBy orders and window", {
    by: ["authorId"],
    where: { published: true },
    orderBy: [
      { authorId: "asc" },
      { _count: { _all: "desc", id: "asc" } },
      { _avg: { views: "desc" } },
      { _sum: { views: "asc" } },
      { _min: { title: "asc" } },
      { _max: { title: "desc" } },
    ],
    take: 4,
    skip: 1,
    _count: true,
    _avg: { views: true },
    _sum: { views: true },
    _min: { title: true },
    _max: { title: true },
  }),
  G(Post, "groupBy", "groupBy empty in/notIn having", {
    by: ["authorId"],
    having: { id: { _count: { in: [] } }, views: { _sum: { notIn: [] } } },
  }),
];

// =============================================================================
// THE DIFFERENTIAL
// =============================================================================

/**
 * K2 orients a junction by SLOT identity: the two directions of a self
 * junction (`user.follows` / `user.followedBy`) read the same table with the
 * sides swapped, and the K1 references must say so — the own row's columns
 * toward the PARENT are the follower columns for `follows` and the followed
 * columns for `followedBy`, and vice versa toward the target.
 */
describe("self-junction reference orientation", () => {
  const registry = registryFor(traversalSchema);
  const ownRowColumns = (field: "follows" | "followedBy") => {
    const pattern = constructRead(
      user,
      "findMany",
      { include: { [field]: true } },
      registry.relations
    );
    const entry = pattern.projection?.relations.find((r) => r.field === field);
    if (!entry) throw new Error(`no relation entry for ${field}`);
    const toParent = entry.extension.reference;
    const target = entry.extension.target;
    const toTarget = target.references.find(
      (reference) => reference.holder === toParent.holder
    );
    const ownRow = target.rows.find((row) => row.id === toParent.holder);
    return {
      table: ownRow?.table.table,
      referenceRow: ownRow?.table.referenceRow,
      toParent: toParent.columns.map((pair) => pair.holderColumn),
      toTarget: toTarget?.columns.map((pair) => pair.holderColumn),
    };
  };

  test("follows and followedBy swap the own row's columns", () => {
    expect(ownRowColumns("follows")).toEqual({
      table: "user_follows",
      referenceRow: true,
      toParent: ["followerId"],
      toTarget: ["followedId"],
    });
    expect(ownRowColumns("followedBy")).toEqual({
      table: "user_follows",
      referenceRow: true,
      toParent: ["followedId"],
      toTarget: ["followerId"],
    });
  });
});

for (const pin of DIALECTS) {
  describe(`read differential on ${pin.dialect}`, () => {
    test.each(
      CORPUS.map((read) => [read.name, read] as const)
    )("%s", (_name, read) => {
      const { oracle, pattern } = compileBoth(pin, read);
      expect(pattern).toEqual(oracle);
    });
  });
}
