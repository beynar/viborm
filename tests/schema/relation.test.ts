import { describe, test, expect, expectTypeOf } from "vitest";
import { s } from "../../src/schema";
import {
  generateJunctionTableName,
  generateJunctionFieldName,
  getJunctionTableName,
  getJunctionFieldNames,
} from "../../src/schema/relation/relation";

describe("Relations", () => {
  describe("Relation Types", () => {
    test("should create oneToOne relation", () => {
      const relation = s.relation().oneToOne(() => s.model("target", {}));
      expect(relation["~relationType"]).toBe("oneToOne");
    });

    test("should create oneToMany relation", () => {
      const relation = s.relation().oneToMany(() => s.model("target", {}));
      expect(relation["~relationType"]).toBe("oneToMany");
    });

    test("should create manyToOne relation", () => {
      const relation = s.relation().manyToOne(() => s.model("target", {}));
      expect(relation["~relationType"]).toBe("manyToOne");
    });

    test("should create manyToMany relation", () => {
      const relation = s.relation().manyToMany(() => s.model("target", {}));
      expect(relation["~relationType"]).toBe("manyToMany");
    });
  });

  describe("Relation Properties", () => {
    test("should have target model accessor", () => {
      const targetModel = s.model("target", {
        id: s.string().id().ulid(),
        name: s.string(),
      });

      const relation = s.relation().oneToOne(() => targetModel);
      expect(relation.targetModel).toBe(targetModel);
    });

    test("should support lazy loading", () => {
      const relation = s.relation().oneToOne(() => s.model("target", {}));
      expect(typeof relation.getter).toBe("function");
    });

    test("should identify to-many relationships", () => {
      const oneToMany = s.relation().oneToMany(() => s.model("target", {}));
      const manyToMany = s.relation().manyToMany(() => s.model("target", {}));

      expect(oneToMany["~isToMany"]).toBe(true);
      expect(manyToMany["~isToMany"]).toBe(true);
    });

    test("should identify to-one relationships", () => {
      const oneToOne = s.relation().oneToOne(() => s.model("target", {}));
      const manyToOne = s.relation().manyToOne(() => s.model("target", {}));

      expect(oneToOne["~isToOne"]).toBe(true);
      expect(manyToOne["~isToOne"]).toBe(true);
    });

    test("should identify junction table requirement", () => {
      const manyToMany = s.relation().manyToMany(() => s.model("target", {}));
      const oneToOne = s.relation().oneToOne(() => s.model("target", {}));

      expect(manyToMany["~requiresJunctionTable"]).toBe(true);
      expect(oneToOne["~requiresJunctionTable"]).toBe(false);
    });
  });

  describe("Model Integration", () => {
    test("should properly integrate with models", () => {
      const userModel = s.model("user", {
        id: s.string().id().ulid(),
        name: s.string(),
        profile: s.relation().oneToOne(() => profileModel),
        posts: s.relation().oneToMany(() => postModel),
      });

      const profileModel = s.model("profile", {
        id: s.string().id().ulid(),
        bio: s.string(),
        user: s.relation().manyToOne(() => userModel),
      });

      const postModel = s.model("post", {
        id: s.string().id().ulid(),
        title: s.string(),
        author: s.relation().manyToOne(() => userModel),
      });

      expect(userModel.relations.get("profile")).toBeDefined();
      expect(userModel.relations.get("posts")).toBeDefined();
      expect(profileModel.relations.get("user")).toBeDefined();
      expect(postModel.relations.get("author")).toBeDefined();
    });

    test("should handle circular references", () => {
      const userModel = s.model("user", {
        id: s.string().id().ulid(),
        friends: s.relation().manyToMany(() => userModel),
      });

      expect(userModel.relations.get("friends")).toBeDefined();
      const friendsRelation = userModel.relations.get("friends")!;
      expect(friendsRelation["~relationType"]).toBe("manyToMany");
    });
  });

  describe("Type Inference", () => {
    test("relations should have expected type properties", () => {
      const relation = s.relation().oneToOne(() => s.model("target", {}));

      expectTypeOf(relation).toHaveProperty("~relationType");
      expectTypeOf(relation).toHaveProperty("targetModel");
      expectTypeOf(relation).toHaveProperty("~isToMany");
      expectTypeOf(relation).toHaveProperty("~isToOne");
      expectTypeOf(relation).toHaveProperty("~requiresJunctionTable");
    });

    test("relation methods should return correct types", () => {
      expectTypeOf(
        s.relation().oneToOne(() => s.model("target", {}))
      ).toHaveProperty("~relationType");
      expectTypeOf(
        s.relation().oneToMany(() => s.model("target", {}))
      ).toHaveProperty("~relationType");
      expectTypeOf(
        s.relation().manyToOne(() => s.model("target", {}))
      ).toHaveProperty("~relationType");
      expectTypeOf(
        s.relation().manyToMany(() => s.model("target", {}))
      ).toHaveProperty("~relationType");
    });

    test("oneToOne relation infer should return single model type", () => {
      const targetModel = s.model("target", {
        id: s.string(),
        name: s.string(),
      });

      const oneToOneRelation = s.relation().oneToOne(() => targetModel);

      type ExpectedType = {
        id: string;
        name: string;
      };

      expectTypeOf(oneToOneRelation.infer).toEqualTypeOf<ExpectedType>();
    });

    test("manyToOne relation infer should return single model type", () => {
      const targetModel = s.model("target", {
        id: s.string(),
        name: s.string(),
      });

      const manyToOneRelation = s.relation().manyToOne(() => targetModel);

      type ExpectedType = {
        id: string;
        name: string;
      };

      expectTypeOf(manyToOneRelation.infer).toEqualTypeOf<ExpectedType>();
    });

    test("oneToMany relation infer should return array of model type", () => {
      const targetModel = s.model("target", {
        id: s.string(),
        name: s.string(),
      });

      const oneToManyRelation = s.relation().oneToMany(() => targetModel);

      type ExpectedType = {
        id: string;
        name: string;
      }[];

      expectTypeOf(oneToManyRelation.infer).toEqualTypeOf<ExpectedType>();
    });

    test("manyToMany relation infer should return array of model type", () => {
      const targetModel = s.model("target", {
        id: s.string(),
        name: s.string(),
      });

      const manyToManyRelation = s.relation().manyToMany(() => targetModel);

      type ExpectedType = {
        id: string;
        name: string;
      }[];

      expectTypeOf(manyToManyRelation.infer).toEqualTypeOf<ExpectedType>();
    });

    test("relation infer with complex model types", () => {
      const complexModel = s.model("complex", {
        id: s.string(),
        name: s.string(),
        age: s.int().nullable(),
        tags: s.string().array(),
        isActive: s.boolean(),
      });

      const relation = s.relation().oneToOne(() => complexModel);

      expectTypeOf(relation.infer).toBeObject();
      expectTypeOf(relation.infer).toHaveProperty("id");
      expectTypeOf(relation.infer).toHaveProperty("name");
      expectTypeOf(relation.infer).toHaveProperty("age");
      expectTypeOf(relation.infer).toHaveProperty("tags");
      expectTypeOf(relation.infer).toHaveProperty("isActive");
    });
  });

  describe("Many-to-Many Junction Table Conventions", () => {
    test("should generate correct junction table names", () => {
      // Test alphabetical ordering
      expect(generateJunctionTableName("post", "tag")).toBe("post_tag");
      expect(generateJunctionTableName("tag", "post")).toBe("post_tag"); // same result

      // Test case insensitivity
      expect(generateJunctionTableName("User", "Role")).toBe("role_user");
      expect(generateJunctionTableName("PRODUCT", "category")).toBe(
        "category_product"
      );
    });

    test("should generate correct junction field names", () => {
      expect(generateJunctionFieldName("post")).toBe("postId");
      expect(generateJunctionFieldName("tag")).toBe("tagId");
      expect(generateJunctionFieldName("User")).toBe("userId");
      expect(generateJunctionFieldName("Category")).toBe("categoryId");
    });

    test("should get junction table name with explicit vs implicit", () => {
      // Explicit junction table name
      const explicitRelation = s
        .relation({
          junctionTable: "custom_junction_table",
        })
        .manyToMany(() => s.model("target", {}));

      expect(getJunctionTableName(explicitRelation, "source", "target")).toBe(
        "custom_junction_table"
      );

      // Implicit junction table name (auto-generated)
      const implicitRelation = s
        .relation()
        .manyToMany(() => s.model("target", {}));

      expect(getJunctionTableName(implicitRelation, "source", "target")).toBe(
        "source_target"
      );
      expect(getJunctionTableName(implicitRelation, "user", "role")).toBe(
        "role_user"
      ); // alphabetical
    });

    test("should get junction field names correctly", () => {
      // Test with explicit junction field
      const explicitRelation = s
        .relation({
          junctionField: "customFieldId",
        })
        .manyToMany(() => s.model("target", {}));

      const [sourceField, targetField] = getJunctionFieldNames(
        explicitRelation,
        "source",
        "target"
      );
      expect(sourceField).toBe("sourceId"); // auto-generated
      expect(targetField).toBe("customFieldId"); // explicit

      // Test with implicit junction fields
      const implicitRelation = s
        .relation()
        .manyToMany(() => s.model("target", {}));

      const [sourceField2, targetField2] = getJunctionFieldNames(
        implicitRelation,
        "post",
        "tag"
      );
      expect(sourceField2).toBe("postId");
      expect(targetField2).toBe("tagId");
    });

    test("should handle real-world naming scenarios", () => {
      // Common scenarios
      expect(generateJunctionTableName("user", "permission")).toBe(
        "permission_user"
      );
      expect(generateJunctionTableName("article", "category")).toBe(
        "article_category"
      );
      expect(generateJunctionTableName("student", "course")).toBe(
        "course_student"
      );

      // Field names
      expect(generateJunctionFieldName("user")).toBe("userId");
      expect(generateJunctionFieldName("permission")).toBe("permissionId");
      expect(generateJunctionFieldName("article")).toBe("articleId");
      expect(generateJunctionFieldName("category")).toBe("categoryId");
    });
  });
});
