import { describe, test, expect } from "vitest";
import { s } from "../../src/schema";
import {
  DefaultSchemaRegistry,
  QueryAST,
  ConditionAST,
} from "../../src/query/ast";
import { createQueryParser } from "../../src/query/parser";

describe("Query Parser", () => {
  // Create test models
  const userModel = s.model("User", {
    id: s.string().id(),
    name: s.string(),
    email: s.string().unique(),
    age: s.int().nullable(),
    posts: s.relation.oneToMany(() => postModel),
  });

  const postModel = s.model("Post", {
    id: s.string().id(),
    title: s.string(),
    content: s.string().nullable(),
    authorId: s.string(),
    author: s.relation.manyToOne(() => userModel),
  });

  // Setup registry
  const registry = new DefaultSchemaRegistry();
  registry.registerModel(userModel);
  registry.registerModel(postModel);

  const parser = createQueryParser(registry);

  describe("Basic WHERE clause parsing", () => {
    test("should parse simple equality filter", () => {
      const ast = parser.parse("User", "findMany", {
        where: { name: "John" },
      } as any);

      const expected: Partial<QueryAST> = {
        type: "QUERY",
        operation: "findMany",
        model: {
          name: "User",
          model: userModel,
        },
        args: {
          type: "QUERY_ARGS",
          where: [
            {
              type: "CONDITION",
              target: {
                type: "FIELD",
                field: {
                  name: "name",
                  field: userModel.fields.get("name")!,
                  model: userModel,
                },
              },
              operator: "equals",
              value: {
                type: "VALUE",
                value: "John",
                valueType: "string",
              },
            },
          ],
        },
      };

      expect(ast).toMatchObject(expected);
    });

    test("should parse filter object with multiple operators", () => {
      const ast = parser.parse("User", "findMany", {
        where: {
          age: { gte: 18, lt: 65 },
        },
      } as any);

      const expected: Partial<QueryAST> = {
        type: "QUERY",
        operation: "findMany",
        model: {
          name: "User",
          model: userModel,
        },
        args: {
          type: "QUERY_ARGS",
          where: [
            {
              type: "CONDITION",
              target: {
                type: "LOGICAL",
                operator: "AND",
              },
              operator: "equals",
              logic: "AND",
              nested: [
                {
                  type: "CONDITION",
                  target: {
                    type: "FIELD",
                    field: {
                      name: "age",
                      field: userModel.fields.get("age")!,
                      model: userModel,
                    },
                  },
                  operator: "gte",
                  value: {
                    type: "VALUE",
                    value: 18,
                    valueType: "int",
                  },
                },
                {
                  type: "CONDITION",
                  target: {
                    type: "FIELD",
                    field: {
                      name: "age",
                      field: userModel.fields.get("age")!,
                      model: userModel,
                    },
                  },
                  operator: "lt",
                  value: {
                    type: "VALUE",
                    value: 65,
                    valueType: "int",
                  },
                },
              ],
            },
          ],
        },
      };

      expect(ast).toMatchObject(expected);
    });

    test("should parse logical AND operator", () => {
      const ast = parser.parse("User", "findMany", {
        where: {
          AND: [{ name: "John" }, { age: { gte: 18 } }],
        },
      } as any);

      const expected: Partial<QueryAST> = {
        type: "QUERY",
        operation: "findMany",
        model: {
          name: "User",
          model: userModel,
        },
        args: {
          type: "QUERY_ARGS",
          where: [
            {
              type: "CONDITION",
              target: {
                type: "LOGICAL",
                operator: "AND",
              },
              operator: "equals",
              logic: "AND",
              nested: [
                {
                  type: "CONDITION",
                  target: {
                    type: "FIELD",
                    field: {
                      name: "name",
                      field: userModel.fields.get("name")!,
                      model: userModel,
                    },
                  },
                  operator: "equals",
                  value: {
                    type: "VALUE",
                    value: "John",
                    valueType: "string",
                  },
                },
                {
                  type: "CONDITION",
                  target: {
                    type: "FIELD",
                    field: {
                      name: "age",
                      field: userModel.fields.get("age")!,
                      model: userModel,
                    },
                  },
                  operator: "gte",
                  value: {
                    type: "VALUE",
                    value: 18,
                    valueType: "int",
                  },
                },
              ],
            },
          ],
        },
      };

      expect(ast).toMatchObject(expected);
    });

    test("should parse logical OR operator", () => {
      const ast = parser.parse("User", "findMany", {
        where: {
          OR: [{ name: "John" }, { name: "Jane" }],
        },
      } as any);

      const expected: Partial<QueryAST> = {
        type: "QUERY",
        operation: "findMany",
        args: {
          type: "QUERY_ARGS",
          where: [
            {
              type: "CONDITION",
              target: {
                type: "LOGICAL",
                operator: "OR",
              },
              operator: "equals",
              logic: "OR",
              nested: [
                {
                  type: "CONDITION",
                  target: {
                    type: "FIELD",
                    field: {
                      name: "name",
                      field: userModel.fields.get("name")!,
                      model: userModel,
                    },
                  },
                  operator: "equals",
                  value: {
                    type: "VALUE",
                    value: "John",
                    valueType: "string",
                  },
                },
                {
                  type: "CONDITION",
                  target: {
                    type: "FIELD",
                    field: {
                      name: "name",
                      field: userModel.fields.get("name")!,
                      model: userModel,
                    },
                  },
                  operator: "equals",
                  value: {
                    type: "VALUE",
                    value: "Jane",
                    valueType: "string",
                  },
                },
              ],
            },
          ],
        },
      };

      expect(ast).toMatchObject(expected);
    });

    test("should parse logical NOT operator", () => {
      const ast = parser.parse("User", "findMany", {
        where: {
          NOT: { name: "John" },
        },
      } as any);

      const expected: Partial<QueryAST> = {
        type: "QUERY",
        operation: "findMany",
        args: {
          type: "QUERY_ARGS",
          where: [
            {
              type: "CONDITION",
              target: {
                type: "LOGICAL",
                operator: "NOT",
              },
              operator: "equals",
              logic: "AND",
              negated: true,
              nested: [
                {
                  type: "CONDITION",
                  target: {
                    type: "FIELD",
                    field: {
                      name: "name",
                      field: userModel.fields.get("name")!,
                      model: userModel,
                    },
                  },
                  operator: "equals",
                  value: {
                    type: "VALUE",
                    value: "John",
                    valueType: "string",
                  },
                },
              ],
            },
          ],
        },
      };

      expect(ast).toMatchObject(expected);
    });

    test("should handle relation filters", () => {
      const ast = parser.parse("User", "findMany", {
        where: {
          posts: {
            some: {
              title: { contains: "TypeScript" },
            },
          },
        },
      } as any);

      const expected: Partial<QueryAST> = {
        type: "QUERY",
        operation: "findMany",
        args: {
          type: "QUERY_ARGS",
          where: [
            {
              type: "CONDITION",
              target: {
                type: "RELATION",
                relation: {
                  name: "posts",
                  relation: userModel.relations.get("posts")!,
                  sourceModel: userModel,
                  targetModel: postModel,
                },
                operation: "some",
              },
              operator: "equals",
              nested: [
                {
                  type: "CONDITION",
                  target: {
                    type: "FIELD",
                    field: {
                      name: "title",
                      field: postModel.fields.get("title")!,
                      model: postModel,
                    },
                  },
                  operator: "contains",
                  value: {
                    type: "VALUE",
                    value: "TypeScript",
                    valueType: "string",
                  },
                },
              ],
            },
          ],
        },
      };

      expect(ast).toMatchObject(expected);
    });

    test("should parse string filter operators", () => {
      const ast = parser.parse("User", "findMany", {
        where: {
          name: { startsWith: "Jo", endsWith: "hn" },
        },
      } as any);

      const condition = ast.args.where![0]! as ConditionAST;
      expect(condition.target.type).toBe("LOGICAL");
      expect(condition.nested).toHaveLength(2);

      const startsWithCondition = condition.nested![0]!;
      expect(startsWithCondition.operator).toBe("startsWith");
      expect(startsWithCondition.value).toMatchObject({
        type: "VALUE",
        value: "Jo",
        valueType: "string",
      });

      const endsWithCondition = condition.nested![1]!;
      expect(endsWithCondition.operator).toBe("endsWith");
      expect(endsWithCondition.value).toMatchObject({
        type: "VALUE",
        value: "hn",
        valueType: "string",
      });
    });

    test("should parse array filter operators", () => {
      const ast = parser.parse("User", "findMany", {
        where: {
          name: { in: ["John", "Jane", "Bob"] },
        },
      } as any);

      const expected: Partial<QueryAST> = {
        args: {
          type: "QUERY_ARGS",
          where: [
            {
              type: "CONDITION",
              target: {
                type: "FIELD",
                field: {
                  name: "name",
                  field: userModel.fields.get("name")!,
                  model: userModel,
                },
              },
              operator: "in",
              value: [
                {
                  type: "VALUE",
                  value: "John",
                  valueType: "string",
                },
                {
                  type: "VALUE",
                  value: "Jane",
                  valueType: "string",
                },
                {
                  type: "VALUE",
                  value: "Bob",
                  valueType: "string",
                },
              ],
            },
          ],
        },
      };

      expect(ast).toMatchObject(expected);
    });
  });

  describe("Pagination and limits", () => {
    test("should parse skip and take", () => {
      const ast = parser.parse("User", "findMany", {
        skip: 20,
        take: 10,
        where: { name: "John" },
      } as any);

      const expected: Partial<QueryAST> = {
        args: {
          type: "QUERY_ARGS",
          skip: 20,
          take: 10,
          where: [
            {
              type: "CONDITION",
              target: {
                type: "FIELD",
                field: {
                  name: "name",
                  field: userModel.fields.get("name")!,
                  model: userModel,
                },
              },
              operator: "equals",
              value: {
                type: "VALUE",
                value: "John",
                valueType: "string",
              },
            },
          ],
        },
      };

      expect(ast).toMatchObject(expected);
    });
  });

  describe("Error handling", () => {
    test("should throw error for unknown field", () => {
      expect(() => {
        parser.parse("User", "findMany", {
          where: { nonExistentField: "value" },
        } as any);
      }).toThrow("Unknown field or relation 'nonExistentField'");
    });

    test("should throw error for unknown model", () => {
      expect(() => {
        parser.parse("NonExistentModel", "findMany", {} as any);
      }).toThrow("Model 'NonExistentModel' not found");
    });

    test("should throw error for invalid relation filter", () => {
      expect(() => {
        parser.parse("User", "findMany", {
          where: {
            posts: "invalid",
          },
        } as any);
      }).toThrow("Invalid relation filter for 'posts'");
    });

    test("should throw error for unknown filter operator", () => {
      expect(() => {
        parser.parse("User", "findMany", {
          where: {
            name: {
              equals: "John", // Known operator
              unknownOperator: "value", // Unknown operator
            },
          },
        } as any);
      }).toThrow("Unknown filter operator 'unknownOperator'");
    });
  });
});
