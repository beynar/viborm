// Tests for PostgreSQL database adapter

import { PostgresAdapter } from "../../src/adapters/database/postgres/adapter.js";
import type {
  SelectOptions,
  InsertOptions,
  UpdateOptions,
  DeleteOptions,
} from "../../src/adapters/types.js";
import { StringField } from "../../src/schema/fields/string.js";
import { DateTimeField } from "../../src/schema/fields/datetime.js";
import { JsonField } from "../../src/schema/fields/json.js";
import { BooleanField } from "../../src/schema/fields/boolean.js";
import { BigIntField } from "../../src/schema/fields/bigint.js";

describe("PostgresAdapter", () => {
  let adapter: PostgresAdapter;

  beforeEach(() => {
    adapter = new PostgresAdapter();
  });

  test("dialect should be postgres", () => {
    expect(adapter.dialect).toBe("postgres");
  });

  describe("buildSelect", () => {
    test("builds simple SELECT query", () => {
      const options: SelectOptions = {
        table: "users",
      };

      const query = adapter.buildSelect(options);
      expect(query.text).toBe('SELECT * FROM "users"');
      expect(query.values).toEqual([]);
    });

    test("builds SELECT with specific fields", () => {
      const options: SelectOptions = {
        table: "users",
        fields: ["id", "name", "email"],
      };

      const query = adapter.buildSelect(options);
      expect(query.text).toBe('SELECT "id", "name", "email" FROM "users"');
      expect(query.values).toEqual([]);
    });

    test("builds SELECT with WHERE clause", () => {
      const options: SelectOptions = {
        table: "users",
        where: {
          field: "age",
          operator: "gt",
          value: 18,
        },
      };

      const query = adapter.buildSelect(options);
      expect(query.text).toBe('SELECT * FROM "users" WHERE "age" > $1');
      expect(query.values).toEqual([18]);
    });

    test("builds SELECT with ORDER BY", () => {
      const options: SelectOptions = {
        table: "users",
        orderBy: [
          { field: "name", direction: "asc" },
          { field: "created_at", direction: "desc" },
        ],
      };

      const query = adapter.buildSelect(options);
      expect(query.text).toBe(
        'SELECT * FROM "users" ORDER BY "name" ASC, "created_at" DESC'
      );
      expect(query.values).toEqual([]);
    });

    test("builds SELECT with LIMIT and OFFSET", () => {
      const options: SelectOptions = {
        table: "users",
        limit: 10,
        offset: 20,
      };

      const query = adapter.buildSelect(options);
      expect(query.text).toBe('SELECT * FROM "users" LIMIT $1 OFFSET $2');
      expect(query.values).toEqual([10, 20]);
    });

    test("builds complex SELECT query", () => {
      const options: SelectOptions = {
        table: "users",
        fields: ["id", "name"],
        where: {
          and: [
            { field: "age", operator: "gte", value: 18 },
            { field: "status", operator: "eq", value: "active" },
          ],
        },
        orderBy: [{ field: "name", direction: "asc" }],
        limit: 50,
      };

      const query = adapter.buildSelect(options);
      expect(query.text).toBe(
        'SELECT "id", "name" FROM "users" WHERE "age" >= $1 AND "status" = $2 ORDER BY "name" ASC LIMIT $3'
      );
      expect(query.values).toEqual([18, "active", 50]);
    });
  });

  describe("buildInsert", () => {
    test("builds single INSERT query", () => {
      const options: InsertOptions = {
        table: "users",
        data: {
          name: "John Doe",
          email: "john@example.com",
          age: 30,
        },
      };

      const query = adapter.buildInsert(options);
      expect(query.text).toBe(
        'INSERT INTO "users" ("name", "email", "age") VALUES ($1, $2, $3)'
      );
      expect(query.values).toEqual(["John Doe", "john@example.com", 30]);
    });

    test("builds INSERT with RETURNING", () => {
      const options: InsertOptions = {
        table: "users",
        data: { name: "John Doe" },
        returning: ["id", "created_at"],
      };

      const query = adapter.buildInsert(options);
      expect(query.text).toBe(
        'INSERT INTO "users" ("name") VALUES ($1) RETURNING "id", "created_at"'
      );
      expect(query.values).toEqual(["John Doe"]);
    });

    test("builds bulk INSERT query", () => {
      const options: InsertOptions = {
        table: "users",
        data: [
          { name: "John", age: 30 },
          { name: "Jane", age: 25 },
        ],
      };

      const query = adapter.buildInsert(options);
      expect(query.text).toBe(
        'INSERT INTO "users" ("name", "age") VALUES ($1, $2), ($3, $4)'
      );
      expect(query.values).toEqual(["John", 30, "Jane", 25]);
    });
  });

  describe("buildUpdate", () => {
    test("builds UPDATE query", () => {
      const options: UpdateOptions = {
        table: "users",
        data: { name: "Jane Doe", age: 31 },
        where: { field: "id", operator: "eq", value: 1 },
      };

      const query = adapter.buildUpdate(options);
      expect(query.text).toBe(
        'UPDATE "users" SET "name" = $1, "age" = $2 WHERE "id" = $3'
      );
      expect(query.values).toEqual(["Jane Doe", 31, 1]);
    });

    test("builds UPDATE with RETURNING", () => {
      const options: UpdateOptions = {
        table: "users",
        data: { name: "Jane Doe" },
        where: { field: "id", operator: "eq", value: 1 },
        returning: ["id", "updated_at"],
      };

      const query = adapter.buildUpdate(options);
      expect(query.text).toBe(
        'UPDATE "users" SET "name" = $1 WHERE "id" = $2 RETURNING "id", "updated_at"'
      );
      expect(query.values).toEqual(["Jane Doe", 1]);
    });
  });

  describe("buildDelete", () => {
    test("builds DELETE query", () => {
      const options: DeleteOptions = {
        table: "users",
        where: { field: "id", operator: "eq", value: 1 },
      };

      const query = adapter.buildDelete(options);
      expect(query.text).toBe('DELETE FROM "users" WHERE "id" = $1');
      expect(query.values).toEqual([1]);
    });

    test("builds DELETE with RETURNING", () => {
      const options: DeleteOptions = {
        table: "users",
        where: { field: "id", operator: "eq", value: 1 },
        returning: ["id"],
      };

      const query = adapter.buildDelete(options);
      expect(query.text).toBe(
        'DELETE FROM "users" WHERE "id" = $1 RETURNING "id"'
      );
      expect(query.values).toEqual([1]);
    });
  });

  describe("transformToDatabase", () => {
    test("transforms string values", () => {
      const field = new StringField();
      const result = adapter.transformToDatabase("hello", field);
      expect(result).toBe("hello");
    });

    test("transforms Date to ISO string for datetime", () => {
      const field = new DateTimeField();
      const date = new Date("2023-01-01T12:00:00Z");
      const result = adapter.transformToDatabase(date, field);
      expect(result).toBe("2023-01-01T12:00:00.000Z");
    });

    test("transforms objects to JSON string", () => {
      const field = new JsonField();
      const obj = { name: "test", value: 42 };
      const result = adapter.transformToDatabase(obj, field);
      expect(result).toBe('{"name":"test","value":42}');
    });

    test("transforms boolean values", () => {
      const field = new BooleanField();
      expect(adapter.transformToDatabase("true", field)).toBe(true);
      expect(adapter.transformToDatabase(0, field)).toBe(false);
    });

    test("transforms array fields", () => {
      const field = new StringField();
      // Simulate array field
      (field as any)["~isArray"] = true;

      const result = adapter.transformToDatabase(["a", "b", "c"], field);
      expect(result).toEqual(["a", "b", "c"]);
    });

    test("handles null values", () => {
      const field = new StringField();
      expect(adapter.transformToDatabase(null, field)).toBe(null);
      expect(adapter.transformToDatabase(undefined, field)).toBe(null);
    });
  });

  describe("transformFromDatabase", () => {
    test("transforms ISO string to Date for datetime", () => {
      const field = new DateTimeField();
      const result = adapter.transformFromDatabase(
        "2023-01-01T12:00:00.000Z",
        field
      );
      expect(result).toEqual(new Date("2023-01-01T12:00:00.000Z"));
    });

    test("transforms JSON string to object", () => {
      const field = new JsonField();
      const result = adapter.transformFromDatabase(
        '{"name":"test","value":42}',
        field
      );
      expect(result).toEqual({ name: "test", value: 42 });
    });

    test("transforms bigint strings", () => {
      const field = new BigIntField();
      const result = adapter.transformFromDatabase(
        "12345678901234567890",
        field
      );
      expect(result).toBe(BigInt("12345678901234567890"));
    });

    test("transforms array fields from database", () => {
      const field = new StringField();
      // Simulate array field
      (field as any)["~isArray"] = true;

      const result = adapter.transformFromDatabase(["a", "b", "c"], field);
      expect(result).toEqual(["a", "b", "c"]);
    });

    test("handles null values", () => {
      const field = new StringField();
      expect(adapter.transformFromDatabase(null, field)).toBe(null);
      expect(adapter.transformFromDatabase(undefined, field)).toBe(null);
    });
  });

  describe("escapeIdentifier", () => {
    test("escapes valid identifiers", () => {
      expect(adapter.escapeIdentifier("users")).toBe('"users"');
      expect(adapter.escapeIdentifier("user_name")).toBe('"user_name"');
      expect(adapter.escapeIdentifier("user123")).toBe('"user123"');
    });

    test("throws error for invalid identifiers", () => {
      expect(() => adapter.escapeIdentifier("123invalid")).toThrow(
        "Invalid PostgreSQL identifier: 123invalid"
      );
      expect(() => adapter.escapeIdentifier("user-name")).toThrow(
        "Invalid PostgreSQL identifier: user-name"
      );
      expect(() => adapter.escapeIdentifier("user name")).toThrow(
        "Invalid PostgreSQL identifier: user name"
      );
      expect(() => adapter.escapeIdentifier('user"name')).toThrow(
        'Invalid PostgreSQL identifier: user"name'
      );
    });
  });
});
