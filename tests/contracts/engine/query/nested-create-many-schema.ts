import { s } from "@schema";

const user = s.model({
  id: s.string().id(),
  name: s.string(),
  posts: s.toMany(() => post),
});

const post = s
  .model({
    id: s.string().id(),
    title: s.string(),
    userId: s.string(),
    author: s
      .toOne(() => user)
      .fields("userId")
      .references("id"),
    comments: s.toMany(() => comment),
  })
  .map("posts");

const comment = s
  .model({
    id: s.string().id(),
    body: s.string(),
    postId: s.string(),
    post: s
      .toOne(() => post)
      .fields("postId")
      .references("id"),
  })
  .map("nested_create_many_comments");

const incrementParent = s
  .model({
    id: s.int().id().increment(),
    name: s.string(),
    children: s.toMany(() => incrementChild),
  })
  .map("nested_increment_parents");

const incrementChild = s
  .model({
    id: s.int().id().increment(),
    label: s.string().nullable(),
    parentId: s.int(),
    parent: s
      .toOne(() => incrementParent)
      .fields("parentId")
      .references("id"),
    grandchildren: s.toMany(() => incrementGrandchild),
  })
  .map("nested_increment_children");

const incrementGrandchild = s
  .model({
    id: s.int().id().increment(),
    marker: s.string(),
    childId: s.int(),
    child: s
      .toOne(() => incrementChild)
      .fields("childId")
      .references("id"),
  })
  .map("nested_increment_grandchildren");

export const nestedCreateManySchema = {
  user,
  post,
  comment,
  incrementParent,
  incrementChild,
  incrementGrandchild,
};
