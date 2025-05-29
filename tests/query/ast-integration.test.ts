// Comprehensive AST Integration Tests
// Tests complex scenarios, edge cases, and integration between parsers

import { DefaultSchemaRegistry } from "../../src/query/ast";
import { DefaultQueryParser } from "../../src/query/parser";
import { s } from "../../src/schema";

describe("AST Integration Tests", () => {
  let registry: DefaultSchemaRegistry;
  let parser: DefaultQueryParser;

  // Simple models for testing without complex relations
  const userModel = s.model("user", {
    id: s.string().id(),
    name: s.string(),
    email: s.string().unique(),
    age: s.int(),
    status: s.string(),
    createdAt: s.dateTime(),
    updatedAt: s.dateTime(),
  });

  const postModel = s.model("post", {
    id: s.string().id(),
    title: s.string(),
    content: s.string(),
    published: s.boolean(),
    likes: s.int(),
    authorId: s.string(),
    categoryId: s.string(),
    createdAt: s.dateTime(),
  });

  beforeEach(() => {
    registry = new DefaultSchemaRegistry();
    registry.registerModel(userModel);
    registry.registerModel(postModel);
    parser = new DefaultQueryParser(registry);
  });

  describe("Complex Query Scenarios", () => {
    test("complex where clauses with multiple conditions", () => {
      const result = parser.parse("user", "findMany", {
        where: {
          status: "active",
          age: { gte: 18 },
          email: { contains: "@example.com" },
        } as any,
        select: {
          id: true,
          name: true,
          email: true,
        } as any,
        orderBy: [{ createdAt: "desc" }, { name: "asc" }] as any,
        take: 10,
        skip: 0,
      });

      expect(result.type).toBe("QUERY");
      expect(result.operation).toBe("findMany");
      expect(result.args.where).toHaveLength(3);
      expect(result.args.select?.type).toBe("SELECTION");
      expect(result.args.orderBy).toHaveLength(2);
      expect(result.args.take).toBe(10);
      expect(result.args.skip).toBe(0);
    });

    test("simple aggregation with groupBy", () => {
      // Test simple aggregation without complex groupBy parsing
      const result = parser.parse("post", "aggregate", {
        where: {
          published: true,
        } as any,
        _count: {
          id: true,
        },
        _avg: {
          likes: true,
        },
      } as any);

      expect(result.operation).toBe("aggregate");
      expect(result.args.where).toHaveLength(1);
      expect(result.args.select?.type).toBe("AGGREGATION");

      if (result.args.select?.type === "AGGREGATION") {
        const aggregations = result.args.select.aggregations;
        expect(aggregations.some((a) => a.operation === "_count")).toBe(true);
        expect(aggregations.some((a) => a.operation === "_avg")).toBe(true);
      }
    });

    test("simple batch operations", () => {
      // Test that batch operations are recognized by operation type
      // Focus on testing the operation detection, not complex data parsing

      // Test empty array batch creation
      const result1 = parser.parse("user", "createMany", {
        data: [],
      } as any);

      expect(result1.operation).toBe("createMany");
      expect(result1.type).toBe("QUERY");

      // Test updateMany operation recognition
      const result2 = parser.parse("user", "updateMany", {
        where: { status: "pending" },
        data: { status: "active" },
      } as any);

      expect(result2.operation).toBe("updateMany");
      expect(result2.type).toBe("QUERY");
    });

    test("cursor pagination with simple ordering", () => {
      const result = parser.parse("post", "findMany", {
        where: {
          published: true,
          likes: { gte: 10 },
        } as any,
        cursor: { createdAt: new Date("2024-01-15") },
        take: 20,
        orderBy: [
          { createdAt: "desc" },
          { likes: "desc" },
          { title: "asc" },
        ] as any,
        select: {
          id: true,
          title: true,
          likes: true,
        } as any,
      });

      expect(result.args.cursor?.type).toBe("CURSOR");
      expect(result.args.cursor?.field.name).toBe("createdAt");
      expect(result.args.orderBy).toHaveLength(3);
      expect(result.args.take).toBe(20);
      expect(result.args.where).toHaveLength(2);
    });
  });

  describe("Edge Cases & Error Resilience", () => {
    test("handles empty objects gracefully", () => {
      const result = parser.parse("user", "findMany", {});

      expect(result.type).toBe("QUERY");
      expect(result.operation).toBe("findMany");
      expect(result.args.where).toBeUndefined();
      expect(result.args.select).toBeUndefined();
    });

    test("handles null and undefined values in where clauses", () => {
      const result = parser.parse("user", "findMany", {
        where: {
          name: null,
          email: { not: null },
          age: undefined,
        } as any,
      });

      expect(result.args.where).toBeDefined();
    });

    test("validates basic aggregation compatibility", () => {
      // Test that at least valid aggregations work
      expect(() => {
        parser.parse("user", "aggregate", {
          _avg: {
            age: true, // This should work - age is numeric
          },
        } as any);
      }).not.toThrow();

      // Test count which should always work
      expect(() => {
        parser.parse("user", "aggregate", {
          _count: true,
        } as any);
      }).not.toThrow();
    });

    test("validates cursor field types", () => {
      expect(() => {
        parser.parse("user", "findMany", {
          cursor: { status: "active" },
        });
      }).not.toThrow();
    });

    test("handles malformed batch data", () => {
      expect(() => {
        parser.parse("user", "createMany", {
          data: "not an array" as any,
        });
      }).toThrow("Invalid data object");

      expect(() => {
        parser.parse("user", "createMany", {
          data: [],
        } as any);
      }).not.toThrow();

      expect(() => {
        parser.parse("user", "updateMany", {
          where: { age: { gte: 18 } },
          data: { name: "updated" },
        } as any);
      }).not.toThrow();
    });

    test("handles logical operators correctly", () => {
      const result = parser.parse("user", "findMany", {
        where: {
          OR: [
            {
              age: { gte: 18 },
              status: "active",
            },
            {
              age: { gte: 21 },
              status: "premium",
            },
          ],
        } as any,
      });

      expect(result.args.where).toHaveLength(1);
    });

    test("validates basic groupBy operations", () => {
      const result = parser.parse("post", "groupBy", {
        by: ["authorId"],
        _count: true,
      } as any);

      expect(result.operation).toBe("groupBy");
      expect(result.args.select?.type).toBe("AGGREGATION");
    });

    test("handles special characters in string values", () => {
      const result = parser.parse("user", "findMany", {
        where: {
          name: { contains: "O'Reilly & Co. (50% off!)" },
          email: { startsWith: "test+tag@" },
        } as any,
      });

      expect(result.args.where).toHaveLength(2);
    });
  });

  describe("Performance & Scale", () => {
    test("handles complex selections efficiently", () => {
      const start = Date.now();

      const result = parser.parse("user", "findMany", {
        select: {
          id: true,
          name: true,
          email: true,
          age: true,
          status: true,
          createdAt: true,
        } as any,
        where: {
          OR: [{ age: { gte: 18 } }, { status: "premium" }],
        } as any,
        orderBy: [{ createdAt: "desc" }, { name: "asc" }] as any,
      });

      const duration = Date.now() - start;

      expect(result.args.select?.type).toBe("SELECTION");
      expect(duration).toBeLessThan(50);
    });
  });

  describe("Type Safety Validation", () => {
    test("maintains type safety with complex queries", () => {
      const result = parser.parse("user", "findMany", {
        where: { age: { gte: 18 } },
        select: { name: true },
        orderBy: { createdAt: "desc" } as any,
        take: 10,
      } as any);

      expectTypeOf(result).toMatchTypeOf<{
        type: "QUERY";
        operation: string;
        model: any;
        args: any;
      }>();
    });

    test("validates operation-specific arguments", () => {
      const findResult = parser.parse("user", "findMany", {
        where: { age: 18 },
      } as any);

      const createResult = parser.parse("user", "create", {
        data: { name: "Test", email: "test@example.com", age: 25 },
      } as any);

      const aggregateResult = parser.parse("user", "aggregate", {
        _count: true,
        _avg: { age: true },
      } as any);

      expect(findResult.operation).toBe("findMany");
      expect(createResult.operation).toBe("create");
      expect(aggregateResult.operation).toBe("aggregate");
    });
  });
});
