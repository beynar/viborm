import { describe, test, expect } from "vitest";
import { s } from "../../src/schema";
import {
  DefaultSchemaRegistry,
  QueryAST,
  ConditionAST,
} from "../../src/query/ast";
import { createQueryParser } from "../../src/query/parser";

describe("Query Parser Integration", () => {
  // Setup comprehensive test schema
  const userModel = s.model("User", {
    id: s.string().id(),
    name: s.string(),
    email: s.string().unique(),
    age: s.int().nullable(),
    isActive: s.boolean().default(true),
    createdAt: s.dateTime(),
    profile: s.relation.oneToOne(() => profileModel),
    posts: s.relation.oneToMany(() => postModel),
    friends: s.relation.manyToMany(() => userModel),
  });

  const profileModel = s.model("Profile", {
    id: s.string().id(),
    bio: s.string().nullable(),
    avatar: s.string().nullable(),
    userId: s.string(),
    user: s.relation.manyToOne(() => userModel),
  });

  const postModel = s.model("Post", {
    id: s.string().id(),
    title: s.string(),
    content: s.string().nullable(),
    published: s.boolean().default(false),
    authorId: s.string(),
    author: s.relation.manyToOne(() => userModel),
    tags: s.relation.manyToMany(() => tagModel),
  });

  const tagModel = s.model("Tag", {
    id: s.string().id(),
    name: s.string().unique(),
    posts: s.relation.manyToMany(() => postModel),
  });

  // Setup registry
  const registry = new DefaultSchemaRegistry();
  registry.registerModel(userModel);
  registry.registerModel(profileModel);
  registry.registerModel(postModel);
  registry.registerModel(tagModel);

  const parser = createQueryParser(registry);

  describe("Complex WHERE clauses", () => {
    test("should parse complex nested conditions", () => {
      const ast = parser.parse("User", "findMany", {
        where: {
          age: { gte: 18, lt: 65 },
          isActive: true,
          OR: [
            { name: { contains: "John" } },
            { email: { endsWith: "@company.com" } },
          ],
        },
      } as any);

      expect(ast.operation).toBe("findMany");
      expect(ast.model.name).toBe("User");
      expect(ast.args.where).toBeDefined();
      expect(ast.args.where?.length).toBe(3); // age, isActive, OR

      // Verify age condition
      const ageCondition = ast.args.where!.find(
        (condition) =>
          condition.target.type === "LOGICAL" &&
          condition.nested?.some(
            (nested) =>
              nested.target.type === "FIELD" &&
              nested.target.field.name === "age" &&
              nested.operator === "gte"
          )
      );
      expect(ageCondition).toBeDefined();
      expect(ageCondition?.nested).toHaveLength(2); // gte and lt

      // Verify isActive condition
      const isActiveCondition = ast.args.where!.find(
        (condition) =>
          condition.target.type === "FIELD" &&
          condition.target.field.name === "isActive"
      );
      expect(isActiveCondition).toMatchObject({
        type: "CONDITION",
        target: {
          type: "FIELD",
          field: {
            name: "isActive",
            field: userModel.fields.get("isActive")!,
            model: userModel,
          },
        },
        operator: "equals",
        value: {
          type: "VALUE",
          value: true,
          valueType: "boolean",
        },
      });

      // Verify OR condition
      const orCondition = ast.args.where!.find(
        (condition) =>
          condition.target.type === "LOGICAL" &&
          condition.target.operator === "OR"
      );
      expect(orCondition).toBeDefined();
      expect(orCondition?.logic).toBe("OR");
      expect(orCondition?.nested).toHaveLength(2);

      // Check OR nested conditions
      const nameContains = orCondition?.nested![0];
      expect(nameContains).toMatchObject({
        type: "CONDITION",
        target: {
          type: "FIELD",
          field: {
            name: "name",
            field: userModel.fields.get("name")!,
            model: userModel,
          },
        },
        operator: "contains",
        value: {
          type: "VALUE",
          value: "John",
          valueType: "string",
        },
      });

      const emailEndsWith = orCondition?.nested![1];
      expect(emailEndsWith).toMatchObject({
        type: "CONDITION",
        target: {
          type: "FIELD",
          field: {
            name: "email",
            field: userModel.fields.get("email")!,
            model: userModel,
          },
        },
        operator: "endsWith",
        value: {
          type: "VALUE",
          value: "@company.com",
          valueType: "string",
        },
      });
    });

    test("should parse relation filters correctly", () => {
      const ast = parser.parse("User", "findMany", {
        where: {
          posts: {
            some: {
              published: true,
              title: { contains: "TypeScript" },
            },
          },
        },
      } as any);

      expect(ast.args.where).toBeDefined();
      expect(ast.args.where?.length).toBe(1);

      const condition = ast.args.where![0]!;
      expect(condition).toMatchObject({
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
                name: "published",
                field: postModel.fields.get("published")!,
                model: postModel,
              },
            },
            operator: "equals",
            value: {
              type: "VALUE",
              value: true,
              valueType: "boolean",
            },
          },
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
      });
    });

    test("should parse deeply nested relation filters", () => {
      const ast = parser.parse("User", "findMany", {
        where: {
          posts: {
            some: {
              tags: {
                some: {
                  name: { in: ["typescript", "javascript"] },
                },
              },
            },
          },
        },
      } as any);

      expect(ast.args.where).toBeDefined();
      const condition = ast.args.where![0]!;
      expect(condition.target.type).toBe("RELATION");

      // Verify the nested structure
      const postsCondition = condition;
      expect(postsCondition.target).toMatchObject({
        type: "RELATION",
        relation: {
          name: "posts",
        },
        operation: "some",
      });

      expect(postsCondition.nested).toHaveLength(1);
      const tagsCondition = postsCondition.nested![0]!;
      expect(tagsCondition.target).toMatchObject({
        type: "RELATION",
        relation: {
          name: "tags",
        },
        operation: "some",
      });

      expect(tagsCondition.nested).toHaveLength(1);
      const nameCondition = tagsCondition.nested![0]!;
      expect(nameCondition).toMatchObject({
        type: "CONDITION",
        target: {
          type: "FIELD",
          field: {
            name: "name",
            field: tagModel.fields.get("name")!,
            model: tagModel,
          },
        },
        operator: "in",
        value: [
          {
            type: "VALUE",
            value: "typescript",
            valueType: "string",
          },
          {
            type: "VALUE",
            value: "javascript",
            valueType: "string",
          },
        ],
      });
    });
  });

  describe("SELECT and INCLUDE clauses", () => {
    test("should parse select fields", () => {
      const ast = parser.parse("User", "findMany", {
        select: {
          id: true,
          name: true,
          email: true,
        },
      } as any);

      expect(ast.args.select).toBeDefined();
      expect(Array.isArray(ast.args.select)).toBe(true);

      if (Array.isArray(ast.args.select)) {
        expect(ast.args.select.length).toBe(3);
        const selectFields = ast.args.select.map((s) => s.field.name);
        expect(selectFields).toContain("id");
        expect(selectFields).toContain("name");
        expect(selectFields).toContain("email");
      }
    });

    test("should parse include with nested relations", () => {
      const ast = parser.parse("User", "findMany", {
        include: {
          profile: true,
          posts: {
            include: {
              tags: true,
            },
          },
        },
      } as any);

      expect(ast.args.include).toBeDefined();
      expect(Array.isArray(ast.args.include)).toBe(true);

      if (Array.isArray(ast.args.include)) {
        expect(ast.args.include.length).toBe(2);

        // Check profile inclusion
        const profileInclude = ast.args.include.find(
          (inc) => inc.relation.name === "profile"
        );
        expect(profileInclude).toBeDefined();

        // Check posts inclusion with nested tags
        const postsInclude = ast.args.include.find(
          (inc) => inc.relation.name === "posts"
        );
        expect(postsInclude).toBeDefined();
        expect(postsInclude?.nested).toBeDefined();
      }
    });
  });

  describe("ORDER BY clauses", () => {
    test("should parse orderBy fields", () => {
      const ast = parser.parse("User", "findMany", {
        orderBy: [{ name: "asc" }, { createdAt: "desc" }],
      } as any);

      expect(ast.args.orderBy).toBeDefined();
      expect(ast.args.orderBy?.length).toBe(2);

      const nameOrder = ast.args.orderBy![0]!;
      expect(nameOrder.target.type).toBe("FIELD");
      expect(nameOrder.direction).toBe("asc");

      const createdAtOrder = ast.args.orderBy![1]!;
      expect(createdAtOrder.target.type).toBe("FIELD");
      expect(createdAtOrder.direction).toBe("desc");
    });
  });

  describe("CREATE operations", () => {
    test("should parse create data", () => {
      const ast = parser.parse("User", "create", {
        data: {
          name: "John Doe",
          email: "john@example.com",
          age: 30,
          profile: {
            create: {
              bio: "Software developer",
              avatar: "avatar.jpg",
            },
          },
        },
      } as any);

      expect(ast.operation).toBe("create");
      expect(ast.args.data).toBeDefined();
      expect(ast.args.data?.length).toBeGreaterThan(0);

      // Should have field data operations
      const nameData = ast.args.data!.find((d) =>
        d.fields?.some(
          (f) => f.target?.type === "FIELD" && f.target?.field?.name === "name"
        )
      );
      expect(nameData).toBeDefined();
      if (nameData) {
        const nameField = nameData.fields.find(
          (f) => f.target?.type === "FIELD" && f.target?.field?.name === "name"
        );
        expect(nameField?.operation).toBe("set");
      }
    });
  });

  describe("UPDATE operations", () => {
    test("should parse update data with where clause", () => {
      const ast = parser.parse("User", "update", {
        where: { id: "user123" },
        data: {
          name: "Updated Name",
          age: { increment: 1 },
          posts: {
            create: {
              title: "New Post",
              content: "Post content",
            },
          },
        },
      } as any);

      expect(ast.operation).toBe("update");
      expect(ast.args.where).toBeDefined();
      expect(ast.args.data).toBeDefined();

      // Check increment operation
      const ageData = ast.args.data!.find((d) =>
        d.fields?.some(
          (f) => f.target?.type === "FIELD" && f.target?.field?.name === "age"
        )
      );
      expect(ageData).toBeDefined();
      if (ageData) {
        const ageField = ageData.fields.find(
          (f) => f.target?.type === "FIELD" && f.target?.field?.name === "age"
        );
        expect(ageField?.operation).toBe("increment");
      }
    });
  });

  describe("DELETE operations", () => {
    test("should parse delete with where clause", () => {
      const ast = parser.parse("User", "delete", {
        where: { id: "user123" },
      } as any);

      expect(ast.operation).toBe("delete");
      expect(ast.args.where).toBeDefined();
      expect(ast.args.data).toBeUndefined();
      expect(ast.args.select).toBeUndefined();
      expect(ast.args.include).toBeUndefined();
    });
  });

  describe("Pagination and limits", () => {
    test("should parse skip and take correctly", () => {
      const ast = parser.parse("User", "findMany", {
        skip: 20,
        take: 10,
        where: { isActive: true },
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
          skip: 20,
          take: 10,
          where: [
            {
              type: "CONDITION",
              target: {
                type: "FIELD",
                field: {
                  name: "isActive",
                  field: userModel.fields.get("isActive")!,
                  model: userModel,
                },
              },
              operator: "equals",
              value: {
                type: "VALUE",
                value: true,
                valueType: "boolean",
              },
            },
          ],
        },
      };

      expect(ast).toMatchObject(expected);
    });
  });

  describe("Data type inference", () => {
    test("should correctly infer value types from JavaScript values", () => {
      const ast = parser.parse("User", "findMany", {
        where: {
          name: "John",
          age: 25,
          isActive: true,
          createdAt: new Date("2023-01-01"),
        },
      } as any);

      expect(ast.args.where).toHaveLength(4);

      // Check string type
      const nameCondition = ast.args.where!.find(
        (c) => c.target.type === "FIELD" && c.target.field.name === "name"
      );
      expect(nameCondition?.value).toMatchObject({
        type: "VALUE",
        value: "John",
        valueType: "string",
      });

      // Check number type
      const ageCondition = ast.args.where!.find(
        (c) => c.target.type === "FIELD" && c.target.field.name === "age"
      );
      expect(ageCondition?.value).toMatchObject({
        type: "VALUE",
        value: 25,
        valueType: "int",
      });

      // Check boolean type
      const isActiveCondition = ast.args.where!.find(
        (c) => c.target.type === "FIELD" && c.target.field.name === "isActive"
      );
      expect(isActiveCondition?.value).toMatchObject({
        type: "VALUE",
        value: true,
        valueType: "boolean",
      });

      // Check date type
      const createdAtCondition = ast.args.where!.find(
        (c) => c.target.type === "FIELD" && c.target.field.name === "createdAt"
      );
      expect(createdAtCondition?.value).toMatchObject({
        type: "VALUE",
        value: expect.any(Date),
        valueType: "dateTime",
      });
    });

    test("should handle array values correctly", () => {
      const ast = parser.parse("User", "findMany", {
        where: {
          name: { in: ["Alice", "Bob", "Charlie"] },
          age: { notIn: [18, 21, 25] },
        },
      } as any);

      expect(ast.args.where).toHaveLength(2);

      // Check string array
      const nameCondition = ast.args.where!.find(
        (c) =>
          c.target.type === "FIELD" &&
          c.target.field.name === "name" &&
          c.operator === "in"
      );
      expect(Array.isArray(nameCondition?.value)).toBe(true);
      expect(nameCondition?.value).toEqual([
        { type: "VALUE", value: "Alice", valueType: "string" },
        { type: "VALUE", value: "Bob", valueType: "string" },
        { type: "VALUE", value: "Charlie", valueType: "string" },
      ]);

      // Check number array
      const ageCondition = ast.args.where!.find(
        (c) =>
          c.target.type === "FIELD" &&
          c.target.field.name === "age" &&
          c.operator === "notIn"
      );
      expect(Array.isArray(ageCondition?.value)).toBe(true);
      expect(ageCondition?.value).toEqual([
        { type: "VALUE", value: 18, valueType: "int" },
        { type: "VALUE", value: 21, valueType: "int" },
        { type: "VALUE", value: 25, valueType: "int" },
      ]);
    });
  });

  describe("Error handling and edge cases", () => {
    test("should handle empty where clauses", () => {
      const ast = parser.parse("User", "findMany", {
        where: {},
      } as any);

      expect(ast.args.where).toEqual([]);
    });

    test("should handle null values", () => {
      const ast = parser.parse("User", "findMany", {
        where: {
          age: null,
        },
      } as any);

      expect(ast.args.where).toHaveLength(1);
      const ageCondition = ast.args.where![0]!;
      expect(ageCondition.value).toMatchObject({
        type: "VALUE",
        value: null,
        valueType: "null",
      });
    });

    test("should throw error for invalid relation operations", () => {
      expect(() => {
        parser.parse("User", "findMany", {
          where: {
            posts: {
              invalidOperation: {
                title: "test",
              },
            },
          },
        } as any);
      }).toThrow("Invalid relation operation 'invalidOperation'");
    });

    test("should throw error for unknown fields", () => {
      expect(() => {
        parser.parse("User", "findMany", {
          where: {
            nonExistentField: "value",
          },
        } as any);
      }).toThrow("Unknown field or relation 'nonExistentField'");
    });

    test("should throw error for unknown models", () => {
      expect(() => {
        parser.parse("NonExistentModel", "findMany", {
          where: { name: "test" },
        } as any);
      }).toThrow("Model 'NonExistentModel' not found");
    });
  });
});
