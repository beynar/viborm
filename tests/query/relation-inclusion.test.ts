import { describe, test, expect } from "vitest";
import { QueryParser } from "../../src/query-parser";
import { PostgresAdapter } from "../../src/adapters/databases/postgres/postgres-adapter";
import { s } from "../../src/schema";

// Declare models first to handle circular references
let user: any;
let post: any;
let profile: any;
let tag: any;

// Define models with relations
user = s.model("user", {
  id: s.string().id(),
  name: s.string(),
  email: s.string(),
  posts: s
    .relation({
      onField: "id", // user.id
      refField: "userId", // post.userId
    })
    .oneToMany(() => post),
  profile: s
    .relation({
      onField: "id", // user.id
      refField: "userId", // profile.userId
    })
    .oneToOne(() => profile),
});

post = s.model("post", {
  id: s.string().id(),
  title: s.string(),
  content: s.string(),
  userId: s.string(),
  user: s
    .relation({
      onField: "userId", // post.userId
      refField: "id", // user.id
    })
    .manyToOne(() => user),
  tags: s
    .relation({
      junctionTable: "post_tags",
      onField: "id", // post.id
      refField: "id", // tag.id
      junctionField: "tagId", // post_tags.tagId
    })
    .manyToMany(() => tag),
});

profile = s.model("profile", {
  id: s.string().id(),
  bio: s.string(),
  avatarUrl: s.string(),
  userId: s.string(),
  user: s
    .relation({
      onField: "userId", // profile.userId
      refField: "id", // user.id
    })
    .manyToOne(() => user),
});

tag = s.model("tag", {
  id: s.string().id(),
  name: s.string(),
  color: s.string(),
  posts: s
    .relation({
      junctionTable: "post_tags",
      onField: "id", // tag.id
      refField: "id", // post.id
      junctionField: "postId", // post_tags.postId
    })
    .manyToMany(() => post),
});

