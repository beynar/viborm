import { s } from "@schema";
import {
  type GetInverseRelationMap,
  getInverseRelationMap,
} from "@schema/relation/types";
import { describe, expect, test } from "vitest";

describe("getInverseRelationMap", () => {
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

      const fields = getInverseRelationMap(authorRelation["~"]["state"], post);

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

      const fields = getInverseRelationMap(authorRelation["~"]["state"], post);

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

      const fields = getInverseRelationMap(
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

      const fields = getInverseRelationMap(postsRelation["~"]["state"], user);

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

      const fieldsOne = getInverseRelationMap(
        postsOneToManyOne["~"]["state"],
        user
      );
      const fieldsTwo = getInverseRelationMap(
        postsOneToManyTwo["~"]["state"],
        user
      );

      expect(fieldsOne).toEqual(["authorId"]);
      expect(fieldsTwo).toEqual(["coAuthorId"]);
    });

    test("ignores non-owning relations while finding the inverse fields", () => {
      const comment = s.model({ id: s.string().id() });
      const profile = s.model({ id: s.string().id() });
      const postsRelation = s.oneToMany(() => post);
      const user = s.model({ id: s.string().id(), posts: postsRelation });
      const post = s.model({
        id: s.string().id(),
        comments: s.oneToMany(() => comment),
        profile: s.oneToOne(() => profile),
        authorId: s.string(),
        author: s
          .manyToOne(() => user)
          .fields("authorId")
          .references("id"),
      });

      expect(getInverseRelationMap(postsRelation["~"].state, user)).toEqual([
        "authorId",
      ]);
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

      const fields = getInverseRelationMap(postsRelation["~"]["state"], user);

      expect(fields).toBeUndefined();
    });

    test("skips a to-one relation that targets a different source model", () => {
      const unrelated = s.model({ id: s.string().id() });
      const childrenRelation = s.oneToMany(() => child);
      const parent = s.model({
        id: s.string().id(),
        children: childrenRelation,
      });
      const child = s.model({
        id: s.string().id(),
        unrelatedId: s.string(),
        unrelated: s
          .manyToOne(() => unrelated)
          .fields("unrelatedId")
          .references("id"),
      });

      const fields = getInverseRelationMap(
        childrenRelation["~"]["state"],
        parent
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

      const fields = getInverseRelationMap(tagsRelation["~"]["state"], post);

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

      type Scalars = GetInverseRelationMap<
        (typeof authorRelation)["~"]["state"],
        typeof post
      >;

      // Type assertion - should be ["authorId"], not string[]
      const _typeCheck: Scalars = ["authorId"];
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

      type Scalars = GetInverseRelationMap<
        (typeof postsRelation)["~"]["state"],
        typeof user
      >;

      // Type assertion - should be ["authorId"], not string[] | undefined
      const _typeCheck: Scalars = ["authorId"];
      expect(_typeCheck).toEqual(["authorId"]);
    });
  });
});
