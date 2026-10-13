// Synthetic catalogue models: integrations with revisions (two named to-one
// pointers back into the revision table), auth methods, callable methods,
// per-organization connections and approvals, and some bookkeeping.

import { s } from "viborm";
import { organization, user } from "./identity";

export const integration = s.model({
  id: s.string().id(),
  slug: s.string().unique(),
  name: s.string(),
  summary: s.string().nullable(),
  description: s.string().nullable(),
  category: s.string(),
  vendor: s.string().nullable(),
  homepage: s.string().nullable(),
  docsUrl: s.string().nullable(),
  icon: s.string().nullable(),
  color: s.string().nullable(),
  tags: s.string().array(),
  status: s.enum(["draft", "review", "published", "retired"]).default("draft"),
  visibility: s.enum(["public", "private"]).default("public"),
  featured: s.boolean().default(false),
  rank: s.int().default(0),
  baseUrl: s.string().nullable(),
  rateLimit: s.int().nullable(),
  timeoutMs: s.int().nullable(),
  retries: s.int().default(0),
  metadata: s.json().nullable(),
  createdAt: s.dateTime().now(),
  updatedAt: s.dateTime().updatedAt(),
  publishedAt: s.dateTime().nullable(),
  currentRevisionId: s.string().nullable(),
  curatedRevisionId: s.string().nullable(),
  revisions: s.toMany(() => revision).name("integrationRevisions"),
  currentRevision: s
    .toOne(() => revision)
    .name("currentRevision")
    .fields("currentRevisionId")
    .references("id")
    .onDelete("setNull"),
  curatedRevision: s
    .toOne(() => revision)
    .name("curatedRevision")
    .fields("curatedRevisionId")
    .references("id")
    .onDelete("setNull"),
  connections: s.toMany(() => connection),
  approvals: s.toMany(() => approval),
});

export const revision = s
  .model({
    id: s.string().id(),
    integrationId: s.string(),
    integration: s
      .toOne(() => integration)
      .name("integrationRevisions")
      .fields("integrationId")
      .references("id")
      .onDelete("cascade"),
    currentOf: s.toMany(() => integration).name("currentRevision"),
    curatedOf: s.toMany(() => integration).name("curatedRevision"),
    number: s.int(),
    spec: s.json(),
    specHash: s.string(),
    source: s.string().nullable(),
    notes: s.string().nullable(),
    status: s.enum(["pending", "valid", "invalid"]).default("pending"),
    errors: s.json().nullable(),
    createdBy: s.string().nullable(),
    createdAt: s.dateTime().now(),
    validatedAt: s.dateTime().nullable(),
    auths: s.toMany(() => authMethod),
    methods: s.toMany(() => method),
  })
  .unique(["integrationId", "number"]);

export const authMethod = s.model({
  id: s.string().id(),
  revisionId: s.string(),
  revision: s
    .toOne(() => revision)
    .fields("revisionId")
    .references("id")
    .onDelete("cascade"),
  kind: s.enum(["oauth2", "apiKey", "basic", "none"]),
  name: s.string(),
  authorizeUrl: s.string().nullable(),
  tokenUrl: s.string().nullable(),
  scopes: s.string().array(),
  headerName: s.string().nullable(),
  config: s.json().nullable(),
  createdAt: s.dateTime().now(),
  connections: s.toMany(() => connection),
});

export const method = s.model({
  id: s.string().id(),
  revisionId: s.string(),
  revision: s
    .toOne(() => revision)
    .fields("revisionId")
    .references("id")
    .onDelete("cascade"),
  name: s.string(),
  summary: s.string().nullable(),
  verb: s.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
  path: s.string(),
  input: s.json().nullable(),
  output: s.json().nullable(),
  sideEffects: s.boolean().default(false),
  needsApproval: s.boolean().default(false),
  costHint: s.int().nullable(),
  createdAt: s.dateTime().now(),
  approvals: s.toMany(() => approval),
  observations: s.toMany(() => observation),
});

