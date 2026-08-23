import { MySQLAdapter } from "@adapters/databases/mysql/mysql-adapter";
import { PostgresAdapter } from "@adapters/databases/postgres/postgres-adapter";
import { SQLiteAdapter } from "@adapters/databases/sqlite/sqlite-adapter";
import { buildOrderByParts } from "@query-engine/builders/orderby-builder";
import { buildSelectWithAliases } from "@query-engine/builders/select-builder";
import { buildWhere } from "@query-engine/builders/where-builder";
import { s } from "@schema";
import { prepareSchema, scopeFor } from "@tests/fixtures/query-scope";
import { beforeAll, describe, expect, test } from "vitest";

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
  // Coexists with the ordinary post relation. The unnamed `post.notes` inverse
  // must keep using postId, not silently adopt these private columns.
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
    .toOne({ post: () => singularPost, video: () => singularVideo })
    .name("featuredCommentable")
    .optional(),
});

// =============================================================================
// COLLECTION INVERSES — the two §2.2 topology cells whose membership lives in a
// MEMBER JUNCTION rather than on either row.
//
// `article.gallery` is a fields-less `manyToOne`: a SINGULAR inverse, physically
// backed by the UNIQUE over the complete target side of `gallery_items_article`.
// `clip.galleries` is a fields-less `manyToMany`: a PLURAL inverse.
// =============================================================================

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
    { values: { article: "inv.article.v1", clip: "inv.clip.v1" } }
  ),
});

const collectionSchema = { article, clip, gallery };

beforeAll(() => {
  const schema = {
    post,
    video,
    comment,
    note,
    singularPost,
    singularVideo,
    singularComment,
  };
  prepareSchema(schema);
  prepareSchema(collectionSchema);
});

const EXPECTED_INVERSE_CORRELATION =
  '"t1"."subject_id" = "t0"."post_pk" AND "t1"."subject_type" = ';
const TO_MANY_FILTER_OPERATORS: readonly ("some" | "every" | "none")[] = [
  "some",
  "every",
  "none",
];

