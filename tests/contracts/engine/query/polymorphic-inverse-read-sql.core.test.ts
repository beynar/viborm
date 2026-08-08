import { MySQLAdapter } from "@adapters/databases/mysql/mysql-adapter";
import { PostgresAdapter } from "@adapters/databases/postgres/postgres-adapter";
import { SQLiteAdapter } from "@adapters/databases/sqlite/sqlite-adapter";
import { buildSelectWithAliases } from "@query-engine/builders/select-builder";
import { buildWhere } from "@query-engine/builders/where-builder";
import { createQueryScope } from "@query-engine/context";
import { hydrateSchemaNames, s } from "@schema";
import { validateSchemaOrThrow } from "@schema/validation";
import { beforeAll, describe, expect, test } from "vitest";

const post = s.model({
  id: s.string().id().map("post_pk"),
  comments: s.oneToMany(() => comment),
  notes: s.oneToMany(() => note),
});

const video = s.model({
  id: s.string().id(),
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

const note = s.model({
  id: s.string().id(),
  postId: s.string().map("post_fk"),
  post: s.manyToOne(() => post).fields("postId").references("id"),
  // Coexists with the ordinary post relation. The unnamed `post.notes` inverse
  // must keep using postId, not silently adopt these private columns.
  subject: s.polymorphic(
    { post: () => post, video: () => video },
    {
      values: {
        post: "note.post.v1",
        video: "note.video.v1",
      },
    }
  ),
});

beforeAll(() => {
  const schema = { post, video, comment, note };
  hydrateSchemaNames(schema);
  validateSchemaOrThrow(schema);
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
    const scope = createQueryScope(new PostgresAdapter(), post);
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
    const scope = createQueryScope(new SQLiteAdapter(), post);
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
    expect(projection.sql.values).toEqual([
      "id",
      "body",
      "content.post.v1",
    ]);
  });

  test.each(TO_MANY_FILTER_OPERATORS)(
    "binds the %s filter to both private columns",
    (operator) => {
      const scope = createQueryScope(new PostgresAdapter(), post);
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
    }
  );

  test("binds relation count before its nested filter", () => {
    const scope = createQueryScope(new PostgresAdapter(), post);
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
    const scope = createQueryScope(new MySQLAdapter(), post);
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
    const scope = createQueryScope(new PostgresAdapter(), post);
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
});
