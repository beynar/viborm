import { describe, test, expect } from "vitest";
import { QueryParser } from "../../src/query-parser/query-parser";
import { PostgresAdapter } from "../../src/adapters/databases/postgres/postgres-adapter";
import { s } from "../../src/schema";

describe("QueryParser - Read Operations (Phase 1)", () => {
  const adapter = new PostgresAdapter();

  // Simple test model
  const user = s.model("user", {
    id: s.string().id(),
    name: s.string(),
    email: s.string(),
    age: s.int(),
    isActive: s.boolean(),
    createdAt: s.dateTime(),
  });

  describe("findMany Operations", () => {
    test("findMany - should generate SELECT without LIMIT", () => {
      const result = QueryParser.parse("findMany", user, {}, adapter);

      expect(result).toBeDefined();
      const sql = result.toStatement();
      expect(sql).toContain("SELECT");
      expect(sql).toContain("FROM");
      expect(sql).not.toContain("LIMIT");
    });

    test("findMany - should handle WHERE clause", () => {
      const result = QueryParser.parse(
        "findMany",
        user,
        {
          where: { isActive: true },
        },
        adapter
      );

      expect(result).toBeDefined();
      const sql = result.toStatement();
      expect(sql).toContain("SELECT");
      expect(sql).toContain("WHERE");
      expect(sql).toContain("isActive");
    });

    test("findMany - should handle select fields", () => {
      const result = QueryParser.parse(
        "findMany",
        user,
        {
          select: {
            id: true,
            name: true,
            email: true,
          },
        },
        adapter
      );

      expect(result).toBeDefined();
      const sql = result.toStatement();
      expect(sql).toContain("SELECT");
      expect(sql).toContain("id");
      expect(sql).toContain("name");
      expect(sql).toContain("email");
    });

    test("findMany - should handle orderBy", () => {
      const result = QueryParser.parse(
        "findMany",
        user,
        {
          orderBy: { name: "asc" },
        },
        adapter
      );

      expect(result).toBeDefined();
      const sql = result.toStatement();
      expect(sql).toContain("SELECT");
      expect(sql).toContain("ORDER BY");
      expect(sql).toContain("name");
    });

    test("findMany - should handle pagination with take and skip", () => {
      const result = QueryParser.parse(
        "findMany",
        user,
        {
          take: 10,
          skip: 20,
        },
        adapter
      );

      expect(result).toBeDefined();
      const sql = result.toStatement();
      expect(sql).toContain("SELECT");
      expect(sql).toContain("LIMIT");
      expect(sql).toContain("OFFSET");
    });

    // TODO: DISTINCT functionality not implemented yet
    // test("findMany - should handle distinct", () => {
    //   const result = QueryParser.parse(
    //     "findMany",
    //     user,
    //     {
    //       distinct: ["name", "email"],
    //     },
    //     adapter
    //   );

    //   expect(result).toBeDefined();
    //   const sql = result.toStatement();
    //   expect(sql).toContain("SELECT");
    //   expect(sql).toContain("DISTINCT");
    // });
  });

  describe("findFirst Operations", () => {
    test("findFirst - should generate SELECT with LIMIT 1", () => {
      const result = QueryParser.parse("findFirst", user, {}, adapter);

      expect(result).toBeDefined();
      const sql = result.toStatement();
      expect(sql).toContain("SELECT");
      expect(sql).toContain("LIMIT 1");
    });

    test("findFirst - should handle WHERE clause", () => {
      const result = QueryParser.parse(
        "findFirst",
        user,
        {
          where: { age: { gte: 18 } },
        },
        adapter
      );

      expect(result).toBeDefined();
      const sql = result.toStatement();
      expect(sql).toContain("SELECT");
      expect(sql).toContain("WHERE");
      expect(sql).toContain("LIMIT 1");
    });

    test("findFirst - should handle orderBy", () => {
      const result = QueryParser.parse(
        "findFirst",
        user,
        {
          orderBy: { createdAt: "desc" },
        },
        adapter
      );

      expect(result).toBeDefined();
      const sql = result.toStatement();
      expect(sql).toContain("SELECT");
      expect(sql).toContain("ORDER BY");
      expect(sql).toContain("LIMIT 1");
    });
  });

  describe("findUnique Operations", () => {
    test("findUnique - should generate SELECT with LIMIT 1", () => {
      const result = QueryParser.parse(
        "findUnique",
        user,
        {
          where: { id: "user_123" },
        },
        adapter
      );

      expect(result).toBeDefined();
      const sql = result.toStatement();
      expect(sql).toContain("SELECT");
      expect(sql).toContain("WHERE");
      expect(sql).toContain("LIMIT 1");
    });

    test("findUnique - should fail without WHERE clause", () => {
      expect(() => {
        QueryParser.parse("findUnique", user, {}, adapter);
      }).toThrow("WHERE clause is required for unique operations");
    });

    test("findUnique - should handle select fields", () => {
      const result = QueryParser.parse(
        "findUnique",
        user,
        {
          where: { id: "user_123" },
          select: {
            id: true,
            name: true,
          },
        },
        adapter
      );

      expect(result).toBeDefined();
      const sql = result.toStatement();
      expect(sql).toContain("SELECT");
      expect(sql).toContain("WHERE");
      expect(sql).toContain("LIMIT 1");
    });
  });

  describe("findFirstOrThrow Operations", () => {
    test("findFirstOrThrow - should behave like findFirst with LIMIT 1", () => {
      const result = QueryParser.parse(
        "findFirstOrThrow",
        user,
        {
          where: { isActive: true },
        },
        adapter
      );

      expect(result).toBeDefined();
      const sql = result.toStatement();
      expect(sql).toContain("SELECT");
      expect(sql).toContain("WHERE");
      expect(sql).toContain("LIMIT 1");
    });
  });

  describe("findUniqueOrThrow Operations", () => {
    test("findUniqueOrThrow - should behave like findUnique with LIMIT 1", () => {
      const result = QueryParser.parse(
        "findUniqueOrThrow",
        user,
        {
          where: { id: "user_123" },
        },
        adapter
      );

      expect(result).toBeDefined();
      const sql = result.toStatement();
      expect(sql).toContain("SELECT");
      expect(sql).toContain("WHERE");
      expect(sql).toContain("LIMIT 1");
    });

    test("findUniqueOrThrow - should fail without WHERE clause", () => {
      expect(() => {
        QueryParser.parse("findUniqueOrThrow", user, {}, adapter);
      }).toThrow("WHERE clause is required for unique operations");
    });
  });

  describe("Complex Scenarios", () => {
    test("should handle complex WHERE with AND/OR", () => {
      const result = QueryParser.parse(
        "findMany",
        user,
        {
          where: {
            AND: [
              { isActive: true },
              {
                OR: [{ age: { gte: 18 } }, { name: { contains: "admin" } }],
              },
            ],
          },
        },
        adapter
      );

      expect(result).toBeDefined();
      const sql = result.toStatement();
      expect(sql).toContain("SELECT");
      expect(sql).toContain("WHERE");
      expect(sql).toContain("AND");
      expect(sql).toContain("OR");
    });

    test("should handle complex query with all clauses", () => {
      const result = QueryParser.parse(
        "findMany",
        user,
        {
          select: {
            id: true,
            name: true,
            email: true,
          },
          where: { isActive: true },
          orderBy: { createdAt: "desc" },
          take: 10,
          skip: 5,
        },
        adapter
      );

      expect(result).toBeDefined();
      const sql = result.toStatement();
      expect(sql).toContain("SELECT");
      expect(sql).toContain("WHERE");
      expect(sql).toContain("ORDER BY");
      expect(sql).toContain("LIMIT");
      expect(sql).toContain("OFFSET");
    });
  });

  describe("Error Handling", () => {
    test("should throw error for unsupported read operation", () => {
      expect(() => {
        QueryParser.parse("invalidOperation" as any, user, {}, adapter);
      }).toThrow("Unsupported operation");
    });
  });
});

