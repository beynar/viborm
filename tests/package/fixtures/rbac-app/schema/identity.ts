// Synthetic identity models, trimmed from `../../recursive-where/schema/identity.ts`
// to what the RBAC plan's acceptance test reads (plan §1.1): a person, their
// sessions and API keys, an organization (with its plan, a row attribute) and
// its memberships, and the stored role ceiling `rolePermission`.

import { s } from "viborm";
import { accessGrant, collection, team, teamMember } from "./access";
import { document, page, pageGroup } from "./content";

export const ROLES = ["admin", "member", "reader"] as const;
export const PLANS = ["free", "pro"] as const;

export const user = s.model({
  id: s.string().id(),
  name: s.string(),
  email: s.string().unique(),
  emailVerified: s.boolean().default(false),
  image: s.string().nullable(),
  createdAt: s.dateTime(),
  updatedAt: s.dateTime(),
  mfaEnabled: s.boolean().nullable().default(false),
  handle: s.string().nullable().unique(),
  displayHandle: s.string().nullable(),
  anonymous: s.boolean().nullable().default(false),
  role: s.string().nullable(),
  banned: s.boolean().nullable().default(false),
  banReason: s.string().nullable(),
  banExpires: s.dateTime().nullable(),
  title: s.string().nullable(),
  givenName: s.string().default(""),
  familyName: s.string().default(""),
  sessions: s.toMany(() => session),
  apiKeys: s.toMany(() => apiKey),
  members: s.toMany(() => member),
  ownedPages: s.toMany(() => page),
  createdGroups: s.toMany(() => pageGroup),
  teamMemberships: s.toMany(() => teamMember),
  ownedCollections: s.toMany(() => collection).name("collectionOwner"),
  createdCollections: s.toMany(() => collection).name("collectionCreator"),
  grants: s.toMany(() => accessGrant).name("grantToUser"),
  grantsGiven: s.toMany(() => accessGrant).name("grantGivenBy"),
  ownedDocuments: s.toMany(() => document),
});

export const session = s.model({
  id: s.string().id(),
  expiresAt: s.dateTime(),
  token: s.string().unique(),
  createdAt: s.dateTime(),
  updatedAt: s.dateTime(),
  ipAddress: s.string().nullable(),
  userAgent: s.string().nullable(),
  userId: s.string(),
  user: s
    .toOne(() => user)
    .fields("userId")
    .references("id")
    .onDelete("cascade"),
  impersonatedBy: s.string().nullable(),
  activeOrganizationId: s.string().nullable(),
});

export const organization = s.model({
  id: s.string().id(),
  name: s.string(),
  slug: s.string().unique(),
  logo: s.string().nullable(),
  plan: s.enum([...PLANS]).default("free"),
  createdAt: s.dateTime(),
  metadata: s.string().nullable(),
  members: s.toMany(() => member),
  permissions: s.toMany(() => rolePermission),
  pages: s.toMany(() => page),
  groups: s.toMany(() => pageGroup),
  collections: s.toMany(() => collection),
  documents: s.toMany(() => document),
  teams: s.toMany(() => team),
  accessGrants: s.toMany(() => accessGrant),
});

export const member = s.model({
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
  role: s.string().default("member"),
  createdAt: s.dateTime(),
  deletedAt: s.dateTime().nullable(),
});

/** The stored-role variant's ceiling: one row per (organization, role, action) it admits. */
export const rolePermission = s
  .model({
    organizationId: s.string(),
    organization: s
      .toOne(() => organization)
      .fields("organizationId")
      .references("id")
      .onDelete("cascade"),
    role: s.string(),
    action: s.string(),
  })
  .id(["organizationId", "role", "action"]);

export const apiKey = s.model({
  id: s.string().id(),
  configId: s.string().default("default"),
  name: s.string().nullable(),
  start: s.string().nullable(),
  referenceId: s.string(),
  user: s
    .toOne(() => user)
    .fields("referenceId")
    .references("id")
    .onDelete("cascade"),
  prefix: s.string().nullable(),
  key: s.string(),
  refillInterval: s.int().nullable(),
  refillAmount: s.int().nullable(),
  lastRefillAt: s.dateTime().nullable(),
  enabled: s.boolean().nullable().default(true),
  rateLimitEnabled: s.boolean().nullable().default(true),
  rateLimitWindow: s.int().nullable().default(86_400_000),
  rateLimitMax: s.int().nullable().default(10),
  requestCount: s.int().nullable().default(0),
  remaining: s.int().nullable(),
  lastRequest: s.dateTime().nullable(),
  expiresAt: s.dateTime().nullable(),
  createdAt: s.dateTime(),
  updatedAt: s.dateTime(),
  permissions: s.string().nullable(),
  metadata: s.string().nullable(),
});

export const identitySchema = {
  user,
  session,
  organization,
  member,
  rolePermission,
  apiKey,
};
