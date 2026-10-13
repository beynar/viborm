// Synthetic identity models: a person, their sessions and credentials, an
// organization and its memberships, and the API/app-client bookkeeping beside
// them. Scale mirrors a typical auth-library schema: one hub model (`user`)
// with ~33 inverse relations, a second hub (`organization`) with ~19.

import { s } from "viborm";
import {
  accessEvent,
  accessGrant,
  apiKeyScope,
  appExclusion,
  appGrant,
  collection,
  invitationTeam,
  team,
  teamMember,
} from "./access";
import {
  document,
  documentPin,
  group,
  module,
  page,
  pagePin,
  pageVersion,
  record,
  room,
  roomMember,
} from "./content";
import {
  approval,
  billing,
  connection,
  observation,
  orgCreation,
} from "./integrations";

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
  accounts: s.toMany(() => account),
  factors: s.toMany(() => factor),
  passkeys: s.toMany(() => passkey),
  ssoProviders: s.toMany(() => ssoProvider),
  members: s.toMany(() => member),
  invitations: s.toMany(() => invitation),
  appClients: s.toMany(() => appClient),
  refreshTokens: s.toMany(() => refreshToken),
  accessTokens: s.toMany(() => accessToken),
  consents: s.toMany(() => consent),
  ownedPages: s.toMany(() => page),
  createdGroups: s.toMany(() => group),
  pageVersions: s.toMany(() => pageVersion),
  pagePins: s.toMany(() => pagePin),
  teamMemberships: s.toMany(() => teamMember),
  ownedCollections: s.toMany(() => collection),
  grants: s.toMany(() => accessGrant).name("grantToUser"),
  grantsGiven: s.toMany(() => accessGrant).name("grantGivenBy"),
  apiKeyScopes: s.toMany(() => apiKeyScope),
  appGrants: s.toMany(() => appGrant),
  exclusions: s.toMany(() => appExclusion).name("excludedUser"),
  exclusionsMade: s.toMany(() => appExclusion).name("exclusionMadeBy"),
  ownedDocuments: s.toMany(() => document),
  documentPins: s.toMany(() => documentPin),
  createdRooms: s.toMany(() => room),
  roomMemberships: s.toMany(() => roomMember),
  ownedModules: s.toMany(() => module),
  orgCreations: s.toMany(() => orgCreation),
  ownedConnections: s.toMany(() => connection).name("connectionOwner"),
  createdConnections: s.toMany(() => connection).name("connectionCreator"),
  requestedApprovals: s.toMany(() => approval).name("approvalRequester"),
  decidedApprovals: s.toMany(() => approval).name("approvalDecider"),
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
  refreshTokens: s.toMany(() => refreshToken),
  accessTokens: s.toMany(() => accessToken),
});

export const account = s.model({
  id: s.string().id(),
  accountId: s.string(),
  providerId: s.string(),
  userId: s.string(),
  user: s
    .toOne(() => user)
    .fields("userId")
    .references("id")
    .onDelete("cascade"),
  accessToken: s.string().nullable(),
  refreshToken: s.string().nullable(),
  idToken: s.string().nullable(),
  accessTokenExpiresAt: s.dateTime().nullable(),
  refreshTokenExpiresAt: s.dateTime().nullable(),
  scope: s.string().nullable(),
  secret: s.string().nullable(),
  createdAt: s.dateTime(),
  updatedAt: s.dateTime(),
});

export const verification = s.model({
  id: s.string().id(),
  identifier: s.string(),
  value: s.string(),
  expiresAt: s.dateTime(),
  createdAt: s.dateTime(),
  updatedAt: s.dateTime(),
});

export const factor = s.model({
  id: s.string().id(),
  secret: s.string(),
  backupCodes: s.string(),
  userId: s.string(),
  user: s
    .toOne(() => user)
    .fields("userId")
    .references("id")
    .onDelete("cascade"),
  verified: s.boolean().nullable().default(true),
  failedCount: s.int().nullable().default(0),
  lockedUntil: s.dateTime().nullable(),
});

