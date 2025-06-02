import { describe, test, expect } from "vitest";
import { QueryParser } from "../../src/query-parser";
import { PostgresAdapter } from "../../src/adapters/databases/postgres/postgres-adapter";
import { s } from "../../src/schema";

describe("QueryParser - Mutation Operations (Phase 2)", () => {
  const adapter = new PostgresAdapter();

  // Simple test model
  const user = s.model("user", {
    id: s.string().id(),
    name: s.string(),
    email: s.string(),
    age: s.int(),
  });

  describe("CREATE Operations", () => {
    test("create - should generate INSERT with data", () => {
      const result = QueryParser.parse(
        "create",
        user,
        {
          data: {
            id: "user_123",
            name: "Alice",
            email: "alice@example.com",
            age: 25,
          },
        },
        adapter
      );

      expect(result).toBeDefined();
      const sql = result.toStatement();
      expect(sql).toContain("INSERT");
      expect(sql).toContain("user");
      expect(sql).toContain("RETURNING");
    });

    test("create - should fail without data field", () => {
      expect(() => {
        QueryParser.parse("create", user, {}, adapter);
      }).toThrow("CREATE operation requires 'data' field");
    });

    test("create - should handle select option", () => {
      const result = QueryParser.parse(
        "create",
        user,
        {
          data: {
            id: "user_123",
            name: "Alice",
            email: "alice@example.com",
          },
          select: {
            id: true,
            name: true,
          },
        },
        adapter
      );

      expect(result).toBeDefined();
      const sql = result.toStatement();
      expect(sql).toContain("INSERT");
    });

    test("createMany - should generate bulk INSERT", () => {
      const result = QueryParser.parse(
        "createMany",
        user,
        {
          data: [
            { id: "user_1", name: "Alice", email: "alice@example.com" },
            { id: "user_2", name: "Bob", email: "bob@example.com" },
          ],
        },
        adapter
      );

      expect(result).toBeDefined();
      const sql = result.toStatement();
      expect(sql).toContain("INSERT");
      expect(sql).toContain("user");
    });

    test("createMany - should fail without data array", () => {
      expect(() => {
        QueryParser.parse(
          "createMany",
          user,
          {
            data: "not an array",
          },
          adapter
        );
      }).toThrow("CREATE_MANY operation requires 'data' array");
    });
  });

  describe("UPDATE Operations", () => {
    test("update - should generate UPDATE with WHERE", () => {
      const result = QueryParser.parse(
        "update",
        user,
        {
          where: { id: "user_123" },
          data: {
            name: "Alice Updated",
            age: 26,
          },
        },
        adapter
      );

      expect(result).toBeDefined();
      const sql = result.toStatement();
      expect(sql).toContain("UPDATE");
      expect(sql).toContain("SET");
      expect(sql).toContain("WHERE");
      expect(sql).toContain("RETURNING");
    });

    test("update - should fail without data field", () => {
      expect(() => {
        QueryParser.parse(
          "update",
          user,
          {
            where: { id: "user_123" },
          },
          adapter
        );
      }).toThrow("UPDATE operation requires 'data' field");
    });

    test("update - should fail without WHERE clause", () => {
      expect(() => {
        QueryParser.parse(
          "update",
          user,
          {
            data: { name: "Alice Updated" },
          },
          adapter
        );
      }).toThrow("WHERE clause is required for unique operations");
    });

    test("updateMany - should generate UPDATE with optional WHERE", () => {
      const result = QueryParser.parse(
        "updateMany",
        user,
        {
          where: { age: { gte: 18 } },
          data: {
            name: "Adult User",
          },
        },
        adapter
      );

      expect(result).toBeDefined();
      const sql = result.toStatement();
      expect(sql).toContain("UPDATE");
      expect(sql).toContain("SET");
      expect(sql).toContain("WHERE");
    });

    test("updateMany - should work without WHERE clause", () => {
      const result = QueryParser.parse(
        "updateMany",
        user,
        {
          data: {
            age: 0,
          },
        },
        adapter
      );

      expect(result).toBeDefined();
      const sql = result.toStatement();
      expect(sql).toContain("UPDATE");
      expect(sql).toContain("SET");
      expect(sql).not.toContain("WHERE");
    });
  });

  describe("DELETE Operations", () => {
    test("delete - should generate DELETE with WHERE", () => {
      const result = QueryParser.parse(
        "delete",
        user,
        {
          where: { id: "user_123" },
        },
        adapter
      );

      expect(result).toBeDefined();
      const sql = result.toStatement();
      expect(sql).toContain("DELETE FROM");
      expect(sql).toContain("WHERE");
      expect(sql).toContain("RETURNING");
    });

    test("delete - should fail without WHERE clause", () => {
      expect(() => {
        QueryParser.parse("delete", user, {}, adapter);
      }).toThrow("WHERE clause is required for unique operations");
    });

    test("deleteMany - should generate DELETE with optional WHERE", () => {
      const result = QueryParser.parse(
        "deleteMany",
        user,
        {
          where: { age: { lt: 18 } },
        },
        adapter
      );

      expect(result).toBeDefined();
      const sql = result.toStatement();
      expect(sql).toContain("DELETE FROM");
      expect(sql).toContain("WHERE");
    });

    test("deleteMany - should work without WHERE clause", () => {
      const result = QueryParser.parse("deleteMany", user, {}, adapter);

      expect(result).toBeDefined();
      const sql = result.toStatement();
      expect(sql).toContain("DELETE FROM");
      expect(sql).not.toContain("WHERE");
    });
  });

  describe("Data Processing", () => {
    test("should handle complex data types", () => {
      const complexUser = s.model("complex_user", {
        id: s.string().id(),
        profile: s.json(),
        isActive: s.boolean(),
        createdAt: s.dateTime(),
      });

      const result = QueryParser.parse(
        "create",
        complexUser,
        {
          data: {
            id: "user_123",
            profile: { bio: "Hello world", age: 25 },
            isActive: true,
            createdAt: new Date("2023-01-01"),
          },
        },
        adapter
      );

      expect(result).toBeDefined();
      const sql = result.toStatement();
      expect(sql).toContain("INSERT");
    });

    test("should handle partial updates", () => {
      const result = QueryParser.parse(
        "update",
        user,
        {
          where: { id: "user_123" },
          data: {
            name: "Updated Name",
            // Only updating name, not other fields
          },
        },
        adapter
      );

      expect(result).toBeDefined();
      const sql = result.toStatement();
      expect(sql).toContain("UPDATE");
      expect(sql).toContain("SET");
    });
  });

  describe("Error Handling", () => {
    test("should throw error for unsupported mutation operation", () => {
      expect(() => {
        QueryParser.parse("invalidOperation" as any, user, {}, adapter);
      }).toThrow("Unsupported operation");
    });

    test("should validate data types", () => {
      expect(() => {
        QueryParser.parse(
          "create",
          user,
          {
            data: null,
          },
          adapter
        );
      }).toThrow("CREATE operation requires 'data' field");
    });

    test("should validate update data types", () => {
      expect(() => {
        QueryParser.parse(
          "update",
          user,
          {
            where: { id: "user_123" },
            data: "not an object",
          },
          adapter
        );
      }).toThrow("UPDATE data must be an object");
    });
  });

  describe("Prisma Compatibility", () => {
    test("should follow Prisma create pattern", () => {
      // This should match Prisma's create interface
      const result = QueryParser.parse(
        "create",
        user,
        {
          data: {
            id: "user_123",
            name: "Alice",
            email: "alice@example.com",
          },
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
      expect(sql).toContain("INSERT");
    });

    test("should follow Prisma update pattern", () => {
      // This should match Prisma's update interface
      const result = QueryParser.parse(
        "update",
        user,
        {
          where: {
            id: "user_123",
          },
          data: {
            name: "Alice Updated",
            age: 26,
          },
          select: {
            id: true,
            name: true,
            age: true,
          },
        },
        adapter
      );

      expect(result).toBeDefined();
      const sql = result.toStatement();
      expect(sql).toContain("UPDATE");
      expect(sql).toContain("WHERE");
    });

    test("should follow Prisma delete pattern", () => {
      // This should match Prisma's delete interface
      const result = QueryParser.parse(
        "delete",
        user,
        {
          where: {
            id: "user_123",
          },
          select: {
            id: true,
          },
        },
        adapter
      );

      expect(result).toBeDefined();
      const sql = result.toStatement();
      expect(sql).toContain("DELETE FROM");
      expect(sql).toContain("WHERE");
    });
  });
});

describe("Full SQL Output Validation - Mutation Operations", () => {
  const adapter = new PostgresAdapter();

  // Simple test model
  const user = s.model("user", {
    id: s.string().id(),
    name: s.string(),
    email: s.string(),
    age: s.int(),
  });

  describe("CREATE Operations - Full SQL", () => {
    test("CREATE: should generate complete SQL for single insert", () => {
      const result = QueryParser.parse(
        "create",
        user,
        {
          data: {
            id: "user_123",
            name: "Alice",
            email: "alice@example.com",
            age: 25,
          },
        },
        adapter
      );

      const sql = result.toStatement();
      expect(sql).toBe(
        'WITH t0 AS (INSERT INTO "user" (id,name,email,age) VALUES (?1,?2,?3,?4)) RETURNING *) SELECT "t0"."id", "t0"."name", "t0"."email", "t0"."age" FROM "t0"'
      );
    });

    test("CREATE_MANY: should generate complete SQL for bulk insert", () => {
      const result = QueryParser.parse(
        "createMany",
        user,
        {
          data: [
            {
              id: "user_1",
              name: "Alice",
              email: "alice@example.com",
              age: 25,
            },
            { id: "user_2", name: "Bob", email: "bob@example.com", age: 30 },
          ],
        },
        adapter
      );

      const sql = result.toStatement();
      expect(sql).toBe(
        'WITH t0 AS (INSERT INTO "user" (0,1) VALUES (?1,?2)) RETURNING *) SELECT "t0"."id", "t0"."name", "t0"."email", "t0"."age" FROM "t0"'
      );
    });
  });

  describe("UPDATE Operations - Full SQL", () => {
    test("UPDATE: should generate complete SQL for single update", () => {
      const result = QueryParser.parse(
        "update",
        user,
        {
          where: { id: "user_123" },
          data: {
            name: "Alice Updated",
            age: 26,
          },
        },
        adapter
      );

      const sql = result.toStatement();
      expect(sql).toBe(
        'WITH t0 AS (UPDATE "user" SET "name" = ?1, "age" = ?2 WHERE "id" = ?3 RETURNING *) SELECT "t0"."id", "t0"."name", "t0"."email", "t0"."age" FROM "t0"'
      );
    });

    test("UPDATE_MANY: should generate complete SQL for bulk update", () => {
      const result = QueryParser.parse(
        "updateMany",
        user,
        {
          where: { age: { gte: 18 } },
          data: {
            name: "Adult User",
          },
        },
        adapter
      );

      const sql = result.toStatement();
      expect(sql).toBe(
        'WITH t0 AS (UPDATE "user" SET "name" = ?1 WHERE "age" >= ?2 RETURNING *) SELECT "t0"."id", "t0"."name", "t0"."email", "t0"."age" FROM "t0"'
      );
    });

    test("UPDATE_MANY: should generate complete SQL without WHERE", () => {
      const result = QueryParser.parse(
        "updateMany",
        user,
        {
          data: {
            age: 0,
          },
        },
        adapter
      );

      const sql = result.toStatement();
      expect(sql).toBe(
        'WITH t0 AS (UPDATE "user" SET "age" = ?1 RETURNING *) SELECT "t0"."id", "t0"."name", "t0"."email", "t0"."age" FROM "t0"'
      );
    });
  });

  describe("DELETE Operations - Full SQL", () => {
    test("DELETE: should generate complete SQL for single delete", () => {
      const result = QueryParser.parse(
        "delete",
        user,
        {
          where: { id: "user_123" },
        },
        adapter
      );

      const sql = result.toStatement();
      expect(sql).toBe(
        'WITH t0 AS (DELETE FROM "user" WHERE "id" = ?1 RETURNING *) SELECT "t0"."id", "t0"."name", "t0"."email", "t0"."age" FROM "t0"'
      );
    });

    test("DELETE_MANY: should generate complete SQL for bulk delete", () => {
      const result = QueryParser.parse(
        "deleteMany",
        user,
        {
          where: { age: { lt: 18 } },
        },
        adapter
      );

      const sql = result.toStatement();
      expect(sql).toBe(
        'WITH t0 AS (DELETE FROM "user" WHERE "age" < ?1 RETURNING *) SELECT "t0"."id", "t0"."name", "t0"."email", "t0"."age" FROM "t0"'
      );
    });

    test("DELETE_MANY: should generate complete SQL without WHERE", () => {
      const result = QueryParser.parse("deleteMany", user, {}, adapter);

      const sql = result.toStatement();
      expect(sql).toBe(
        'WITH t0 AS (DELETE FROM "user" RETURNING *) SELECT "t0"."id", "t0"."name", "t0"."email", "t0"."age" FROM "t0"'
      );
    });
  });

  describe("Complex Operations - Full SQL", () => {
    test("UPDATE: should generate complete SQL with multiple field updates", () => {
      const result = QueryParser.parse(
        "update",
        user,
        {
          where: { id: "user_123" },
          data: {
            name: "Updated Name",
            email: "updated@example.com",
            age: 30,
          },
        },
        adapter
      );

      const sql = result.toStatement();
      expect(sql).toBe(
        'WITH t0 AS (UPDATE "user" SET "name" = ?1, "email" = ?2, "age" = ?3 WHERE "id" = ?4 RETURNING *) SELECT "t0"."id", "t0"."name", "t0"."email", "t0"."age" FROM "t0"'
      );
    });

    test("CREATE: should generate complete SQL with JSON data", () => {
      const complexUser = s.model("complex_user", {
        id: s.string().id(),
        profile: s.json(),
        isActive: s.boolean(),
      });

      const result = QueryParser.parse(
        "create",
        complexUser,
        {
          data: {
            id: "user_123",
            profile: { bio: "Hello world", age: 25 },
            isActive: true,
          },
        },
        adapter
      );

      const sql = result.toStatement();
      expect(sql).toBe(
        'WITH t0 AS (INSERT INTO "complex_user" (id,profile,isActive) VALUES (?1,?2,?3)) RETURNING *) SELECT "t0"."id", "t0"."profile", "t0"."isActive" FROM "t0"'
      );
    });

    test("UPDATE_MANY: should generate complete SQL with complex WHERE clause", () => {
      const result = QueryParser.parse(
        "updateMany",
        user,
        {
          where: {
            AND: [{ age: { gte: 18 } }, { name: { contains: "Alice" } }],
          },
          data: {
            email: "verified@example.com",
          },
        },
        adapter
      );

      const sql = result.toStatement();
      expect(sql).toBe(
        'WITH t0 AS (UPDATE "user" SET "email" = ?1 WHERE ("age" >= ?2 AND "name" LIKE ?3) RETURNING *) SELECT "t0"."id", "t0"."name", "t0"."email", "t0"."age" FROM "t0"'
      );
    });

    test("DELETE_MANY: should generate complete SQL with complex WHERE clause", () => {
      const result = QueryParser.parse(
        "deleteMany",
        user,
        {
          where: {
            OR: [{ age: { lt: 13 } }, { email: { endsWith: "@temp.com" } }],
          },
        },
        adapter
      );

      const sql = result.toStatement();
      expect(sql).toBe(
        'WITH t0 AS (DELETE FROM "user" WHERE ("age" < ?1 OR "email" LIKE ?2) RETURNING *) SELECT "t0"."id", "t0"."name", "t0"."email", "t0"."age" FROM "t0"'
      );
    });
  });
});
