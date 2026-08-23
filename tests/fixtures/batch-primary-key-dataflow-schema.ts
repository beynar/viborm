import { s } from "@schema";

export const batchPrimaryKeyDataflowSchema = (() => {
  const featuredChild = s
    .model({
      id: s.int().id().increment(),
      label: s.string(),
      holders: s.toMany(() => generatedUser),
    })
    .map("batch_pk_featured_children");

  const generatedUser = s
    .model({
      id: s.int().id().increment(),
      name: s.string(),
      featuredChildId: s.int().nullable(),
      featuredChild: s
        .toOne(() => featuredChild)
        .fields("featuredChildId")
        .references("id"),
      posts: s.toMany(() => generatedPost),
      notes: s.toMany(() => generatedNote),
    })
    .map("batch_pk_generated_users");

  const generatedPost = s
    .model({
      id: s.int().id().increment(),
      title: s.string(),
      slug: s.string().unique(),
      userId: s.int().nullable(),
      author: s
        .toOne(() => generatedUser)
        .fields("userId")
        .references("id"),
      comments: s.toMany(() => generatedComment),
    })
    .map("batch_pk_generated_posts");

  const generatedNote = s
    .model({
      id: s.int().id().increment(),
      body: s.string(),
      userId: s.int().nullable(),
      author: s
        .toOne(() => generatedUser)
        .fields("userId")
        .references("id"),
    })
    .map("batch_pk_generated_notes");

  const generatedComment = s
    .model({
      id: s.int().id().increment(),
      body: s.string(),
      postId: s.int().nullable(),
      post: s
        .toOne(() => generatedPost)
        .fields("postId")
        .references("id"),
    })
    .map("batch_pk_generated_comments");

  const mutableUser = s
    .model({
      id: s.int().id(),
      name: s.string(),
      posts: s.toMany(() => mutablePost),
    })
    .map("batch_pk_mutable_users");

  const mutablePost = s
    .model({
      id: s.int().id().increment(),
      title: s.string(),
      userId: s.int(),
      author: s
        .toOne(() => mutableUser)
        .fields("userId")
        .references("id"),
    })
    .map("batch_pk_mutable_posts");

  const compoundOwner = s
    .model({
      orgId: s.string(),
      localId: s.int(),
      name: s.string(),
    })
    .id(["orgId", "localId"])
    .map("batch_pk_compound_owners");

  return {
    featuredChild,
    generatedUser,
    generatedPost,
    generatedNote,
    generatedComment,
    mutableUser,
    mutablePost,
    compoundOwner,
  };
})();
