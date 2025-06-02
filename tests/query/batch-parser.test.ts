// Tests for Batch Parser

import { DefaultSchemaRegistry } from "../../src/query/ast";
import { BatchParser } from "../../src/query/batch-parser";
import { DataParser } from "../../src/query/data-parser";
import { FieldResolver } from "../../src/query/field-resolver";
import { ValueParser } from "../../src/query/value-parser";
import { s } from "../../src/schema";

describe("BatchParser", () => {
  let registry: DefaultSchemaRegistry;
  let fieldResolver: FieldResolver;
  let valueParser: ValueParser;
  let dataParser: DataParser;
  let parser: BatchParser;

  const userModel = s.model("user", {
    id: s.string().id(),
    name: s.string(),
    age: s.int(),
    email: s.string(),
    createdAt: s.dateTime(),
  });

  beforeEach(() => {
    registry = new DefaultSchemaRegistry();
    registry.registerModel(userModel);
    fieldResolver = new FieldResolver(registry);
    valueParser = new ValueParser();
    dataParser = new DataParser(fieldResolver, valueParser);
    parser = new BatchParser(dataParser);
  });

  describe("parseCreateMany", () => {
    test("parses createMany with array of data", () => {
      const modelRef = registry.createModelReference("user");
      const result = parser.parseCreateMany(
        {
          data: [
            { name: "Alice", age: 25, email: "alice@example.com" },
            { name: "Bob", age: 30, email: "bob@example.com" },
          ],
        },
        modelRef
      );

      expect(result.type).toBe("BATCH_DATA");
      expect(result.operation).toBe("createMany");
      expect(result.model).toBe(modelRef);
      expect(result.items).toHaveLength(2);
      expect(result.options?.skipDuplicates).toBeUndefined();
    });

    test("parses createMany with skipDuplicates option", () => {
      const modelRef = registry.createModelReference("user");
      const result = parser.parseCreateMany(
        {
          data: [{ name: "Alice", age: 25, email: "alice@example.com" }],
          skipDuplicates: true,
        },
        modelRef
      );

      expect(result.operation).toBe("createMany");
      expect(result.options?.skipDuplicates).toBe(true);
    });

    test("throws error for invalid createMany object", () => {
      const modelRef = registry.createModelReference("user");

      expect(() => parser.parseCreateMany(null, modelRef)).toThrow(
        "Invalid createMany object"
      );
      expect(() => parser.parseCreateMany("invalid", modelRef)).toThrow(
        "Invalid createMany object"
      );
    });

    test("throws error when data is not an array", () => {
      const modelRef = registry.createModelReference("user");

      expect(() =>
        parser.parseCreateMany({ data: { name: "Alice" } }, modelRef)
      ).toThrow("createMany.data must be an array");
    });

    test("handles errors in individual data items", () => {
      const modelRef = registry.createModelReference("user");

      expect(() =>
        parser.parseCreateMany(
          {
            data: [{ name: "Alice", age: 25 }, { invalidField: "value" }],
          },
          modelRef
        )
      ).toThrow("Failed to parse createMany item at index 1");
    });
  });

  describe("parseUpdateMany", () => {
    test("parses updateMany with data object", () => {
      const modelRef = registry.createModelReference("user");
      const result = parser.parseUpdateMany(
        {
          data: { age: 26, name: "Updated Name" },
        },
        modelRef
      );

      expect(result.type).toBe("BATCH_DATA");
      expect(result.operation).toBe("updateMany");
      expect(result.model).toBe(modelRef);
      expect(result.items).toHaveLength(1);
    });

    test("throws error for invalid updateMany object", () => {
      const modelRef = registry.createModelReference("user");

      expect(() => parser.parseUpdateMany(null, modelRef)).toThrow(
        "Invalid updateMany object"
      );
      expect(() => parser.parseUpdateMany("invalid", modelRef)).toThrow(
        "Invalid updateMany object"
      );
    });

    test("throws error when data is missing", () => {
      const modelRef = registry.createModelReference("user");

      expect(() => parser.parseUpdateMany({}, modelRef)).toThrow(
        "updateMany.data is required"
      );
    });
  });

  describe("parseDeleteMany", () => {
    test("parses deleteMany operation", () => {
      const modelRef = registry.createModelReference("user");
      const result = parser.parseDeleteMany({}, modelRef);

      expect(result.type).toBe("BATCH_DATA");
      expect(result.operation).toBe("deleteMany");
      expect(result.model).toBe(modelRef);
      expect(result.items).toHaveLength(0);
    });
  });

  describe("parseBatchOperation", () => {
    test("delegates to appropriate parser based on operation", () => {
      const modelRef = registry.createModelReference("user");

      // Test createMany delegation
      const createManyResult = parser.parseBatchOperation(
        "createMany",
        { data: [{ name: "Alice" }] },
        modelRef
      );
      expect(createManyResult.operation).toBe("createMany");

      // Test updateMany delegation
      const updateManyResult = parser.parseBatchOperation(
        "updateMany",
        { data: { name: "Updated" } },
        modelRef
      );
      expect(updateManyResult.operation).toBe("updateMany");

      // Test deleteMany delegation
      const deleteManyResult = parser.parseBatchOperation(
        "deleteMany",
        {},
        modelRef
      );
      expect(deleteManyResult.operation).toBe("deleteMany");
    });

    test("throws error for unknown batch operation", () => {
      const modelRef = registry.createModelReference("user");

      expect(() =>
        parser.parseBatchOperation("unknownOperation" as any, {}, modelRef)
      ).toThrow("Unknown batch operation: unknownOperation");
    });
  });

  describe("type inference", () => {
    test("maintains type safety for batch operations", () => {
      const modelRef = registry.createModelReference("user");
      const result = parser.parseCreateMany(
        { data: [{ name: "Alice" }] },
        modelRef
      );

      expectTypeOf(result).toMatchTypeOf<{
        type: "BATCH_DATA";
        model: typeof modelRef;
        operation: "createMany" | "updateMany" | "deleteMany";
        items: any[];
        options?: any;
      }>();
    });
  });
});
