import { MySQLAdapter } from "@adapters/databases/mysql/mysql-adapter";
import { PostgresAdapter } from "@adapters/databases/postgres/postgres-adapter";
import { SQLiteAdapter } from "@adapters/databases/sqlite/sqlite-adapter";
import { buildOrderByParts } from "@query-engine/builders/orderby-builder";
import { buildSelectWithAliases } from "@query-engine/builders/select-builder";
import { buildWhere } from "@query-engine/builders/where-builder";
import { buildMutationProjectionFold } from "@query-engine/operations/mutation-projection-fold";
import {
  projectionReadsMutatedModel,
  selectProjectsRelation,
} from "@query-engine/write-engine/shared";
import { s } from "@schema";
import { sql } from "@sql";
import { prepareSchema, scopeFor } from "@tests/fixtures/query-scope";
import { beforeAll, describe, expect, test } from "vitest";

const post = s.model({
  id: s.string().id(),
  title: s.string(),
});

const video = s.model({
  id: s.string().id(),
  duration: s.int(),
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

const schema = { post, video, comment };

const scaleTarget1 = s.model({ id: s.string().id() });
const scaleTarget2 = s.model({ id: s.string().id() });
const scaleTarget3 = s.model({ id: s.string().id() });
const scaleTarget4 = s.model({ id: s.string().id() });
const scaleTarget5 = s.model({ id: s.string().id() });
const scaleTarget6 = s.model({ id: s.string().id() });
const scaleTarget7 = s.model({ id: s.string().id() });
const scaleTarget8 = s.model({ id: s.string().id() });

const threeVariantOwner = s.model({
  id: s.string().id(),
  subject: s.toOne(
    {
      first: () => scaleTarget1,
      second: () => scaleTarget2,
      third: () => scaleTarget3,
    },
    {
      values: {
        first: "scale.first",
        second: "scale.second",
        third: "scale.third",
      },
    }
  ),
});

const eightVariantOwner = s.model({
  id: s.string().id(),
  subject: s.toOne(
    {
      first: () => scaleTarget1,
      second: () => scaleTarget2,
      third: () => scaleTarget3,
      fourth: () => scaleTarget4,
      fifth: () => scaleTarget5,
      sixth: () => scaleTarget6,
      seventh: () => scaleTarget7,
      eighth: () => scaleTarget8,
    },
    {
      values: {
        first: "scale.first",
        second: "scale.second",
        third: "scale.third",
        fourth: "scale.fourth",
        fifth: "scale.fifth",
        sixth: "scale.sixth",
        seventh: "scale.seventh",
        eighth: "scale.eighth",
      },
    }
  ),
});

const scaleSchema = {
  scaleTarget1,
  scaleTarget2,
  scaleTarget3,
  scaleTarget4,
  scaleTarget5,
  scaleTarget6,
  scaleTarget7,
  scaleTarget8,
  threeVariantOwner,
  eightVariantOwner,
};

// =============================================================================
// COLLECTION SCHEMAS
//
// Built through a SEPARATE registry for the same reason the polymorphic pins in
// `read-traversal-byte-pins` are: member-junction topology is MATERIALIZED by
// `validateSchemaOrThrow`, not by hydration.
// =============================================================================

const article = s.model({
  id: s.string().id(),
  title: s.string(),
  rank: s.int(),
});

const clip = s.model({
  id: s.string().id(),
  seconds: s.int(),
});

const gallery = s.model({
  id: s.string().id(),
  items: s.toMany(
    { article: () => article, clip: () => clip },
    { values: { article: "coll.article.v1", clip: "coll.clip.v1" } }
  ),
});

const collectionSchema = { article, clip, gallery };

/** A compound/mapped target key, to prove every member joins on every column. */
const region = s
  .model({
    code: s.string().map("region_code"),
    slug: s.string(),
    label: s.string(),
  })
  .id(["code", "slug"]);

const compoundOwner = s.model({
  id: s.string().id(),
  places: s.toMany(
    { region: () => region },
    { values: { region: "cmp.region.v1" } }
  ),
});
const compoundSchema = { region, compoundOwner };

/** Five variants × fifteen columns — the D1 bind-budget frontier (§6.4). */
const fanTarget = (() =>
  Object.fromEntries(
    Array.from({ length: 15 }, (_, index) => [`c${index}`, s.string()])
  ))();
const fan1 = s.model({ id: s.string().id(), ...fanTarget });
const fan2 = s.model({ id: s.string().id(), ...fanTarget });
const fan3 = s.model({ id: s.string().id(), ...fanTarget });
const fan4 = s.model({ id: s.string().id(), ...fanTarget });
const fan5 = s.model({ id: s.string().id(), ...fanTarget });
const fanOwner = s.model({
  id: s.string().id(),
  items: s.toMany(
    {
      one: () => fan1,
      two: () => fan2,
      three: () => fan3,
      four: () => fan4,
      five: () => fan5,
    },
    {
      values: {
        one: "fan.one.v1",
        two: "fan.two.v1",
        three: "fan.three.v1",
        four: "fan.four.v1",
        five: "fan.five.v1",
      },
    }
  ),
});
const fanSchema = { fan1, fan2, fan3, fan4, fan5, fanOwner };

beforeAll(() => {
  prepareSchema(schema);
  prepareSchema(scaleSchema);
  prepareSchema(collectionSchema);
  prepareSchema(compoundSchema);
  prepareSchema(fanSchema);
});

describe("direct polymorphic read SQL", () => {
  test("grows one CASE arm per configured variant", () => {
    const threeScope = scopeFor(new PostgresAdapter(), threeVariantOwner);
    const three = buildSelectWithAliases(
      threeScope,
      { subject: true },
      undefined,
      threeScope.rootAlias
    ).sql;
    const eightScope = scopeFor(new PostgresAdapter(), eightVariantOwner);
    const eight = buildSelectWithAliases(
      eightScope,
      { subject: true },
      undefined,
      eightScope.rootAlias
    ).sql;

    expect(three.toStatement("$n").match(/\bWHEN\b/g)).toHaveLength(4);
    expect(eight.toStatement("$n").match(/\bWHEN\b/g)).toHaveLength(9);
    expect(
      eight.values.filter(
        (value) => typeof value === "string" && value.startsWith("scale.")
      )
    ).toHaveLength(8);
  });

  test("emits one CASE arm per variant and defaults omitted target projections", () => {
    const scope = scopeFor(new PostgresAdapter(), comment);
    const projection = buildSelectWithAliases(
      scope,
      {
        id: true,
        subject: {
          post: { select: { title: true } },
        },
      },
      undefined,
      scope.rootAlias
    );
    const statement = projection.sql.toStatement("$n");

    expect(statement.match(/\bWHEN\b/g)).toHaveLength(3);
    expect(statement).toContain('"t1"."title"');
    expect(statement).toContain('"t2"."id"');
    expect(statement).toContain('"t2"."duration"');
    expect(statement).toContain('"t0"."subject_type"');
    expect(statement).toContain('"t0"."subject_id"');
    expect(statement).not.toContain("LATERAL");
    const discriminatorsAndStates = projection.sql.values.filter(
      (value) =>
        typeof value === "string" &&
        [
          "content.post.v1",
          "content.video.v1",
          "linked",
          "post",
          "video",
          "invalid",
        ].includes(value)
    );
    expect(discriminatorsAndStates).toEqual([
      "content.post.v1",
      "linked",
      "post",
      "content.video.v1",
      "linked",
      "video",
      "invalid",
    ]);
  });

  test("uses exact discriminator equality on MySQL", () => {
    const scope = scopeFor(new MySQLAdapter(), comment);
    const where = buildWhere(
      scope,
      {
        subject: {
          type: "post",
          is: { title: { equals: "hello" } },
        },
      },
      scope.rootAlias
    );
    const statement = where?.toStatement("?") ?? "";

    expect(statement).toContain(
      "`t0`.`subject_type` = ? AND BINARY `t0`.`subject_type` = ?"
    );
    expect(statement).toContain("EXISTS (SELECT 1 FROM `post` AS `t1`");
    expect(where?.values).toEqual([
      "content.post.v1",
      "content.post.v1",
      "hello",
      "hello",
    ]);
  });

  test("restores SQLite JSON document identity across the target subquery", () => {
    const scope = scopeFor(new SQLiteAdapter(), comment);
    const projection = buildSelectWithAliases(
      scope,
      {
        subject: {
          post: { select: { id: true, title: true } },
          video: { select: { id: true, duration: true } },
        },
      },
      undefined,
      scope.rootAlias
    );

    expect(projection.sql.toStatement("?")).toContain("json((SELECT");
  });

  test("compiles presence and negative target filters from exact storage", () => {
    const adapter = new SQLiteAdapter();
    const nullScope = scopeFor(adapter, comment);
    const empty = buildWhere(
      nullScope,
      { subject: { is: null } },
      nullScope.rootAlias
    );
    expect(empty?.toStatement("?")).toContain(
      '"t0"."subject_type" IS NULL AND "t0"."subject_id" IS NULL'
    );
    expect(empty?.values).toEqual([]);

    const presentScope = scopeFor(adapter, comment);
    const present = buildWhere(
      presentScope,
      { subject: { isNot: null } },
      presentScope.rootAlias
    );
    expect(present?.toStatement("?")).toContain(
      '"t0"."subject_type" IS NOT NULL AND "t0"."subject_id" IS NOT NULL'
    );
    expect(present?.values).toEqual([]);

    const negativeScope = scopeFor(adapter, comment);
    const negative = buildWhere(
      negativeScope,
      {
        subject: {
          type: "video",
          isNot: { duration: { equals: 0 } },
        },
      },
      negativeScope.rootAlias
    );
    expect(negative?.toStatement("?")).toContain(
      'NOT EXISTS (SELECT 1 FROM "video" AS "t1"'
    );
    expect(negative?.values).toEqual(["content.video.v1", 0]);
  });

  test("adapters encode invalid-storage diagnostics with a real JSON boolean", () => {
    const postgres = new PostgresAdapter();
    expect(
      postgres.json
        .boolean(
          postgres.operators.isNotNull(
            postgres.identifiers.escape("subject_id")
          )
        )
        .toStatement("$n")
    ).toBe('"subject_id" IS NOT NULL');

    const mysql = new MySQLAdapter();
    expect(
      mysql.json
        .boolean(
          mysql.operators.isNotNull(mysql.identifiers.escape("subject_id"))
        )
        .toStatement("?")
    ).toContain("JSON_EXTRACT(CASE WHEN `subject_id` IS NOT NULL");

    const sqlite = new SQLiteAdapter();
    expect(
      sqlite.json
        .boolean(
          sqlite.operators.isNotNull(sqlite.identifiers.escape("subject_id"))
        )
        .toStatement("?")
    ).toContain('json(CASE WHEN "subject_id" IS NOT NULL');
  });

  test("carries selected private columns through the mutation CTE only", () => {
    const scope = scopeFor(new PostgresAdapter(), comment);
    const folded = buildMutationProjectionFold(scope, {
      mutation: sql`UPDATE "comment" SET "body" = ${"changed"}`,
      select: { id: true, subject: true },
    });
    const statement = folded.toStatement("$n");

    expect(statement).toContain(
      'RETURNING "id", "body", "subject_type", "subject_id"'
    );
    expect(statement).not.toContain('AS "subject_type"');

    const scalarScope = scopeFor(new PostgresAdapter(), comment);
    const scalarFold = buildMutationProjectionFold(scalarScope, {
      mutation: sql`UPDATE "comment" SET "body" = ${"changed"}`,
      select: { id: true },
    }).toStatement("$n");
    expect(scalarFold).toContain('RETURNING "id", "body"');
    expect(scalarFold).not.toContain('RETURNING "id", "body", "subject_type"');
  });

  test("classifies polymorphic projections and self-target fold hazards", () => {
    expect(selectProjectsRelation(comment, { subject: true })).toBe(true);
    const commentScope = scopeFor(new PostgresAdapter(), comment);
    expect(
      projectionReadsMutatedModel(commentScope, { subject: true }, undefined)
    ).toBe(false);

    const node = s.model({
      id: s.string().id(),
      subject: s
        .toOne({ node: () => node }, { values: { node: "tree.node.v1" } })
        .optional(),
    });
    const selfSchema = { node };
    prepareSchema(selfSchema);
    const nodeScope = scopeFor(new PostgresAdapter(), node);
    expect(
      projectionReadsMutatedModel(nodeScope, { subject: true }, undefined)
    ).toBe(true);
    expect(
      projectionReadsMutatedModel(nodeScope, undefined, {
        subject: { node: { select: { id: true } } },
      })
    ).toBe(true);
    expect(
      projectionReadsMutatedModel(nodeScope, undefined, {
        subject: { type: "node" },
      })
    ).toBe(false);
  });
});

/**
 * DIRECT POLYMORPHIC COLLECTION READ SQL.
 *
 * Driven through directly-built scopes rather than `QueryEngine.build`, the way
 * the toOne pins above are: the shapes under measurement are the compiled
 * statement and its bound parameters, and the collection selection is handed to
 * the builder in exactly the ONE cross-boundary shape the operation schema
 * produces — `true` / `false` verbatim, or `{ only?, variants? }` with `only`
 * already deduplicated into declaration order.
 */
describe("direct polymorphic collection read SQL", () => {
  const collectionScope = () => scopeFor(new PostgresAdapter(), gallery);

  test("emits one branch per variant, in declaration order, in one statement", () => {
    const scope = collectionScope();
    const statement = buildSelectWithAliases(
      scope,
      { id: true, items: true },
      undefined,
      scope.rootAlias
    ).sql.toStatement("$n");

    // ONE statement, no set operation, no lateral: the whole collection is one
    // correlated JSON document per owner row.
    expect(statement).not.toContain("UNION");
    expect(statement).not.toContain("LATERAL");

    // Both member tables, both target tables, in DECLARATION ORDER — the one
    // ordering truth. `indexOf` compares first occurrence, which is the arm's
    // membership subquery.
    const articleAt = statement.indexOf('"gallery_items_article"');
    const clipAt = statement.indexOf('"gallery_items_clip"');
    expect(articleAt).toBeGreaterThan(-1);
    expect(clipAt).toBeGreaterThan(articleAt);
    expect(statement).toContain('"article" AS');
    expect(statement).toContain('"clip" AS');
  });

  test("grows only with variant count, never with owner or column count", () => {
    const twoScope = collectionScope();
    const two = buildSelectWithAliases(
      twoScope,
      { items: true },
      undefined,
      twoScope.rootAlias
    ).sql.toStatement("$n");
    const fanScope = scopeFor(new PostgresAdapter(), fanOwner);
    const five = buildSelectWithAliases(
      fanScope,
      { items: true },
      undefined,
      fanScope.rootAlias
    ).sql.toStatement("$n");

    // Three correlated subqueries per arm: membership count, orphan count, rows.
    const perArm = (sqlText: string) => sqlText.match(/SELECT COUNT\(\*\)/g);
    expect(perArm(two)).toHaveLength(4);
    expect(perArm(five)).toHaveLength(10);
  });

  test("computes owner-scoped integrity facts through a membership-first LEFT JOIN", () => {
    const scope = collectionScope();
    const statement = buildSelectWithAliases(
      scope,
      { items: true },
      undefined,
      scope.rootAlias
    ).sql.toStatement("$n");

    // THE INTEGRITY CARRIER. The orphan probe reads the member table FIRST and
    // outer-joins the target, so a membership row whose target is gone survives
    // to be counted. An inner join — which is what the ordinary junction
    // traversal emits — would drop it silently.
    expect(statement).toContain(
      'FROM "public"."gallery_items_article" AS "t1" LEFT JOIN "public"."article" AS "t2" ON "t2"."id" = "t1"."articleId" WHERE ("t1"."galleryId" = "t0"."id" AND "t2"."id" IS NULL)'
    );
    // The membership count is the member table ALONE — no target join at all.
    expect(statement).toContain(
      'SELECT COUNT(*) FROM "public"."gallery_items_article" AS "t1" WHERE "t1"."galleryId" = "t0"."id"'
    );
  });

  test("keeps every integrity subquery free of the user filter and window", () => {
    const scope = collectionScope();
    const statement = buildSelectWithAliases(
      scope,
      {
        items: {
          variants: {
            article: { where: { title: { equals: "kept" } }, take: 2, skip: 1 },
          },
        },
      },
      undefined,
      scope.rootAlias
    ).sql.toStatement("$n");

    // The window landed on the VISIBLE-ROW branch...
    expect(statement).toContain("LIMIT");
    expect(statement).toContain("OFFSET");
    // ...and nowhere near either integrity subquery, whose text is byte-identical
    // to the unfiltered read's.
    expect(statement).toContain(
      'SELECT COUNT(*) FROM "public"."gallery_items_article" AS "t1" WHERE "t1"."galleryId" = "t0"."id"'
    );
    expect(statement).toContain(
      'FROM "public"."gallery_items_article" AS "t1" LEFT JOIN "public"."article" AS "t2" ON "t2"."id" = "t1"."articleId" WHERE ("t1"."galleryId" = "t0"."id" AND "t2"."id" IS NULL)'
    );
  });

  test("only: ['article'] emits no clip row branch but keeps both integrity pairs", () => {
    const scope = collectionScope();
    const statement = buildSelectWithAliases(
      scope,
      { items: { only: ["article"] } },
      undefined,
      scope.rootAlias
    ).sql.toStatement("$n");

    // The excluded arm contributes NO visible-row branch: its `rows` value is a
    // bare NULL, which is what lets the parser tell "excluded" from "empty"
    // structurally instead of guessing from the value.
    expect(statement).not.toContain(
      'FROM "gallery_items_clip" AS "t4", "clip"'
    );
    expect(statement).toContain("$19::text, NULL)");
    // Its integrity pair survives untouched.
    expect(statement).toContain(
      'SELECT COUNT(*) FROM "public"."gallery_items_clip" AS "t4" WHERE "t4"."galleryId" = "t0"."id"'
    );
    expect(statement).toContain(
      'FROM "public"."gallery_items_clip" AS "t4" LEFT JOIN "public"."clip" AS "t5" ON "t5"."id" = "t4"."clipId" WHERE ("t4"."galleryId" = "t0"."id" AND "t5"."id" IS NULL)'
    );
    // The allow-listed arm still emits its comma-pair row branch.
    expect(statement).toContain(
      'FROM "public"."gallery_items_article" AS "t1", "public"."article" AS "t2"'
    );
  });

  test("only: [] emits no visible branch at all but every integrity subquery", () => {
    const scope = collectionScope();
    const statement = buildSelectWithAliases(
      scope,
      { items: { only: [] } },
      undefined,
      scope.rootAlias
    ).sql.toStatement("$n");

    expect(statement).not.toContain(
      'FROM "gallery_items_article" AS "t1", "article"'
    );
    expect(statement).not.toContain(
      'FROM "gallery_items_clip" AS "t3", "clip"'
    );
    expect(statement).not.toContain("json_agg");
    // Four integrity subqueries survive: an orphan in an EXCLUDED member table
    // must still fail the strict carrier.
    expect(statement.match(/SELECT COUNT\(\*\)/g)).toHaveLength(4);
  });

  test("applies order, window, cursor and distinct inside ONE arm only", () => {
    const scope = collectionScope();
    const statement = buildSelectWithAliases(
      scope,
      {
        items: {
          variants: {
            article: {
              orderBy: { rank: "desc" },
              take: -3,
              distinct: ["rank"],
            },
          },
        },
      },
      undefined,
      scope.rootAlias
    ).sql.toStatement("$n");

    // The negative take ran as a REVERSED window with an absolute limit — the
    // ordinary nested-read-window contract, byte-for-byte: `desc` inverted to
    // `ASC`, the identity tie-breaker inverted to `DESC`, `LIMIT 3`.
    expect(statement).toContain('ORDER BY "t2"."rank" ASC, "t2"."id" DESC');
    // DISTINCT is the ordinary ROW_NUMBER partition emulation, applied BEFORE
    // the window — the same order of application the top level uses.
    expect(statement).toContain('PARTITION BY "t2"."rank"');
    expect(statement).toContain('"_distinct_subquery"');
    // ARM-LOCAL: the sibling arm carries no order, no window and no dedupe.
    const clipBranch = statement.slice(
      statement.indexOf('"gallery_items_clip"')
    );
    expect(clipBranch).not.toContain("ORDER BY");
    expect(clipBranch).not.toContain("PARTITION BY");
    expect(clipBranch).not.toContain("LIMIT");
  });

  test("joins every member on every column of a compound, mapped target key", () => {
    const scope = scopeFor(new PostgresAdapter(), compoundOwner);
    const statement = buildSelectWithAliases(
      scope,
      { places: true },
      undefined,
      scope.rootAlias
    ).sql.toStatement("$n");

    // Both members of the compound key, under their MAPPED column names, in the
    // orphan LEFT JOIN and again in the row branch — never abbreviated to one.
    expect(statement).toContain(
      'LEFT JOIN "public"."region" AS "t2" ON ("t2"."region_code" = "t1"."region_1" AND "t2"."slug" = "t1"."region_2")'
    );
    expect(statement).toContain(
      '("t2"."region_code" = "t1"."region_1" AND "t2"."slug" = "t1"."region_2")'
    );
    // The orphan probe tests the FIRST referenced member only — sufficient
    // because a LEFT JOIN miss nulls every target column and the target side is
    // a row key, therefore non-nullable.
    expect(statement).toContain('"t2"."region_code" IS NULL');
  });

  test("SQLite restores JSON document identity across every arm", () => {
    const scope = scopeFor(new SQLiteAdapter(), gallery);
    const statement = buildSelectWithAliases(
      scope,
      { items: true },
      undefined,
      scope.rootAlias
    ).sql.toStatement("?");

    expect(statement).toContain("json(");
    expect(statement).toContain("json_group_array");
  });

  test("MySQL emits the collection carrier with no lateral branch", () => {
    const scope = scopeFor(new MySQLAdapter(), gallery);
    const statement = buildSelectWithAliases(
      scope,
      { items: true },
      undefined,
      scope.rootAlias
    ).sql.toStatement("?");

    // MySQL DECLARES `supportsLateralJoins: true`; the collection read is
    // correlated on every adapter regardless (decision D3), so the carrier is
    // one JSON value the single decode hook can parse.
    expect(statement).not.toContain("LATERAL");
    expect(statement).toContain("JSON_OBJECT");
  });

  test("binds a measured number of parameters for a five-variant read", () => {
    const scope = scopeFor(new PostgresAdapter(), fanOwner);
    const projection = buildSelectWithAliases(
      scope,
      { items: true },
      undefined,
      scope.rootAlias
    );

    // MEASURED, NOT ASSUMED. `json.objectFromColumns` binds every JSON KEY
    // NAME, and the collection carrier adds the outer tag, the arm container
    // keys, three fact keys per arm and one `type` literal per arm on top of the
    // target columns. D1 refuses a statement over 100 binds before any I/O
    // (`assertOperationStatementCapacity`), and there is NO read-side chunking,
    // so this number is the frontier a five-variant × fifteen-column read sits
    // at BEFORE any user filter contributes its own parameters. 128 > 100: a
    // read this wide is REFUSED on D1 today, loudly and before any I/O, which
    // is the honest state to record rather than design around.
    expect(projection.sql.values).toHaveLength(128);
  });
});

describe("direct polymorphic collection filter and count SQL", () => {
  const whereSql = (filter: Record<string, unknown>) => {
    const scope = scopeFor(new PostgresAdapter(), gallery);
    return buildWhere(scope, filter, scope.rootAlias)?.toStatement("$n") ?? "";
  };

  test("some compiles to correlated existence of the SELECTED arm only", () => {
    expect(
      whereSql({
        items: { some: { type: "article", is: { title: { equals: "x" } } } },
      })
    ).toBe(
      'EXISTS (SELECT 1 FROM "public"."gallery_items_article" AS "t1", "public"."article" AS "t2" WHERE ("t1"."galleryId" = "t0"."id" AND "t2"."id" = "t1"."articleId" AND "t2"."title" = $1))'
    );
    // No OR(), no IN (): a missing arm emits nothing at all.
    expect(whereSql({ items: { some: { type: "article" } } })).not.toContain(
      "clip"
    );
  });

  test("none is the absence of the same matching member", () => {
    expect(
      whereSql({
        items: { none: { type: "article", is: { title: { equals: "x" } } } },
      })
    ).toBe(
      'NOT EXISTS (SELECT 1 FROM "public"."gallery_items_article" AS "t1", "public"."article" AS "t2" WHERE ("t1"."galleryId" = "t0"."id" AND "t2"."id" = "t1"."articleId" AND "t2"."title" = $1))'
    );
  });

  test("none + isNot is the ONE public spelling of 'others allowed'", () => {
    // "Every article satisfies P while other variants are allowed" has this
    // spelling and only this spelling. It must never fall out of `every`.
    expect(
      whereSql({
        items: { none: { type: "article", isNot: { title: { equals: "x" } } } },
      })
    ).toBe(
      'NOT EXISTS (SELECT 1 FROM "public"."gallery_items_article" AS "t1", "public"."article" AS "t2" WHERE ("t1"."galleryId" = "t0"."id" AND "t2"."id" = "t1"."articleId" AND NOT ("t2"."title" = $1)))'
    );
  });

  test("every is a CONJUNCTION, membership-first, over every configured arm", () => {
    expect(
      whereSql({
        items: { every: { type: "article", is: { title: { equals: "x" } } } },
      })
    ).toBe(
      // Conjunct 1 — no ARTICLE member violates the predicate, read through a
      // membership-first LEFT JOIN so an ORPHAN counts as a violation (it
      // cannot satisfy P) instead of vanishing into an inner join.
      '(NOT EXISTS (SELECT 1 FROM "public"."gallery_items_article" AS "t1" LEFT JOIN "public"."article" AS "t2" ON "t2"."id" = "t1"."articleId" WHERE ("t1"."galleryId" = "t0"."id" AND ("t2"."id" IS NULL OR NOT ("t2"."title" = $1)))) ' +
        // Conjunct 2 — no member of ANY OTHER arm exists at all. Without it the
        // statement would silently mean "others allowed", which is the wrong
        // truth table rather than an error.
        'AND NOT EXISTS (SELECT 1 FROM "public"."gallery_items_clip" AS "t3" WHERE "t3"."galleryId" = "t0"."id"))'
    );
  });

  test("a bare every does NOT short-circuit — 'all members are articles' is real", () => {
    // The ordinary to-many `every` returns `undefined` with no inner condition.
    // A tagged `every` still asserts the variant, so it keeps conjunct 2.
    expect(whereSql({ items: { every: { type: "article" } } })).toBe(
      'NOT EXISTS (SELECT 1 FROM "public"."gallery_items_clip" AS "t3" WHERE "t3"."galleryId" = "t0"."id")'
    );
  });

  test("an unfiltered count sums membership counts in declaration order", () => {
    const scope = scopeFor(new PostgresAdapter(), gallery);
    const statement = buildSelectWithAliases(
      scope,
      { id: true, _count: { select: { items: true } } },
      undefined,
      scope.rootAlias
    ).sql.toStatement("$n");

    // MEMBERSHIP ONLY — no target join. Counting through the join would answer
    // a different question than "how many members does this owner hold".
    expect(statement).toContain(
      '((SELECT COUNT(*) FROM "public"."gallery_items_article" AS "t1" WHERE "t1"."galleryId" = "t0"."id") + (SELECT COUNT(*) FROM "public"."gallery_items_clip" AS "t3" WHERE "t3"."galleryId" = "t0"."id"))'
    );
  });

  test("a filtered count compiles exactly one arm", () => {
    const scope = scopeFor(new PostgresAdapter(), gallery);
    const statement = buildSelectWithAliases(
      scope,
      {
        id: true,
        _count: {
          select: {
            items: {
              where: { type: "article", is: { title: { equals: "x" } } },
            },
          },
        },
      },
      undefined,
      scope.rootAlias
    ).sql.toStatement("$n");

    expect(statement).toContain(
      '(SELECT COUNT(*) FROM "public"."gallery_items_article" AS "t1", "public"."article" AS "t2" WHERE ("t1"."galleryId" = "t0"."id" AND "t2"."id" = "t1"."articleId" AND "t2"."title" = $2))'
    );
    expect(statement).not.toContain("gallery_items_clip");
  });

  test("count ordering reuses the SAME summed expression and parameter order", () => {
    const orderScope = scopeFor(new PostgresAdapter(), gallery);
    const order = buildOrderByParts(
      orderScope,
      { items: { _count: "desc" } },
      orderScope.rootAlias
    );
    const selectScope = scopeFor(new PostgresAdapter(), gallery);
    const projected = buildSelectWithAliases(
      selectScope,
      { id: true, _count: { select: { items: true } } },
      undefined,
      selectScope.rootAlias
    ).sql.toStatement("$n");

    const summed =
      '((SELECT COUNT(*) FROM "public"."gallery_items_article" AS "t1" WHERE "t1"."galleryId" = "t0"."id") + (SELECT COUNT(*) FROM "public"."gallery_items_clip" AS "t3" WHERE "t3"."galleryId" = "t0"."id"))';
    // ONE builder, therefore one expression and one parameter order — the count
    // in the projection and the count in the ORDER BY cannot drift apart.
    expect(order.orderBy?.toStatement("$n")).toBe(`${summed} DESC`);
    expect(projected).toContain(summed);
    expect(order.joins).toHaveLength(0);
  });

  test("a row-held polymorphic slot stays off the count and order surfaces", () => {
    // Plan §7.4: `_count: true` includes toMany polymorphic fields but not
    // toOne ones, and no target-scalar root ordering is added for toOne.
    const countScope = scopeFor(new PostgresAdapter(), comment);
    expect(
      buildSelectWithAliases(
        countScope,
        { id: true, _count: { select: { subject: true } } },
        undefined,
        countScope.rootAlias
      ).sql.toStatement("$n")
    ).not.toContain("COUNT(*)");

    const orderScope = scopeFor(new PostgresAdapter(), comment);
    expect(() =>
      buildOrderByParts(
        orderScope,
        { subject: { _count: "desc" } },
        orderScope.rootAlias
      )
    ).toThrowError("Unknown orderBy field 'subject'.");
  });
});

describe("polymorphic collection projections at the mutation-fold boundary", () => {
  test("a collection key contributes NO private columns to the CTE RETURNING", () => {
    const scope = scopeFor(new PostgresAdapter(), gallery);
    const statement = buildMutationProjectionFold(scope, {
      mutation: sql`UPDATE "gallery" SET "id" = ${"changed"}`,
      select: { id: true, items: true },
    }).toStatement("$n");

    // A row-held slot pushes its `(type, id)` pair into the RETURNING list so
    // the outer projection can read the mutated row. A COLLECTION stores nothing
    // on the row at all — its membership lives in member junction tables — so
    // the CTE has nothing to carry, and reading `storage.typeColumn` here would
    // be a runtime TypeError the moment the widened info arrived.
    expect(statement).toContain('RETURNING "id"');
    expect(statement).not.toContain("items_type");
    expect(statement).not.toContain("items_id");
    // The projection still compiles — the arms are read straight from the
    // member junctions in the outer SELECT.
    expect(statement).toContain('"gallery_items_article"');
  });

  test("projectionReadsMutatedModel answers through a collection arm", () => {
    // A collection projection reads BOTH the member junction and the variant
    // target. When the target is the model under mutation, the fold must know:
    // a false `false` here lets PostgreSQL refuse the statement with 0A000.
    const selfSchema = (() => {
      const node = s.model({
        id: s.string().id(),
        children: s
          .toMany({ node: () => node }, { values: { node: "tree.node.v1" } })
          // A SELF target whose variant spells the owner's own name collides on
          // the generated side tokens; `.through()` is the documented escape.
          .through({
            node: {
              table: "node_children",
              source: "parentId",
              target: "childId",
            },
          }),
      });
      const built = { node };
      prepareSchema(built);
      return built;
    })();
    const scope = scopeFor(new PostgresAdapter(), selfSchema.node);

    expect(selectProjectsRelation(selfSchema.node, { children: true })).toBe(
      true
    );
    expect(
      projectionReadsMutatedModel(scope, { children: true }, undefined)
    ).toBe(true);
    // Through the ENVELOPE, one level deeper than the bare key: a `variants` arm
    // whose own nested include reaches the mutated table.
    expect(
      projectionReadsMutatedModel(scope, undefined, {
        children: { variants: { node: { select: { id: true } } } },
      })
    ).toBe(true);
    // And through a quantifier's tagged predicate.
    expect(
      projectionReadsMutatedModel(scope, undefined, {
        children: { some: { type: "node", is: { id: { equals: "x" } } } },
      })
    ).toBe(true);
  });
});
