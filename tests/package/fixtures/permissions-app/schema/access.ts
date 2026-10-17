// Synthetic access models, trimmed from `../../recursive-where/schema/access.ts`:
// teams in a graph (a self many-to-many through the `teamParent` join),
// grants as an arc over four things (page, pageGroup, document, collection;
// every thing key nullable, so the arc is a convention only) with four grantee
// kinds (a user, everyone, a team, a role), and collections.

import { s } from "viborm";
import { document, page, pageGroup } from "./content";
import { organization, ROLES, user } from "./identity";

export const LEVELS = ["read", "update", "full"] as const;
export const COLLECTION_STATUSES = ["draft", "active", "archived"] as const;

export const team = s
  .model({
    id: s.string().id(),
    organizationId: s.string(),
    organization: s
      .toOne(() => organization)
      .fields("organizationId")
      .references("id")
      .onDelete("cascade"),
    name: s.string(),
    parents: s
      .toMany(() => team)
      .name("teamGraph")
      .through("teamParent")
      .source("childId")
      .target("parentId")
      .onDelete({ source: "cascade", target: "restrict" }),
    children: s.toMany(() => team).name("teamGraph"),
    createdAt: s.dateTime().now(),
    members: s.toMany(() => teamMember),
    holds: s.toMany(() => accessGrant).name("grantToTeam"),
  })
  .unique(["organizationId", "name"])
  .index(["organizationId"]);

export const teamMember = s
  .model({
    teamId: s.string(),
    team: s
      .toOne(() => team)
      .fields("teamId")
      .references("id")
      .onDelete("cascade"),
    userId: s.string(),
    user: s
      .toOne(() => user)
      .fields("userId")
      .references("id")
      .onDelete("cascade"),
    role: s.string().default("member"),
    createdAt: s.dateTime().now(),
    deletedAt: s.dateTime().nullable(),
  })
  .id(["teamId", "userId"])
  .index(["userId"]);

export const collection = s
  .model({
    id: s.string().id(),
    organizationId: s.string(),
    organization: s
      .toOne(() => organization)
      .fields("organizationId")
      .references("id")
      .onDelete("cascade"),
    name: s.string(),
    ownerId: s.string().nullable(),
    owner: s
      .toOne(() => user)
      .name("collectionOwner")
      .fields("ownerId")
      .references("id")
      .onDelete("setNull"),
    personal: s.boolean().default(false),
    status: s.enum([...COLLECTION_STATUSES]).default("draft"),
    createdById: s.string().nullable(),
    createdBy: s
      .toOne(() => user)
      .name("collectionCreator")
      .fields("createdById")
      .references("id")
      .onDelete("setNull"),
    budget: s.int().default(0),
    createdAt: s.dateTime().now(),
    grants: s.toMany(() => accessGrant),
  })
  .unique(["organizationId", "name"]);

export const accessGrant = s
  .model({
    id: s.string().id(),
    key: s.string().unique(),
    organizationId: s.string(),
    organization: s
      .toOne(() => organization)
      .fields("organizationId")
      .references("id")
      .onDelete("cascade"),
    pageId: s.string().nullable(),
    page: s
      .toOne(() => page)
      .fields("pageId")
      .references("id")
      .onDelete("cascade"),
    groupId: s.string().nullable(),
    group: s
      .toOne(() => pageGroup)
      .fields("groupId")
      .references("id")
      .onDelete("cascade"),
    documentId: s.string().nullable(),
    document: s
      .toOne(() => document)
      .fields("documentId")
      .references("id")
      .onDelete("cascade"),
    collectionId: s.string().nullable(),
    collection: s
      .toOne(() => collection)
      .fields("collectionId")
      .references("id")
      .onDelete("cascade"),
    userId: s.string().nullable(),
    user: s
      .toOne(() => user)
      .name("grantToUser")
      .fields("userId")
      .references("id")
      .onDelete("cascade"),
    granteeTeamId: s.string().nullable(),
    granteeTeam: s
      .toOne(() => team)
      .name("grantToTeam")
      .fields("granteeTeamId")
      .references("id")
      .onDelete("cascade"),
    granteeRole: s.enum([...ROLES]).nullable(),
    everyone: s.boolean().default(false),
    level: s.enum([...LEVELS]).nullable(),
    actions: s.string().array(),
    grantedBy: s.string().nullable(),
    granter: s
      .toOne(() => user)
      .name("grantGivenBy")
      .fields("grantedBy")
      .references("id")
      .onDelete("setNull"),
    createdAt: s.dateTime().now(),
    deletedAt: s.dateTime().nullable(),
  })
  .index(["organizationId", "userId"])
  .index(["granteeTeamId"])
  .index(["pageId"])
  .index(["groupId"])
  .index(["documentId"])
  .index(["collectionId"]);

export const accessSchema = {
  team,
  teamMember,
  collection,
  accessGrant,
};
