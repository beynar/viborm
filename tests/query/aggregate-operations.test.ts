import { QueryParser } from "../../src/query-parser";
import { PostgresAdapter } from "../../src/adapters/databases/postgres/postgres-adapter";
import { s } from "../../src/schema";

describe("Aggregate Operations (Phase 3)", () => {
  let adapter: PostgresAdapter;
  let userModel: any;

  beforeEach(() => {
    adapter = new PostgresAdapter();

    // Create a realistic user model for testing
    userModel = s.model("user", {
      id: s.string(),
      name: s.string(),
      email: s.string(),
      age: s.int(),
      salary: s.int(),
      department: s.string(),
      isActive: s.boolean(),
      createdAt: s.dateTime(),
    });
  });

  describe("COUNT Operations", () => {
    test("should generate simple count query", () => {
      const result = QueryParser.parse("count", userModel, {}, adapter);

      const sql = result.toStatement();
      expect(sql).toContain("COUNT(*)");
      expect(sql).toContain("FROM");
    });

    test("should generate count query with where clause", () => {
      const result = QueryParser.parse(
        "count",
        userModel,
        {
          where: { isActive: true },
        },
        adapter
      );

      const sql = result.toStatement();
      expect(sql).toContain("COUNT(*)");
      expect(sql).toContain("WHERE");
      expect(sql).toContain("isActive");
    });

    test("should generate field-specific count", () => {
      const result = QueryParser.parse(
        "count",
        userModel,
        {
          select: { _count: { name: true } },
        },
        adapter
      );

      const sql = result.toStatement();
      expect(sql).toContain("COUNT");
      expect(sql).toContain("name");
    });

    test("should handle count with orderBy", () => {
      const result = QueryParser.parse(
        "count",
        userModel,
        {
          orderBy: { name: "asc" },
        },
        adapter
      );

      const sql = result.toStatement();
      expect(sql).toContain("COUNT(*)");
      expect(sql).toContain("ORDER BY");
    });
  });

  describe("AGGREGATE Operations", () => {
    test("should generate aggregate query with _sum", () => {
      const result = QueryParser.parse(
        "aggregate",
        userModel,
        {
          _sum: { salary: true },
        },
        adapter
      );

      const sql = result.toStatement();
      expect(sql).toContain("SUM");
      expect(sql).toContain("salary");
    });

    test("should generate aggregate query with _avg", () => {
      const result = QueryParser.parse(
        "aggregate",
        userModel,
        {
          _avg: { age: true },
        },
        adapter
      );

      const sql = result.toStatement();
      expect(sql).toContain("AVG");
      expect(sql).toContain("age");
    });

    test("should generate aggregate query with _min and _max", () => {
      const result = QueryParser.parse(
        "aggregate",
        userModel,
        {
          _min: { salary: true },
          _max: { salary: true },
        },
        adapter
      );

      const sql = result.toStatement();
      expect(sql).toContain("MIN");
      expect(sql).toContain("MAX");
      expect(sql).toContain("salary");
    });

    test("should generate aggregate query with _count", () => {
      const result = QueryParser.parse(
        "aggregate",
        userModel,
        {
          _count: true,
        },
        adapter
      );

      const sql = result.toStatement();
      expect(sql).toContain("COUNT(*)");
    });

    test("should generate aggregate query with multiple aggregations", () => {
      const result = QueryParser.parse(
        "aggregate",
        userModel,
        {
          _count: true,
          _sum: { salary: true },
          _avg: { age: true },
          _min: { salary: true },
          _max: { salary: true },
        },
        adapter
      );

      const sql = result.toStatement();
      expect(sql).toContain("COUNT(*)");
      expect(sql).toContain("SUM");
      expect(sql).toContain("AVG");
      expect(sql).toContain("MIN");
      expect(sql).toContain("MAX");
    });

    test("should handle aggregate with where clause", () => {
      const result = QueryParser.parse(
        "aggregate",
        userModel,
        {
          _sum: { salary: true },
          where: { isActive: true },
        },
        adapter
      );

      const sql = result.toStatement();
      expect(sql).toContain("SUM");
      expect(sql).toContain("WHERE");
      expect(sql).toContain("isActive");
    });

    test("should handle aggregate with orderBy", () => {
      const result = QueryParser.parse(
        "aggregate",
        userModel,
        {
          _sum: { salary: true },
          orderBy: { salary: "desc" },
        },
        adapter
      );

      const sql = result.toStatement();
      expect(sql).toContain("SUM");
      expect(sql).toContain("ORDER BY");
    });
  });

  describe("GROUP BY Operations", () => {
    test("should generate groupBy query with single field", () => {
      const result = QueryParser.parse(
        "groupBy",
        userModel,
        {
          by: ["department"],
          _count: true,
        },
        adapter
      );

      const sql = result.toStatement();
      expect(sql).toContain("GROUP BY");
      expect(sql).toContain("department");
      expect(sql).toContain("COUNT(*)");
    });

    test("should generate groupBy query with multiple fields", () => {
      const result = QueryParser.parse(
        "groupBy",
        userModel,
        {
          by: ["department", "isActive"],
          _count: true,
        },
        adapter
      );

      const sql = result.toStatement();
      expect(sql).toContain("GROUP BY");
      expect(sql).toContain("department");
      expect(sql).toContain("isActive");
    });

    test("should generate groupBy query with aggregations", () => {
      const result = QueryParser.parse(
        "groupBy",
        userModel,
        {
          by: ["department"],
          _count: true,
          _sum: { salary: true },
          _avg: { age: true },
        },
        adapter
      );

      const sql = result.toStatement();
      expect(sql).toContain("GROUP BY");
      expect(sql).toContain("department");
      expect(sql).toContain("COUNT(*)");
      expect(sql).toContain("SUM");
      expect(sql).toContain("AVG");
    });

    test("should generate groupBy query with where clause", () => {
      const result = QueryParser.parse(
        "groupBy",
        userModel,
        {
          by: ["department"],
          _count: true,
          where: { isActive: true },
        },
        adapter
      );

      const sql = result.toStatement();
      expect(sql).toContain("GROUP BY");
      expect(sql).toContain("WHERE");
      expect(sql).toContain("isActive");
    });

    test("should generate groupBy query with orderBy", () => {
      const result = QueryParser.parse(
        "groupBy",
        userModel,
        {
          by: ["department"],
          _count: true,
          orderBy: { department: "asc" },
        },
        adapter
      );

      const sql = result.toStatement();
      expect(sql).toContain("GROUP BY");
      expect(sql).toContain("ORDER BY");
    });

    test("should throw error for groupBy without 'by' field", () => {
      expect(() => {
        QueryParser.parse(
          "groupBy",
          userModel,
          {
            _count: true,
          },
          adapter
        );
      }).toThrow("GROUP BY operation requires 'by' field");
    });

    test("should throw error for groupBy with empty 'by' array", () => {
      expect(() => {
        QueryParser.parse(
          "groupBy",
          userModel,
          {
            by: [],
            _count: true,
          },
          adapter
        );
      }).toThrow("GROUP BY operation requires 'by' field");
    });
  });

  describe("Operation Type Detection", () => {
    test("should correctly identify count operation", () => {
      const result = QueryParser.parse("count", userModel, {}, adapter);
      const sql = result.toStatement();
      expect(sql).toContain("COUNT(*)");
    });

    test("should correctly identify aggregate operation", () => {
      const result = QueryParser.parse(
        "aggregate",
        userModel,
        { _sum: { salary: true } },
        adapter
      );
      const sql = result.toStatement();
      expect(sql).toContain("SUM");
    });

    test("should correctly identify groupBy operation", () => {
      const result = QueryParser.parse(
        "groupBy",
        userModel,
        { by: ["department"], _count: true },
        adapter
      );
      const sql = result.toStatement();
      expect(sql).toContain("GROUP BY");
    });
  });

  describe("Complex Scenarios", () => {
    test("should handle complex groupBy with all clauses", () => {
      const result = QueryParser.parse(
        "groupBy",
        userModel,
        {
          by: ["department", "isActive"],
          _count: true,
          _sum: { salary: true },
          _avg: { age: true },
          where: { createdAt: { gte: new Date("2023-01-01") } },
          orderBy: { _count: "desc" },
        },
        adapter
      );

      const sql = result.toStatement();
      expect(sql).toContain("GROUP BY");
      expect(sql).toContain("department");
      expect(sql).toContain("isActive");
      expect(sql).toContain("COUNT(*)");
      expect(sql).toContain("SUM");
      expect(sql).toContain("AVG");
      expect(sql).toContain("WHERE");
      expect(sql).toContain("ORDER BY");
    });

    test("should handle aggregate with multiple field aggregations", () => {
      const result = QueryParser.parse(
        "aggregate",
        userModel,
        {
          _sum: { salary: true, age: true },
          _avg: { salary: true },
          _min: { age: true },
          _max: { salary: true },
          where: { department: "Engineering" },
        },
        adapter
      );

      const sql = result.toStatement();
      expect(sql).toContain("SUM");
      expect(sql).toContain("AVG");
      expect(sql).toContain("MIN");
      expect(sql).toContain("MAX");
      expect(sql).toContain("salary");
      expect(sql).toContain("age");
    });
  });

  describe("Error Handling", () => {
    test("should throw error for unsupported aggregate operation", () => {
      expect(() => {
        QueryParser.parse("invalidAggregate" as any, userModel, {}, adapter);
      }).toThrow("Unsupported operation");
    });
  });

  describe("Full SQL Output Validation", () => {
    test("COUNT: should generate complete SQL for simple count", () => {
      const result = QueryParser.parse("count", userModel, {}, adapter);
      const sql = result.toStatement();

      expect(sql).toBe('SELECT COUNT(*) FROM "user" AS "t0"');
    });

    test("COUNT: should generate complete SQL for count with WHERE", () => {
      const result = QueryParser.parse(
        "count",
        userModel,
        {
          where: { isActive: true },
        },
        adapter
      );
      const sql = result.toStatement();

      expect(sql).toBe(
        'SELECT COUNT(*) FROM "user" AS "t0" WHERE "t0"."isActive" = ?1'
      );
    });

    test("COUNT: should generate complete SQL for field-specific count", () => {
      const result = QueryParser.parse(
        "count",
        userModel,
        {
          select: { _count: { name: true } },
        },
        adapter
      );
      const sql = result.toStatement();

      expect(sql).toBe(
        'SELECT COUNT("t0"."name") AS "_count_name" FROM "user" AS "t0"'
      );
    });

    test("AGGREGATE: should generate complete SQL for single aggregation", () => {
      const result = QueryParser.parse(
        "aggregate",
        userModel,
        {
          _sum: { salary: true },
        },
        adapter
      );
      const sql = result.toStatement();

      expect(sql).toBe(
        'SELECT SUM("t0"."salary") AS "_sum_salary" FROM "user" AS "t0"'
      );
    });

    test("AGGREGATE: should generate complete SQL for multiple aggregations", () => {
      const result = QueryParser.parse(
        "aggregate",
        userModel,
        {
          _count: true,
          _sum: { salary: true },
          _avg: { age: true },
        },
        adapter
      );
      const sql = result.toStatement();

      expect(sql).toBe(
        'SELECT COUNT(*) AS "_count", SUM("t0"."salary") AS "_sum_salary", AVG("t0"."age") AS "_avg_age" FROM "user" AS "t0"'
      );
    });

    test("AGGREGATE: should generate complete SQL with WHERE clause", () => {
      const result = QueryParser.parse(
        "aggregate",
        userModel,
        {
          _avg: { salary: true },
          where: { department: "Engineering" },
        },
        adapter
      );
      const sql = result.toStatement();

      expect(sql).toBe(
        'SELECT AVG("t0"."salary") AS "_avg_salary" FROM "user" AS "t0" WHERE "t0"."department" = ?1'
      );
    });

    test("GROUP BY: should generate complete SQL for simple groupBy", () => {
      const result = QueryParser.parse(
        "groupBy",
        userModel,
        {
          by: ["department"],
          _count: true,
        },
        adapter
      );
      const sql = result.toStatement();

      expect(sql).toBe(
        'SELECT "t0"."department", COUNT(*) AS "_count" FROM "user" AS "t0" GROUP BY "t0"."department"'
      );
    });

    test("GROUP BY: should generate complete SQL for multiple field grouping", () => {
      const result = QueryParser.parse(
        "groupBy",
        userModel,
        {
          by: ["department", "isActive"],
          _count: true,
          _avg: { salary: true },
        },
        adapter
      );
      const sql = result.toStatement();

      expect(sql).toBe(
        'SELECT "t0"."department", "t0"."isActive", COUNT(*) AS "_count", AVG("t0"."salary") AS "_avg_salary" FROM "user" AS "t0" GROUP BY "t0"."department", "t0"."isActive"'
      );
    });

    test("GROUP BY: should generate complete SQL with WHERE and ORDER BY", () => {
      const result = QueryParser.parse(
        "groupBy",
        userModel,
        {
          by: ["department"],
          _count: true,
          _sum: { salary: true },
          where: { isActive: true },
          orderBy: { _count: "desc" },
        },
        adapter
      );
      const sql = result.toStatement();

      expect(sql).toBe(
        'SELECT "t0"."department", COUNT(*) AS "_count", SUM("t0"."salary") AS "_sum_salary" FROM "user" AS "t0" WHERE "t0"."isActive" = ?1 GROUP BY "t0"."department" ORDER BY "t0"."_count" DESC'
      );
    });

    test("AGGREGATE: should generate complete SQL for multiple field aggregations", () => {
      const result = QueryParser.parse(
        "aggregate",
        userModel,
        {
          _sum: { salary: true, age: true },
          _min: { age: true },
          _max: { salary: true },
        },
        adapter
      );
      const sql = result.toStatement();

      expect(sql).toBe(
        'SELECT SUM("t0"."salary") AS "_sum_salary", SUM("t0"."age") AS "_sum_age", MIN("t0"."age") AS "_min_age", MAX("t0"."salary") AS "_max_salary" FROM "user" AS "t0"'
      );
    });

    test("COUNT: should generate complete SQL with ORDER BY", () => {
      const result = QueryParser.parse(
        "count",
        userModel,
        {
          where: { department: "Engineering" },
          orderBy: { name: "asc" },
        },
        adapter
      );
      const sql = result.toStatement();

      expect(sql).toBe(
        'SELECT COUNT(*) FROM "user" AS "t0" WHERE "t0"."department" = ?1 ORDER BY "t0"."name" ASC'
      );
    });

    test("AGGREGATE: should generate complete SQL for all aggregation types", () => {
      const result = QueryParser.parse(
        "aggregate",
        userModel,
        {
          _count: true,
          _sum: { salary: true },
          _avg: { age: true },
          _min: { salary: true },
          _max: { salary: true },
        },
        adapter
      );
      const sql = result.toStatement();

      expect(sql).toBe(
        'SELECT COUNT(*) AS "_count", SUM("t0"."salary") AS "_sum_salary", AVG("t0"."age") AS "_avg_age", MIN("t0"."salary") AS "_min_salary", MAX("t0"."salary") AS "_max_salary" FROM "user" AS "t0"'
      );
    });

    test("GROUP BY: should generate complete SQL for complex scenario", () => {
      const result = QueryParser.parse(
        "groupBy",
        userModel,
        {
          by: ["department", "isActive"],
          _count: true,
          _sum: { salary: true },
          _avg: { age: true },
          where: { isActive: true },
          orderBy: { department: "asc" },
        },
        adapter
      );
      const sql = result.toStatement();

      expect(sql).toBe(
        'SELECT "t0"."department", "t0"."isActive", COUNT(*) AS "_count", SUM("t0"."salary") AS "_sum_salary", AVG("t0"."age") AS "_avg_age" FROM "user" AS "t0" WHERE "t0"."isActive" = ?1 GROUP BY "t0"."department", "t0"."isActive" ORDER BY "t0"."department" ASC'
      );
    });
  });
});
