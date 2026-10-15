// The RBAC plan's acceptance policy (§1.1 `policy.ts`), verbatim over the
// rbac-app fixture except `v.optional(v.string())`, the validation library's
// spelling (§11.2 F8), and the stored-role variant's `roles`, which a stored
// ceiling needs to enumerate (the fixture's `member.role` is a string, not an
// enum). Read by the type program (`tests/package/type-rbac-smoke.mjs`, from
// the packed tarball) and by the compiler's witnesses (tests/unit/rbac).

import {
  everyone,
  grant,
  keyLimit,
  member,
  notBanned,
  owner,
  rbac,
  role,
  session,
  team,
  up,
} from "@src/rbac";
import { v } from "@src/validation";

/** Who calls: facts of the request only. Bound once by `db.$as(actor)`; nothing here is read from the database. */
export const Actor = v.object({
  userId: v.string(),
  organizationId: v.string(),
  network: v.string(), // where the request comes from ("office", "public"): a request fact
  session: v.optional(v.string()), // the session's id, never its bearer token (§5.4)
  key: v.optional(
    v.object({
      // an API key or a delegated token: its id and its immutable claims
      id: v.string(),
      scopes: v.record(v.string(), v.array(v.string())), // per model: the actions it may use
      resources: v.object({
        document: v.union([v.literal("all"), v.array(v.string())]),
      }), // "all" is written, never implied
    })
  ),
});

/** The organization role caps every arm: a reader granted edit holds view. */
const ceiling = { reader: "view", member: "full", admin: "full" };
/** An active member of the row's organization: not banned, on a live session or a live key, capped by its role. */
const inOrg = member({
  via: "organization",
  ceiling,
  user: { AND: [notBanned(), session()] },
});
const admin = member({ via: "organization", roles: ["admin"] });

/** Grants on a row, per action: to the actor, to everyone, to a team the actor is in or below, to the actor's role. */
const given = grant.to(
  [
    owner("userId"),
    everyone(),
    team("granteeTeam", { below: "children", memberOf: "members" }),
    role("granteeRole", { via: "organization" }),
  ],
  { relation: "grants", level: "level", actions: "actions" }
);
/** Who writes a grant: whoever administers EVERY thing it is attached to; never more than the writer holds there. */
const grants = grant.administer(
  { page: "full", group: "full", document: "share", collection: "full" },
  { level: "level", actions: "actions" }
);

export const policy = rbac({
  actor: Actor,
  levels: ["view", "edit", "full"], // ordered: full implies edit implies view
  limit: keyLimit({
    when: "key",
    scopes: "key.scopes",
    ids: { document: { path: "key.resources.document", through: "parent" } },
  }),
  models: {
    organization: {
      view: member(),
      invite: admin,
      export: {
        AND: [admin, { plan: "pro" }, { actor: { network: "office" } }],
      }, // a row fact, and a request fact
    },
    member: {
      within: inOrg,
      view: {},
      edit: admin, // the new row too: no move into an org the actor does not run
      create: { organization: "invite" }, // the invited user must be visible to the actor
      operations: { delete: "edit" },
    },
    user: {
      view: {
        members: { some: { organizationId: { actor: "organizationId" } } },
      },
    },
    team: {
      within: inOrg,
      view: {},
      invite: {
        OR: [
          admin,
          { members: { some: { userId: { actor: "userId" }, role: "lead" } } },
        ],
      },
      edit: admin, // `parents` is read by team(...): only admins re-parent
    },
    teamMember: {
      view: { team: "view" },
      manage: { team: "invite" },
      create: { team: "invite" },
      operations: { update: "manage", delete: "manage" },
    },
    accessGrant: {
      view: { OR: [{ userId: { actor: "userId" } }, grants.admin] },
      edit: grants.admin,
      create: grants.place, // admin, one thing at least, contents bounded by what is held
      operations: { delete: "edit" },
    },
    pageGroup: { within: inOrg, arms: [owner("createdById"), admin, given] },
    page: {
      within: inOrg,
      arms: [
        owner("ownerId"),
        { AND: [{ personal: false }, admin] },
        given,
        (a) => ({ personal: false, group: a }),
      ],
      create: {
        OR: [
          { group: "edit" },
          { groupId: null, personal: true, ownerId: { actor: "userId" } },
        ],
      },
      fields: { ownerId: { write: "full" } },
      domains: { given }, // `as: "given"`: P(view) ∧ given(view)
    },
    document: {
      within: inOrg,
      actions: {
        view: [],
        comment: ["view"],
        archive: ["view"],
        edit: ["comment", "archive"],
        share: ["edit"],
        export: ["view"],
      },
      arms: [
        up("parent", owner("ownerId")),
        { AND: [admin, up("parent", { parentId: null, personal: false })] },
        up("parent", given),
      ],
      operations: { delete: "share" },
      create: {
        OR: [
          { parent: "edit" },
          { parentId: null, ownerId: { actor: "userId" } },
        ],
      },
      fields: { ownerId: { write: "share" }, archivedAt: { write: "archive" } },
    },
    collection: {
      within: inOrg,
      arms: [
        owner("ownerId"),
        { status: "draft", createdById: { actor: "userId" } },
        given,
      ],
      create: { createdById: { actor: "userId" } },
      fields: { budget: { read: "full" } },
    },
  },
});

// The stored-role variant: the ceiling read from `rolePermission` rows instead of declared.
const inOrgStored = member({
  via: "organization",
  roles: ["admin", "member", "reader"],
  ceiling: { relation: "permissions", action: "action" },
  user: { AND: [notBanned(), session()] },
});
const { models } = policy.config;
const within = { within: inOrgStored } as const;
export const storedPolicy = rbac({
  ...policy.config,
  models: {
    ...models,
    member: { ...models.member, ...within },
    team: { ...models.team, ...within },
    pageGroup: { ...models.pageGroup, ...within },
    page: { ...models.page, ...within },
    document: { ...models.document, ...within },
    collection: { ...models.collection, ...within },
  },
});

/** The simplest case, a blog where the author edits and admins delete (§1.1), on the fixture's `page`. */
export const blog = rbac({
  actor: v.object({ userId: v.string(), admin: v.boolean() }), // `admin`: an identity-provider claim, not a row of this database
  models: {
    page: {
      view: {},
      edit: owner("ownerId"),
      delete: { actor: { admin: true } },
      create: { ownerId: { actor: "userId" } },
    },
    user: { view: {} },
  },
});
