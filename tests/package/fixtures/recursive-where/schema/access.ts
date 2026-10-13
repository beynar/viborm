// Synthetic access models: teams in a graph (a self many-to-many through the
// `teamParent` join), grants as an exclusive arc (one "thing" FK and one
// "grantee" FK set per row), an event log, and API/app-client scoping.

import { s } from "viborm";
import { document, group, module, page, record, room } from "./content";
import { apiKey, appClient, organization, user } from "./identity";

export const LEVELS = ["view", "edit", "full"] as const;
export const ROLES = ["admin", "manager", "editor", "reader"] as const;

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
    grants: s.toMany(() => accessGrant).name("grantOnTeam"),
    holds: s.toMany(() => accessGrant).name("grantToTeam"),
    invited: s.toMany(() => invitationTeam),
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
    createdAt: s.dateTime().now(),
  })
  .id(["teamId", "userId"])
  .index(["userId"]);

export const invitationTeam = s
  .model({
    organizationId: s.string(),
    organization: s
      .toOne(() => organization)
      .fields("organizationId")
      .references("id")
      .onDelete("cascade"),
    email: s.string(),
    teamId: s.string(),
    team: s
      .toOne(() => team)
      .fields("teamId")
      .references("id")
      .onDelete("cascade"),
  })
  .id(["organizationId", "email", "teamId"]);

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
      .fields("ownerId")
      .references("id")
      .onDelete("setNull"),
    personal: s.boolean().default(false),
    createdAt: s.dateTime().now(),
    grants: s.toMany(() => accessGrant),
    records: s.toMany(() => record),
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
      .toOne(() => group)
      .fields("groupId")
      .references("id")
      .onDelete("cascade"),
    documentId: s.string().nullable(),
    document: s
      .toOne(() => document)
      .fields("documentId")
      .references("id")
      .onDelete("cascade"),
    roomId: s.string().nullable(),
    room: s
      .toOne(() => room)
      .fields("roomId")
      .references("id")
      .onDelete("cascade"),
    teamId: s.string().nullable(),
    team: s
      .toOne(() => team)
      .name("grantOnTeam")
      .fields("teamId")
      .references("id")
      .onDelete("cascade"),
    collectionId: s.string().nullable(),
    collection: s
      .toOne(() => collection)
      .fields("collectionId")
      .references("id")
      .onDelete("cascade"),
    moduleId: s.string().nullable(),
    module: s
      .toOne(() => module)
      .fields("moduleId")
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
    level: s.enum([...LEVELS]),
    grantedBy: s.string().nullable(),
    granter: s
      .toOne(() => user)
      .name("grantGivenBy")
      .fields("grantedBy")
      .references("id")
      .onDelete("setNull"),
    createdAt: s.dateTime().now(),
  })
  .index(["organizationId", "userId"])
  .index(["granteeTeamId"])
  .index(["pageId"])
  .index(["groupId"])
  .index(["documentId"])
  .index(["roomId"])
  .index(["teamId"])
  .index(["collectionId"])
  .index(["moduleId"]);

export const accessEvent = s
  .model({
    id: s.string().id(),
    organizationId: s.string(),
    organization: s
      .toOne(() => organization)
      .fields("organizationId")
      .references("id")
      .onDelete("cascade"),
    actorId: s.string(),
    keyId: s.string().nullable(),
    action: s.string(),
    target: s.string(),
    payload: s.json().nullable(),
    createdAt: s.dateTime().now(),
  })
  .index(["organizationId", "createdAt"])
  .index(["organizationId", "target"]);

export const apiKeyScope = s
  .model({
    keyId: s.string().id(),
    key: s
      .toOne(() => apiKey)
      .fields("keyId")
      .references("id")
      .onDelete("cascade"),
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
    resources: s.json().nullable(),
    createdAt: s.dateTime().now(),
  })
  .index(["organizationId", "userId"]);

export const appGrant = s
  .model({
    id: s.string().id(),
    userId: s.string(),
    user: s
      .toOne(() => user)
      .fields("userId")
      .references("id")
      .onDelete("cascade"),
    clientId: s.string(),
    client: s
      .toOne(() => appClient)
      .fields("clientId")
      .references("clientId")
      .onDelete("cascade"),
    organizationIds: s.string().array(),
    allOrganizations: s.boolean().default(false),
    scopes: s.string().array(),
    createdAt: s.dateTime().now(),
    updatedAt: s.dateTime().updatedAt(),
  })
  .unique(["userId", "clientId"]);

export const appExclusion = s
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
      .name("excludedUser")
      .fields("userId")
      .references("id")
      .onDelete("cascade"),
    appKey: s.string(),
    clientId: s.string(),
    name: s.string().nullable(),
    uri: s.string().nullable(),
    icon: s.string().nullable(),
    createdAt: s.dateTime().now(),
    createdBy: s.string().nullable(),
    creator: s
      .toOne(() => user)
      .name("exclusionMadeBy")
      .fields("createdBy")
      .references("id")
      .onDelete("setNull"),
  })
  .unique(["organizationId", "userId", "appKey"])
  .index(["userId"]);

export const accessSchema = {
  team,
  teamMember,
  invitationTeam,
  collection,
  accessGrant,
  accessEvent,
  apiKeyScope,
  appGrant,
  appExclusion,
};
