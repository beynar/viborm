import { s } from "@schema";

export const clientUserPostSchema = (() => {
  const user = s.model({
    id: s.string().id(),
    name: s.string(),
    email: s.string().unique(),
    age: s.int().nullable(),
    posts: s.toMany(() => post),
  });

  const post = s
    .model({
      id: s.string().id(),
      title: s.string(),
      content: s.string().nullable(),
      published: s.boolean().default(false),
      views: s.int().default(0),
      authorId: s.string(),
      author: s
        .toOne(() => user)
        .fields("authorId")
        .references("id"),
    })
    .map("posts");

  return { user, post };
})();

export const sqliteUserPostSchema = (() => {
  const user = s
    .model({
      id: s.string().id(),
      name: s.string().nullable(),
      email: s.string(),
      age: s.int().nullable(),
      posts: s.toMany(() => post),
    })
    .map("users");

  const post = s
    .model({
      id: s.string().id(),
      title: s.string(),
      content: s.string().nullable(),
      published: s.boolean().default(false),
      views: s.int().default(0),
      authorId: s.string(),
      author: s
        .toOne(() => user)
        .fields("authorId")
        .references("id"),
    })
    .map("posts");

  return { user, post };
})();

export const windowUserPostSchema = (() => {
  const user = s
    .model({
      id: s.string().id(),
      name: s.string().nullable(),
      email: s.string(),
      age: s.int().nullable(),
      posts: s.toMany(() => post),
    })
    .map("window_users");

  const post = s
    .model({
      id: s.string().id(),
      title: s.string(),
      content: s.string().nullable(),
      published: s.boolean().default(false),
      views: s.int().default(0),
      authorId: s.string(),
      author: s
        .toOne(() => user)
        .fields("authorId")
        .references("id"),
    })
    .map("window_posts");

  return { user, post };
})();

export const sqlGenerationUserPostSchema = (() => {
  const Author = s.model({
    id: s.string().id(),
    name: s.string(),
    email: s.string().unique(),
    age: s.int().nullable(),
    metadata: s.json().nullable(),
    posts: s.toMany(() => Post),
  });

  const Post = s
    .model({
      id: s.string().id(),
      title: s.string(),
      content: s.string().nullable(),
      published: s.boolean().default(false),
      views: s.int().default(0),
      authorId: s.string(),
      author: s
        .toOne(() => Author)
        .fields("authorId")
        .references("id"),
      comments: s.toMany(() => Comment),
      tags: s.toMany(() => Tag),
    })
    .map("posts");

  const Comment = s
    .model({
      id: s.string().id(),
      text: s.string(),
      postId: s.string(),
      post: s
        .toOne(() => Post)
        .fields("postId")
        .references("id"),
    })
    .map("comments");

  const Tag = s
    .model({
      id: s.string().id(),
      name: s.string().unique(),
      posts: s.toMany(() => Post),
    })
    .map("tags");

  const Membership = s
    .model({
      orgId: s.string(),
      memberId: s.string(),
      tenantId: s.string(),
      email: s.string(),
      role: s.string(),
    })
    .id(["orgId", "memberId"])
    .unique(["email", "tenantId"]);

  return { Author, Post, Comment, Tag, Membership };
})();
