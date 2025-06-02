// Integration Tests for Enhanced Query Parser

import { DefaultSchemaRegistry } from "../../src/query/ast";
import { DefaultQueryParser } from "../../src/query/parser";
import { s } from "../../src/schema";

describe("Enhanced Query Parser Integration", () => {
  let registry: DefaultSchemaRegistry;
  let parser: DefaultQueryParser;

  const userModel = s.model("user", {
    id: s.string().id(),
    name: s.string(),
    age: s.int(),
    email: s.string(),
    createdAt: s.dateTime().unique(),
    posts: s.relation.oneToMany(() => postModel),
  });

  const postModel = s.model("post", {
    id: s.string().id(),
    title: s.string(),
    content: s.string(),
    authorId: s.string(),
    likes: s.int(),
    createdAt: s.dateTime(),
    author: s.relation.manyToOne(() => userModel),
  });

  beforeEach(() => {
    registry = new DefaultSchemaRegistry();
    registry.registerModel(userModel);
    registry.registerModel(postModel);
    parser = new DefaultQueryParser(registry);
  });

  describe("Aggregation Operations", () => {
    test("parses aggregate operation with _count", () => {
      const result = parser.parse("user", "aggregate", {
        _count: true,
        where: { age: { gte: 18 } },
      });

      expect(result.type).toBe("QUERY");
      expect(result.operation).toBe("aggregate");
      expect(result.args.select?.type).toBe("AGGREGATION");
      expect(result.args.where).toHaveLength(1);
    });

    test("parses count operation", () => {
      const result = parser.parse("user", "count", {
        where: { name: { contains: "John" } },
      });

      expect(result.operation).toBe("count");
      expect(result.args.where).toHaveLength(1);
    });

    test("parses groupBy operation", () => {
      const result = parser.parse("user", "groupBy", {
        groupBy: ["name", "age"],
        _count: true,
        _avg: { age: true },
      });

      expect(result.operation).toBe("groupBy");
      expect(result.args.groupBy).toHaveLength(2);
    });
  });

  describe("Batch Operations", () => {
    test("parses createMany operation", () => {
      const result = parser.parse("user", "createMany", {
        data: [
          { name: "Alice", age: 25, email: "alice@example.com" },
          { name: "Bob", age: 30, email: "bob@example.com" },
        ],
        skipDuplicates: true,
      });

      expect(result.operation).toBe("createMany");
      expect(result.args.data).toBeDefined();
    });

    test("parses updateMany operation", () => {
      const result = parser.parse("user", "updateMany", {
        where: { age: { gte: 18 } },
        data: { name: "Updated Name" },
      });

      expect(result.operation).toBe("updateMany");
      expect(result.args.where).toHaveLength(1);
      expect(result.args.data).toBeDefined();
    });

    test("parses deleteMany operation", () => {
      const result = parser.parse("user", "deleteMany", {
        where: { age: { lt: 18 } },
      });

      expect(result.operation).toBe("deleteMany");
      expect(result.args.where).toHaveLength(1);
    });
  });

  describe("Cursor-based Pagination", () => {
    test("parses cursor pagination", () => {
      const result = parser.parse("user", "findMany", {
        cursor: { id: "user_123" },
        take: 10,
      });

      expect(result.args.cursor?.type).toBe("CURSOR");
      expect(result.args.cursor?.field.name).toBe("id");
      expect(result.args.cursor?.value.value).toBe("user_123");
      expect(result.args.take).toBe(10);
    });

    test("handles cursor with different field types", () => {
      // Date cursor
      const testDate = new Date("2024-01-01");
      const result = parser.parse("user", "findMany", {
        cursor: { createdAt: testDate },
        take: 5,
      });

      expect(result.args.cursor?.field.name).toBe("createdAt");
      expect(result.args.cursor?.value.valueType).toBe("dateTime");
    });
  });

  describe("Nested Aggregations", () => {
    test("handles aggregations in nested relations", () => {
      // Add relation to test model (simulated)
      const result = parser.parse("user", "findMany", {
        select: {
          name: true,
          posts: {
            _count: true,
            _avg: { likes: true },
          },
        },
      });

      expect(result.args.select?.type).toBe("SELECTION");

      if (result.args.select?.type === "SELECTION") {
        expect(result.args.select.fields).toHaveLength(2);

        // Check for the posts field with nested aggregation
        const postsField = result.args.select.fields.find(
          (f) => f.field.name === "posts"
        );
        expect(postsField?.nested?.args?.aggregate).toBeDefined();
      }
    });
  });

  describe("Complex Query Combinations", () => {
    test("combines multiple advanced features", () => {
      const result = parser.parse("user", "findMany", {
        where: {
          AND: [{ age: { gte: 18 } }, { email: { contains: "@example.com" } }],
        },
        select: {
          name: true,
          age: true,
          posts: {
            _count: true,
            where: { likes: { gte: 10 } },
          },
        },
        orderBy: [{ createdAt: "desc" }, { name: "asc" }],
        cursor: { id: "user_123" },
        take: 20,
        skip: 0,
      });

      expect(result.operation).toBe("findMany");
      expect(result.args.where).toHaveLength(1);
      expect(result.args.select?.type).toBe("SELECTION");
      expect(result.args.orderBy).toHaveLength(2);
      expect(result.args.cursor?.type).toBe("CURSOR");
      expect(result.args.take).toBe(20);
      expect(result.args.skip).toBe(0);
    });

    test("handles aggregation with groupBy and having", () => {
      const result = parser.parse("user", "aggregate", {
        where: { age: { gte: 18 } },
        _count: true,
        _avg: { age: true },
        groupBy: ["name"],
        having: { age: { avg: { gte: 25 } } },
        orderBy: { _count: { name: "desc" } },
      });

      expect(result.args.where).toHaveLength(1);
      expect(result.args.select?.type).toBe("AGGREGATION");
      expect(result.args.groupBy).toHaveLength(1);
      expect(result.args.having).toHaveLength(1);
      expect(result.args.orderBy).toHaveLength(1);
    });
  });

  describe("Error Handling", () => {
    test("provides clear error messages for invalid operations", () => {
      expect(() =>
        parser.parse("user", "invalidOperation" as any, {})
      ).toThrow();
    });

    test("handles invalid aggregation syntax", () => {
      expect(() =>
        parser.parse("user", "aggregate", {
          _avg: { invalidField: true },
        })
      ).toThrow("Failed to resolve _avg field 'invalidField'");
    });

    test("validates batch operation data", () => {
      expect(() =>
        parser.parse("user", "createMany", {
          data: "invalid",
        })
      ).toThrow("createMany.data must be an array");
    });

    test("validates cursor syntax", () => {
      expect(() =>
        parser.parse("user", "findMany", {
          cursor: { id: "user_123", name: "Alice" },
        })
      ).toThrow("Cursor must contain exactly one field:value pair");
    });
  });

  describe("Type Safety", () => {
    test("maintains type safety across all operations", () => {
      const result = parser.parse("user", "findMany", {
        where: { age: { gte: 18 } },
        select: { name: true },
        cursor: { id: "user_123" },
      });

      expectTypeOf(result).toMatchTypeOf<{
        type: "QUERY";
        operation: any;
        model: any;
        args: any;
      }>();
    });
  });
});
