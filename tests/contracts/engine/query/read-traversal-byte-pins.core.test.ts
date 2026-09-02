/**
 * Read-side relation traversal — BYTE PINS.
 *
 * WHY THIS FILE EXISTS
 *
 * Phase 7 of `docs/architecture/query-engine-distinct-truth-compression-plan.md`
 * ("Centralize read-side physical traversal", units 7.1 and 7.2) moves the
 * physical relation traversal out of the include, filter, count and order
 * builders into one narrow owner, then deletes the raw many-to-many topology
 * branches, `buildCorrelation()`'s junction refusal, and the duplicated
 * join-part prologues. Its keep gate (plan `:1447`) reads:
 *
 *   "Serialized SQL and parameters are byte-identical for scalar FK, compound
 *    FK, polymorphic inverse, M2M, self-relation, lateral, and subquery
 *    strategies."
 *
 * That gate was not checkable when the work started. The Phase 0 witness census
 * found the entire read-side estate asserts `toContain`/`toMatch` on the
 * serialized statement — `sql-generation.core.test.ts`,
 * `lateral-joins.core.test.ts`, `polymorphic-inverse-read-sql.core.test.ts` are
 * parameter-exact, never byte-exact — and found NO witness at all, of any kind,
 * for self-relation many-to-many READ SQL. That strategy's only coverage is
 * behavioral (`m2m-mutation.test.ts`, `many-to-many-behavior.ts`): it pins
 * junction row orientation and returned row ids, never a statement.
 *
 * So this file is the before-picture the Phase 3–7 migrations diff against.
 * Every assertion pins ONE `{ sql, params }` object — the complete serialized
 * statement plus the complete bound parameter array — for one strategy on one
 * dialect. Snapshots are inline and each lives at its own call site; there are
 * deliberately no loops over adapters, because one call site cannot carry two
 * inline snapshots.
 *
 * HOW TO TREAT A DIFF HERE
 *
 * A changed snapshot is a CHANGED STATEMENT, i.e. a behavior change in the read
 * path. It is never a casual `vitest -u`. Accept a diff only inside the phase
 * that intends it, carrying that phase's explicit written justification for the
 * new bytes. Otherwise the migration moved more than the physical traversal and
 * the Phase 7 keep gate has failed.
 *
 * Structural only: no database boots and no driver connects. The mock driver
 * below opens no provider resource; every statement comes from
 * `QueryEngine.build()`.
 */

import type { DatabaseAdapter } from "@adapters/database-adapter";
import { MySQLAdapter } from "@adapters/databases/mysql/mysql-adapter";
import { PostgresAdapter } from "@adapters/databases/postgres/postgres-adapter";
import { SQLiteAdapter } from "@adapters/databases/sqlite/sqlite-adapter";
import type { Dialect } from "@drivers";
import { createModelRegistry, QueryEngine } from "@query-engine/query-engine";
import type { Operation } from "@query-engine/types";
import { hydrateSchemaNames, s } from "@schema";
import type { Model } from "@schema/model";
import { validateSchemaOrThrow } from "@schema/validation";
import { SqlOnlyDriver } from "@tests/fixtures/drivers/sql-only";
import { createSchemaRegistry } from "@validation";
import { describe, expect, test } from "vitest";

// =============================================================================
// SCHEMAS
// =============================================================================

/**
 * Every ordinary physical traversal Phase 7 centralizes, in one schema:
 *
 * - `user.follows` / `user.followedBy` — a SELF-referential many-to-many. The
 *   junction is explicit (`user_follows(followerId, followedId)`) so the A/B
 *   orientation is readable in the pinned bytes: the reversed side must swap
 *   the two columns, not the table. This is the strategy the census found
 *   completely unwitnessed on the read side.
 * - `author` / `post` — scalar FK, both directions (to-one and to-many).
 * - `post` / `tag` — an ordinary many-to-many with a generated junction.
 * - `tenant` / `membership` — a COMPOUND reference key that is deliberately not
 *   the row key: `tenant`'s row key is `[id]` while `membership` stores
 *   `(tenantRegion, tenantSlug)` against the `(region, slug)` compound unique.
 */
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

/**
 * The polymorphic inverse traversal, copied from
 * `polymorphic-inverse-read-sql.core.test.ts` so the two files describe the same
 * shapes: a to-many inverse (`post.comments`, resolved through the private
 * `subject_type`/`subject_id` pair), an ordinary inverse coexisting with it
 * (`post.notes`, which must keep using `post_fk`), and a fields-less singular
 * inverse (`singularPost.featuredComment`).
 *
 * It stays a SEPARATE schema because polymorphic private storage is
 * materialized by the schema validator, not by hydration — `validateSchemaOrThrow`
 * below is what makes `getPolymorphicStorage` non-empty, and running the whole
 * graph validation over an unrelated schema is not this file's business.
 */
