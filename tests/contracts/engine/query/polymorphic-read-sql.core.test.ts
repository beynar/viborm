import { MySQLAdapter } from "@adapters/databases/mysql/mysql-adapter";
import { PostgresAdapter } from "@adapters/databases/postgres/postgres-adapter";
import { SQLiteAdapter } from "@adapters/databases/sqlite/sqlite-adapter";
import { buildSelectWithAliases } from "@query-engine/builders/select-builder";
import { buildWhere } from "@query-engine/builders/where-builder";
import { createQueryScope } from "@query-engine/context";
import { buildMutationProjectionFold } from "@query-engine/operations/mutation-projection-fold";
import {
  projectionReadsMutatedModel,
  selectProjectsRelation,
} from "@query-engine/write-engine/shared";
import { hydrateSchemaNames, s } from "@schema";
import { validateSchemaOrThrow } from "@schema/validation";
import { sql } from "@sql";
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
  subject: s.polymorphic(
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
  subject: s.polymorphic(
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
  subject: s.polymorphic(
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

beforeAll(() => {
  hydrateSchemaNames(schema);
  validateSchemaOrThrow(schema);
  hydrateSchemaNames(scaleSchema);
  validateSchemaOrThrow(scaleSchema);
});

describe("direct polymorphic read SQL", () => {
  test("grows one CASE arm per configured variant", () => {
    const threeScope = createQueryScope(
      new PostgresAdapter(),
      threeVariantOwner
    );
    const three = buildSelectWithAliases(
      threeScope,
      { subject: true },
      undefined,
      threeScope.rootAlias
    ).sql;
    const eightScope = createQueryScope(
      new PostgresAdapter(),
      eightVariantOwner
    );
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
    const scope = createQueryScope(new PostgresAdapter(), comment);
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
    const scope = createQueryScope(new MySQLAdapter(), comment);
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
    const scope = createQueryScope(new SQLiteAdapter(), comment);
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

  test("compiles null and negative target filters from both storage columns", () => {
    const adapter = new SQLiteAdapter();
    const nullScope = createQueryScope(adapter, comment);
    const empty = buildWhere(
      nullScope,
      { subject: null },
      nullScope.rootAlias
    );
    expect(empty?.toStatement("?")).toContain(
      '"t0"."subject_type" IS NULL AND "t0"."subject_id" IS NULL'
    );

    const negativeScope = createQueryScope(adapter, comment);
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
    ).toContain("json(CASE WHEN \"subject_id\" IS NOT NULL");
  });

  test("carries selected private columns through the mutation CTE only", () => {
    const scope = createQueryScope(new PostgresAdapter(), comment);
    const folded = buildMutationProjectionFold(scope, {
      mutation: sql`UPDATE "comment" SET "body" = ${"changed"}`,
      select: { id: true, subject: true },
    });
    const statement = folded.toStatement("$n");

    expect(statement).toContain(
      'RETURNING "id", "body", "subject_type", "subject_id"'
    );
    expect(statement).not.toContain('AS "subject_type"');

    const scalarScope = createQueryScope(new PostgresAdapter(), comment);
    const scalarFold = buildMutationProjectionFold(scalarScope, {
      mutation: sql`UPDATE "comment" SET "body" = ${"changed"}`,
      select: { id: true },
    }).toStatement("$n");
    expect(scalarFold).toContain('RETURNING "id", "body"');
    expect(scalarFold).not.toContain('RETURNING "id", "body", "subject_type"');
  });

  test("classifies polymorphic projections and self-target fold hazards", () => {
    expect(selectProjectsRelation(comment, { subject: true })).toBe(true);
    const commentScope = createQueryScope(new PostgresAdapter(), comment);
    expect(
      projectionReadsMutatedModel(commentScope, { subject: true }, undefined)
    ).toBe(false);

    const node = s.model({
      id: s.string().id(),
      subject: s
        .polymorphic(
          { node: () => node },
          { values: { node: "tree.node.v1" } }
        )
        .optional(),
    });
    const selfSchema = { node };
    hydrateSchemaNames(selfSchema);
    validateSchemaOrThrow(selfSchema);
    const nodeScope = createQueryScope(new PostgresAdapter(), node);
    expect(
      projectionReadsMutatedModel(nodeScope, { subject: true }, undefined)
    ).toBe(true);
    expect(
      projectionReadsMutatedModel(
        nodeScope,
        undefined,
        { subject: { node: { select: { id: true } } } }
      )
    ).toBe(true);
    expect(
      projectionReadsMutatedModel(
        nodeScope,
        undefined,
        { subject: { type: "node" } }
      )
    ).toBe(false);
  });
});