describe("Full SQL Output Validation - Read Operations", () => {
  const adapter = new PostgresAdapter();

  // Simple test model
  const user = s.model("user", {
    id: s.string().id(),
    name: s.string(),
    email: s.string(),
    age: s.int(),
    isActive: s.boolean(),
  });

  describe("findMany Operations - Full SQL", () => {
    test("findMany: should generate complete SQL for basic query", () => {
      const result = QueryParser.parse("findMany", user, {}, adapter);
      const sql = result.toStatement();

      expect(sql).toBe(
        'SELECT "t0"."id", "t0"."name", "t0"."email", "t0"."age", "t0"."isActive" FROM "user" AS "t0"'
      );
    });

    test("findMany: should generate complete SQL with WHERE clause", () => {
      const result = QueryParser.parse(
        "findMany",
        user,
        {
          where: { isActive: true },
        },
        adapter
      );
      const sql = result.toStatement();

      expect(sql).toBe(
        'SELECT "t0"."id", "t0"."name", "t0"."email", "t0"."age", "t0"."isActive" FROM "user" AS "t0" WHERE "t0"."isActive" = ?1'
      );
    });

    test("findMany: should generate complete SQL with select fields", () => {
      const result = QueryParser.parse(
        "findMany",
        user,
        {
          select: {
            id: true,
            name: true,
          },
        },
        adapter
      );
      const sql = result.toStatement();

      expect(sql).toBe('SELECT "t0"."id", "t0"."name" FROM "user" AS "t0"');
    });

    test("findMany: should generate complete SQL with ORDER BY", () => {
      const result = QueryParser.parse(
        "findMany",
        user,
        {
          orderBy: { name: "asc" },
        },
        adapter
      );
      const sql = result.toStatement();

      expect(sql).toBe(
        'SELECT "t0"."id", "t0"."name", "t0"."email", "t0"."age", "t0"."isActive" FROM "user" AS "t0" ORDER BY "t0"."name" ASC'
      );
    });

    test("findMany: should generate complete SQL with LIMIT and OFFSET", () => {
      const result = QueryParser.parse(
        "findMany",
        user,
        {
          take: 10,
          skip: 20,
        },
        adapter
      );
      const sql = result.toStatement();

      expect(sql).toBe(
        'SELECT "t0"."id", "t0"."name", "t0"."email", "t0"."age", "t0"."isActive" FROM "user" AS "t0" LIMIT ?1 OFFSET ?2'
      );
    });

    // TODO: DISTINCT functionality not implemented yet
    // test("findMany: should generate complete SQL with DISTINCT", () => {
    //   const result = QueryParser.parse(
    //     "findMany",
    //     user,
    //     {
    //       distinct: ["name"],
    //     },
    //     adapter
    //   );
    //   const sql = result.toStatement();

    //   expect(sql).toBe('SELECT DISTINCT "t0"."name" "t0"."id", "t0"."name", "t0"."email", "t0"."age", "t0"."isActive" FROM "user" AS "t0"');
    // });
  });

  describe("findFirst Operations - Full SQL", () => {
    test("findFirst: should generate complete SQL with LIMIT 1", () => {
      const result = QueryParser.parse("findFirst", user, {}, adapter);
      const sql = result.toStatement();

      expect(sql).toBe(
        'SELECT "t0"."id", "t0"."name", "t0"."email", "t0"."age", "t0"."isActive" FROM "user" AS "t0" LIMIT 1'
      );
    });

    test("findFirst: should generate complete SQL with WHERE and LIMIT 1", () => {
      const result = QueryParser.parse(
        "findFirst",
        user,
        {
          where: { age: { gte: 18 } },
        },
        adapter
      );
      const sql = result.toStatement();

      expect(sql).toBe(
        'SELECT "t0"."id", "t0"."name", "t0"."email", "t0"."age", "t0"."isActive" FROM "user" AS "t0" WHERE "t0"."age" >= ?1 LIMIT 1'
      );
    });

    test("findFirst: should generate complete SQL with ORDER BY and LIMIT 1", () => {
      const result = QueryParser.parse(
        "findFirst",
        user,
        {
          orderBy: { name: "desc" },
        },
        adapter
      );
      const sql = result.toStatement();

      expect(sql).toBe(
        'SELECT "t0"."id", "t0"."name", "t0"."email", "t0"."age", "t0"."isActive" FROM "user" AS "t0" ORDER BY "t0"."name" DESC LIMIT 1'
      );
    });
  });

  describe("findUnique Operations - Full SQL", () => {
    test("findUnique: should generate complete SQL with WHERE and LIMIT 1", () => {
      const result = QueryParser.parse(
        "findUnique",
        user,
        {
          where: { id: "user_123" },
        },
        adapter
      );
      const sql = result.toStatement();

      expect(sql).toBe(
        'SELECT "t0"."id", "t0"."name", "t0"."email", "t0"."age", "t0"."isActive" FROM "user" AS "t0" WHERE "t0"."id" = ?1 LIMIT 1'
      );
    });

    test("findUnique: should generate complete SQL with select and WHERE", () => {
      const result = QueryParser.parse(
        "findUnique",
        user,
        {
          where: { id: "user_123" },
          select: {
            id: true,
            name: true,
          },
        },
        adapter
      );
      const sql = result.toStatement();

      expect(sql).toBe(
        'SELECT "t0"."id", "t0"."name" FROM "user" AS "t0" WHERE "t0"."id" = ?1 LIMIT 1'
      );
    });
  });

  describe("Complex Operations - Full SQL", () => {
    test("findMany: should generate complete SQL with complex WHERE clause", () => {
      const result = QueryParser.parse(
        "findMany",
        user,
        {
          where: {
            AND: [{ isActive: true }, { age: { gte: 18 } }],
          },
        },
        adapter
      );
      const sql = result.toStatement();

      expect(sql).toBe(
        'SELECT "t0"."id", "t0"."name", "t0"."email", "t0"."age", "t0"."isActive" FROM "user" AS "t0" WHERE ("t0"."isActive" = ?1 AND "t0"."age" >= ?2)'
      );
    });

    test("findMany: should generate complete SQL with all clauses", () => {
      const result = QueryParser.parse(
        "findMany",
        user,
        {
          select: {
            id: true,
            name: true,
          },
          where: { isActive: true },
          orderBy: { name: "asc" },
          take: 5,
          skip: 10,
        },
        adapter
      );
      const sql = result.toStatement();

      expect(sql).toBe(
        'SELECT "t0"."id", "t0"."name" FROM "user" AS "t0" WHERE "t0"."isActive" = ?1 ORDER BY "t0"."name" ASC LIMIT ?2 OFFSET ?3'
      );
    });

    test("findFirstOrThrow: should generate same SQL as findFirst", () => {
      const result = QueryParser.parse(
        "findFirstOrThrow",
        user,
        {
          where: { isActive: true },
        },
        adapter
      );
      const sql = result.toStatement();

      expect(sql).toBe(
        'SELECT "t0"."id", "t0"."name", "t0"."email", "t0"."age", "t0"."isActive" FROM "user" AS "t0" WHERE "t0"."isActive" = ?1 LIMIT 1'
      );
    });

    test("findUniqueOrThrow: should generate same SQL as findUnique", () => {
      const result = QueryParser.parse(
        "findUniqueOrThrow",
        user,
        {
          where: { id: "user_123" },
        },
        adapter
      );
      const sql = result.toStatement();

      expect(sql).toBe(
        'SELECT "t0"."id", "t0"."name", "t0"."email", "t0"."age", "t0"."isActive" FROM "user" AS "t0" WHERE "t0"."id" = ?1 LIMIT 1'
      );
    });
  });
});