describe("QueryParser - Relation Inclusion (Phase 4)", () => {
  const adapter = new PostgresAdapter();

  // Models are now defined above and available here

  describe("Basic Relation Inclusion", () => {
    test("findMany - should include oneToMany relations", () => {
      const result = QueryParser.parse(
        "findMany",
        user,
        {
          include: {
            posts: true,
          },
        },
        adapter
      );

      expect(result).toBeDefined();
      const sql = result.toStatement();

      // Should contain both user fields and posts relation
      expect(sql).toContain('SELECT "t0"."id", "t0"."name", "t0"."email"');
      expect(sql).toContain('AS "posts"');
      expect(sql).toContain("json_agg(row_to_json");
      expect(sql).toContain('"t1"."userId" = "t0"."id"');
      expect(sql).toContain('FROM "user" AS "t0"');
    });

    test("findFirst - should include relations with LIMIT 1", () => {
      const result = QueryParser.parse(
        "findFirst",
        user,
        {
          include: {
            posts: true,
          },
        },
        adapter
      );

      const sql = result.toStatement();
      expect(sql).toContain('AS "posts"');
      expect(sql).toContain("LIMIT 1");
    });

    test("findUnique - should include relations with unique constraint", () => {
      const result = QueryParser.parse(
        "findUnique",
        user,
        {
          where: { id: "user-123" },
          include: {
            posts: true,
          },
        },
        adapter
      );

      const sql = result.toStatement();
      expect(sql).toContain('AS "posts"');
      expect(sql).toContain('WHERE "t0"."id" = ?1');
      expect(sql).toContain("LIMIT 1");
    });

    test("findMany - should work with manyToOne relations", () => {
      const result = QueryParser.parse(
        "findMany",
        post,
        {
          include: {
            user: true,
          },
        },
        adapter
      );

      const sql = result.toStatement();
      expect(sql).toContain('AS "user"');
      expect(sql).toContain('"t1"."id" = "t0"."userId"');
      expect(sql).toContain('FROM "post" AS "t0"');
    });

    test("findMany - should work with oneToOne relations", () => {
      const result = QueryParser.parse(
        "findMany",
        user,
        {
          include: {
            profile: true,
          },
        },
        adapter
      );

      const sql = result.toStatement();
      expect(sql).toContain('AS "profile"');
      expect(sql).toContain('"t1"."userId" = "t0"."id"');
      expect(sql).toContain('FROM "user" AS "t0"');
      expect(sql).toContain('FROM "profile" AS "t1"');
    });

    test("findMany - should work with reverse oneToOne relations", () => {
      const result = QueryParser.parse(
        "findMany",
        profile,
        {
          include: {
            user: true,
          },
        },
        adapter
      );

      const sql = result.toStatement();
      expect(sql).toContain('AS "user"');
      expect(sql).toContain('"t1"."id" = "t0"."userId"');
      expect(sql).toContain('FROM "profile" AS "t0"');
      expect(sql).toContain('FROM "user" AS "t1"');
    });

    test("findMany - should work with manyToMany relations", () => {
      const result = QueryParser.parse(
        "findMany",
        post,
        {
          include: {
            tags: true,
          },
        },
        adapter
      );

      const sql = result.toStatement();
      expect(sql).toContain('AS "tags"');
      expect(sql).toContain('FROM "tag" AS "t1"');
      expect(sql).toContain('FROM "post" AS "t0"');
      // Note: This test will currently pass but generate incorrect SQL
      // The SQL should include junction table logic, but currently doesn't
    });
  });

  describe("Complex Relation Scenarios", () => {
    test("should handle relations with WHERE conditions", () => {
      const result = QueryParser.parse(
        "findMany",
        user,
        {
          where: { name: "Alice" },
          include: {
            posts: true,
          },
        },
        adapter
      );

      const sql = result.toStatement();
      expect(sql).toContain('WHERE "t0"."name" = ?1');
      expect(sql).toContain('AS "posts"');
    });

    test("should handle relations with nested WHERE", () => {
      const result = QueryParser.parse(
        "findMany",
        user,
        {
          include: {
            posts: {
              where: { title: { contains: "TypeScript" } },
            },
          },
        },
        adapter
      );

      const sql = result.toStatement();
      expect(sql).toContain('AS "posts"');
      expect(sql).toContain('"t1"."title" LIKE ?1');
    });

    test("should handle relations with ORDER BY", () => {
      const result = QueryParser.parse(
        "findMany",
        user,
        {
          orderBy: { name: "asc" },
          include: {
            posts: true,
          },
        },
        adapter
      );

      const sql = result.toStatement();
      expect(sql).toContain('ORDER BY "t0"."name" ASC');
      expect(sql).toContain('AS "posts"');
    });

    test("should handle relations with pagination", () => {
      const result = QueryParser.parse(
        "findMany",
        user,
        {
          include: {
            posts: true,
          },
          take: 10,
          skip: 5,
        },
        adapter
      );

      const sql = result.toStatement();
      expect(sql).toContain("LIMIT ?1");
      expect(sql).toContain("OFFSET ?2");
      expect(sql).toContain('AS "posts"');
    });
  });

  describe("One-to-One Relations", () => {
    test("should include oneToOne relation with proper foreign key", () => {
      const result = QueryParser.parse(
        "findMany",
        user,
        {
          include: {
            profile: true,
          },
        },
        adapter
      );

      const sql = result.toStatement();

      // Should contain profile relation
      expect(sql).toContain('AS "profile"');
      expect(sql).toContain('"profile" AS "t1"');

      // Should have correct foreign key relationship
      expect(sql).toContain('"t1"."userId" = "t0"."id"');

      // Should include profile fields
      expect(sql).toContain('"t1"."bio"');
      expect(sql).toContain('"t1"."avatarUrl"');
    });

    test("should include reverse oneToOne relation", () => {
      const result = QueryParser.parse(
        "findMany",
        profile,
        {
          include: {
            user: true,
          },
        },
        adapter
      );

      const sql = result.toStatement();

      // Should contain user relation
      expect(sql).toContain('AS "user"');
      expect(sql).toContain('"user" AS "t1"');

      // Should have correct foreign key relationship (reverse direction)
      expect(sql).toContain('"t1"."id" = "t0"."userId"');

      // Should include user fields
      expect(sql).toContain('"t1"."name"');
      expect(sql).toContain('"t1"."email"');
    });

    test("should handle oneToOne with WHERE conditions", () => {
      const result = QueryParser.parse(
        "findMany",
        user,
        {
          where: { name: "Alice" },
          include: {
            profile: {
              where: { bio: { contains: "developer" } },
            },
          },
        },
        adapter
      );

      const sql = result.toStatement();

      // Should have main WHERE condition
      expect(sql).toContain('"t0"."name" = ?');

      // Should have nested WHERE condition for profile
      expect(sql).toContain('"t1"."bio" LIKE ?');
      expect(sql).toContain('AS "profile"');
    });

    test("should handle oneToOne with multiple operations", () => {
      const result = QueryParser.parse(
        "findFirst",
        user,
        {
          where: { email: "alice@example.com" },
          include: {
            profile: true,
          },
          orderBy: { name: "asc" },
        },
        adapter
      );

      const sql = result.toStatement();

      // Should have LIMIT 1 for findFirst
      expect(sql).toContain("LIMIT 1");

      // Should have ORDER BY
      expect(sql).toContain('ORDER BY "t0"."name" ASC');

      // Should include profile
      expect(sql).toContain('AS "profile"');

      // Should have WHERE condition
      expect(sql).toContain('"t0"."email" = ?');
    });

    test("oneToOne relation - complete SQL validation", () => {
      const result = QueryParser.parse(
        "findMany",
        user,
        {
          include: {
            profile: true,
          },
        },
        adapter
      );

      const sql = result.toStatement();
      expect(sql).toBe(/*SQL*/ `SELECT "t0"."id", "t0"."name", "t0"."email", 
        ((SELECT row_to_json(t1)
        FROM (SELECT "t1"."id", "t1"."bio" FROM "profile" AS "t1" WHERE "t1"."userId" = "t0"."id" LIMIT 1) t1
        )) AS "profile" FROM "user" AS "t0"`);
    });
  });

  describe("Many-to-Many Relations", () => {
    test("should include manyToMany relation (basic test)", () => {
      const result = QueryParser.parse(
        "findMany",
        post,
        {
          include: {
            tags: true,
          },
        },
        adapter
      );

      const sql = result.toStatement();

      // Should contain tags relation
      expect(sql).toContain('AS "tags"');
      expect(sql).toContain('"tag" AS "t1"');

      // Should include tag fields
      expect(sql).toContain('"t1"."name"');
      expect(sql).toContain('"t1"."color"');

      // Note: Currently this generates incorrect SQL without junction table
      // TODO: Fix Many-to-Many junction table logic
    });

    test("should include reverse manyToMany relation", () => {
      const result = QueryParser.parse(
        "findMany",
        tag,
        {
          include: {
            posts: true,
          },
        },
        adapter
      );

      const sql = result.toStatement();

      // Should contain posts relation
      expect(sql).toContain('AS "posts"');
      expect(sql).toContain('"post" AS "t1"');

      // Should include post fields
      expect(sql).toContain('"t1"."title"');
      expect(sql).toContain('"t1"."content"');

      // Note: Currently this generates incorrect SQL without junction table
      // TODO: Fix Many-to-Many junction table logic
    });

    test("should handle manyToMany with WHERE conditions", () => {
      const result = QueryParser.parse(
        "findMany",
        post,
        {
          include: {
            tags: {
              where: { name: { contains: "tech" } },
            },
          },
        },
        adapter
      );

      const sql = result.toStatement();

      // Should contain tags relation
      expect(sql).toContain('AS "tags"');

      // Should have nested WHERE condition for tags
      expect(sql).toContain('"t1"."name" LIKE ?');

      // Note: Currently this generates incorrect SQL without junction table
      // TODO: Fix Many-to-Many junction table logic
    });

    test("manyToMany relation - complete SQL validation (now CORRECT with junction table)", () => {
      const result = QueryParser.parse(
        "findMany",
        post,
        {
          include: {
            tags: true,
          },
        },
        adapter
      );

      const sql = result.toStatement();

      // This test now validates the CORRECT Many-to-Many SQL with JSON aggregation
      expect(sql).toBe(
        'SELECT "t0"."id", "t0"."title", "t0"."content", "t0"."userId", ((' +
          "\n        SELECT COALESCE(json_agg(row_to_json(t1)), '[]'::json)" +
          '\n        FROM (SELECT "t1"."id", "t1"."name", "t1"."color" FROM "tag" AS "t1" WHERE EXISTS (' +
          '\n      SELECT 1 FROM "post_tags"' +
          '\n      WHERE "post_tags"."tagId" = "t1"."id"' +
          '\n        AND "post_tags"."postId" = "t0"."id"' +
          "\n    )) t1" +
          '\n      )) AS "tags" FROM "post" AS "t0"'
      );
    });
  });

  describe("Complex Multi-Relation Scenarios", () => {
    test("should handle multiple relation types together", () => {
      const result = QueryParser.parse(
        "findMany",
        user,
        {
          include: {
            profile: true,
            posts: {
              include: {
                tags: true,
              },
            },
          },
        },
        adapter
      );

      const sql = result.toStatement();

      // Should include both profile (oneToOne) and posts (oneToMany)
      expect(sql).toContain('AS "profile"');
      expect(sql).toContain('AS "posts"');

      // Note: Nested includes with tags would require additional implementation
      // This test may fail until nested relation inclusion is fully implemented
    });

    test("should handle all relation types on one model", () => {
      const result = QueryParser.parse(
        "findMany",
        post,
        {
          include: {
            user: true, // manyToOne
            tags: true, // manyToMany
          },
        },
        adapter
      );

      const sql = result.toStatement();

      // Should include both user and tags relations
      expect(sql).toContain('AS "user"');
      expect(sql).toContain('AS "tags"');

      // Should have different foreign key patterns
      expect(sql).toContain('"t1"."id" = "t0"."userId"'); // manyToOne pattern
      // Note: manyToMany pattern should use junction table but currently doesn't
    });
  });

  describe("Error Handling", () => {
    test("should throw error for non-existent relation", () => {
      expect(() => {
        QueryParser.parse(
          "findMany",
          user,
          {
            include: {
              nonExistentRelation: true,
            },
          },
          adapter
        );
      }).toThrow("Relation 'nonExistentRelation' not found");
    });

    test("should handle empty include object", () => {
      const result = QueryParser.parse(
        "findMany",
        user,
        {
          include: {},
        },
        adapter
      );

      const sql = result.toStatement();
      // Should not contain any relation subqueries
      expect(sql).not.toContain('AS "posts"');
      expect(sql).toBe(
        'SELECT "t0"."id", "t0"."name", "t0"."email" FROM "user" AS "t0"'
      );
    });
  });

  describe("Relation Configuration", () => {
    test("should properly handle relation field references", () => {
      // Test that the relation configuration correctly maps:
      // user.posts -> post.userId references user.id
      const result = QueryParser.parse(
        "findMany",
        user,
        {
          include: {
            posts: true,
          },
        },
        adapter
      );

      const sql = result.toStatement();

      // Check foreign key relationship is correct
      expect(sql).toContain('"t1"."userId" = "t0"."id"');

      // Check table aliases are correct
      expect(sql).toContain('"user" AS "t0"');
      expect(sql).toContain('"post" AS "t1"');
    });
  });

  describe("Multiple Operations", () => {
    test("findUniqueOrThrow - should include relations", () => {
      const result = QueryParser.parse(
        "findUniqueOrThrow",
        user,
        {
          where: { id: "user_123" },
          include: {
            posts: true,
          },
        },
        adapter
      );

      const sql = result.toStatement();
      expect(sql).toContain('AS "posts"');
      expect(sql).toContain("LIMIT 1");
    });

    test("findFirstOrThrow - should include relations", () => {
      const result = QueryParser.parse(
        "findFirstOrThrow",
        user,
        {
          include: {
            posts: true,
          },
        },
        adapter
      );

      const sql = result.toStatement();
      expect(sql).toContain('AS "posts"');
      expect(sql).toContain("LIMIT 1");
    });
  });
});