export const connection = s.model({
  id: s.string().id(),
  organizationId: s.string(),
  organization: s
    .toOne(() => organization)
    .fields("organizationId")
    .references("id")
    .onDelete("cascade"),
  ownerUserId: s.string().nullable(),
  ownerUser: s
    .toOne(() => user)
    .name("connectionOwner")
    .fields("ownerUserId")
    .references("id")
    .onDelete("cascade"),
  integrationId: s.string(),
  integration: s
    .toOne(() => integration)
    .fields("integrationId")
    .references("id")
    .onDelete("restrict"),
  authId: s.string(),
  auth: s
    .toOne(() => authMethod)
    .fields("authId")
    .references("id")
    .onDelete("restrict"),
  label: s.string(),
  secretRef: s.string().nullable(),
  status: s.enum(["active", "expired", "revoked"]).default("active"),
  expiresAt: s.dateTime().nullable(),
  createdBy: s.string().nullable(),
  creator: s
    .toOne(() => user)
    .name("connectionCreator")
    .fields("createdBy")
    .references("id")
    .onDelete("setNull"),
  createdAt: s.dateTime().now(),
  updatedAt: s.dateTime().updatedAt(),
});

export const approval = s.model({
  id: s.string().id(),
  organizationId: s.string(),
  organization: s
    .toOne(() => organization)
    .fields("organizationId")
    .references("id")
    .onDelete("cascade"),
  methodId: s.string(),
  method: s
    .toOne(() => method)
    .fields("methodId")
    .references("id")
    .onDelete("cascade"),
  integrationId: s.string(),
  integration: s
    .toOne(() => integration)
    .fields("integrationId")
    .references("id")
    .onDelete("cascade"),
  state: s.enum(["pending", "approved", "denied"]).default("pending"),
  requestedBy: s.string().nullable(),
  requester: s
    .toOne(() => user)
    .name("approvalRequester")
    .fields("requestedBy")
    .references("id")
    .onDelete("setNull"),
  decidedBy: s.string().nullable(),
  decider: s
    .toOne(() => user)
    .name("approvalDecider")
    .fields("decidedBy")
    .references("id")
    .onDelete("setNull"),
  reason: s.string().nullable(),
  createdAt: s.dateTime().now(),
  decidedAt: s.dateTime().nullable(),
});

export const observation = s.model({
  id: s.string().id(),
  organizationId: s.string(),
  organization: s
    .toOne(() => organization)
    .fields("organizationId")
    .references("id")
    .onDelete("cascade"),
  methodId: s.string(),
  method: s
    .toOne(() => method)
    .fields("methodId")
    .references("id")
    .onDelete("cascade"),
  shape: s.json(),
  samples: s.int().default(0),
  createdAt: s.dateTime().now(),
});

export const callLog = s.model({
  id: s.string().id(),
  organizationId: s.string(),
  connectionId: s.string().nullable(),
  methodName: s.string(),
  status: s.int(),
  durationMs: s.int(),
  error: s.string().nullable(),
  createdAt: s.dateTime().now(),
});

export const billing = s.model({
  organizationId: s.string().id(),
  organization: s
    .toOne(() => organization)
    .fields("organizationId")
    .references("id")
    .onDelete("cascade"),
  plan: s.string(),
  seats: s.int().default(1),
  customerRef: s.string().nullable(),
  renewsAt: s.dateTime().nullable(),
  createdAt: s.dateTime().now(),
});

export const orgCreation = s.model({
  id: s.string().id(),
  userId: s.string(),
  user: s
    .toOne(() => user)
    .fields("userId")
    .references("id")
    .onDelete("cascade"),
  createdAt: s.dateTime().now(),
});

export const integrationsSchema = {
  integration,
  revision,
  authMethod,
  method,
  connection,
  approval,
  observation,
  callLog,
  billing,
  orgCreation,
};