export const passkey = s.model({
  id: s.string().id(),
  name: s.string().nullable(),
  publicKey: s.string(),
  userId: s.string(),
  user: s
    .toOne(() => user)
    .fields("userId")
    .references("id")
    .onDelete("cascade"),
  credentialId: s.string(),
  counter: s.int(),
  deviceType: s.string(),
  backedUp: s.boolean(),
  transports: s.string().nullable(),
  createdAt: s.dateTime().nullable(),
  aaguid: s.string().nullable(),
});

export const ssoProvider = s.model({
  id: s.string().id(),
  issuer: s.string(),
  oidcConfig: s.string().nullable(),
  samlConfig: s.string().nullable(),
  userId: s.string(),
  user: s
    .toOne(() => user)
    .fields("userId")
    .references("id")
    .onDelete("cascade"),
  providerId: s.string().unique(),
  organizationId: s.string().nullable(),
  domain: s.string(),
});

export const organization = s.model({
  id: s.string().id(),
  name: s.string(),
  slug: s.string().unique(),
  logo: s.string().nullable(),
  createdAt: s.dateTime(),
  metadata: s.string().nullable(),
  members: s.toMany(() => member),
  invitations: s.toMany(() => invitation),
  pages: s.toMany(() => page),
  groups: s.toMany(() => group),
  collections: s.toMany(() => collection),
  rooms: s.toMany(() => room),
  modules: s.toMany(() => module),
  documents: s.toMany(() => document),
  teams: s.toMany(() => team),
  invitationTeams: s.toMany(() => invitationTeam),
  accessGrants: s.toMany(() => accessGrant),
  accessEvents: s.toMany(() => accessEvent),
  apiKeyScopes: s.toMany(() => apiKeyScope),
  exclusions: s.toMany(() => appExclusion),
  records: s.toMany(() => record),
  billing: s.toOne(() => billing),
  connections: s.toMany(() => connection),
  approvals: s.toMany(() => approval),
  observations: s.toMany(() => observation),
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
});

export const invitation = s.model({
  id: s.string().id(),
  organizationId: s.string(),
  organization: s
    .toOne(() => organization)
    .fields("organizationId")
    .references("id")
    .onDelete("cascade"),
  email: s.string(),
  role: s.string().nullable(),
  status: s.string().default("pending"),
  expiresAt: s.dateTime(),
  createdAt: s.dateTime(),
  inviterId: s.string(),
  inviter: s
    .toOne(() => user)
    .fields("inviterId")
    .references("id")
    .onDelete("cascade"),
});

export const apiKey = s.model({
  id: s.string().id(),
  configId: s.string().default("default"),
  name: s.string().nullable(),
  start: s.string().nullable(),
  referenceId: s.string(),
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
  scope: s.toOne(() => apiKeyScope),
});

export const signingKey = s.model({
  id: s.string().id(),
  publicKey: s.string(),
  privateKey: s.string(),
  createdAt: s.dateTime(),
  expiresAt: s.dateTime().nullable(),
  alg: s.string().nullable(),
  crv: s.string().nullable(),
});

export const appClient = s.model({
  id: s.string().id(),
  clientId: s.string().unique(),
  clientSecret: s.string().nullable(),
  disabled: s.boolean().nullable().default(false),
  skipConsent: s.boolean().nullable(),
  subjectType: s.string().nullable(),
  scopes: s.string().array().nullable(),
  defaultScopes: s.string().array().nullable().default([]),
  userId: s.string().nullable(),
  user: s
    .toOne(() => user)
    .fields("userId")
    .references("id")
    .onDelete("cascade"),
  createdAt: s.dateTime().nullable(),
  updatedAt: s.dateTime().nullable(),
  name: s.string().nullable(),
  uri: s.string().nullable(),
  icon: s.string().nullable(),
  contacts: s.string().array().nullable(),
  tos: s.string().nullable(),
  policy: s.string().nullable(),
  softwareId: s.string().nullable(),
  softwareVersion: s.string().nullable(),
  redirectUris: s.string().array(),
  logoutRedirectUris: s.string().array().nullable(),
  authMethod: s.string().nullable(),
  applicationType: s.string().nullable(),
  jwks: s.string().nullable(),
  jwksUri: s.string().nullable(),
  grantTypes: s.string().array().nullable(),
  responseTypes: s.string().array().nullable(),
  requirePkce: s.boolean().nullable(),
  referenceId: s.string().nullable(),
  metadata: s.json().nullable(),
  resources: s.toMany(() => appClientResource),
  refreshTokens: s.toMany(() => refreshToken),
  accessTokens: s.toMany(() => accessToken),
  consents: s.toMany(() => consent),
  appGrants: s.toMany(() => appGrant),
});

