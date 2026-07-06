import { s } from "@schema";

export const clientUserPostSchema = (() => {
  const user = s.model({
    id: s.string().id(),
    name: s.string(),
    email: s.string().unique(),
    age: s.int().nullable(),
    posts: s.oneToMany(() => post),
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
        .manyToOne(() => user)
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
      posts: s.oneToMany(() => post),
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
        .manyToOne(() => user)
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
      posts: s.oneToMany(() => post),
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
        .manyToOne(() => user)
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
    posts: s.oneToMany(() => Post),
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
        .manyToOne(() => Author)
        .fields("authorId")
        .references("id")
        .optional(),
      comments: s.oneToMany(() => Comment),
      tags: s.manyToMany(() => Tag),
    })
    .map("posts");

  const Comment = s
    .model({
      id: s.string().id(),
      text: s.string(),
      postId: s.string(),
      post: s
        .manyToOne(() => Post)
        .fields("postId")
        .references("id"),
    })
    .map("comments");

  const Tag = s
    .model({
      id: s.string().id(),
      name: s.string().unique(),
      posts: s.manyToMany(() => Post),
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
