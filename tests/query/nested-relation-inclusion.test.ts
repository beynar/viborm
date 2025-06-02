import { describe, test, expect } from "vitest";
import { QueryParser } from "../../src/query-parser";
import { PostgresAdapter } from "../../src/adapters/databases/postgres/postgres-adapter";
import { s } from "../../src/schema";

// Declare models first to handle circular references
let user: any;
let post: any;
let tag: any;
let comment: any;

// Define models with complex nested relations
user = s.model("user", {
  id: s.string().id(),
  name: s.string(),
  email: s.string(),
  posts: s
    .relation({
      onField: "id",
      refField: "userId",
    })
    .oneToMany(() => post),
  comments: s
    .relation({
      onField: "id",
      refField: "userId",
    })
    .oneToMany(() => comment),
});

post = s.model("post", {
  id: s.string().id(),
  title: s.string(),
  content: s.string(),
  userId: s.string(),
  user: s
    .relation({
      onField: "userId",
      refField: "id",
    })
    .manyToOne(() => user),
  tags: s
    .relation({
      junctionTable: "post_tags",
      onField: "id",
      refField: "id",
      junctionField: "tagId",
    })
    .manyToMany(() => tag),
  comments: s
    .relation({
      onField: "id",
      refField: "postId",
    })
    .oneToMany(() => comment),
});

tag = s.model("tag", {
  id: s.string().id(),
  name: s.string(),
  color: s.string(),
  posts: s
    .relation({
      junctionTable: "post_tags",
      onField: "id",
      refField: "id",
      junctionField: "postId",
    })
    .manyToMany(() => post),
});

comment = s.model("comment", {
  id: s.string().id(),
  content: s.string(),
  userId: s.string(),
  postId: s.string(),
  user: s
    .relation({
      onField: "userId",
      refField: "id",
    })
    .manyToOne(() => user),
  post: s
    .relation({
      onField: "postId",
      refField: "id",
    })
    .manyToOne(() => post),
});

