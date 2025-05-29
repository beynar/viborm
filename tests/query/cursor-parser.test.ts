// Tests for Cursor Parser

import { DefaultSchemaRegistry } from "../../src/query/ast";
import { CursorParser } from "../../src/query/cursor-parser";
import { FieldResolver } from "../../src/query/field-resolver";
import { ValueParser } from "../../src/query/value-parser";
import { s } from "../../src/schema";

describe("CursorParser", () => {
  let registry: DefaultSchemaRegistry;
  let fieldResolver: FieldResolver;
  let valueParser: ValueParser;
  let parser: CursorParser;

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
    parser = new CursorParser(fieldResolver, valueParser);
  });

  describe("parseCursor", () => {
    test("parses cursor with string field", () => {
      const modelRef = registry.createModelReference("user");
      const result = parser.parseCursor({ id: "user_123" }, modelRef);

      expect(result.type).toBe("CURSOR");
      expect(result.field.name).toBe("id");
      expect(result.value.value).toBe("user_123");
      expect(result.value.valueType).toBe("string");
      expect(result.direction).toBeUndefined();
    });

    test("parses cursor with numeric field", () => {
      const modelRef = registry.createModelReference("user");
      const result = parser.parseCursor({ age: 25 }, modelRef);

      expect(result.field.name).toBe("age");
      expect(result.value.value).toBe(25);
      expect(result.value.valueType).toBe("int");
    });

    test("parses cursor with date field", () => {
      const modelRef = registry.createModelReference("user");
      const testDate = new Date("2024-01-01T00:00:00Z");
      const result = parser.parseCursor({ createdAt: testDate }, modelRef);

      expect(result.field.name).toBe("createdAt");
      expect(result.value.value).toBe(testDate);
      expect(result.value.valueType).toBe("dateTime");
    });

    test("throws error for invalid cursor object", () => {
      const modelRef = registry.createModelReference("user");

      expect(() => parser.parseCursor(null, modelRef)).toThrow(
        "Invalid cursor object"
      );
      expect(() => parser.parseCursor("invalid", modelRef)).toThrow(
        "Invalid cursor object"
      );
    });

    test("throws error for empty cursor object", () => {
      const modelRef = registry.createModelReference("user");

      expect(() => parser.parseCursor({}, modelRef)).toThrow(
        "Cursor must contain exactly one field:value pair"
      );
    });

    test("throws error for cursor with multiple fields", () => {
      const modelRef = registry.createModelReference("user");

      expect(() =>
        parser.parseCursor({ id: "user_123", name: "Alice" }, modelRef)
      ).toThrow("Cursor must contain exactly one field:value pair");
    });

    test("throws error for unknown field in cursor", () => {
      const modelRef = registry.createModelReference("user");

      expect(() =>
        parser.parseCursor({ unknownField: "value" }, modelRef)
      ).toThrow("Failed to parse cursor field 'unknownField'");
    });
  });

  describe("validateCursorField", () => {
    test("validates orderable field types as valid cursor fields", () => {
      const modelRef = registry.createModelReference("user");

      // String field should be valid
      const stringField = fieldResolver.resolveField("user", "id");
      expect(parser.validateCursorField(stringField)).toBe(true);

      // Numeric field should be valid
      const intField = fieldResolver.resolveField("user", "age");
      expect(parser.validateCursorField(intField)).toBe(true);

      // Date field should be valid
      const dateField = fieldResolver.resolveField("user", "createdAt");
      expect(parser.validateCursorField(dateField)).toBe(true);
    });

    test("handles edge cases in field validation", () => {
      const modelRef = registry.createModelReference("user");
      const stringField = fieldResolver.resolveField("user", "name");

      // Should return true for valid orderable types
      expect(parser.validateCursorField(stringField)).toBe(true);
    });
  });

  describe("integration with value parser", () => {
    test("properly delegates value parsing to ValueParser", () => {
      const modelRef = registry.createModelReference("user");
      const result = parser.parseCursor({ id: "user_123" }, modelRef);

      // The ValueParser should have inferred the correct type
      expect(result.value.valueType).toBe("string");
      expect(result.value.value).toBe("user_123");
    });

    test("handles complex value types correctly", () => {
      const modelRef = registry.createModelReference("user");
      const testDate = new Date("2024-01-01T00:00:00Z");
      const result = parser.parseCursor({ createdAt: testDate }, modelRef);

      expect(result.value.valueType).toBe("dateTime");
      expect(result.value.value).toBe(testDate);
    });
  });

  describe("type inference", () => {
    test("maintains type safety for cursor operations", () => {
      const modelRef = registry.createModelReference("user");
      const result = parser.parseCursor({ id: "user_123" }, modelRef);

      expectTypeOf(result).toMatchTypeOf<{
        type: "CURSOR";
        field: any;
        value: any;
        direction?: "forward" | "backward";
      }>();
    });
  });
});
