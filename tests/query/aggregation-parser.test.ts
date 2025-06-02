// Tests for Aggregation Parser

import { DefaultSchemaRegistry } from "../../src/query/ast";
import { AggregationParser } from "../../src/query/aggregation-parser";
import { FieldResolver } from "../../src/query/field-resolver";
import { s } from "../../src/schema";

describe("AggregationParser", () => {
  let registry: DefaultSchemaRegistry;
  let fieldResolver: FieldResolver;
  let parser: AggregationParser;

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
    parser = new AggregationParser(fieldResolver);
  });

  describe("parseAggregate", () => {
    test("parses simple _count aggregation", () => {
      const modelRef = registry.createModelReference("user");
      const result = parser.parseAggregate({ _count: true }, modelRef);

      expect(result.type).toBe("AGGREGATION");
      expect(result.model).toBe(modelRef);
      expect(result.aggregations).toHaveLength(1);
      expect(result.aggregations[0]?.operation).toBe("_count");
      expect(result.aggregations[0]?.operation).toBe("_count");
      expect(result.aggregations[0]?.field).toBeUndefined();
    });

    test("parses _count with specific fields", () => {
      const modelRef = registry.createModelReference("user");
      const result = parser.parseAggregate(
        { _count: { name: true, email: true } },
        modelRef
      );

      expect(result.aggregations).toHaveLength(2);
      expect(result.aggregations[0]?.operation).toBe("_count");
      expect(result.aggregations[0]?.field?.name).toBe("name");
      expect(result.aggregations[1]?.operation).toBe("_count");
      expect(result.aggregations[1]?.field?.name).toBe("email");
    });

    test("parses _avg aggregation", () => {
      const modelRef = registry.createModelReference("user");
      const result = parser.parseAggregate({ _avg: { age: true } }, modelRef);

      expect(result.aggregations).toHaveLength(1);
      expect(result.aggregations[0]?.operation).toBe("_avg");
      expect(result.aggregations[0]?.field?.name).toBe("age");
    });

    test("parses multiple aggregation operations", () => {
      const modelRef = registry.createModelReference("user");
      const result = parser.parseAggregate(
        {
          _count: true,
          _avg: { age: true },
          _sum: { age: true },
          _min: { createdAt: true },
          _max: { createdAt: true },
        },
        modelRef
      );

      expect(result.aggregations).toHaveLength(5);
      expect(result.aggregations.map((a) => a.operation)).toEqual([
        "_count",
        "_avg",
        "_sum",
        "_min",
        "_max",
      ]);
    });

    test("throws error for invalid aggregate object", () => {
      const modelRef = registry.createModelReference("user");

      expect(() => parser.parseAggregate(null, modelRef)).toThrow(
        "Invalid aggregate object"
      );
      expect(() => parser.parseAggregate("invalid", modelRef)).toThrow(
        "Invalid aggregate object"
      );
    });

    test("throws error for unknown field in aggregation", () => {
      const modelRef = registry.createModelReference("user");

      expect(() =>
        parser.parseAggregate({ _avg: { unknownField: true } }, modelRef)
      ).toThrow();
    });
  });

  describe("parseCount", () => {
    test("parses simple count", () => {
      const modelRef = registry.createModelReference("user");
      const result = parser.parseCount(true, modelRef);

      expect(result.type).toBe("AGGREGATION");
      expect(result.aggregations).toHaveLength(1);
      expect(result.aggregations[0]?.operation).toBe("_count");
    });

    test("parses count with specific fields", () => {
      const modelRef = registry.createModelReference("user");
      const result = parser.parseCount({ name: true, email: true }, modelRef);

      expect(result.aggregations).toHaveLength(2);
      expect(result.aggregations[0]?.field?.name).toBe("name");
      expect(result.aggregations[1]?.field?.name).toBe("email");
    });

    test("handles _all count operation", () => {
      const modelRef = registry.createModelReference("user");
      const result = parser.parseCount({ _all: true }, modelRef);

      expect(result.aggregations).toHaveLength(1);
      expect(result.aggregations[0]?.operation).toBe("_count");
      expect(result.aggregations[0]?.field).toBeUndefined();
    });
  });

  describe("parseGroupBy", () => {
    test("parses simple groupBy array", () => {
      const modelRef = registry.createModelReference("user");
      const result = parser.parseGroupBy(["name", "age"], modelRef);

      expect(result).toHaveLength(2);
      expect(result[0]?.type).toBe("GROUP_BY");
      expect(result[0]?.field?.name).toBe("name");
      expect(result[1]?.field?.name).toBe("age");
    });

    test("throws error for non-array groupBy", () => {
      const modelRef = registry.createModelReference("user");

      expect(() => parser.parseGroupBy("invalid", modelRef)).toThrow(
        "groupBy must be an array"
      );
      expect(() => parser.parseGroupBy({ field: "name" }, modelRef)).toThrow(
        "groupBy must be an array"
      );
    });

    test("throws error for non-string field names", () => {
      const modelRef = registry.createModelReference("user");

      expect(() => parser.parseGroupBy([123, "name"], modelRef)).toThrow(
        "groupBy field names must be strings"
      );
    });

    test("throws error for unknown fields", () => {
      const modelRef = registry.createModelReference("user");

      expect(() => parser.parseGroupBy(["unknownField"], modelRef)).toThrow();
    });
  });

  describe("type inference", () => {
    test("maintains type safety for aggregation operations", () => {
      const modelRef = registry.createModelReference("user");
      const result = parser.parseAggregate({ _count: true }, modelRef);

      expectTypeOf(result).toMatchTypeOf<{
        type: "AGGREGATION";
        model: typeof modelRef;
        aggregations: Array<{
          type: "AGGREGATION_FIELD";
          operation: "_count" | "_avg" | "_sum" | "_min" | "_max";
          field?: any;
        }>;
      }>();
    });
  });
});
