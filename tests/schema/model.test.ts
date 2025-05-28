import { s } from "../../src/schema/index.js";
import {
  model,
  oneToOne,
  oneToMany,
  manyToMany,
  manyToOne,
} from "../schema.js";

describe("Model", () => {
  describe("Basic Model Structure", () => {
    test("should have correct model name", () => {
      expect(model.name).toBe("test");
    });

    test("should have fields defined", () => {
      expect(model.fields).toBeDefined();
      expect(model.fields instanceof Map).toBe(true);
    });

    test("should contain all defined fields", () => {
      const fieldNames = Array.from(model.fields.keys());
      expect(fieldNames).toContain("string");
      expect(fieldNames).toContain("number");
      expect(fieldNames).toContain("boolean");
      expect(fieldNames).toContain("bigint");
      expect(fieldNames).toContain("dateTime");
      expect(fieldNames).toContain("json");
      expect(fieldNames).toContain("blob");
      expect(fieldNames).toContain("enumField");
    });

    test("should contain relation fields in relations map", () => {
      const relationNames = Array.from(model.relations.keys());
      expect(relationNames).toContain("oneToOne");
      expect(relationNames).toContain("oneToMany");
      expect(relationNames).toContain("manyToMany");
      expect(relationNames).toContain("manyToOne");
    });
  });

  describe("Field Access", () => {
    test("should allow access to individual fields", () => {
      const stringField = model.fields.get("string");
      expect(stringField).toBeDefined();
      expect(stringField!["~fieldType"]).toBe("string");

      const numberField = model.fields.get("number");
      expect(numberField).toBeDefined();
      expect(numberField!["~fieldType"]).toBe("int");

      const booleanField = model.fields.get("boolean");
      expect(booleanField).toBeDefined();
      expect(booleanField!["~fieldType"]).toBe("boolean");
    });

    test("should access fields with modifiers", () => {
      const stringWithDefault = model.fields.get("stringWithDefault");
      expect(stringWithDefault!["~defaultValue"]).toBe("default");

      const nullableString = model.fields.get("nullableString");
      expect(nullableString!["~isOptional"]).toBe(true);

      const stringWithValidation = model.fields.get("stringWithValidation");
      expect(stringWithValidation).toBeDefined();
    });
  });

  describe("Relation Models", () => {
    test("oneToOne model should be properly structured", () => {
      expect(oneToOne.name).toBe("oneToOne");
      expect(oneToOne.fields).toBeDefined();
      expect(oneToOne.fields.get("id")).toBeDefined();
      expect(oneToOne.relations.get("test")).toBeDefined();
    });

    test("oneToMany model should be properly structured", () => {
      expect(oneToMany.name).toBe("oneToMany");
      expect(oneToMany.fields).toBeDefined();
      expect(oneToMany.fields.get("id")).toBeDefined();
      expect(oneToMany.relations.get("test")).toBeDefined();
    });

    test("manyToMany model should be properly structured", () => {
      expect(manyToMany.name).toBe("manyToMany");
      expect(manyToMany.fields).toBeDefined();
      expect(manyToMany.fields.get("id")).toBeDefined();
      expect(manyToMany.relations.get("test")).toBeDefined();
    });

    test("manyToOne model should be properly structured", () => {
      expect(manyToOne.name).toBe("manyToOne");
      expect(manyToOne.fields).toBeDefined();
      expect(manyToOne.fields.get("id")).toBeDefined();
      expect(manyToOne.relations.get("test")).toBeDefined();
    });
  });

  describe("Model Creation", () => {
    test("should create model with simple fields", () => {
      const simpleModel = s.model("simple", {
        id: s.string().id().ulid(),
        name: s.string(),
        age: s.int(),
      });

      expect(simpleModel.name).toBe("simple");
      expect(simpleModel.fields.get("id")).toBeDefined();
      expect(simpleModel.fields.get("name")).toBeDefined();
      expect(simpleModel.fields.get("age")).toBeDefined();
    });

    test("should create model with complex fields", () => {
      const complexModel = s.model("complex", {
        id: s.string().id().ulid(),
        status: s.enum(["active", "inactive"]),
        createdAt: s.dateTime().default(new Date()),
      });

      expect(complexModel.name).toBe("complex");
      expect(complexModel.fields.get("status")).toBeDefined();
      expect(complexModel.fields.get("createdAt")).toBeDefined();
    });
  });

  describe("Model Methods", () => {
    test("should support table mapping", () => {
      const testModel = s.model("user", {
        id: s.string().id().ulid(),
        name: s.string(),
      });

      testModel.map("users");
      expect(testModel.tableName).toBe("users");
    });

    test("should support index creation", () => {
      const testModel = s.model("user", {
        id: s.string().id().ulid(),
        email: s.string(),
        name: s.string(),
      });

      const modelWithIndex = testModel.index("email");
      const modelWithCompoundIndex = modelWithIndex.index(["name", "email"]);

      expect(modelWithCompoundIndex.indexes).toHaveLength(2);
      expect(modelWithCompoundIndex.indexes[0]?.fields).toEqual(["email"]);
      expect(modelWithCompoundIndex.indexes[1]?.fields).toEqual([
        "name",
        "email",
      ]);
    });

    test("should support unique constraints", () => {
      const testModel = s.model("user", {
        id: s.string().id().ulid(),
        email: s.string(),
        username: s.string(),
      });

      const modelWithUnique = testModel.unique("email");
      const modelWithCompoundUnique = modelWithUnique.unique([
        "username",
        "email",
      ]);

      expect(modelWithCompoundUnique.uniqueConstraints).toHaveLength(2);
      expect(modelWithCompoundUnique.uniqueConstraints[0]?.fields).toEqual([
        "email",
      ]);
      expect(modelWithCompoundUnique.uniqueConstraints[1]?.fields).toEqual([
        "username",
        "email",
      ]);
    });
  });

  describe("Type Inference", () => {
    test("model should have expected type properties", () => {
      expectTypeOf(model).toHaveProperty("name");
      expectTypeOf(model).toHaveProperty("fields");
      expectTypeOf(model).toHaveProperty("relations");
    });

    test("model name should be correctly typed", () => {
      expectTypeOf(model.name).toEqualTypeOf<string>();
    });

    test("fields should be accessible with correct types", () => {
      expectTypeOf(model.fields).toBeObject();
      expectTypeOf(model.relations).toBeObject();
    });

    test("created models should have correct type inference", () => {
      const testModel = s.model("typed", {
        name: s.string(),
        count: s.int(),
      });

      expectTypeOf(testModel.name).toEqualTypeOf<string>();
      expectTypeOf(testModel.fields).toBeObject();
    });

    test("model infer should provide correct type structure", () => {
      const simpleModel = s.model("simple", {
        id: s.string(),
        name: s.string(),
        age: s.int(),
        isActive: s.boolean(),
      });

      type ExpectedType = {
        id: string;
        name: string;
        age: number;
        isActive: boolean;
      };

      expectTypeOf(simpleModel.infer).toEqualTypeOf<ExpectedType>();
    });

    test("model infer with nullable fields", () => {
      const modelWithNullable = s.model("nullable", {
        id: s.string(),
        optionalName: s.string().nullable(),
        optionalAge: s.int().nullable(),
      });

      type ExpectedType = {
        id: string;
        optionalName: string | null;
        optionalAge: number | null;
      };

      expectTypeOf(modelWithNullable.infer).toEqualTypeOf<ExpectedType>();
    });

    test("model infer with array fields", () => {
      const modelWithArrays = s.model("arrays", {
        id: s.string(),
        tags: s.string().array(),
        scores: s.int().array(),
      });

      type ExpectedType = {
        id: string;
        tags: string[];
        scores: number[];
      };

      expectTypeOf(modelWithArrays.infer).toEqualTypeOf<ExpectedType>();
    });

    test("model infer with enum fields", () => {
      const modelWithEnum = s.model("withEnum", {
        id: s.string(),
        status: s.enum(["active", "inactive"]),
        priority: s.enum([1, 2, 3]),
      });

      expectTypeOf(modelWithEnum.infer).toBeObject();
      expectTypeOf(modelWithEnum.infer).toHaveProperty("id");
      expectTypeOf(modelWithEnum.infer).toHaveProperty("status");
      expectTypeOf(modelWithEnum.infer).toHaveProperty("priority");
    });

    test("model infer with nullable arrays vs arrays of nullable items", () => {
      const modelWithArrays = s.model("arrayTypes", {
        id: s.string(),
        // Regular array: string[]
        tags: s.string().array(),
        // Nullable array: string[] | null
        optionalTags: s.string().array().nullable(),
        // Array of nullable strings: (string | null)[]
        tagsWithNulls: s.string().nullable().array(),
      });

      type ExpectedType = {
        id: string;
        tags: string[];
        optionalTags: string[] | null;
        tagsWithNulls: (string | null)[];
      };

      expectTypeOf(modelWithArrays.infer).toBeObject();
      expectTypeOf(modelWithArrays.infer).toHaveProperty("tags");
      expectTypeOf(modelWithArrays.infer).toHaveProperty("optionalTags");
      expectTypeOf(modelWithArrays.infer).toHaveProperty("tagsWithNulls");
    });
  });
});