describe("QueryParser - Nested Relation Inclusion", () => {
  const adapter = new PostgresAdapter();

  describe("Two-Level Nesting", () => {
    test("user.posts.tags - should include nested manyToMany", () => {
      const result = QueryParser.parse(
        "findMany",
        user,
        {
          include: {
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

      // Should contain both posts and tags
      expect(sql).toContain('AS "posts"');
      expect(sql).toContain('AS "tags"');

      // Should have nested structure
      expect(sql).toContain("json_agg(row_to_json(t1))");
      expect(sql).toContain("json_agg(row_to_json(t2))");

      // Should have proper table references
      expect(sql).toContain('"post" AS "t1"');
      expect(sql).toContain('"tag" AS "t2"');
    });

    test("user.posts.user - should handle circular references", () => {
      const result = QueryParser.parse(
        "findMany",
        user,
        {
          include: {
            posts: {
              include: {
                user: true, // circular reference back to user
              },
            },
          },
        },
        adapter
      );

      const sql = result.toStatement();

      // Should contain both posts and nested user
      expect(sql).toContain('AS "posts"');
      expect(sql).toContain('AS "user"');

      // Should have different aliases for user tables
      expect(sql).toContain('"user" AS "t0"'); // main user
      expect(sql).toContain('"user" AS "t2"'); // nested user
    });

    test("post.user.posts - should handle reverse nesting", () => {
      const result = QueryParser.parse(
        "findMany",
        post,
        {
          include: {
            user: {
              include: {
                posts: true,
              },
            },
          },
        },
        adapter
      );

      const sql = result.toStatement();

      // Should contain both user and nested posts
      expect(sql).toContain('AS "user"');
      expect(sql).toContain('AS "posts"');

      // Should start from post table
      expect(sql).toContain('FROM "post" AS "t0"');
    });
  });

  describe("Three-Level Nesting", () => {
    test("user.posts.tags.posts - should handle deep nesting", () => {
      const result = QueryParser.parse(
        "findMany",
        user,
        {
          include: {
            posts: {
              include: {
                tags: {
                  include: {
                    posts: true,
                  },
                },
              },
            },
          },
        },
        adapter
      );

      const sql = result.toStatement();

      // Should contain all three levels
      expect(sql).toContain('AS "posts"');
      expect(sql).toContain('AS "tags"');

      // Should have multiple nesting levels
      const postOccurrences = (sql.match(/AS "posts"/g) || []).length;
      expect(postOccurrences).toBeGreaterThanOrEqual(2); // At least 2 "posts" (level 1 and 3)
    });

    test("user.posts.comments.user - should handle complex relationships", () => {
      const result = QueryParser.parse(
        "findMany",
        user,
        {
          include: {
            posts: {
              include: {
                comments: {
                  include: {
                    user: true,
                  },
                },
              },
            },
          },
        },
        adapter
      );

      const sql = result.toStatement();

      // Should contain all relation types
      expect(sql).toContain('AS "posts"');
      expect(sql).toContain('AS "comments"');
      expect(sql).toContain('AS "user"');

      // Should reference comment table
      expect(sql).toContain('"comment" AS');
    });
  });

  describe("Multiple Includes at Same Level", () => {
    test("user.posts(tags + comments) - should handle multiple nested includes", () => {
      const result = QueryParser.parse(
        "findMany",
        user,
        {
          include: {
            posts: {
              include: {
                tags: true,
                comments: true,
              },
            },
          },
        },
        adapter
      );

      const sql = result.toStatement();

      // Should contain all relations
      expect(sql).toContain('AS "posts"');
      expect(sql).toContain('AS "tags"');
      expect(sql).toContain('AS "comments"');

      // Should reference all tables
      expect(sql).toContain('"tag" AS');
      expect(sql).toContain('"comment" AS');
    });

    test("post(user + tags + comments) - should handle multiple relations", () => {
      const result = QueryParser.parse(
        "findMany",
        post,
        {
          include: {
            user: true,
            tags: true,
            comments: true,
          },
        },
        adapter
      );

      const sql = result.toStatement();

      // Should contain all direct relations
      expect(sql).toContain('AS "user"');
      expect(sql).toContain('AS "tags"');
      expect(sql).toContain('AS "comments"');
    });
  });

  describe("Nested Relations with WHERE Conditions", () => {
    test("user.posts(filtered).tags(filtered) - should apply WHERE at each level", () => {
      const result = QueryParser.parse(
        "findMany",
        user,
        {
          include: {
            posts: {
              where: { title: { contains: "TypeScript" } },
              include: {
                tags: {
                  where: { name: { contains: "tech" } },
                },
              },
            },
          },
        },
        adapter
      );

      const sql = result.toStatement();

      // Should contain filtered includes
      expect(sql).toContain('AS "posts"');
      expect(sql).toContain('AS "tags"');

      // Should have WHERE conditions at both levels
      expect(sql).toContain('"title" LIKE');
      expect(sql).toContain('"name" LIKE');
    });

    test("user.posts.comments(filtered).user - should filter nested relations", () => {
      const result = QueryParser.parse(
        "findMany",
        user,
        {
          where: { name: "Alice" },
          include: {
            posts: {
              include: {
                comments: {
                  where: { content: { contains: "great" } },
                  include: {
                    user: true,
                  },
                },
              },
            },
          },
        },
        adapter
      );

      const sql = result.toStatement();

      // Should have root WHERE condition
      expect(sql).toContain('"t0"."name" = ?');

      // Should have nested WHERE condition
      expect(sql).toContain('"content" LIKE');

      // Should contain all relations
      expect(sql).toContain('AS "posts"');
      expect(sql).toContain('AS "comments"');
      expect(sql).toContain('AS "user"');
    });
  });

  describe("Complex Nested Scenarios", () => {
    test("user(posts + comments) with nested includes", () => {
      const result = QueryParser.parse(
        "findMany",
        user,
        {
          include: {
            posts: {
              include: {
                tags: true,
                comments: {
                  include: {
                    user: true,
                  },
                },
              },
            },
            comments: {
              include: {
                post: {
                  include: {
                    tags: true,
                  },
                },
              },
            },
          },
        },
        adapter
      );

      const sql = result.toStatement();

      // Should contain all main relations
      expect(sql).toContain('AS "posts"');
      expect(sql).toContain('AS "comments"');
      expect(sql).toContain('AS "tags"');

      // Should be a complex query
      expect(sql.length).toBeGreaterThan(500); // Complex nested query
    });

    test("deeply nested with ordering and pagination", () => {
      const result = QueryParser.parse(
        "findMany",
        user,
        {
          where: { name: { contains: "A" } },
          orderBy: { name: "asc" },
          take: 10,
          include: {
            posts: {
              orderBy: { title: "desc" },
              take: 5,
              include: {
                tags: {
                  orderBy: { name: "asc" },
                },
                comments: {
                  orderBy: { content: "desc" },
                  take: 3,
                },
              },
            },
          },
        },
        adapter
      );

      const sql = result.toStatement();

      // Should contain relations
      expect(sql).toContain('AS "posts"');
      expect(sql).toContain('AS "tags"');
      expect(sql).toContain('AS "comments"');

      // Should have ordering at root level
      expect(sql).toContain('ORDER BY "t0"."name" ASC');

      // Should have pagination at root level
      expect(sql).toContain("LIMIT ?");
    });
  });

  describe("Error Handling", () => {
    test("should handle invalid nested relation", () => {
      expect(() => {
        QueryParser.parse(
          "findMany",
          user,
          {
            include: {
              posts: {
                include: {
                  invalidRelation: true,
                },
              },
            },
          },
          adapter
        );
      }).toThrow("Relation 'invalidRelation' not found");
    });

    test("should handle empty nested includes", () => {
      const result = QueryParser.parse(
        "findMany",
        user,
        {
          include: {
            posts: {
              include: {},
            },
          },
        },
        adapter
      );

      const sql = result.toStatement();

      // Should include posts but no nested relations
      expect(sql).toContain('AS "posts"');
      expect(sql).not.toContain('AS "tags"');
    });
  });
});

describe("Nested Relations - SQL Validation", () => {
  const adapter = new PostgresAdapter();

  test("user.posts.tags - complete SQL structure validation", () => {
    const result = QueryParser.parse(
      "findMany",
      user,
      {
        include: {
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

    // Should be properly structured nested query
    expect(sql).toContain('SELECT "t0"."id", "t0"."name", "t0"."email"');
    expect(sql).toContain('FROM "user" AS "t0"');

    // Should have nested posts subquery
    expect(sql).toContain("json_agg(row_to_json(t1))");
    expect(sql).toContain('FROM "post" AS "t1"');

    // Should have nested tags subquery within posts
    expect(sql).toContain("json_agg(row_to_json(t2))");
    expect(sql).toContain('FROM "tag" AS "t2"');

    // Should have proper relation linking
    expect(sql).toContain('"t1"."userId" = "t0"."id"'); // posts -> user
    expect(sql).toContain('"t2"."id" = "t1"."id"'); // tags -> posts (many-to-many)
  });
});