const polymorphicSchema = (() => {
  const post = s.model({
    id: s.string().id().map("post_pk"),
    comments: s.toMany(() => comment),
    // NAMED so the ordinary pair partitions away from the variant member that
    // also points back here (§6.2 rule 3).
    notes: s.toMany(() => note).name("notePost"),
  });

  const video = s.model({
    id: s.string().id(),
  });

  const comment = s.model({
    id: s.string().id(),
    body: s.string(),
    subject: s.toOne(
      { post: () => post, video: () => video },
      {
        values: {
          post: "content.post.v1",
          video: "content.video.v1",
        },
      }
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
      {
        values: {
          post: "note.post.v1",
          video: "note.video.v1",
        },
      }
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
      .toOne({
        post: () => singularPost,
        video: () => singularVideo,
      })
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

/**
 * The polymorphic COLLECTION traversal — a THIRD registry, for the same reason
 * the second one exists: member-junction topology is materialized by
 * `validateSchemaOrThrow`, and running that over an unrelated schema is not this
 * file's business.
 *
 * `gallery.items` is the direct collection; `article.gallery` is its SINGULAR
 * inverse (a fields-less `manyToOne`) and `clip.galleries` its PLURAL one (a
 * fields-less `manyToMany`).
 */
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

const { user, author, post, tenant, membership } = traversalSchema;
const { post: subjectPost, singularPost } = polymorphicSchema;
const {
  article: collectionArticle,
  clip: collectionClip,
  gallery: collectionGallery,
} = collectionSchema;

// =============================================================================
// PINS
// =============================================================================

type DialectPin = {
  readonly dialect: Dialect;
  readonly placeholder: "$n" | "?";
  readonly createAdapter: () => DatabaseAdapter;
};

const POSTGRES: DialectPin = {
  dialect: "postgresql",
  placeholder: "$n",
  createAdapter: () => new PostgresAdapter(),
};

const SQLITE: DialectPin = {
  dialect: "sqlite",
  placeholder: "?",
  createAdapter: () => new SQLiteAdapter(),
};

const MYSQL: DialectPin = {
  dialect: "mysql",
  placeholder: "?",
  createAdapter: () => new MySQLAdapter(),
};

const traversalRegistry = createModelRegistry(
  traversalSchema,
  createSchemaRegistry(traversalSchema)
);
const polymorphicRegistry = createModelRegistry(
  polymorphicSchema,
  createSchemaRegistry(polymorphicSchema)
);

/**
 * One bound `(schema, dialect)` pair. Returns the complete statement text in
 * that dialect's placeholder spelling plus the complete bound parameter array —
 * `QueryEngine.build()` compiles a read to exactly one `Sql`, so this object IS
 * the whole command.
 */
const readPin = (
  registry: ReturnType<typeof createModelRegistry>,
  dialectPin: DialectPin
) => {
  const engine = new QueryEngine(
    new SqlOnlyDriver(dialectPin.createAdapter(), dialectPin.dialect),
    registry
  );
  return (
    model: Model<any>,
    operation: Operation,
    args: Record<string, unknown>
  ) => {
    const statement = engine.build(model, operation, args);
    return {
      sql: statement.toStatement(dialectPin.placeholder),
      params: statement.values,
    };
  };
};

const pgPin = readPin(traversalRegistry, POSTGRES);
const sqlitePin = readPin(traversalRegistry, SQLITE);
const mysqlPin = readPin(traversalRegistry, MYSQL);
const pgPolyPin = readPin(polymorphicRegistry, POSTGRES);
const sqlitePolyPin = readPin(polymorphicRegistry, SQLITE);
const collectionRegistry = createModelRegistry(
  collectionSchema,
  createSchemaRegistry(collectionSchema)
);
const pgCollectionPin = readPin(collectionRegistry, POSTGRES);
const sqliteCollectionPin = readPin(collectionRegistry, SQLITE);

// =============================================================================
// A–D. SELF-RELATION MANY-TO-MANY — the strategy with no read witness at HEAD
// =============================================================================

describe("self-relation many-to-many read SQL", () => {
  test("PostgreSQL include of the forward side (follows)", () => {
    expect(
      pgPin(user, "findMany", { include: { follows: true } })
    ).toMatchInlineSnapshot(`
      {
        "params": [
          "id",
          "name",
        ],
        "sql": "SELECT "t0"."id" AS "id", "t0"."name" AS "name", "t3"."_result" AS "follows" FROM "public"."rtb_users" AS "t0" LEFT JOIN LATERAL (SELECT COALESCE(json_agg("t4"."_json"), '[]'::json) AS "_result" FROM (SELECT json_build_object($1::text, "t2"."id", $2::text, "t2"."name") AS "_json" FROM "public"."user_follows" AS "t1", "public"."rtb_users" AS "t2" WHERE ("t1"."followerId" = "t0"."id" AND "t2"."id" = "t1"."followedId")) "t4") AS "t3" ON TRUE",
      }
    `);
  });

  test("SQLite include of the forward side (follows)", () => {
    expect(
      sqlitePin(user, "findMany", { include: { follows: true } })
    ).toMatchInlineSnapshot(`
      {
        "params": [
          "id",
          "name",
        ],
        "sql": "SELECT "t0"."id" AS "id", "t0"."name" AS "name", (SELECT COALESCE(json_group_array(json("t3"."_json")), json_array()) FROM (SELECT json_object(?, "t2"."id", ?, "t2"."name") AS "_json" FROM "user_follows" AS "t1", "rtb_users" AS "t2" WHERE ("t1"."followerId" = "t0"."id" AND "t2"."id" = "t1"."followedId")) "t3") AS "follows" FROM "rtb_users" AS "t0"",
      }
    `);
  });

  test("MySQL include of the forward side (follows)", () => {
    expect(
      mysqlPin(user, "findMany", { include: { follows: true } })
    ).toMatchInlineSnapshot(`
      {
        "params": [
          "id",
          "name",
        ],
        "sql": "SELECT \`t0\`.\`id\` AS \`id\`, \`t0\`.\`name\` AS \`name\`, \`t3\`.\`_result\` AS \`follows\` FROM \`rtb_users\` AS \`t0\` LEFT JOIN LATERAL (SELECT COALESCE(JSON_ARRAYAGG(\`t4\`.\`_json\`), JSON_ARRAY()) AS \`_result\` FROM (SELECT JSON_OBJECT(?, \`t2\`.\`id\`, ?, \`t2\`.\`name\`) AS \`_json\` FROM \`user_follows\` AS \`t1\`, \`rtb_users\` AS \`t2\` WHERE (\`t1\`.\`followerId\` = \`t0\`.\`id\` AND \`t2\`.\`id\` = \`t1\`.\`followedId\`)) \`t4\`) AS \`t3\` ON TRUE",
      }
    `);
  });

  test("PostgreSQL include of the reversed side (followedBy)", () => {
    expect(
      pgPin(user, "findMany", { include: { followedBy: true } })
    ).toMatchInlineSnapshot(`
      {
        "params": [
          "id",
          "name",
        ],
        "sql": "SELECT "t0"."id" AS "id", "t0"."name" AS "name", "t3"."_result" AS "followedBy" FROM "public"."rtb_users" AS "t0" LEFT JOIN LATERAL (SELECT COALESCE(json_agg("t4"."_json"), '[]'::json) AS "_result" FROM (SELECT json_build_object($1::text, "t2"."id", $2::text, "t2"."name") AS "_json" FROM "public"."user_follows" AS "t1", "public"."rtb_users" AS "t2" WHERE ("t1"."followedId" = "t0"."id" AND "t2"."id" = "t1"."followerId")) "t4") AS "t3" ON TRUE",
      }
    `);
  });

  test("SQLite include of the reversed side (followedBy)", () => {
    expect(
      sqlitePin(user, "findMany", { include: { followedBy: true } })
    ).toMatchInlineSnapshot(`
      {
        "params": [
          "id",
          "name",
        ],
        "sql": "SELECT "t0"."id" AS "id", "t0"."name" AS "name", (SELECT COALESCE(json_group_array(json("t3"."_json")), json_array()) FROM (SELECT json_object(?, "t2"."id", ?, "t2"."name") AS "_json" FROM "user_follows" AS "t1", "rtb_users" AS "t2" WHERE ("t1"."followedId" = "t0"."id" AND "t2"."id" = "t1"."followerId")) "t3") AS "followedBy" FROM "rtb_users" AS "t0"",
      }
    `);
  });

  test("PostgreSQL some and none filters through the self junction", () => {
    expect(
      pgPin(user, "findMany", {
        where: { follows: { some: { name: "Alice" } } },
      })
    ).toMatchInlineSnapshot(`
      {
        "params": [
          "Alice",
        ],
        "sql": "SELECT "t0"."id" AS "id", "t0"."name" AS "name" FROM "public"."rtb_users" AS "t0" WHERE EXISTS (SELECT 1 FROM "public"."user_follows" AS "t1", "public"."rtb_users" AS "t2" WHERE ("t1"."followerId" = "t0"."id" AND "t2"."id" = "t1"."followedId" AND "t2"."name" = $1))",
      }
    `);
    expect(
      pgPin(user, "findMany", {
        where: { follows: { none: { name: "Mallory" } } },
      })
    ).toMatchInlineSnapshot(`
      {
        "params": [
          "Mallory",
        ],
        "sql": "SELECT "t0"."id" AS "id", "t0"."name" AS "name" FROM "public"."rtb_users" AS "t0" WHERE NOT EXISTS (SELECT 1 FROM "public"."user_follows" AS "t1", "public"."rtb_users" AS "t2" WHERE ("t1"."followerId" = "t0"."id" AND "t2"."id" = "t1"."followedId" AND "t2"."name" = $1))",
      }
    `);
  });

  test("SQLite some and none filters through the self junction", () => {
    expect(
      sqlitePin(user, "findMany", {
        where: { follows: { some: { name: "Alice" } } },
      })
    ).toMatchInlineSnapshot(`
      {
        "params": [
          "Alice",
        ],
        "sql": "SELECT "t0"."id" AS "id", "t0"."name" AS "name" FROM "rtb_users" AS "t0" WHERE EXISTS (SELECT 1 FROM "user_follows" AS "t1", "rtb_users" AS "t2" WHERE ("t1"."followerId" = "t0"."id" AND "t2"."id" = "t1"."followedId" AND "t2"."name" COLLATE BINARY = ?))",
      }
    `);
    expect(
      sqlitePin(user, "findMany", {
        where: { follows: { none: { name: "Mallory" } } },
      })
    ).toMatchInlineSnapshot(`
      {
        "params": [
          "Mallory",
        ],
        "sql": "SELECT "t0"."id" AS "id", "t0"."name" AS "name" FROM "rtb_users" AS "t0" WHERE NOT EXISTS (SELECT 1 FROM "user_follows" AS "t1", "rtb_users" AS "t2" WHERE ("t1"."followerId" = "t0"."id" AND "t2"."id" = "t1"."followedId" AND "t2"."name" COLLATE BINARY = ?))",
      }
    `);
  });

  test("PostgreSQL _count of the self relation", () => {
    expect(
      pgPin(user, "findMany", {
        select: { id: true, _count: { select: { follows: true } } },
      })
    ).toMatchInlineSnapshot(`
      {
        "params": [
          "follows",
        ],
        "sql": "SELECT "t0"."id" AS "id", json_build_object($1::text, (SELECT COUNT(*) FROM "public"."user_follows" AS "t1", "public"."rtb_users" AS "t2" WHERE ("t1"."followerId" = "t0"."id" AND "t2"."id" = "t1"."followedId"))) AS "0viborm_relation_counts" FROM "public"."rtb_users" AS "t0"",
      }
    `);
  });

  test("SQLite _count of the self relation", () => {
    expect(
      sqlitePin(user, "findMany", {
        select: { id: true, _count: { select: { follows: true } } },
      })
    ).toMatchInlineSnapshot(`
      {
        "params": [
          "follows",
        ],
        "sql": "SELECT "t0"."id" AS "id", json_object(?, (SELECT COUNT(*) FROM "user_follows" AS "t1", "rtb_users" AS "t2" WHERE ("t1"."followerId" = "t0"."id" AND "t2"."id" = "t1"."followedId"))) AS "0viborm_relation_counts" FROM "rtb_users" AS "t0"",
      }
    `);
  });
});

// =============================================================================
// E–G. ORDINARY MANY-TO-MANY
// =============================================================================

describe("ordinary many-to-many read SQL", () => {
  test("PostgreSQL include takes the LATERAL strategy", () => {
    expect(
      pgPin(post, "findMany", { include: { tags: true } })
    ).toMatchInlineSnapshot(`
      {
        "params": [
          "id",
          "name",
        ],
        "sql": "SELECT "t0"."id" AS "id", "t0"."title" AS "title", "t0"."authorId" AS "authorId", "t3"."_result" AS "tags" FROM "public"."rtb_posts" AS "t0" LEFT JOIN LATERAL (SELECT COALESCE(json_agg("t4"."_json"), '[]'::json) AS "_result" FROM (SELECT json_build_object($1::text, "t2"."id", $2::text, "t2"."name") AS "_json" FROM "public"."post_tag" AS "t1", "public"."rtb_tags" AS "t2" WHERE ("t1"."postId" = "t0"."id" AND "t2"."id" = "t1"."tagId")) "t4") AS "t3" ON TRUE",
      }
    `);
  });

  test("SQLite include takes the correlated-subquery strategy", () => {
    expect(
      sqlitePin(post, "findMany", { include: { tags: true } })
    ).toMatchInlineSnapshot(`
      {
        "params": [
          "id",
          "name",
        ],
        "sql": "SELECT "t0"."id" AS "id", "t0"."title" AS "title", "t0"."authorId" AS "authorId", (SELECT COALESCE(json_group_array(json("t3"."_json")), json_array()) FROM (SELECT json_object(?, "t2"."id", ?, "t2"."name") AS "_json" FROM "post_tag" AS "t1", "rtb_tags" AS "t2" WHERE ("t1"."postId" = "t0"."id" AND "t2"."id" = "t1"."tagId")) "t3") AS "tags" FROM "rtb_posts" AS "t0"",
      }
    `);
  });

  test("PostgreSQL some, every and none filters through the junction", () => {
    expect(
      pgPin(post, "findMany", {
        where: { tags: { some: { name: "typescript" } } },
      })
    ).toMatchInlineSnapshot(`
      {
        "params": [
          "typescript",
        ],
        "sql": "SELECT "t0"."id" AS "id", "t0"."title" AS "title", "t0"."authorId" AS "authorId" FROM "public"."rtb_posts" AS "t0" WHERE EXISTS (SELECT 1 FROM "public"."post_tag" AS "t1", "public"."rtb_tags" AS "t2" WHERE ("t1"."postId" = "t0"."id" AND "t2"."id" = "t1"."tagId" AND "t2"."name" = $1))",
      }
    `);
    expect(
      pgPin(post, "findMany", {
        where: { tags: { every: { name: "typescript" } } },
      })
    ).toMatchInlineSnapshot(`
      {
        "params": [
          "typescript",
        ],
        "sql": "SELECT "t0"."id" AS "id", "t0"."title" AS "title", "t0"."authorId" AS "authorId" FROM "public"."rtb_posts" AS "t0" WHERE NOT EXISTS (SELECT 1 FROM "public"."post_tag" AS "t1", "public"."rtb_tags" AS "t2" WHERE ("t1"."postId" = "t0"."id" AND "t2"."id" = "t1"."tagId" AND NOT ("t2"."name" = $1)))",
      }
    `);
    expect(
      pgPin(post, "findMany", {
        where: { tags: { none: { name: "deprecated" } } },
      })
    ).toMatchInlineSnapshot(`
      {
        "params": [
          "deprecated",
        ],
        "sql": "SELECT "t0"."id" AS "id", "t0"."title" AS "title", "t0"."authorId" AS "authorId" FROM "public"."rtb_posts" AS "t0" WHERE NOT EXISTS (SELECT 1 FROM "public"."post_tag" AS "t1", "public"."rtb_tags" AS "t2" WHERE ("t1"."postId" = "t0"."id" AND "t2"."id" = "t1"."tagId" AND "t2"."name" = $1))",
      }
    `);
  });

  test("PostgreSQL _count through the junction", () => {
    expect(
      pgPin(post, "findMany", {
        select: { id: true, _count: { select: { tags: true } } },
      })
    ).toMatchInlineSnapshot(`
      {
        "params": [
          "tags",
        ],
        "sql": "SELECT "t0"."id" AS "id", json_build_object($1::text, (SELECT COUNT(*) FROM "public"."post_tag" AS "t1", "public"."rtb_tags" AS "t2" WHERE ("t1"."postId" = "t0"."id" AND "t2"."id" = "t1"."tagId"))) AS "0viborm_relation_counts" FROM "public"."rtb_posts" AS "t0"",
      }
    `);
  });
});

// =============================================================================
// H–J. SCALAR AND COMPOUND FOREIGN KEYS
// =============================================================================

describe("foreign-key read SQL", () => {
  test("PostgreSQL scalar-FK include, to-one then to-many", () => {
    expect(
      pgPin(post, "findMany", { include: { author: true } })
    ).toMatchInlineSnapshot(`
      {
        "params": [
          "id",
          "name",
          1,
        ],
        "sql": "SELECT "t0"."id" AS "id", "t0"."title" AS "title", "t0"."authorId" AS "authorId", "t2"."_result" AS "author" FROM "public"."rtb_posts" AS "t0" LEFT JOIN LATERAL (SELECT json_build_object($1::text, "t1"."id", $2::text, "t1"."name") AS "_result" FROM "public"."rtb_authors" AS "t1" WHERE "t0"."authorId" = "t1"."id" LIMIT $3) AS "t2" ON TRUE",
      }
    `);
    expect(
      pgPin(author, "findMany", { include: { posts: true } })
    ).toMatchInlineSnapshot(`
      {
        "params": [
          "id",
          "title",
          "authorId",
        ],
        "sql": "SELECT "t0"."id" AS "id", "t0"."name" AS "name", "t2"."_result" AS "posts" FROM "public"."rtb_authors" AS "t0" LEFT JOIN LATERAL (SELECT COALESCE(json_agg("t3"."_json"), '[]'::json) AS "_result" FROM (SELECT json_build_object($1::text, "t1"."id", $2::text, "t1"."title", $3::text, "t1"."authorId") AS "_json" FROM "public"."rtb_posts" AS "t1" WHERE "t0"."id" = "t1"."authorId") "t3") AS "t2" ON TRUE",
      }
    `);
  });

  test("SQLite scalar-FK include, to-one then to-many", () => {
    expect(
      sqlitePin(post, "findMany", { include: { author: true } })
    ).toMatchInlineSnapshot(`
      {
        "params": [
          "id",
          "name",
          1,
        ],
        "sql": "SELECT "t0"."id" AS "id", "t0"."title" AS "title", "t0"."authorId" AS "authorId", (SELECT json_object(?, "t1"."id", ?, "t1"."name") FROM "rtb_authors" AS "t1" WHERE "t0"."authorId" = "t1"."id" LIMIT ?) AS "author" FROM "rtb_posts" AS "t0"",
      }
    `);
    expect(
      sqlitePin(author, "findMany", { include: { posts: true } })
    ).toMatchInlineSnapshot(`
      {
        "params": [
          "id",
          "title",
          "authorId",
        ],
        "sql": "SELECT "t0"."id" AS "id", "t0"."name" AS "name", (SELECT COALESCE(json_group_array(json("t2"."_json")), json_array()) FROM (SELECT json_object(?, "t1"."id", ?, "t1"."title", ?, "t1"."authorId") AS "_json" FROM "rtb_posts" AS "t1" WHERE "t0"."id" = "t1"."authorId") "t2") AS "posts" FROM "rtb_authors" AS "t0"",
      }
    `);
  });

  test("PostgreSQL compound-FK to-one include correlates on both members", () => {
    expect(
      pgPin(membership, "findMany", { include: { tenant: true } })
    ).toMatchInlineSnapshot(`
      {
        "params": [
          "id",
          "region",
          "slug",
          1,
        ],
        "sql": "SELECT "t0"."id" AS "id", "t0"."role" AS "role", "t0"."tenantRegion" AS "tenantRegion", "t0"."tenantSlug" AS "tenantSlug", "t2"."_result" AS "tenant" FROM "public"."rtb_memberships" AS "t0" LEFT JOIN LATERAL (SELECT json_build_object($1::text, "t1"."id", $2::text, "t1"."region", $3::text, "t1"."slug") AS "_result" FROM "public"."rtb_tenants" AS "t1" WHERE ("t0"."tenantRegion" = "t1"."region" AND "t0"."tenantSlug" = "t1"."slug") LIMIT $4) AS "t2" ON TRUE",
      }
    `);
  });

  test("PostgreSQL findUnique by the named compound unique", () => {
    expect(
      pgPin(tenant, "findUnique", {
        where: { region_slug: { region: "eu-west", slug: "acme" } },
      })
    ).toMatchInlineSnapshot(`
      {
        "params": [
          "eu-west",
          "acme",
        ],
        "sql": "SELECT "t0"."id" AS "id", "t0"."region" AS "region", "t0"."slug" AS "slug" FROM "public"."rtb_tenants" AS "t0" WHERE ("t0"."region" = $1 AND "t0"."slug" = $2) LIMIT 1",
      }
    `);
  });
});

// =============================================================================
// K–L. RELATION ORDERING
// =============================================================================

describe("relation ordering read SQL", () => {
  test("PostgreSQL orderBy through a to-one chain joins the target", () => {
    expect(
      pgPin(post, "findMany", { orderBy: { author: { name: "asc" } } })
    ).toMatchInlineSnapshot(`
      {
        "params": [],
        "sql": "SELECT "t0"."id" AS "id", "t0"."title" AS "title", "t0"."authorId" AS "authorId" FROM "public"."rtb_posts" AS "t0" LEFT JOIN "public"."rtb_authors" AS "t1" ON "t0"."authorId" = "t1"."id" ORDER BY "t1"."name" ASC",
      }
    `);
  });

  test("PostgreSQL orderBy on a to-many _count uses a count subquery", () => {
    expect(
      pgPin(author, "findMany", { orderBy: { posts: { _count: "desc" } } })
    ).toMatchInlineSnapshot(`
      {
        "params": [],
        "sql": "SELECT "t0"."id" AS "id", "t0"."name" AS "name" FROM "public"."rtb_authors" AS "t0" ORDER BY (SELECT COUNT(*) FROM "public"."rtb_posts" AS "t1" WHERE "t0"."id" = "t1"."authorId") DESC",
      }
    `);
  });
});

// =============================================================================
// M–N. POLYMORPHIC INVERSE
// =============================================================================

describe("polymorphic inverse read SQL", () => {
  test("PostgreSQL to-many inverse include takes the LATERAL strategy", () => {
    expect(
      pgPolyPin(subjectPost, "findMany", { include: { comments: true } })
    ).toMatchInlineSnapshot(`
      {
        "params": [
          "id",
          "body",
          "content.post.v1",
        ],
        "sql": "SELECT "t0"."post_pk" AS "id", "t2"."_result" AS "comments" FROM "public"."post" AS "t0" LEFT JOIN LATERAL (SELECT COALESCE(json_agg("t3"."_json"), '[]'::json) AS "_result" FROM (SELECT json_build_object($1::text, "t1"."id", $2::text, "t1"."body") AS "_json" FROM "public"."comment" AS "t1" WHERE ("t1"."subject_id" = "t0"."post_pk" AND "t1"."subject_type" = $3)) "t3") AS "t2" ON TRUE",
      }
    `);
  });

  test("SQLite to-many inverse include takes the correlated-subquery strategy", () => {
    expect(
      sqlitePolyPin(subjectPost, "findMany", { include: { comments: true } })
    ).toMatchInlineSnapshot(`
      {
        "params": [
          "id",
          "body",
          "content.post.v1",
        ],
        "sql": "SELECT "t0"."post_pk" AS "id", (SELECT COALESCE(json_group_array(json("t2"."_json")), json_array()) FROM (SELECT json_object(?, "t1"."id", ?, "t1"."body") AS "_json" FROM "comment" AS "t1" WHERE ("t1"."subject_id" = "t0"."post_pk" AND "t1"."subject_type" COLLATE BINARY = ?)) "t2") AS "comments" FROM "post" AS "t0"",
      }
    `);
  });

  test("PostgreSQL fields-less singular inverse include", () => {
    expect(
      pgPolyPin(singularPost, "findMany", {
        include: { featuredComment: true },
      })
    ).toMatchInlineSnapshot(`
      {
        "params": [
          "id",
          "body",
          "post",
          1,
        ],
        "sql": "SELECT "t0"."post_pk" AS "id", "t2"."_result" AS "featuredComment" FROM "public"."singularPost" AS "t0" LEFT JOIN LATERAL (SELECT json_build_object($1::text, "t1"."id", $2::text, "t1"."body") AS "_result" FROM "public"."singularComment" AS "t1" WHERE ("t1"."commentable_id" = "t0"."post_pk" AND "t1"."commentable_type" = $3) LIMIT $4) AS "t2" ON TRUE",
      }
    `);
  });
});

// =============================================================================
// O. NESTED INCLUDE, DEPTH 2
// =============================================================================

describe("nested include read SQL", () => {
  test("PostgreSQL depth-2 include with an inner where, orderBy and take", () => {
    expect(
      pgPin(author, "findMany", {
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
      })
    ).toMatchInlineSnapshot(`
      {
        "params": [
          "id",
          "title",
          "authorId",
          "tags",
          "id",
          "name",
          "type",
          3,
        ],
        "sql": "SELECT "t0"."id" AS "id", "t0"."name" AS "name", "t2"."_result" AS "posts" FROM "public"."rtb_authors" AS "t0" LEFT JOIN LATERAL (SELECT COALESCE(json_agg("t7"."_json"), '[]'::json) AS "_result" FROM (SELECT json_build_object($1::text, "t1"."id", $2::text, "t1"."title", $3::text, "t1"."authorId", $4::text, "t5"."_result") AS "_json" FROM "public"."rtb_posts" AS "t1" LEFT JOIN LATERAL (SELECT COALESCE(json_agg("t6"."_json"), '[]'::json) AS "_result" FROM (SELECT json_build_object($5::text, "t4"."id", $6::text, "t4"."name") AS "_json" FROM "public"."post_tag" AS "t3", "public"."rtb_tags" AS "t4" WHERE ("t3"."postId" = "t1"."id" AND "t4"."id" = "t3"."tagId" AND POSITION($7 IN "t4"."name") > 0) ORDER BY "t4"."name" DESC, "t4"."id" ASC LIMIT $8) "t6") AS "t5" ON TRUE WHERE "t0"."id" = "t1"."authorId") "t7") AS "t2" ON TRUE",
      }
    `);
  });

  test("SQLite depth-2 include with an inner where, orderBy and take", () => {
    expect(
      sqlitePin(author, "findMany", {
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
      })
    ).toMatchInlineSnapshot(`
      {
        "params": [
          "id",
          "title",
          "authorId",
          "tags",
          "id",
          "name",
          "type",
          3,
        ],
        "sql": "SELECT "t0"."id" AS "id", "t0"."name" AS "name", (SELECT COALESCE(json_group_array(json("t5"."_json")), json_array()) FROM (SELECT json_object(?, "t1"."id", ?, "t1"."title", ?, "t1"."authorId", ?, (SELECT COALESCE(json_group_array(json("t4"."_json")), json_array()) FROM (SELECT json_object(?, "t3"."id", ?, "t3"."name") AS "_json" FROM "post_tag" AS "t2", "rtb_tags" AS "t3" WHERE ("t2"."postId" = "t1"."id" AND "t3"."id" = "t2"."tagId" AND instr("t3"."name", ?) > 0) ORDER BY "t3"."name" DESC, "t3"."id" ASC LIMIT ?) "t4")) AS "_json" FROM "rtb_posts" AS "t1" WHERE "t0"."id" = "t1"."authorId") "t5") AS "posts" FROM "rtb_authors" AS "t0"",
      }
    `);
  });
});

// =============================================================================
// P–S. POLYMORPHIC COLLECTION
//
// These go through `QueryEngine.build`, which VALIDATES args first — so they
// also witness that the operation-schema half admits the collection grammar.
// =============================================================================

describe("polymorphic collection read SQL", () => {
  test("PostgreSQL direct collection include, every variant", () => {
    expect(
      pgCollectionPin(collectionGallery, "findMany", {
        include: { items: true },
      })
    ).toMatchSnapshot();
  });

  test("SQLite direct collection include, every variant", () => {
    expect(
      sqliteCollectionPin(collectionGallery, "findMany", {
        include: { items: true },
      })
    ).toMatchSnapshot();
  });

  test("PostgreSQL direct collection include narrowed by only", () => {
    expect(
      pgCollectionPin(collectionGallery, "findMany", {
        include: {
          items: {
            only: ["article"],
            variants: { article: { orderBy: { title: "asc" }, take: 2 } },
          },
        },
      })
    ).toMatchSnapshot();
  });

  test("PostgreSQL collection quantifier filters", () => {
    expect(
      pgCollectionPin(collectionGallery, "findMany", {
        where: { items: { some: { type: "article", is: { title: "x" } } } },
      })
    ).toMatchSnapshot();
    expect(
      pgCollectionPin(collectionGallery, "findMany", {
        where: { items: { every: { type: "article", is: { title: "x" } } } },
      })
    ).toMatchSnapshot();
  });

  test("PostgreSQL collection _count projection and ordering", () => {
    expect(
      pgCollectionPin(collectionGallery, "findMany", {
        select: { id: true, _count: { select: { items: true } } },
      })
    ).toMatchSnapshot();
    expect(
      pgCollectionPin(collectionGallery, "findMany", {
        orderBy: { items: { _count: "desc" } },
      })
    ).toMatchSnapshot();
  });

  test("PostgreSQL singular collection inverse include", () => {
    expect(
      pgCollectionPin(collectionArticle, "findMany", {
        include: { gallery: true },
      })
    ).toMatchSnapshot();
  });

  test("PostgreSQL plural collection inverse include", () => {
    expect(
      pgCollectionPin(collectionClip, "findMany", {
        include: { galleries: true },
      })
    ).toMatchSnapshot();
  });

  test("PostgreSQL parent ordering through a singular collection inverse", () => {
    expect(
      pgCollectionPin(collectionArticle, "findMany", {
        orderBy: { gallery: { name: "asc" } },
      })
    ).toMatchSnapshot();
  });
});
