// Synthetic content models, trimmed from `../../recursive-where/schema/content.ts`:
// pages filed in groups (the source's `group`, renamed `pageGroup`; the
// relations keep the name `group`), and documents in a self-referencing tree
// (parent to-one / children to-many). `bookmark` is this fixture's own: a
// user's pin of a page or a document, a polymorphic to-one stored on its row
// (the variants of plan §1.2 C1 and witness W-R9).

import { s } from "viborm";
import { accessGrant } from "./access";
import { organization, user } from "./identity";

export const page = s
  .model({
    id: s.string().id(),
    organizationId: s.string(),
    organization: s
      .toOne(() => organization)
      .fields("organizationId")
      .references("id")
      .onDelete("cascade"),
    title: s.string(),
    icon: s.string().nullable(),
    color: s.string().nullable(),
    position: s.int(),
    ownerId: s.string().nullable(),
    owner: s
      .toOne(() => user)
      .fields("ownerId")
      .references("id")
      .onDelete("setNull"),
    groupId: s.string().nullable(),
    group: s
      .toOne(() => pageGroup)
      .fields("groupId")
      .references("id")
      .onDelete("setNull"),
    personal: s.boolean().default(false),
    deletedAt: s.dateTime().nullable(),
    headVersionId: s.string().nullable(),
    createdAt: s.dateTime().now(),
    updatedAt: s.dateTime().updatedAt(),
    grants: s.toMany(() => accessGrant),
    bookmarks: s.toMany(() => bookmark).name("bookmarked"),
  })
  .index(["organizationId"])
  .index(["groupId"]);

export const pageGroup = s
  .model({
    id: s.string().id(),
    organizationId: s.string(),
    organization: s
      .toOne(() => organization)
      .fields("organizationId")
      .references("id")
      .onDelete("cascade"),
    label: s.string(),
    icon: s.string(),
    color: s.string().nullable(),
    position: s.int(),
    createdById: s.string().nullable(),
    createdBy: s
      .toOne(() => user)
      .fields("createdById")
      .references("id")
      .onDelete("setNull"),
    createdAt: s.dateTime().now(),
    pages: s.toMany(() => page),
    grants: s.toMany(() => accessGrant),
  })
  .unique(["organizationId", "label"]);

export const document = s
  .model({
    id: s.string().id(),
    organizationId: s.string(),
    organization: s
      .toOne(() => organization)
      .fields("organizationId")
      .references("id")
      .onDelete("cascade"),
    parentId: s.string().nullable(),
    title: s.string().default(""),
    icon: s.string().nullable(),
    attributes: s.json().nullable(),
    body: s.string().default(""),
    searchKey: s.string().default(""),
    position: s.int(),
    sizeBytes: s.bigInt().default(0n),
    ownerId: s.string().nullable(),
    owner: s
      .toOne(() => user)
      .fields("ownerId")
      .references("id")
      .onDelete("setNull"),
    personal: s.boolean().default(false),
    archivedAt: s.dateTime().nullable(),
    deletedAt: s.dateTime().nullable(),
    createdAt: s.dateTime().now(),
    updatedAt: s.dateTime().updatedAt(),
    parent: s
      .toOne(() => document)
      .fields("parentId")
      .references("id")
      .onDelete("cascade"),
    children: s.toMany(() => document),
    grants: s.toMany(() => accessGrant),
    bookmarks: s.toMany(() => bookmark).name("bookmarked"),
  })
  .index(["organizationId"]);

export const bookmark = s
  .model({
    id: s.string().id(),
    organizationId: s.string(),
    organization: s
      .toOne(() => organization)
      .fields("organizationId")
      .references("id")
      .onDelete("cascade"),
    userId: s.string(),
    user: s
      .toOne(() => user)
      .fields("userId")
      .references("id")
      .onDelete("cascade"),
    note: s.string().default(""),
    // Unset, the bookmark points at nothing (its variant columns are null).
    subject: s
      .toOne({ page: () => page, document: () => document })
      .name("bookmarked")
      .optional(),
    createdAt: s.dateTime().now(),
  })
  .index(["organizationId"]);

export const contentSchema = {
  page,
  pageGroup,
  document,
  bookmark,
};