describe("polymorphic inverse read correlation", () => {
  test("keeps the PostgreSQL to-many include on the LATERAL path", () => {
    const scope = scopeFor(new PostgresAdapter(), post);
    const projection = buildSelectWithAliases(
      scope,
      undefined,
      { comments: { where: { body: { equals: "included" } } } },
      scope.rootAlias
    );

    expect(projection.lateralJoins).toHaveLength(1);
    const lateral = projection.lateralJoins[0]!.toStatement("$n");
    expect(lateral).toContain("LEFT JOIN LATERAL");
    expect(lateral).toContain(EXPECTED_INVERSE_CORRELATION);
    expect(lateral).toContain(`${EXPECTED_INVERSE_CORRELATION}$3`);
    expect(projection.lateralJoins[0]!.values).toEqual([
      "id",
      "body",
      "content.post.v1",
      "included",
    ]);
  });

  test("keeps the SQLite include on the correlated-subquery path", () => {
    const scope = scopeFor(new SQLiteAdapter(), post);
    const projection = buildSelectWithAliases(
      scope,
      undefined,
      { comments: true },
      scope.rootAlias
    );
    const statement = projection.sql.toStatement("?");

    expect(projection.lateralJoins).toEqual([]);
    expect(statement).not.toContain("LATERAL");
    expect(statement).toContain(
      '"t1"."subject_id" = "t0"."post_pk" AND "t1"."subject_type" COLLATE BINARY = ?'
    );
    expect(projection.sql.values).toEqual(["id", "body", "content.post.v1"]);
  });

  test.each(
    TO_MANY_FILTER_OPERATORS
  )("binds the %s filter to both private columns", (operator) => {
    const scope = scopeFor(new PostgresAdapter(), post);
    const condition = buildWhere(
      scope,
      {
        comments: {
          [operator]: { body: { equals: operator } },
        },
      },
      scope.rootAlias
    );
    const statement = condition?.toStatement("$n") ?? "";

    expect(statement).toContain(`${EXPECTED_INVERSE_CORRELATION}$1`);
    expect(condition?.values).toEqual(["content.post.v1", operator]);
    if (operator === "some") expect(statement).toContain("EXISTS");
    if (operator === "every") expect(statement).toContain("NOT EXISTS");
    if (operator === "none") expect(statement).toContain("NOT EXISTS");
  });

  test("binds relation count before its nested filter", () => {
    const scope = scopeFor(new PostgresAdapter(), post);
    const projection = buildSelectWithAliases(
      scope,
      {
        id: true,
        _count: {
          select: {
            comments: { where: { body: { equals: "counted" } } },
          },
        },
      },
      undefined,
      scope.rootAlias
    );
    const statement = projection.sql.toStatement("$n");

    expect(statement).toContain("SELECT COUNT(*)");
    expect(statement).toContain(`${EXPECTED_INVERSE_CORRELATION}$2`);
    expect(projection.sql.values).toEqual([
      "comments",
      "content.post.v1",
      "counted",
    ]);
  });

  test("uses exact discriminator equality on MySQL", () => {
    const scope = scopeFor(new MySQLAdapter(), post);
    const condition = buildWhere(
      scope,
      { comments: { some: { body: { equals: "matched" } } } },
      scope.rootAlias
    );
    const statement = condition?.toStatement("?") ?? "";

    expect(statement).toContain(
      "`t1`.`subject_id` = `t0`.`post_pk` AND (`t1`.`subject_type` = ? AND BINARY `t1`.`subject_type` = ?)"
    );
    expect(condition?.values).toEqual([
      "content.post.v1",
      "content.post.v1",
      "matched",
      "matched",
    ]);
  });

  test("leaves ordinary inverse correlation unchanged", () => {
    const scope = scopeFor(new PostgresAdapter(), post);
    const projection = buildSelectWithAliases(
      scope,
      undefined,
      { notes: true },
      scope.rootAlias
    );
    const lateral = projection.lateralJoins[0]!.toStatement("$n");

    expect(lateral).toContain("LEFT JOIN LATERAL");
    expect(lateral).toContain('"t0"."post_pk" = "t1"."post_fk"');
    expect(projection.lateralJoins[0]!.values).toEqual(["id", "postId"]);
  });

  test("uses the same exact membership for a singular include and filter", () => {
    const scope = scopeFor(new PostgresAdapter(), singularPost);
    const projection = buildSelectWithAliases(
      scope,
      undefined,
      { featuredComment: true },
      scope.rootAlias
    );
    const condition = buildWhere(
      scope,
      { featuredComment: { is: { body: { equals: "featured" } } } },
      scope.rootAlias
    );

    expect(projection.lateralJoins[0]!.toStatement("$n")).toContain(
      '"t1"."commentable_id" = "t0"."post_pk" AND "t1"."commentable_type" = '
    );
    expect(projection.lateralJoins[0]!.values).toEqual([
      "id",
      "body",
      "post",
      1,
    ]);
    expect(condition?.toStatement("$n")).toContain(
      '"t3"."commentable_id" = "t0"."post_pk" AND "t3"."commentable_type" = $1'
    );
    expect(condition?.values).toEqual(["post", "featured"]);
  });
});

