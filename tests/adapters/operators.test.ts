import { describe, test, expect } from "vitest";
import { sql } from "@sql";
import { postgresAdapter } from "../../src/adapters/databases/postgres/postgres-adapter";
import { mysqlAdapter } from "../../src/adapters/databases/mysql/mysql-adapter";
import { BuilderContext } from "../../src/query-parser/types";

/**
 * Database Operators Test Suite
 *
 * Tests the comprehensive operators abstraction layer that provides
 * database-agnostic comparison, logical, pattern matching, range,
 * and existence operations.
 */

// Mock BuilderContext for testing
const mockContext: BuilderContext = {
  model: { name: "test", tableName: "test" } as any,
  baseOperation: "findMany" as any,
  alias: "t0",
};

describe("Database Operators - PostgreSQL", () => {
  const adapter = postgresAdapter;

  describe("Comparison Operators", () => {
    test("eq: should generate equality comparison", () => {
      const result = adapter.operators.eq(
        mockContext,
        sql`"t0"."name"`,
        sql`'John'`
      );
      expect(result.toStatement()).toBe('"t0"."name" = \'John\'');
    });

    test("neq: should generate not equals comparison", () => {
      const result = adapter.operators.neq(
        mockContext,
        sql`"t0"."age"`,
        sql`25`
      );
      expect(result.toStatement()).toBe('"t0"."age" != 25');
    });

    test("lt: should generate less than comparison", () => {
      const result = adapter.operators.lt(
        mockContext,
        sql`"t0"."age"`,
        sql`30`
      );
      expect(result.toStatement()).toBe('"t0"."age" < 30');
    });

    test("gte: should generate greater than or equal comparison", () => {
      const result = adapter.operators.gte(
        mockContext,
        sql`"t0"."price"`,
        sql`100.50`
      );
      expect(result.toStatement()).toBe('"t0"."price" >= 100.50');
    });
  });

  describe("Pattern Matching Operators", () => {
    test("like: should generate PostgreSQL LIKE", () => {
      const result = adapter.operators.like(
        mockContext,
        sql`"t0"."name"`,
        sql`'John%'`
      );
      expect(result.toStatement()).toBe('"t0"."name" LIKE \'John%\'');
    });

    test("ilike: should generate PostgreSQL ILIKE", () => {
      const result = adapter.operators.ilike(
        mockContext,
        sql`"t0"."name"`,
        sql`'john%'`
      );
      expect(result.toStatement()).toBe('"t0"."name" ILIKE \'john%\'');
    });

    test("notLike: should generate PostgreSQL NOT LIKE", () => {
      const result = adapter.operators.notLike(
        mockContext,
        sql`"t0"."name"`,
        sql`'%admin%'`
      );
      expect(result.toStatement()).toBe('"t0"."name" NOT LIKE \'%admin%\'');
    });

    test("notIlike: should generate PostgreSQL NOT ILIKE", () => {
      const result = adapter.operators.notIlike(
        mockContext,
        sql`"t0"."email"`,
        sql`'%test%'`
      );
      expect(result.toStatement()).toBe('"t0"."email" NOT ILIKE \'%test%\'');
    });
  });

  describe("Range Operators", () => {
    test("between: should generate BETWEEN clause", () => {
      const result = adapter.operators.between(
        mockContext,
        sql`"t0"."age"`,
        sql`18`,
        sql`65`
      );
      expect(result.toStatement()).toBe('"t0"."age" BETWEEN 18 AND 65');
    });

    test("notBetween: should generate NOT BETWEEN clause", () => {
      const result = adapter.operators.notBetween(
        mockContext,
        sql`"t0"."salary"`,
        sql`50000`,
        sql`100000`
      );
      expect(result.toStatement()).toBe(
        '"t0"."salary" NOT BETWEEN 50000 AND 100000'
      );
    });
  });

  describe("Regular Expression Operators", () => {
    test("regexp: should generate PostgreSQL regex match", () => {
      const result = adapter.operators.regexp(
        mockContext,
        sql`"t0"."email"`,
        sql`'^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$'`
      );
      expect(result.toStatement()).toBe(
        '"t0"."email" ~ \'^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+.[a-zA-Z]{2,}$\''
      );
    });

    test("notRegexp: should generate PostgreSQL regex not match", () => {
      const result = adapter.operators.notRegexp(
        mockContext,
        sql`"t0"."username"`,
        sql`'[0-9]+'`
      );
      expect(result.toStatement()).toBe('"t0"."username" !~ \'[0-9]+\'');
    });
  });

  describe("Set Membership Operators", () => {
    test("in: should generate PostgreSQL ANY syntax", () => {
      const result = adapter.operators.in(
        mockContext,
        sql`"t0"."status"`,
        sql`ARRAY['active', 'pending']`
      );
      expect(result.toStatement()).toBe(
        "\"t0\".\"status\" = ANY(ARRAY['active', 'pending'])"
      );
    });

    test("notIn: should generate PostgreSQL ALL syntax", () => {
      const result = adapter.operators.notIn(
        mockContext,
        sql`"t0"."role"`,
        sql`ARRAY['admin', 'super']`
      );
      expect(result.toStatement()).toBe(
        "\"t0\".\"role\" != ALL(ARRAY['admin', 'super'])"
      );
    });
  });

  describe("Existence Operators", () => {
    test("exists: should generate EXISTS clause", () => {
      const subquery = sql`SELECT 1 FROM "posts" WHERE "posts"."user_id" = "t0"."id"`;
      const result = adapter.operators.exists(mockContext, subquery);
      expect(result.toStatement()).toBe(
        'EXISTS (SELECT 1 FROM "posts" WHERE "posts"."user_id" = "t0"."id")'
      );
    });

    test("notExists: should generate NOT EXISTS clause", () => {
      const subquery = sql`SELECT 1 FROM "orders" WHERE "orders"."user_id" = "t0"."id"`;
      const result = adapter.operators.notExists(mockContext, subquery);
      expect(result.toStatement()).toBe(
        'NOT EXISTS (SELECT 1 FROM "orders" WHERE "orders"."user_id" = "t0"."id")'
      );
    });
  });

  describe("Logical Operators", () => {
    test("and: should combine conditions with AND", () => {
      const result = adapter.operators.and(
        mockContext,
        sql`"t0"."active" = true`,
        sql`"t0"."age" >= 18`,
        sql`"t0"."verified" = true`
      );
      expect(result.toStatement()).toBe(
        '("t0"."active" = true AND "t0"."age" >= 18 AND "t0"."verified" = true)'
      );
    });

    test("or: should combine conditions with OR", () => {
      const result = adapter.operators.or(
        mockContext,
        sql`"t0"."role" = 'admin'`,
        sql`"t0"."role" = 'moderator'`
      );
      expect(result.toStatement()).toBe(
        '("t0"."role" = \'admin\' OR "t0"."role" = \'moderator\')'
      );
    });

    test("not: should negate condition", () => {
      const result = adapter.operators.not(
        mockContext,
        sql`"t0"."deleted" = true`
      );
      expect(result.toStatement()).toBe('NOT ("t0"."deleted" = true)');
    });
  });

  describe("Null Operators", () => {
    test("isNull: should generate IS NULL check", () => {
      const result = adapter.operators.isNull(
        mockContext,
        sql`"t0"."deleted_at"`
      );
      expect(result.toStatement()).toBe('"t0"."deleted_at" IS NULL');
    });

    test("isNotNull: should generate IS NOT NULL check", () => {
      const result = adapter.operators.isNotNull(
        mockContext,
        sql`"t0"."email"`
      );
      expect(result.toStatement()).toBe('"t0"."email" IS NOT NULL');
    });
  });

  describe("Utility Functions", () => {
    test("caseInsensitive: should generate UPPER() wrapper", () => {
      const column = sql`name`;
      const result = adapter.utils.caseInsensitive(mockContext, column);
      expect(result.toStatement()).toBe("UPPER(name)");
    });
  });
});

