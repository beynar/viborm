// Foundation Tests: Model Extraction
// Test model extraction types with real Model instances

import { describe, test, expectTypeOf } from "vitest";
import { s } from "../../../../src/schema/index.js";
import type {
  ExtractModelFields,
  ExtractFields,
  ExtractRelations,
  ExtractModelName,
  FieldNames,
  RelationNames,
  ModelFields,
  ModelRelations,
  HasFields,
  HasRelations,
  ModelPropertyNames,
} from "../../../../src/types/foundation/index.js";

describe("Model Extraction Types", () => {
  describe("Basic Model with Fields Only", () => {
    const userModel = s.model("User", {
      id: s.string().id(),
      name: s.string(),
      age: s.int().nullable(),
      isActive: s.boolean().default(true),
    });

    test("ExtractModelFields extracts generic parameter", () => {
      type Fields = ExtractModelFields<typeof userModel>;

      expectTypeOf<Fields>().toHaveProperty("id");
      expectTypeOf<Fields>().toHaveProperty("name");
      expectTypeOf<Fields>().toHaveProperty("age");
      expectTypeOf<Fields>().toHaveProperty("isActive");
    });

    test("ExtractFields filters only BaseField instances", () => {
      type Fields = ExtractFields<typeof userModel>;

      expectTypeOf<Fields>().toHaveProperty("id");
      expectTypeOf<Fields>().toHaveProperty("name");
      expectTypeOf<Fields>().toHaveProperty("age");
      expectTypeOf<Fields>().toHaveProperty("isActive");
    });

    test("ExtractRelations returns empty for fields-only model", () => {
      type Relations = ExtractRelations<typeof userModel>;

      // Should have no relation properties
      expectTypeOf<Relations>().toEqualTypeOf<{}>();
    });

    test("ExtractModelName gets model name", () => {
      type Name = ExtractModelName<typeof userModel>;
      expectTypeOf<Name>().toMatchTypeOf<string>();
    });

    test("FieldNames extracts field property names", () => {
      type Names = FieldNames<typeof userModel>;
      expectTypeOf<Names>().toEqualTypeOf<"id" | "name" | "age" | "isActive">();
    });

    test("RelationNames returns never for fields-only model", () => {
      type Names = RelationNames<typeof userModel>;
      expectTypeOf<Names>().toEqualTypeOf<never>();
    });

    test("ModelFields provides clean field mapping", () => {
      type Fields = ModelFields<typeof userModel>;

      expectTypeOf<Fields>().toHaveProperty("id");
      expectTypeOf<Fields>().toHaveProperty("name");
      expectTypeOf<Fields>().toHaveProperty("age");
      expectTypeOf<Fields>().toHaveProperty("isActive");
    });

    test("HasFields returns true for model with fields", () => {
      type HasF = HasFields<typeof userModel>;
      expectTypeOf<HasF>().toEqualTypeOf<true>();
    });

    test("HasRelations returns false for fields-only model", () => {
      type HasR = HasRelations<typeof userModel>;
      expectTypeOf<HasR>().toEqualTypeOf<false>();
    });
  });

  describe("Model with Relations Only", () => {
    // Create models for relations first
    const userModel = s.model("User", { id: s.string() });
    const commentModel = s.model("Comment", { id: s.string() });
    const tagModel = s.model("Tag", { id: s.string() });

    const postModel = s.model("Post", {
      author: s.relation.manyToOne(() => userModel),
      comments: s.relation.oneToMany(() => commentModel),
      tags: s.relation.manyToMany(() => tagModel),
    });

    test("ExtractFields returns empty for relations-only model", () => {
      type Fields = ExtractFields<typeof postModel>;

      // Should have no field properties
      expectTypeOf<Fields>().toEqualTypeOf<{}>();
    });

    test("ExtractRelations filters only Relation instances", () => {
      type Relations = ExtractRelations<typeof postModel>;

      expectTypeOf<Relations>().toHaveProperty("author");
      expectTypeOf<Relations>().toHaveProperty("comments");
      expectTypeOf<Relations>().toHaveProperty("tags");
    });

    test("FieldNames returns never for relations-only model", () => {
      type Names = FieldNames<typeof postModel>;
      expectTypeOf<Names>().toEqualTypeOf<never>();
    });

    test("RelationNames extracts relation property names", () => {
      type Names = RelationNames<typeof postModel>;
      expectTypeOf<Names>().toEqualTypeOf<"author" | "comments" | "tags">();
    });

    test("HasFields returns false for relations-only model", () => {
      type HasF = HasFields<typeof postModel>;
      expectTypeOf<HasF>().toEqualTypeOf<false>();
    });

    test("HasRelations returns true for model with relations", () => {
      type HasR = HasRelations<typeof postModel>;
      expectTypeOf<HasR>().toEqualTypeOf<true>();
    });
  });

  describe("Mixed Model with Fields and Relations", () => {
    // Create models for relations first
    const userModel = s.model("User", { id: s.string() });
    const commentModel = s.model("Comment", { id: s.string() });
    const tagModel = s.model("Tag", { id: s.string() });

    const articleModel = s.model("Article", {
      // Fields
      id: s.string().id(),
      title: s.string(),
      content: s.string().nullable(),
      publishedAt: s.dateTime().nullable(),

      // Relations
      author: s.relation.manyToOne(() => userModel),
      comments: s.relation.oneToMany(() => commentModel),
      tags: s.relation.manyToMany(() => tagModel),
    });

    test("ExtractFields correctly separates fields from relations", () => {
      type Fields = ExtractFields<typeof articleModel>;

      expectTypeOf<Fields>().toHaveProperty("id");
      expectTypeOf<Fields>().toHaveProperty("title");
      expectTypeOf<Fields>().toHaveProperty("content");
      expectTypeOf<Fields>().toHaveProperty("publishedAt");
    });

    test("ExtractRelations correctly separates relations from fields", () => {
      type Relations = ExtractRelations<typeof articleModel>;

      expectTypeOf<Relations>().toHaveProperty("author");
      expectTypeOf<Relations>().toHaveProperty("comments");
      expectTypeOf<Relations>().toHaveProperty("tags");
    });

    test("FieldNames extracts only field names", () => {
      type Names = FieldNames<typeof articleModel>;
      expectTypeOf<Names>().toEqualTypeOf<
        "id" | "title" | "content" | "publishedAt"
      >();
    });

    test("RelationNames extracts only relation names", () => {
      type Names = RelationNames<typeof articleModel>;
      expectTypeOf<Names>().toEqualTypeOf<"author" | "comments" | "tags">();
    });

    test("ModelPropertyNames includes both fields and relations", () => {
      type Names = ModelPropertyNames<typeof articleModel>;
      expectTypeOf<Names>().toEqualTypeOf<
        | "id"
        | "title"
        | "content"
        | "publishedAt"
        | "author"
        | "comments"
        | "tags"
      >();
    });

    test("HasFields and HasRelations both return true", () => {
      type HasF = HasFields<typeof articleModel>;
      type HasR = HasRelations<typeof articleModel>;

      expectTypeOf<HasF>().toEqualTypeOf<true>();
      expectTypeOf<HasR>().toEqualTypeOf<true>();
    });
  });

  describe("Empty Model Edge Case", () => {
    const emptyModel = s.model("Empty", {});

    test("Empty model handles gracefully", () => {
      type Fields = FieldNames<typeof emptyModel>;
      type Relations = RelationNames<typeof emptyModel>;
      type HasF = HasFields<typeof emptyModel>;
      type HasR = HasRelations<typeof emptyModel>;

      expectTypeOf<Fields>().toEqualTypeOf<never>();
      expectTypeOf<Relations>().toEqualTypeOf<never>();
      expectTypeOf<HasF>().toEqualTypeOf<false>();
      expectTypeOf<HasR>().toEqualTypeOf<false>();
    });
  });
});