describe("polymorphic collection inverse read SQL", () => {
  test("a singular inverse returns one row or null through the member junction", () => {
    const scope = scopeFor(new PostgresAdapter(), article);
    const statement = buildSelectWithAliases(
      scope,
      undefined,
      { gallery: true },
      scope.rootAlias
    ).sql.toStatement("$n");

    // ONE row, LIMIT 1, ordinary to-one shape — no aggregation, no array.
    expect(statement).toContain(
      'ELSE (SELECT json_build_object($3::text, "t2"."id", $4::text, "t2"."name") FROM "gallery_items_article" AS "t1", "gallery" AS "t2" WHERE ("t1"."articleId" = "t0"."id" AND "t2"."id" = "t1"."galleryId") LIMIT $5)'
    );
    expect(statement).not.toContain("json_agg");
    // No LATERAL: a member table takes the correlated route on every adapter,
    // matching the direct collection read.
    expect(statement).not.toContain("LATERAL");
  });

  test("a singular inverse refuses a duplicate membership BEFORE its LIMIT", () => {
    const scope = scopeFor(new PostgresAdapter(), article);
    const statement = buildSelectWithAliases(
      scope,
      undefined,
      // A target filter that would leave exactly one visible row.
      { gallery: { where: { name: { equals: "only-one" } } } },
      scope.rootAlias
    ).sql.toStatement("$n");

    // THE TWO INTEGRITY BRANCHES SIT OUTSIDE THE ROW SUBQUERY, so neither the
    // target filter nor the `LIMIT 1` can hide malformed provider state. Each
    // branch answers ONE invariant.
    const orphanBranch =
      'WHEN (SELECT COUNT(*) FROM "gallery_items_article" AS "t1" LEFT JOIN "gallery" AS "t2" ON "t2"."id" = "t1"."galleryId" WHERE ("t1"."articleId" = "t0"."id" AND "t2"."id" IS NULL)) > $1';
    const duplicateBranch =
      'WHEN (SELECT COUNT(*) FROM "gallery_items_article" AS "t1" WHERE "t1"."articleId" = "t0"."id") > $2';
    expect(statement).toContain(orphanBranch);
    expect(statement).toContain(duplicateBranch);

    // Ordering, literally: both WHEN branches precede the ELSE that carries the
    // filter and the LIMIT.
    const duplicateAt = statement.indexOf(duplicateBranch);
    const filterAt = statement.indexOf('"t2"."name" = $5');
    const limitAt = statement.indexOf("LIMIT");
    expect(duplicateAt).toBeGreaterThan(-1);
    expect(filterAt).toBeGreaterThan(duplicateAt);
    expect(limitAt).toBeGreaterThan(duplicateAt);

    // The refusal is carried in the VALUE — a JSON array where a to-one leaf
    // owes one row object — because no provider has a portable `RAISE`. The
    // strict result parser names that shape.
    expect(statement).toContain("THEN '[]'::json");
  });

  test("a plural inverse returns an ordinary array plus its orphan fact", () => {
    const scope = scopeFor(new PostgresAdapter(), clip);
    const statement = buildSelectWithAliases(
      scope,
      undefined,
      { galleries: true },
      scope.rootAlias
    ).sql.toStatement("$n");

    expect(statement).toContain(
      'ELSE (SELECT COALESCE(json_agg("t3"."_json"), \'[]\'::json)'
    );
    // ONE integrity branch: a plural inverse holds any number of memberships,
    // so only the orphan fact is a violation.
    expect(statement.match(/WHEN /g)).toHaveLength(1);
    expect(statement).toContain(
      '(SELECT COUNT(*) FROM "gallery_items_clip" AS "t1" LEFT JOIN "gallery" AS "t2" ON "t2"."id" = "t1"."galleryId" WHERE ("t1"."clipId" = "t0"."id" AND "t2"."id" IS NULL)) > $1'
    );
    // A JSON object where a to-many leaf owes a row array.
    expect(statement).toContain("THEN '{}'::json");
  });

  test("orders a parent through a singular inverse with TWO left joins", () => {
    const scope = scopeFor(new PostgresAdapter(), article);
    const parts = buildOrderByParts(
      scope,
      { gallery: { name: "asc" } },
      scope.rootAlias
    );

    // A junction FROM is a comma pair, so ONE `LEFT JOIN (a, b) ON (…)` is not
    // a statement. The lowering splits the traversal's own two conditions
    // across two OUTER joins, which is what preserves ordinary NULL placement:
    // an article with no membership, and one whose membership is orphaned, both
    // still yield a parent row.
    expect(parts.joins).toHaveLength(1);
    expect(parts.joins[0]?.toStatement("$n")).toBe(
      'LEFT JOIN "gallery_items_article" AS "t1" ON "t1"."articleId" = "t0"."id" LEFT JOIN "gallery" AS "t2" ON "t2"."id" = "t1"."galleryId"'
    );
    expect(parts.orderBy?.toStatement("$n")).toBe('"t2"."name" ASC');
  });
});