describe("Database Operators - MySQL", () => {
  const adapter = mysqlAdapter;

  describe("Comparison Operators", () => {
    test("eq: should generate equality comparison", () => {
      const result = adapter.operators.eq(
        mockContext,
        sql`\`t0\`.\`name\``,
        sql`'John'`
      );
      expect(result.toStatement()).toBe("`t0`.`name` = 'John'");
    });
  });

  describe("Pattern Matching Operators", () => {
    test("like: should generate MySQL LIKE", () => {
      const result = adapter.operators.like(
        mockContext,
        sql`\`t0\`.\`name\``,
        sql`'John%'`
      );
      expect(result.toStatement()).toBe("`t0`.`name` LIKE 'John%'");
    });

    test("ilike: should generate MySQL case-insensitive LIKE", () => {
      const result = adapter.operators.ilike(
        mockContext,
        sql`\`t0\`.\`name\``,
        sql`'john%'`
      );
      expect(result.toStatement()).toBe(
        "`t0`.`name` LIKE 'john%' COLLATE utf8mb4_unicode_ci"
      );
    });
  });

  describe("Range Operators", () => {
    test("between: should generate BETWEEN clause", () => {
      const result = adapter.operators.between(
        mockContext,
        sql`\`t0\`.\`age\``,
        sql`18`,
        sql`65`
      );
      expect(result.toStatement()).toBe("`t0`.`age` BETWEEN 18 AND 65");
    });
  });

  describe("Regular Expression Operators", () => {
    test("regexp: should generate MySQL REGEXP", () => {
      const result = adapter.operators.regexp(
        mockContext,
        sql`\`t0\`.\`email\``,
        sql`'^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\\.[a-zA-Z]{2,}$'`
      );
      expect(result.toStatement()).toBe(
        "`t0`.`email` REGEXP '^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\\.[a-zA-Z]{2,}$'"
      );
    });
  });

  describe("Set Membership Operators", () => {
    test("in: should generate MySQL IN syntax", () => {
      const result = adapter.operators.in(
        mockContext,
        sql`\`t0\`.\`status\``,
        sql`'active', 'pending'`
      );
      expect(result.toStatement()).toBe(
        "`t0`.`status` IN ('active', 'pending')"
      );
    });

    test("notIn: should generate MySQL NOT IN syntax", () => {
      const result = adapter.operators.notIn(
        mockContext,
        sql`\`t0\`.\`role\``,
        sql`'admin', 'super'`
      );
      expect(result.toStatement()).toBe(
        "`t0`.`role` NOT IN ('admin', 'super')"
      );
    });
  });

  describe("Existence Operators", () => {
    test("exists: should generate EXISTS clause", () => {
      const subquery = sql`SELECT 1 FROM \`posts\` WHERE \`posts\`.\`user_id\` = \`t0\`.\`id\``;
      const result = adapter.operators.exists(mockContext, subquery);
      expect(result.toStatement()).toBe(
        "EXISTS (SELECT 1 FROM `posts` WHERE `posts`.`user_id` = `t0`.`id`)"
      );
    });
  });
});

