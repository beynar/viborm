/**
 * The schema and client the extension pages' examples assume when a page
 * does not declare its own: one model per thing the examples name. Read
 * only by `scripts/docs-extension-examples.mjs`, never by the library.
 */
import { createClient } from "viborm/pglite";
import { s } from "viborm/schema";

export const user = s.model({
  id: s.string().id().ulid(),
  email: s.string().unique(),
  firstName: s.string(),
  lastName: s.string(),
  passwordHash: s.string(),
  orgId: s.string().nullable(),
  posts: s.toMany(() => post),
});

export const post = s.model({
  id: s.string().id().ulid(),
  title: s.string(),
  published: s.boolean().default(false),
  tenantId: s.string().nullable(),
  ownerId: s.string().nullable(),
  authorId: s.string().nullable(),
  createdBy: s.string().nullable(),
  updatedBy: s.string().nullable(),
  editedAt: s.dateTime().nullable(),
  deletedAt: s.dateTime().nullable(),
  version: s.int().default(0),
  author: s
    .toOne(() => user)
    .fields("authorId")
    .references("id"),
  comments: s.toMany(() => comment),
});

export const comment = s.model({
  id: s.string().id().ulid(),
  body: s.string(),
  tenantId: s.string(),
  postId: s.string(),
  post: s.toOne(() => post).fields("postId").references("id"),
});

export const document = s.model({
  id: s.string().id().ulid(),
  title: s.string(),
  notes: s.string().nullable(),
  public: s.boolean().default(false),
  ownerId: s.string(),
  archivistId: s.string().nullable(),
  archivedAt: s.dateTime().nullable(),
  folderId: s.string().nullable(),
  parentId: s.string().nullable(),
  parent: s
    .toOne(() => document)
    .fields("parentId")
    .references("id"),
  children: s.toMany(() => document),
});

export const project = s.model({
  id: s.string().id().ulid(),
  name: s.string(),
  archivedAt: s.dateTime().nullable(),
  archivedBy: s.string().nullable(),
});

export const card = s.model({
  id: s.string().id().ulid(),
  title: s.string(),
  columnId: s.string(),
  rank: s.string(),
});

export const counter = s.model({
  id: s.string().id().ulid(),
  hits: s.int().default(0),
  touchedAt: s.dateTime().updatedAt(),
});

export const grant = s.model({
  id: s.string().id().ulid(),
  tenantId: s.string(),
  userId: s.string(),
});

export const order = s.model({
  id: s.string().id().ulid(),
  total: s.int(),
  status: s.string(),
});

export const schema = {
  user,
  post,
  comment,
  document,
  project,
  card,
  counter,
  grant,
  order,
};

export const client = createClient({ schema });