export const appResource = s.model({
  id: s.string().id(),
  identifier: s.string().unique(),
  name: s.string(),
  accessTokenTtl: s.int().nullable(),
  refreshTokenTtl: s.int().nullable(),
  signingAlgorithm: s.string().nullable(),
  allowedScopes: s.string().array().nullable(),
  customClaims: s.json().nullable(),
  disabled: s.boolean().nullable().default(false),
  createdAt: s.dateTime().nullable(),
  updatedAt: s.dateTime().nullable(),
  metadata: s.json().nullable(),
  clients: s.toMany(() => appClientResource),
});

export const appClientResource = s.model({
  id: s.string().id(),
  clientId: s.string(),
  client: s
    .toOne(() => appClient)
    .fields("clientId")
    .references("clientId")
    .onDelete("cascade"),
  resourceId: s.string(),
  resource: s
    .toOne(() => appResource)
    .fields("resourceId")
    .references("identifier")
    .onDelete("cascade"),
  metadata: s.json().nullable(),
  createdAt: s.dateTime().nullable(),
});

export const refreshToken = s.model({
  id: s.string().id(),
  token: s.string().unique(),
  clientId: s.string(),
  client: s
    .toOne(() => appClient)
    .fields("clientId")
    .references("clientId")
    .onDelete("cascade"),
  sessionId: s.string().nullable(),
  session: s
    .toOne(() => session)
    .fields("sessionId")
    .references("id")
    .onDelete("setNull"),
  userId: s.string(),
  user: s
    .toOne(() => user)
    .fields("userId")
    .references("id")
    .onDelete("cascade"),
  resources: s.string().array().nullable(),
  expiresAt: s.dateTime(),
  createdAt: s.dateTime(),
  revoked: s.dateTime().nullable(),
  rotatedAt: s.dateTime().nullable(),
  confirmation: s.json().nullable(),
  scopes: s.string().array(),
  accessTokens: s.toMany(() => accessToken),
});

export const accessToken = s.model({
  id: s.string().id(),
  token: s.string().unique(),
  clientId: s.string(),
  client: s
    .toOne(() => appClient)
    .fields("clientId")
    .references("clientId")
    .onDelete("cascade"),
  sessionId: s.string().nullable(),
  session: s
    .toOne(() => session)
    .fields("sessionId")
    .references("id")
    .onDelete("setNull"),
  userId: s.string().nullable(),
  user: s
    .toOne(() => user)
    .fields("userId")
    .references("id")
    .onDelete("cascade"),
  refreshId: s.string().nullable(),
  refresh: s
    .toOne(() => refreshToken)
    .fields("refreshId")
    .references("id")
    .onDelete("cascade"),
  resources: s.string().array().nullable(),
  expiresAt: s.dateTime(),
  createdAt: s.dateTime(),
  revoked: s.dateTime().nullable(),
  confirmation: s.json().nullable(),
  scopes: s.string().array(),
});

export const consent = s.model({
  id: s.string().id(),
  clientId: s.string(),
  client: s
    .toOne(() => appClient)
    .fields("clientId")
    .references("clientId")
    .onDelete("cascade"),
  userId: s.string().nullable(),
  user: s
    .toOne(() => user)
    .fields("userId")
    .references("id")
    .onDelete("cascade"),
  referenceId: s.string().nullable(),
  scopes: s.string().array(),
  createdAt: s.dateTime(),
  updatedAt: s.dateTime(),
});

export const clientAssertion = s.model({
  id: s.string().id(),
  expiresAt: s.dateTime(),
});

export const rateLimit = s.model({
  id: s.string().id(),
  key: s.string().unique(),
  count: s.int(),
  lastRequest: s.bigInt(),
});

export const identitySchema = {
  user,
  session,
  account,
  verification,
  factor,
  passkey,
  ssoProvider,
  organization,
  member,
  invitation,
  apiKey,
  signingKey,
  appClient,
  appResource,
  appClientResource,
  refreshToken,
  accessToken,
  consent,
  clientAssertion,
  rateLimit,
};
