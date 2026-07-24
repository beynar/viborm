import { s } from "@schema";

export const batchPrimaryKeyDataflowSchema = (() => {
  const featuredChild = s
    .model({
      id: s.int().id().increment(),
      label: s.string(),
      holders: s.oneToMany(() => generatedUser),
    })
    .map("batch_pk_featured_children");

  const generatedUser = s
    .model({
      id: s.int().id().increment(),
      name: s.string(),
      featuredChildId: s.int().nullable(),
      featuredChild: s
        .manyToOne(() => featuredChild)
        .fields("featuredChildId")
        .references("id")
        .optional(),
      posts: s.oneToMany(() => generatedPost),
      notes: s.oneToMany(() => generatedNote),
    })
    .map("batch_pk_generated_users");

  const generatedPost = s
    .model({
      id: s.int().id().increment(),
      title: s.string(),
      slug: s.string().unique(),
      userId: s.int().nullable(),
      author: s
        .manyToOne(() => generatedUser)
        .fields("userId")
        .references("id")
        .optional(),
      comments: s.oneToMany(() => generatedComment),
    })
    .map("batch_pk_generated_posts");

  const generatedNote = s
    .model({
      id: s.int().id().increment(),
      body: s.string(),
      userId: s.int().nullable(),
      author: s
        .manyToOne(() => generatedUser)
        .fields("userId")
        .references("id")
        .optional(),
    })
    .map("batch_pk_generated_notes");

  const generatedComment = s
    .model({
      id: s.int().id().increment(),
      body: s.string(),
      postId: s.int().nullable(),
      post: s
        .manyToOne(() => generatedPost)
        .fields("postId")
        .references("id")
        .optional(),
    })
    .map("batch_pk_generated_comments");

  const mutableUser = s
    .model({
      id: s.int().id(),
      name: s.string(),
      posts: s.oneToMany(() => mutablePost),
    })
    .map("batch_pk_mutable_users");

  const mutablePost = s
    .model({
      id: s.int().id().increment(),
      title: s.string(),
      userId: s.int(),
      author: s
        .manyToOne(() => mutableUser)
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
