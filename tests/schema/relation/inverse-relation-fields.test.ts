import { s } from "@schema";
import {
  type GetInverseRelationFields,
  getInverseRelationFields,
} from "@schema/relation/types";
import { describe, expect, test } from "vitest";

describe("getInverseRelationFields", () => {
  describe("manyToOne relations", () => {
    test("returns its own fields directly", () => {
      const user = s.model({
        id: s.string().id(),
      });

      const authorRelation = s
        .manyToOne(() => user)
        .fields("authorId")
        .references("id");

      const post = s.model({
        id: s.string().id(),
        authorId: s.string(),
        author: authorRelation,
      });

      const fields = getInverseRelationFields(
        authorRelation["~"]["state"],
        post
      );

      expect(fields).toEqual(["authorId"]);
    });

    test("returns multiple FK fields", () => {
      const user = s.model({
        id: s.string().id(),
        orgId: s.string(),
      });

      const authorRelation = s
        .manyToOne(() => user)
        .fields("authorId", "authorOrgId")
        .references("id", "orgId");

      const post = s.model({
        id: s.string().id(),
        authorId: s.string(),
        authorOrgId: s.string(),
        author: authorRelation,
      });

      const fields = getInverseRelationFields(
        authorRelation["~"]["state"],
        post
      );

      expect(fields).toEqual(["authorId", "authorOrgId"]);
    });
  });

  describe("oneToOne relations", () => {
    test("returns its own fields directly", () => {
      const user = s.model({
        id: s.string().id(),
      });

      const profileRelation = s
        .oneToOne(() => user)
        .fields("userId")
        .references("id");

      const profile = s.model({
        id: s.string().id(),
        userId: s.string(),
        user: profileRelation,
      });

      const fields = getInverseRelationFields(
        profileRelation["~"]["state"],
        profile
      );

      expect(fields).toEqual(["userId"]);
    });
  });

  describe("oneToMany relations", () => {
    test("finds inverse manyToOne fields from target model", () => {
      const postsRelation = s.oneToMany(() => post);

      const user = s.model({
        id: s.string().id(),
        posts: postsRelation,
      });

      const post = s.model({
        id: s.string().id(),
        authorId: s.string(),
        author: s
          .manyToOne(() => user)
          .fields("authorId")
          .references("id"),
      });

      const fields = getInverseRelationFields(
        postsRelation["~"]["state"],
        user
      );

      expect(fields).toEqual(["authorId"]);
    });

    test("matches by name when multiple relations to same model", () => {
      const postsOneToManyOne = s.oneToMany(() => post).name("one");
      const postsOneToManyTwo = s.oneToMany(() => post).name("two");

      const user = s.model({
        id: s.string().id(),
        posts: postsOneToManyOne,
        coAuthoredPosts: postsOneToManyTwo,
      });

      const post = s.model({
        id: s.string().id(),
        authorId: s.string(),
        coAuthorId: s.string(),
        author: s
          .manyToOne(() => user)
          .fields("authorId")
          .references("id")
          .name("one"),
        coAuthor: s
          .manyToOne(() => user)
          .fields("coAuthorId")
          .references("id")
          .name("two"),
      });

      const fieldsOne = getInverseRelationFields(
        postsOneToManyOne["~"]["state"],
        user
      );
      const fieldsTwo = getInverseRelationFields(
        postsOneToManyTwo["~"]["state"],
        user
      );

      expect(fieldsOne).toEqual(["authorId"]);
      expect(fieldsTwo).toEqual(["coAuthorId"]);
    });

    test("returns undefined when no inverse relation found", () => {
      const postsRelation = s.oneToMany(() => post);

      const user = s.model({
        id: s.string().id(),
        posts: postsRelation,
      });

      // Post has no manyToOne back to user
      const post = s.model({
        id: s.string().id(),
        title: s.string(),
      });

      const fields = getInverseRelationFields(
        postsRelation["~"]["state"],
        user
      );

      expect(fields).toBeUndefined();
    });
  });

  describe("manyToMany relations", () => {
    test("finds inverse manyToOne fields from target model", () => {
      const tagsRelation = s.manyToMany(() => tag);

      const post = s.model({
        id: s.string().id(),
        tags: tagsRelation,
      });

      const tag = s.model({
        id: s.string().id(),
        postId: s.string(),
        post: s
          .manyToOne(() => post)
          .fields("postId")
          .references("id"),
      });

      const fields = getInverseRelationFields(tagsRelation["~"]["state"], post);

      expect(fields).toEqual(["postId"]);
    });
  });

  describe("type inference", () => {
    test("infers literal tuple types for manyToOne", () => {
      const user = s.model({
        id: s.string().id(),
      });

      const authorRelation = s
        .manyToOne(() => user)
        .fields("authorId")
        .references("id");

      const post = s.model({
        id: s.string().id(),
        authorId: s.string(),
        author: authorRelation,
      });

      type Fields = GetInverseRelationFields<
        (typeof authorRelation)["~"]["state"],
        typeof post
      >;

      // Type assertion - should be ["authorId"], not string[]
      const _typeCheck: Fields = ["authorId"];
      expect(_typeCheck).toEqual(["authorId"]);
    });

    test("infers literal tuple types for oneToMany with named relations", () => {
      const postsRelation = s.oneToMany(() => post).name("author");

      const user = s.model({
        id: s.string().id(),
        posts: postsRelation,
      });

      const post = s.model({
        id: s.string().id(),
        authorId: s.string(),
        author: s
          .manyToOne(() => user)
          .fields("authorId")
          .references("id")
          .name("author"),
      });

      type Fields = GetInverseRelationFields<
        (typeof postsRelation)["~"]["state"],
        typeof user
      >;

      // Type assertion - should be ["authorId"], not string[] | undefined
      const _typeCheck: Fields = ["authorId"];
      expect(_typeCheck).toEqual(["authorId"]);
    });
  });
});
