import { describe, test, expect, vi, beforeEach } from "vitest";
import { FieldFilterBuilder } from "../../src/query-parser/fields/field-filters";
import { sql } from "../../src/sql/sql";
import type { QueryParser } from "../../src/query-parser/query-parser";
import type { DatabaseAdapter } from "../../src/adapters/database-adapter";
import type { BuilderContext } from "../../src/query-parser/types";

describe("FieldFilterBuilder - Zod Integration", () => {
  let fieldFilterBuilder: FieldFilterBuilder;
  let mockParser: QueryParser;
  let mockAdapter: DatabaseAdapter;
  let mockContext: BuilderContext;

  beforeEach(() => {
    // Mock database adapter with filter implementations
    mockAdapter = {
      filters: {
        string: {
          equals: vi.fn(() => sql`field = ?`),
          contains: vi.fn(() => sql`field LIKE ?`),
          startsWith: vi.fn(() => sql`field LIKE ?`),
          endsWith: vi.fn(() => sql`field LIKE ?`),
          not: vi.fn(() => sql`field != ?`),
          in: vi.fn(() => sql`field IN (?)`),
          notIn: vi.fn(() => sql`field NOT IN (?)`),
        },
        number: {
          equals: vi.fn(() => sql`field = ?`),
          gt: vi.fn(() => sql`field > ?`),
          gte: vi.fn(() => sql`field >= ?`),
          lt: vi.fn(() => sql`field < ?`),
          lte: vi.fn(() => sql`field <= ?`),
          not: vi.fn(() => sql`field != ?`),
          in: vi.fn(() => sql`field IN (?)`),
          notIn: vi.fn(() => sql`field NOT IN (?)`),
        },
        boolean: {
          equals: vi.fn(() => sql`field = ?`),
          not: vi.fn(() => sql`field != ?`),
        },
        dateTime: {
          equals: vi.fn(() => sql`field = ?`),
          gt: vi.fn(() => sql`field > ?`),
          gte: vi.fn(() => sql`field >= ?`),
          lt: vi.fn(() => sql`field < ?`),
          lte: vi.fn(() => sql`field <= ?`),
        },
        bigint: {
          equals: vi.fn(() => sql`field = ?`),
          gt: vi.fn(() => sql`field > ?`),
        },
        json: {
          equals: vi.fn(() => sql`field = ?`),
          path: vi.fn(() => sql`field->? = ?`),
        },
      },
      operators: {
        and: vi.fn((...conditions) => {
          return sql.join(conditions, " AND ");
        }),
      },
    } as any;

    mockParser = {} as QueryParser;

    fieldFilterBuilder = new FieldFilterBuilder(mockParser, mockAdapter);

    // Mock context with model and field
    mockContext = {
      model: { name: "User" },
      field: null, // Will be set per test
      tableName: "users",
      aliases: new Map(),
    } as any;
  });

  describe("Raw Value Transformation", () => {
    test("should transform raw string value to equals filter", () => {
      const mockField = {
        "~fieldType": "string",
        "~state": { IsNullable: false, IsArray: false },
      } as any;

      const result = fieldFilterBuilder.validateFilter(
        mockField,
        "test@example.com",
        mockContext
      );

      expect(result).toEqual({ equals: "test@example.com" });
    });

    test("should transform raw number value to equals filter", () => {
      const mockField = {
        "~fieldType": "int",
        "~state": { IsNullable: false, IsArray: false },
      } as any;

      const result = fieldFilterBuilder.validateFilter(
        mockField,
        42,
        mockContext
      );

      expect(result).toEqual({ equals: 42 });
    });

    test("should transform raw boolean value to equals filter", () => {
      const mockField = {
        "~fieldType": "boolean",
        "~state": { IsNullable: false, IsArray: false },
      } as any;

      const result = fieldFilterBuilder.validateFilter(
        mockField,
        true,
        mockContext
      );

      expect(result).toEqual({ equals: true });
    });

    test("should preserve explicit filter objects", () => {
      const mockField = {
        "~fieldType": "string",
        "~state": { IsNullable: false, IsArray: false },
      } as any;

      const explicitFilter = {
        contains: "example",
        startsWith: "test",
      };

      const result = fieldFilterBuilder.validateFilter(
        mockField,
        explicitFilter,
        mockContext
      );

      expect(result).toEqual(explicitFilter);
    });
  });

  describe("String Field Validation", () => {
    let stringField: any;

    beforeEach(() => {
      stringField = {
        "~fieldType": "string",
        "~state": { IsNullable: false, IsArray: false },
      };
      mockContext.field = stringField;
    });

    test("should validate string filter operations", () => {
      const validFilters = [
        { equals: "test" },
        { contains: "example" },
        { startsWith: "test" },
        { endsWith: "com" },
        { not: "invalid" },
        { in: ["value1", "value2"] },
        { notIn: ["spam", "invalid"] },
      ];

      validFilters.forEach((filter) => {
        const result = fieldFilterBuilder.validateFilter(
          stringField,
          filter,
          mockContext
        );
        expect(result).toEqual(filter);
      });
    });

    test("should reject invalid string filter values", () => {
      const invalidFilters = [
        { contains: 123 }, // Number instead of string
        { startsWith: true }, // Boolean instead of string
        { in: [123, 456] }, // Array of numbers instead of strings
        { equals: {} }, // Object instead of string
      ];

      invalidFilters.forEach((filter) => {
        expect(() => {
          fieldFilterBuilder.validateFilter(stringField, filter, mockContext);
        }).toThrow();
      });
    });

    test("should handle case sensitivity mode", () => {
      const result = fieldFilterBuilder.validateFilter(
        stringField,
        {
          contains: "example",
          mode: "insensitive",
        },
        mockContext
      );

      expect(result).toEqual({
        contains: "example",
        mode: "insensitive",
      });
    });
  });

  describe("Number Field Validation", () => {
    let numberField: any;

    beforeEach(() => {
      numberField = {
        "~fieldType": "int",
        "~state": { IsNullable: false, IsArray: false },
      };
      mockContext.field = numberField;
    });

    test("should validate number filter operations", () => {
      const validFilters = [
        { equals: 42 },
        { gt: 0 },
        { gte: 18 },
        { lt: 100 },
        { lte: 65 },
        { not: 0 },
        { in: [1, 2, 3] },
        { notIn: [0, -1] },
      ];

      validFilters.forEach((filter) => {
        const result = fieldFilterBuilder.validateFilter(
          numberField,
          filter,
          mockContext
        );
        expect(result).toEqual(filter);
      });
    });

    test("should reject invalid number filter values", () => {
      const invalidFilters = [
        { gt: "invalid" }, // String instead of number
        { equals: true }, // Boolean instead of number
        { in: ["1", "2"] }, // Array of strings instead of numbers
        { lte: Infinity }, // Infinite number
        { gte: NaN }, // NaN value
      ];

      invalidFilters.forEach((filter) => {
        expect(() => {
          fieldFilterBuilder.validateFilter(numberField, filter, mockContext);
        }).toThrow();
      });
    });
  });

  describe("Boolean Field Validation", () => {
    let booleanField: any;

    beforeEach(() => {
      booleanField = {
        "~fieldType": "boolean",
        "~state": { IsNullable: false, IsArray: false },
      } as any;
      mockContext.field = booleanField;
    });

    test("should validate boolean filter operations", () => {
      const validFilters = [
        { equals: true },
        { equals: false },
        { not: true },
        { not: false },
      ];

      validFilters.forEach((filter) => {
        const result = fieldFilterBuilder.validateFilter(
          booleanField,
          filter,
          mockContext
        );
        expect(result).toEqual(filter);
      });
    });

    test("should reject invalid boolean filter values", () => {
      const invalidFilters = [
        { equals: "true" }, // String instead of boolean
        { not: 1 }, // Number instead of boolean
        { equals: null }, // Null on non-nullable field (would fail differently)
      ];

      invalidFilters.forEach((filter) => {
        expect(() => {
          fieldFilterBuilder.validateFilter(booleanField, filter, mockContext);
        }).toThrow();
      });
    });
  });

  describe("Nullable Field Handling", () => {
    test("should allow null values on nullable string fields", () => {
      const nullableField = {
        "~fieldType": "string",
        "~state": { IsNullable: true, IsArray: false },
      } as any;

      const validFilters = [
        { input: null, expected: { equals: null } }, // Raw null value → { equals: null }
        { input: { equals: null }, expected: { equals: null } },
        { input: { equals: "value" }, expected: { equals: "value" } },
        {
          input: { in: ["value1", null, "value2"] },
          expected: { in: ["value1", null, "value2"] },
        },
      ];

      validFilters.forEach(({ input, expected }) => {
        const result = fieldFilterBuilder.validateFilter(
          nullableField,
          input,
          mockContext
        );
        expect(result).toEqual(expected);
      });
    });

    test("should reject null on non-nullable fields", () => {
      const nonNullableField = {
        "~fieldType": "string",
        "~state": { IsNullable: false, IsArray: false },
      } as any;

      expect(() => {
        fieldFilterBuilder.validateFilter(nonNullableField, null, mockContext);
      }).toThrow();
    });
  });

  describe("Array Field Handling", () => {
    test("should handle array field operations", () => {
      const arrayField = {
        "~fieldType": "string",
        "~state": { IsNullable: false, IsArray: true },
      } as any;

      const validFilters = [
        { input: ["tag1", "tag2"], expected: { equals: ["tag1", "tag2"] } }, // Raw array value → { equals: array }
        {
          input: { equals: ["tag1", "tag2"] },
          expected: { equals: ["tag1", "tag2"] },
        },
        { input: { has: "tag1" }, expected: { has: "tag1" } },
        {
          input: { hasEvery: ["tag1", "tag2"] },
          expected: { hasEvery: ["tag1", "tag2"] },
        },
        {
          input: { hasSome: ["tag1", "tag3"] },
          expected: { hasSome: ["tag1", "tag3"] },
        },
        { input: { isEmpty: true }, expected: { isEmpty: true } },
      ];

      validFilters.forEach(({ input, expected }) => {
        const result = fieldFilterBuilder.validateFilter(
          arrayField,
          input,
          mockContext
        );
        expect(result).toEqual(expected);
      });
    });

    test("should validate array field values correctly", () => {
      const arrayField = {
        "~fieldType": "string",
        "~state": { IsNullable: false, IsArray: true },
      } as any;

      const invalidFilters = [
        { has: ["invalid"] }, // Array when expecting single value
        { equals: "not-array" }, // String when expecting array
        { hasEvery: "invalid" }, // String when expecting array
      ];

      invalidFilters.forEach((filter) => {
        expect(() => {
          fieldFilterBuilder.validateFilter(arrayField, filter, mockContext);
        }).toThrow();
      });
    });
  });

  describe("DateTime Field Validation", () => {
    let dateTimeField: any;

    beforeEach(() => {
      dateTimeField = {
        "~fieldType": "dateTime",
        "~state": { IsNullable: false, IsArray: false },
      } as any;
      mockContext.field = dateTimeField;
    });

    test("should validate Date objects and ISO strings", () => {
      const validFilters = [
        new Date("2023-01-01"), // Raw Date object
        "2023-01-01T00:00:00.000Z", // Raw ISO string
        { equals: new Date("2023-01-01") },
        { gte: "2023-01-01T00:00:00.000Z" },
        { lt: new Date("2024-01-01") },
      ];

      validFilters.forEach((filter) => {
        const result = fieldFilterBuilder.validateFilter(
          dateTimeField,
          filter,
          mockContext
        );
        expect(result).toEqual(filter);
      });
    });

    test("should reject invalid date values", () => {
      const invalidFilters = [
        { equals: "invalid-date" }, // Invalid date string
        { gt: 123456789 }, // Number instead of date
        { lte: true }, // Boolean instead of date
      ];

      invalidFilters.forEach((filter) => {
        expect(() => {
          fieldFilterBuilder.validateFilter(dateTimeField, filter, mockContext);
        }).toThrow();
      });
    });
  });

  describe("BigInt Field Validation", () => {
    let bigIntField: any;

    beforeEach(() => {
      bigIntField = {
        "~fieldType": "bigInt",
        "~state": { IsNullable: false, IsArray: false },
      } as any;
      mockContext.field = bigIntField;
    });

    test("should validate bigint values", () => {
      const validFilters = [
        { input: BigInt(123), expected: { equals: BigInt(123) } }, // Raw bigint → { equals: bigint }
        { input: { equals: BigInt(456) }, expected: { equals: BigInt(456) } },
        { input: { gt: BigInt(999) }, expected: { gt: BigInt(999) } },
        { input: { lte: BigInt(500) }, expected: { lte: BigInt(500) } },
      ];

      validFilters.forEach(({ input, expected }) => {
        const result = fieldFilterBuilder.validateFilter(
          bigIntField,
          input,
          mockContext
        );
        expect(result).toEqual(expected);
      });
    });
  });

  describe("JSON Field Validation", () => {
    let jsonField: any;

    beforeEach(() => {
      jsonField = {
        "~fieldType": "json",
        "~state": { IsNullable: false, IsArray: false },
      } as any;
      mockContext.field = jsonField;
    });

    test("should validate JSON operations", () => {
      const validFilters = [
        { key: "value" }, // Raw JSON object
        { equals: { nested: { prop: 123 } } },
        { path: ["user", "name"] },
        { string_contains: "text" },
        { array_contains: ["item"] },
      ];

      validFilters.forEach((filter) => {
        const result = fieldFilterBuilder.validateFilter(
          jsonField,
          filter,
          mockContext
        );
        console.dir({ result, filter }, { depth: null });
        expect(result).toEqual(filter);
      });
    });

    test("should reject undefined values", () => {
      expect(() => {
        fieldFilterBuilder.validateFilter(
          jsonField,
          {
            equals: undefined,
          },
          mockContext
        );
      }).toThrow();
    });
  });

  describe("Error Handling", () => {
    test("should handle unsupported field types", () => {
      const unsupportedField = {
        "~fieldType": "unknownType",
        "~state": { IsNullable: false, IsArray: false },
      } as any;

      expect(() => {
        fieldFilterBuilder.validateFilter(
          unsupportedField,
          "value",
          mockContext
        );
      }).toThrow(
        /Operation 'filtering' is not supported for field type 'unknownType'/
      );
    });

    test("should handle missing field type", () => {
      const invalidField = {
        "~state": { IsNullable: false, IsArray: false },
      } as any;

      expect(() => {
        fieldFilterBuilder.validateFilter(invalidField, "value", mockContext);
      }).toThrow(
        /Operation 'filtering' is not supported for field type 'undefined'/
      );
    });

    test("should handle empty filter objects gracefully", () => {
      const stringField = {
        "~fieldType": "string",
        "~state": { IsNullable: false, IsArray: false },
      } as any;

      // Empty objects should be allowed and return empty objects
      const result = fieldFilterBuilder.validateFilter(
        stringField,
        {},
        mockContext
      );
      expect(result).toEqual({});
    });

    test("should return sql.empty for empty filter objects in handle method", () => {
      mockContext.field = {
        "~fieldType": "string",
        "~state": { IsNullable: false, IsArray: false },
      } as any;

      const result = fieldFilterBuilder.handle(mockContext, {}, "email");
      expect(result).toBe(sql.empty);
    });
  });

  describe("Integration with Filter Builder", () => {
    test("should successfully validate and process filters through the main API", () => {
      mockContext.field = {
        "~fieldType": "string",
        "~state": { IsNullable: false, IsArray: false },
      } as any;

      // Test that the handle method works with validated input
      expect(() => {
        fieldFilterBuilder.handle(mockContext, "test@example.com", "email");
      }).not.toThrow();

      expect(() => {
        fieldFilterBuilder.handle(
          mockContext,
          { contains: "example" },
          "email"
        );
      }).not.toThrow();
    });

    test("should handle invalid input appropriately", () => {
      mockContext.field = {
        "~fieldType": "string",
        "~state": { IsNullable: false, IsArray: false },
      } as any;

      // Test with invalid filter operations that should fail Zod validation
      expect(() => {
        fieldFilterBuilder.handle(mockContext, { contains: 123 }, "email");
      }).toThrow(/Invalid filter conditions/);
    });
  });
});
