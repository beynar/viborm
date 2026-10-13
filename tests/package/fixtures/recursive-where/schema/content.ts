// Synthetic content models: pages filed in groups, versioned; documents in a
// self-referencing tree (parent to-one / children to-many); rooms with
// members; modules; records belonging to a collection by a compound key.

import { s } from "viborm";
import { accessGrant, collection } from "./access";
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
      .toOne(() => group)
      .fields("groupId")
      .references("id")
      .onDelete("setNull"),
    personal: s.boolean().default(false),
    deletedAt: s.dateTime().nullable(),
    headVersionId: s.string().nullable(),
    createdAt: s.dateTime().now(),
    updatedAt: s.dateTime().updatedAt(),
    versions: s.toMany(() => pageVersion),
    grants: s.toMany(() => accessGrant),
    pins: s.toMany(() => pagePin),
  })
  .index(["organizationId"])
  .index(["groupId"]);

export const group = s
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

export const pageVersion = s
  .model({
    id: s.string().id(),
    pageId: s.string(),
    page: s
      .toOne(() => page)
      .fields("pageId")
      .references("id")
      .onDelete("cascade"),
    number: s.int(),
    source: s.string(),
    tree: s.json(),
    authorId: s.string().nullable(),
    author: s
      .toOne(() => user)
      .fields("authorId")
      .references("id")
      .onDelete("setNull"),
    note: s.string().nullable(),
    copiedFrom: s.int().nullable(),
    createdAt: s.dateTime().now(),
  })
  .unique(["pageId", "number"]);

export const pagePin = s
  .model({
    pageId: s.string(),
    page: s
      .toOne(() => page)
      .fields("pageId")
      .references("id")
      .onDelete("cascade"),
    userId: s.string(),
    user: s
      .toOne(() => user)
      .fields("userId")
      .references("id")
      .onDelete("cascade"),
    createdAt: s.dateTime().now(),
  })
  .id(["pageId", "userId"]);

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
    pins: s.toMany(() => documentPin),
    links: s.toMany(() => documentLink),
  })
  .index(["organizationId"]);

export const documentPin = s
  .model({
    documentId: s.string(),
    document: s
      .toOne(() => document)
      .fields("documentId")
      .references("id")
      .onDelete("cascade"),
    userId: s.string(),
    user: s
      .toOne(() => user)
      .fields("userId")
      .references("id")
      .onDelete("cascade"),
    createdAt: s.dateTime().now(),
  })
  .id(["documentId", "userId"]);

export const documentLink = s
  .model({
    fromId: s.string(),
    from: s
      .toOne(() => document)
      .fields("fromId")
      .references("id")
      .onDelete("cascade"),
    toId: s.string(),
  })
  .id(["fromId", "toId"])
  .index(["toId"]);

export const room = s
  .model({
    id: s.string().id(),
    organizationId: s.string(),
    organization: s
      .toOne(() => organization)
      .fields("organizationId")
      .references("id")
      .onDelete("cascade"),
    name: s.string(),
    summary: s.string().nullable(),
    createdBy: s.string().nullable(),
    creator: s
      .toOne(() => user)
      .fields("createdBy")
      .references("id")
      .onDelete("setNull"),
    seq: s.int().default(0),
    lastActivityAt: s.dateTime().nullable(),
    createdAt: s.dateTime().now(),
    updatedAt: s.dateTime().updatedAt(),
    members: s.toMany(() => roomMember),
    grants: s.toMany(() => accessGrant),
  })
  .unique(["organizationId", "name"])
  .index(["organizationId"]);

export const roomMember = s
  .model({
    roomId: s.string(),
    room: s
      .toOne(() => room)
      .fields("roomId")
      .references("id")
      .onDelete("cascade"),
    userId: s.string(),
    user: s
      .toOne(() => user)
      .fields("userId")
      .references("id")
      .onDelete("cascade"),
    readSeq: s.int().default(0),
    unread: s.int().default(0),
    joinedAt: s.dateTime().now(),
  })
  .id(["roomId", "userId"])
  .index(["userId"]);

export const TRIGGERS = ["manual", "webhook", "cron"] as const;

export const module = s
  .model({
    id: s.string().id(),
    organizationId: s.string(),
    organization: s
      .toOne(() => organization)
      .fields("organizationId")
      .references("id")
      .onDelete("cascade"),
    externalId: s.string(),
    name: s.string(),
    ownerId: s.string().nullable(),
    owner: s
      .toOne(() => user)
      .fields("ownerId")
      .references("id")
      .onDelete("setNull"),
    mode: s.enum([...TRIGGERS]).default("manual"),
    createdAt: s.dateTime().now(),
    grants: s.toMany(() => accessGrant),
  })
  .unique(["organizationId", "name"])
  .unique(["organizationId", "externalId"])
  .index(["organizationId"]);

export const record = s
  .model({
    id: s.string().id(),
    organizationId: s.string(),
    organization: s
      .toOne(() => organization)
      .fields("organizationId")
      .references("id")
      .onDelete("cascade"),
    collection: s.string(),
    belongsTo: s
      .toOne(() => collection)
      .fields("organizationId", "collection")
      .references("organizationId", "name")
      .onDelete("cascade"),
    data: s.json(),
    createdAt: s.dateTime().now(),
    updatedAt: s.dateTime().updatedAt(),
  })
  .index(["organizationId", "collection"]);

export const contentSchema = {
  page,
  group,
  pageVersion,
  pagePin,
  document,
  documentPin,
  documentLink,
  room,
  roomMember,
  module,
  record,
};
