import { s } from "@schema";

export const nestedWriteBehaviorSchema = (() => {
  const user = s
    .model({
      id: s.string().id(),
      name: s.string(),
      posts: s.oneToMany(() => post),
      profile: s.oneToOne(() => profile).optional(),
    })
    .map("nested_behavior_users");

  const profile = s
    .model({
      id: s.string().id(),
      bio: s.string().nullable(),
      userId: s.string().unique().nullable(),
      user: s
        .oneToOne(() => user)
        .fields("userId")
        .references("id")
        .optional(),
    })
    .map("nested_behavior_profiles");

  const post = s
    .model({
      id: s.string().id(),
      title: s.string(),
      userId: s.string().nullable(),
      author: s
        .manyToOne(() => user)
        .fields("userId")
        .references("id")
        .optional(),
      postTags: s.oneToMany(() => postTag),
    })
    .map("nested_behavior_posts");

  const tag = s
    .model({
      id: s.string().id(),
      name: s.string().unique(),
      postTags: s.oneToMany(() => postTag),
    })
    .map("nested_behavior_tags");

  const postTag = s
    .model({
      id: s.string().id(),
      postId: s.string(),
      tagId: s.string(),
      post: s
        .manyToOne(() => post)
        .fields("postId")
        .references("id"),
      tag: s
        .manyToOne(() => tag)
        .fields("tagId")
        .references("id"),
    })
    .map("nested_behavior_post_tags");

  // .map()ed columns: RETURNING/SELECT rows come back with raw column names,
  // so nested-write record capture must translate them to field names.
  const mappedUser = s
    .model({
      id: s.string().id().map("uid"),
      name: s.string().map("full_name"),
      posts: s.oneToMany(() => mappedPost),
    })
    .map("nested_behavior_mapped_users");

  const mappedPost = s
    .model({
      id: s.string().id().map("pid"),
      title: s.string(),
      authorId: s.string().nullable().map("author_ref"),
      author: s
        .manyToOne(() => mappedUser)
        .fields("authorId")
        .references("id")
        .optional(),
    })
    .map("nested_behavior_mapped_posts");

  return { user, profile, post, tag, postTag, mappedUser, mappedPost };
})();
