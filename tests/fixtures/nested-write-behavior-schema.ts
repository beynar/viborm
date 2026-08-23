import { s } from "@schema";

export const nestedWriteBehaviorSchema = (() => {
  const user = s
    .model({
      id: s.string().id(),
      name: s.string(),
      posts: s.toMany(() => post),
      profile: s.toOne(() => profile),
    })
    .map("nested_behavior_users");

  const profile = s
    .model({
      id: s.string().id(),
      bio: s.string().nullable(),
      userId: s.string().unique().nullable(),
      user: s
        .toOne(() => user)
        .fields("userId")
        .references("id"),
    })
    .map("nested_behavior_profiles");

  const post = s
    .model({
      id: s.string().id(),
      title: s.string(),
      userId: s.string().nullable(),
      author: s
        .toOne(() => user)
        .fields("userId")
        .references("id"),
      postTags: s.toMany(() => postTag),
    })
    .map("nested_behavior_posts");

  const tag = s
    .model({
      id: s.string().id(),
      name: s.string().unique(),
      postTags: s.toMany(() => postTag),
    })
    .map("nested_behavior_tags");

  const postTag = s
    .model({
      id: s.string().id(),
      postId: s.string(),
      tagId: s.string(),
      post: s
        .toOne(() => post)
        .fields("postId")
        .references("id"),
      tag: s
        .toOne(() => tag)
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
      posts: s.toMany(() => mappedPost),
    })
    .map("nested_behavior_mapped_users");

  const mappedPost = s
    .model({
      id: s.string().id().map("pid"),
      title: s.string(),
      authorId: s.string().nullable().map("author_ref"),
      author: s
        .toOne(() => mappedUser)
        .fields("authorId")
        .references("id"),
    })
    .map("nested_behavior_mapped_posts");

  const defaultOnlyRecord = s
    .model({
      id: s.int().id().increment(),
    })
    .map("nested_behavior_default_only_records");

  const defaultOnlyParent = s
    .model({
      id: s.string().id(),
      children: s.toMany(() => defaultOnlyChild),
    })
    .map("nested_behavior_default_only_parents");

  const defaultOnlyChild = s
    .model({
      id: s.int().id().increment(),
      parentId: s.string(),
      parent: s
        .toOne(() => defaultOnlyParent)
        .fields("parentId")
        .references("id"),
    })
    .map("nested_behavior_default_only_children");

  return {
    user,
    profile,
    post,
    tag,
    postTag,
    mappedUser,
    mappedPost,
    defaultOnlyRecord,
    defaultOnlyParent,
    defaultOnlyChild,
  };
})();
