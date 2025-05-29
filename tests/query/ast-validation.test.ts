// AST Validation Tests
// Tests AST structural integrity, logical consistency, and validation

import { DefaultSchemaRegistry, ParseError } from "../../src/query/ast";
import { DefaultQueryParser } from "../../src/query/parser";
import { s } from "../../src/schema";

describe("AST Validation Tests", () => {
  let registry: DefaultSchemaRegistry;
  let parser: DefaultQueryParser;

  const userModel = s.model("user", {
    id: s.string().id(),
    name: s.string(),
    email: s.string().unique(),
    age: s.int(),
    score: s.float(),
    isActive: s.boolean(),
    metadata: s.json(),
    createdAt: s.dateTime(),
  });

  const postModel = s.model("post", {
    id: s.string().id(),
    title: s.string(),
    content: s.string(),
    published: s.boolean(),
    likes: s.int(),
    authorId: s.string(),
    createdAt: s.dateTime(),
  });

  beforeEach(() => {
    registry = new DefaultSchemaRegistry();
    registry.registerModel(userModel);
    registry.registerModel(postModel);
    parser = new DefaultQueryParser(registry);
  });

  describe("Field Type Validation", () => {
    test("validates numeric aggregations on numeric fields only", () => {
      // Valid: numeric field with numeric aggregation
      expect(() => {
        parser.parse("user", "aggregate", {
          _avg: { age: true },
          _sum: { score: true },
        });
      }).not.toThrow();

      // Invalid: string field with numeric aggregation
      expect(() => {
        parser.parse("user", "aggregate", {
          _avg: { name: true },
        });
      }).toThrow();

      expect(() => {
        parser.parse("user", "aggregate", {
          _sum: { email: true },
        });
      }).toThrow();
    });

    test("validates count operations work on any field type", () => {
      expect(() => {
        parser.parse("user", "aggregate", {
          _count: {
            name: true, // string
            age: true, // int
            isActive: true, // boolean
            metadata: true, // json
          },
        });
      }).not.toThrow();
    });

    test("validates boolean operations on appropriate fields", () => {
      // Valid: boolean field
      expect(() => {
        parser.parse("user", "findMany", {
          where: { isActive: true },
        });
      }).not.toThrow();

      // Valid: numeric comparisons
      expect(() => {
        parser.parse("user", "findMany", {
          where: { age: { gte: 18 } },
        });
      }).not.toThrow();

      // Valid: string operations
      expect(() => {
        parser.parse("user", "findMany", {
          where: { name: { contains: "John" } },
        });
      }).not.toThrow();
    });

    test("validates date/time operations", () => {
      const testDate = new Date("2024-01-01");

      expect(() => {
        parser.parse("user", "findMany", {
          where: {
            createdAt: { gte: testDate },
          },
        });
      }).not.toThrow();

      expect(() => {
        parser.parse("user", "findMany", {
          cursor: { createdAt: testDate },
        });
      }).not.toThrow();
    });
  });

  describe("Structural Validation", () => {
    test("validates required fields are present", () => {
      // Missing data in create
      expect(() => {
        parser.parse("user", "create", {});
      }).toThrow();

      // Missing data in updateMany
      expect(() => {
        parser.parse("user", "updateMany", {
          where: { age: { gte: 18 } },
          // data is missing
        });
      }).toThrow("updateMany.data is required");

      // Missing array in createMany
      expect(() => {
        parser.parse("user", "createMany", {
          data: "invalid",
        });
      }).toThrow("createMany.data must be an array");
    });

    test("validates cursor constraints", () => {
      // Empty cursor object
      expect(() => {
        parser.parse("user", "findMany", {
          cursor: {},
        });
      }).toThrow("Cursor must contain exactly one field:value pair");

      // Multiple fields in cursor
      expect(() => {
        parser.parse("user", "findMany", {
          cursor: { id: "123", name: "test" },
        });
      }).toThrow("Cursor must contain exactly one field:value pair");

      // Unknown field in cursor
      expect(() => {
        parser.parse("user", "findMany", {
          cursor: { unknownField: "value" },
        });
      }).toThrow();
    });

    test("validates aggregation combinations", () => {
      // groupBy without aggregation should work with proper structure
      expect(() => {
        parser.parse("user", "groupBy", {
          groupBy: ["name"],
          _count: true,
        });
      }).not.toThrow();

      // aggregate without where should work
      expect(() => {
        parser.parse("user", "aggregate", {
          _count: true,
        });
      }).not.toThrow();
    });

    test("validates logical operator nesting", () => {
      // Valid nested logical operators
      expect(() => {
        parser.parse("user", "findMany", {
          where: {
            AND: [
              { age: { gte: 18 } },
              {
                OR: [
                  { name: { contains: "John" } },
                  { email: { contains: "admin" } },
                ],
              },
            ],
          },
        });
      }).not.toThrow();

      // Empty logical operators should be handled gracefully
      expect(() => {
        parser.parse("user", "findMany", {
          where: {
            AND: [],
          },
        });
      }).not.toThrow();
    });
  });

  describe("Data Integrity Validation", () => {
    test("validates field existence in model", () => {
      // Unknown field in where
      expect(() => {
        parser.parse("user", "findMany", {
          where: { unknownField: "value" },
        });
      }).toThrow();

      // Unknown field in select
      expect(() => {
        parser.parse("user", "findMany", {
          select: { unknownField: true },
        });
      }).toThrow();

      // Unknown field in orderBy
      expect(() => {
        parser.parse("user", "findMany", {
          orderBy: { unknownField: "asc" },
        });
      }).toThrow();

      // Unknown field in data
      expect(() => {
        parser.parse("user", "create", {
          data: { unknownField: "value" },
        });
      }).toThrow();
    });

    test("validates model existence", () => {
      expect(() => {
        parser.parse("unknownModel", "findMany", {});
      }).toThrow();
    });

    test("validates operation existence", () => {
      expect(() => {
        parser.parse("user", "unknownOperation" as any, {});
      }).toThrow();
    });
  });

  describe("Value Type Validation", () => {
    test("validates value types match field expectations", () => {
      // String to int field should be handled appropriately
      expect(() => {
        parser.parse("user", "findMany", {
          where: { age: "25" }, // string value for int field
        });
      }).not.toThrow(); // Parser should handle type coercion

      // Boolean field with boolean value
      expect(() => {
        parser.parse("user", "findMany", {
          where: { isActive: true },
        });
      }).not.toThrow();

      // Null values should be handled
      expect(() => {
        parser.parse("user", "findMany", {
          where: { name: null },
        });
      }).not.toThrow();
    });

    test("validates array operations", () => {
      // Valid 'in' operation
      expect(() => {
        parser.parse("user", "findMany", {
          where: {
            id: { in: ["id1", "id2", "id3"] },
          },
        });
      }).not.toThrow();

      // Valid 'notIn' operation
      expect(() => {
        parser.parse("user", "findMany", {
          where: {
            age: { notIn: [18, 19, 20] },
          },
        });
      }).not.toThrow();

      // Empty array should be valid
      expect(() => {
        parser.parse("user", "findMany", {
          where: {
            id: { in: [] },
          },
        });
      }).not.toThrow();
    });

    test("validates JSON operations", () => {
      expect(() => {
        parser.parse("user", "findMany", {
          where: {
            metadata: { jsonPath: ["path", "to", "value"] },
          },
        });
      }).not.toThrow();

      expect(() => {
        parser.parse("user", "findMany", {
          where: {
            metadata: { jsonContains: { key: "value" } },
          },
        });
      }).not.toThrow();
    });
  });

  describe("Consistency Validation", () => {
    test("validates orderBy field exists when used with cursor", () => {
      // cursor field should generally be in orderBy for meaningful pagination
      const result = parser.parse("user", "findMany", {
        cursor: { createdAt: new Date() },
        orderBy: { createdAt: "desc" },
        take: 10,
      });

      expect(result.args.cursor?.field.name).toBe("createdAt");
      expect(result.args.orderBy?.[0]?.target.type).toBe("FIELD");
      if (result.args.orderBy?.[0]?.target.type === "FIELD") {
        expect(result.args.orderBy[0].target.field.name).toBe("createdAt");
      }
    });

    test("validates take/skip combinations", () => {
      // Negative values should be handled
      expect(() => {
        parser.parse("user", "findMany", {
          take: -10,
        });
      }).not.toThrow(); // Parser might allow this, adapter should handle

      expect(() => {
        parser.parse("user", "findMany", {
          skip: -5,
        });
      }).not.toThrow();

      // Very large values
      expect(() => {
        parser.parse("user", "findMany", {
          take: 1000000,
        });
      }).not.toThrow();
    });

    test("validates aggregation field compatibility with groupBy", () => {
      // Fields in groupBy should be groupable
      expect(() => {
        parser.parse("user", "groupBy", {
          groupBy: ["name", "isActive"],
          _count: true,
          _avg: { age: true },
        });
      }).not.toThrow();

      // aggregation fields should be compatible with their operations
      expect(() => {
        parser.parse("user", "groupBy", {
          groupBy: ["name"],
          _avg: { name: true }, // string field - should error
        });
      }).toThrow();
    });
  });

  describe("Error Context Validation", () => {
    test("provides meaningful error contexts", () => {
      try {
        parser.parse("user", "findMany", {
          where: { unknownField: "value" },
        });
      } catch (error) {
        expect(error).toBeInstanceOf(ParseError);
        if (error instanceof ParseError) {
          expect(error.context?.model).toBe("user");
          expect(error.context?.field).toBe("unknownField");
        }
      }

      try {
        parser.parse("user", "aggregate", {
          _avg: { name: true },
        });
      } catch (error) {
        expect(error).toBeInstanceOf(ParseError);
        if (error instanceof ParseError) {
          expect(error.message).toContain("_avg");
          expect(error.message).toContain("name");
        }
      }
    });

    test("provides context for nested field errors", () => {
      try {
        parser.parse("user", "createMany", {
          data: [{ name: "Valid User", age: 25 }, { invalidField: "value" }],
        });
      } catch (error) {
        expect(error).toBeInstanceOf(ParseError);
        if (error instanceof ParseError) {
          expect(error.message).toContain("index 1");
        }
      }
    });
  });

  describe("AST Node Validation", () => {
    test("validates all AST nodes have required properties", () => {
      const result = parser.parse("user", "findMany", {
        where: { age: { gte: 18 } },
        select: { name: true, age: true },
        orderBy: { createdAt: "desc" },
        take: 10,
      });

      // Root query AST
      expect(result.type).toBe("QUERY");
      expect(result.operation).toBeDefined();
      expect(result.model).toBeDefined();
      expect(result.args).toBeDefined();

      // QueryArgs AST
      expect(result.args.type).toBe("QUERY_ARGS");

      // Condition AST
      if (result.args.where) {
        result.args.where.forEach((condition) => {
          expect(condition.type).toBe("CONDITION");
          expect(condition.target).toBeDefined();
          expect(condition.operator).toBeDefined();
        });
      }

      // Selection AST
      if (result.args.select?.type === "SELECTION") {
        expect(result.args.select.model).toBeDefined();
        expect(result.args.select.fields).toBeDefined();
        expect(Array.isArray(result.args.select.fields)).toBe(true);

        result.args.select.fields.forEach((field) => {
          expect(field.type).toBe("SELECTION_FIELD");
          expect(field.field).toBeDefined();
        });
      }

      // Ordering AST
      if (result.args.orderBy) {
        result.args.orderBy.forEach((order) => {
          expect(order.type).toBe("ORDERING");
          expect(order.target).toBeDefined();
          expect(order.direction).toMatch(/^(asc|desc)$/);
        });
      }
    });

    test("validates AST references are properly linked", () => {
      const result = parser.parse("user", "findMany", {
        where: { name: "John" },
        select: { name: true, age: true },
      });

      // Model references should point to same model
      expect(result.model.name).toBe("user");
      if (result.args.select?.type === "SELECTION") {
        expect(result.args.select.model.name).toBe("user");
        expect(result.args.select.model).toBe(result.model);
      }

      // Field references should be from correct model
      if (result.args.where) {
        result.args.where.forEach((condition) => {
          if (condition.target.type === "FIELD") {
            expect(condition.target.field.model.name).toBe("user");
          }
        });
      }
    });
  });
});
