// Tests for PostgreSQL adapter with AST-based queries

import { PostgresAdapter } from "../../src/adapters/database/postgres/adapter.js";
import type {
  SelectAST,
  InsertAST,
  ColumnAST,
  LiteralAST,
  TableAST,
  BinaryOperationAST,
  ParameterAST,
} from "../../src/query/ast.js";

describe("PostgresAdapter - AST Translation", () => {
  let adapter: PostgresAdapter;

  beforeEach(() => {
    adapter = new PostgresAdapter();
  });

  test("dialect should be postgres", () => {
    expect(adapter.dialect).toBe("postgres");
  });

  describe("translateQuery", () => {
    test("translates simple SELECT AST", () => {
      const ast: SelectAST = {
        type: "SELECT",
        fields: [
          {
            type: "WILDCARD",
          },
        ],
        from: {
          type: "TABLE",
          name: "users",
        },
      };

      const result = adapter.translateQuery(ast);
      expect(result.text).toBe('SELECT * FROM "users"');
      expect(result.values).toEqual([]);
    });

    test("translates SELECT with WHERE clause", () => {
      const ast: SelectAST = {
        type: "SELECT",
        fields: [
          {
            type: "WILDCARD",
          },
        ],
        from: {
          type: "TABLE",
          name: "users",
        },
        where: {
          type: "BINARY_OPERATION",
          operator: "GT",
          left: {
            type: "COLUMN",
            name: "age",
          },
          right: {
            type: "PARAMETER",
            value: 18,
          },
        },
      };

      const result = adapter.translateQuery(ast);
      expect(result.text).toBe('SELECT * FROM "users" WHERE "age" > $1');
      expect(result.values).toEqual([18]);
    });

    test("translates SELECT with column selection and alias", () => {
      const ast: SelectAST = {
        type: "SELECT",
        fields: [
          {
            type: "COLUMN_SELECT",
            column: {
              type: "COLUMN",
              name: "name",
            },
          },
          {
            type: "COLUMN_SELECT",
            column: {
              type: "COLUMN",
              name: "email",
            },
            alias: "user_email",
          },
        ],
        from: {
          type: "TABLE",
          name: "users",
        },
      };

      const result = adapter.translateQuery(ast);
      expect(result.text).toBe(
        'SELECT "name", "email" AS "user_email" FROM "users"'
      );
      expect(result.values).toEqual([]);
    });

    test("translates SELECT with ORDER BY and LIMIT", () => {
      const ast: SelectAST = {
        type: "SELECT",
        fields: [
          {
            type: "WILDCARD",
          },
        ],
        from: {
          type: "TABLE",
          name: "users",
        },
        orderBy: [
          {
            type: "ORDER_BY",
            expression: {
              type: "COLUMN",
              name: "created_at",
            },
            direction: "DESC",
          },
        ],
        limit: {
          type: "LIMIT",
          count: {
            type: "LITERAL",
            value: 10,
            dataType: "NUMBER",
          },
        },
      };

      const result = adapter.translateQuery(ast);
      expect(result.text).toBe(
        'SELECT * FROM "users" ORDER BY "created_at" DESC LIMIT $1'
      );
      expect(result.values).toEqual([10]);
    });

    test("translates INSERT AST", () => {
      const ast: InsertAST = {
        type: "INSERT",
        table: {
          type: "TABLE",
          name: "users",
        },
        fields: [
          {
            type: "COLUMN",
            name: "name",
          },
          {
            type: "COLUMN",
            name: "email",
          },
        ],
        values: {
          type: "VALUES",
          rows: [
            [
              {
                type: "PARAMETER",
                value: "John Doe",
              },
              {
                type: "PARAMETER",
                value: "john@example.com",
              },
            ],
          ],
        },
      };

      const result = adapter.translateQuery(ast);
      expect(result.text).toBe(
        'INSERT INTO "users" ("name", "email") VALUES ($1, $2)'
      );
      expect(result.values).toEqual(["John Doe", "john@example.com"]);
    });

    test("translates complex WHERE clause with AND/OR", () => {
      const ast: SelectAST = {
        type: "SELECT",
        fields: [
          {
            type: "WILDCARD",
          },
        ],
        from: {
          type: "TABLE",
          name: "users",
        },
        where: {
          type: "BINARY_OPERATION",
          operator: "AND",
          left: {
            type: "BINARY_OPERATION",
            operator: "GT",
            left: {
              type: "COLUMN",
              name: "age",
            },
            right: {
              type: "PARAMETER",
              value: 18,
            },
          },
          right: {
            type: "BINARY_OPERATION",
            operator: "LIKE",
            left: {
              type: "COLUMN",
              name: "email",
            },
            right: {
              type: "PARAMETER",
              value: "%@gmail.com",
            },
          },
        },
      };

      const result = adapter.translateQuery(ast);
      expect(result.text).toBe(
        'SELECT * FROM "users" WHERE "age" > $1 AND "email" LIKE $2'
      );
      expect(result.values).toEqual([18, "%@gmail.com"]);
    });
  });

  describe("error handling", () => {
    test("throws error for unsupported query type", () => {
      const invalidAst = {
        type: "INVALID_QUERY",
        table: "users",
      } as any;

      expect(() => adapter.translateQuery(invalidAst)).toThrow(
        "Unsupported query type: INVALID_QUERY"
      );
    });

    test("throws error for unsupported expression type", () => {
      const ast: SelectAST = {
        type: "SELECT",
        fields: [
          {
            type: "WILDCARD",
          },
        ],
        from: {
          type: "TABLE",
          name: "users",
        },
        where: {
          type: "INVALID_EXPRESSION",
          value: "test",
        } as any,
      };

      expect(() => adapter.translateQuery(ast)).toThrow(
        "Unsupported expression type: INVALID_EXPRESSION"
      );
    });
  });
});