describe("Database Operators - Edge Cases", () => {
  const adapter = postgresAdapter;

  test("and: should handle empty conditions", () => {
    const result = adapter.operators.and(mockContext);
    expect(result.toStatement()).toBe("");
  });

  test("and: should handle single condition", () => {
    const result = adapter.operators.and(
      mockContext,
      sql`"t0"."active" = true`
    );
    expect(result.toStatement()).toBe('"t0"."active" = true');
  });

  test("or: should handle single condition", () => {
    const result = adapter.operators.or(
      mockContext,
      sql`"t0"."status" = 'pending'`
    );
    expect(result.toStatement()).toBe('"t0"."status" = \'pending\'');
  });

  test("between: should handle date ranges", () => {
    const result = adapter.operators.between(
      mockContext,
      sql`"t0"."created_at"`,
      sql`'2024-01-01'`,
      sql`'2024-12-31'`
    );
    expect(result.toStatement()).toBe(
      "\"t0\".\"created_at\" BETWEEN '2024-01-01' AND '2024-12-31'"
    );
  });

  test("like: should handle escaped patterns", () => {
    const result = adapter.operators.like(
      mockContext,
      sql`"t0"."description"`,
      sql`'50\\% off'`
    );
    expect(result.toStatement()).toBe('"t0"."description" LIKE \'50\\% off\'');
  });
});

describe("Database Operators - Complex Combinations", () => {
  const adapter = postgresAdapter;

  test("should combine multiple operator types", () => {
    const nameCondition = adapter.operators.ilike(
      mockContext,
      sql`"t0"."name"`,
      sql`'john%'`
    );
    const ageCondition = adapter.operators.between(
      mockContext,
      sql`"t0"."age"`,
      sql`18`,
      sql`65`
    );
    const statusCondition = adapter.operators.in(
      mockContext,
      sql`"t0"."status"`,
      sql`ARRAY['active', 'verified']`
    );

    const result = adapter.operators.and(
      mockContext,
      nameCondition,
      ageCondition,
      statusCondition
    );

    expect(result.toStatement()).toBe(
      '("t0"."name" ILIKE \'john%\' AND "t0"."age" BETWEEN 18 AND 65 AND "t0"."status" = ANY(ARRAY[\'active\', \'verified\']))'
    );
  });

  test("should handle nested logical operations", () => {
    const condition1 = adapter.operators.eq(
      mockContext,
      sql`"t0"."role"`,
      sql`'admin'`
    );
    const condition2 = adapter.operators.eq(
      mockContext,
      sql`"t0"."role"`,
      sql`'moderator'`
    );
    const condition3 = adapter.operators.eq(
      mockContext,
      sql`"t0"."active"`,
      sql`true`
    );

    const orCondition = adapter.operators.or(
      mockContext,
      condition1,
      condition2
    );
    const result = adapter.operators.and(mockContext, orCondition, condition3);

    expect(result.toStatement()).toBe(
      '(("t0"."role" = \'admin\' OR "t0"."role" = \'moderator\') AND "t0"."active" = true)'
    );
  });
});