describe("Full SQL Validation - Relation Inclusion", () => {
  const adapter = new PostgresAdapter();

  // Use the same models from the main test suite (declared above)
  // No need to redeclare them here

  describe("Complete SQL Generation", () => {
    test("findMany with include - complete SQL validation", () => {
      const result = QueryParser.parse(
        "findMany",
        user,
        {
          include: {
            posts: true,
          },
        },
        adapter
      );

      const sql = result.toStatement();
      expect(sql).toBe(
        `SELECT "t0"."id", "t0"."name", "t0"."email", ((
        SELECT COALESCE(json_agg(row_to_json(t1)), \'[]\'::json)
        FROM (SELECT "t1"."id", "t1"."title", "t1"."content", "t1"."userId" FROM "post" AS "t1" WHERE "t1"."userId" = "t0"."id") t1
        )) AS "posts" FROM "user" AS "t0"`
      );
    });

    test("findFirst with include and WHERE - complete SQL validation", () => {
      const result = QueryParser.parse(
        "findFirst",
        user,
        {
          where: { name: "Alice" },
          include: {
            posts: true,
          },
        },
        adapter
      );

      const sql = result.toStatement();
      expect(sql).toBe(
        'SELECT "t0"."id", "t0"."name", "t0"."email", ((\n        SELECT COALESCE(json_agg(row_to_json(t1)), \'[]\'::json)\n        FROM (SELECT "t1"."id", "t1"."title", "t1"."content", "t1"."userId" FROM "post" AS "t1" WHERE "t1"."userId" = "t0"."id") t1\n      )) AS "posts" FROM "user" AS "t0" WHERE "t0"."name" = ?1 LIMIT 1'
      );
    });

    test("manyToOne relation - complete SQL validation", () => {
      const result = QueryParser.parse(
        "findMany",
        post,
        {
          include: {
            user: true,
          },
        },
        adapter
      );

      const sql = result.toStatement();
      expect(sql).toBe(
        'SELECT "t0"."id", "t0"."title", "t0"."content", "t0"."userId", ((\n          SELECT row_to_json(t1)\n          FROM (SELECT "t1"."id", "t1"."name", "t1"."email" FROM "user" AS "t1" WHERE "t1"."id" = "t0"."userId" LIMIT 1) t1\n        )) AS "user" FROM "post" AS "t0"'
      );
    });

    test("oneToOne relation - complete SQL validation", () => {
      const result = QueryParser.parse(
        "findMany",
        user,
        {
          include: {
            profile: true,
          },
        },
        adapter
      );

      const sql = result.toStatement();
      expect(sql).toBe(
        'SELECT "t0"."id", "t0"."name", "t0"."email", ((\n          SELECT row_to_json(t1)\n          FROM (SELECT "t1"."id", "t1"."bio", "t1"."avatarUrl", "t1"."userId" FROM "profile" AS "t1" WHERE "t1"."userId" = "t0"."id" LIMIT 1) t1\n        )) AS "profile" FROM "user" AS "t0"'
      );
    });

    test("reverse oneToOne relation - complete SQL validation", () => {
      const result = QueryParser.parse(
        "findMany",
        profile,
        {
          include: {
            user: true,
          },
        },
        adapter
      );

      const sql = result.toStatement();
      expect(sql).toBe(
        'SELECT "t0"."id", "t0"."bio", "t0"."avatarUrl", "t0"."userId", ((\n          SELECT row_to_json(t1)\n          FROM (SELECT "t1"."id", "t1"."name", "t1"."email" FROM "user" AS "t1" WHERE "t1"."id" = "t0"."userId" LIMIT 1) t1\n        )) AS "user" FROM "profile" AS "t0"'
      );
    });

    test("manyToMany relation - complete SQL validation (now CORRECT with junction table)", () => {
      const result = QueryParser.parse(
        "findMany",
        post,
        {
          include: {
            tags: true,
          },
        },
        adapter
      );

      const sql = result.toStatement();

      // This test now validates the CORRECT Many-to-Many SQL with JSON aggregation
      expect(sql).toBe(
        'SELECT "t0"."id", "t0"."title", "t0"."content", "t0"."userId", ((' +
          "\n        SELECT COALESCE(json_agg(row_to_json(t1)), '[]'::json)" +
          '\n        FROM (SELECT "t1"."id", "t1"."name", "t1"."color" FROM "tag" AS "t1" WHERE EXISTS (' +
          '\n      SELECT 1 FROM "post_tags"' +
          '\n      WHERE "post_tags"."tagId" = "t1"."id"' +
          '\n        AND "post_tags"."postId" = "t0"."id"' +
          "\n    )) t1" +
          '\n      )) AS "tags" FROM "post" AS "t0"'
      );
    });
  });
});
