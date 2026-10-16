// Application-specific acceptance policy, shared by packed type checks and the
// independent authorization oracle. Every schema convention is written here;
// viborm/rbac supplies only the predicate and action language.

import { type Rule, rbac } from "@src/rbac";
import { v } from "@src/validation";

// Application grant/token vocabulary. These explicit tables describe which
// stored values cover each requested action; they are not a graph interpreter.
const levels = ["view", "edit", "full"] as const;
const levelCoverage = { view: levels, edit: ["edit", "full"], full: ["full"] };
const coverage: Readonly<
  Record<string, Readonly<Record<string, readonly string[]>>>
> = {
  organization: {
    ...levelCoverage,
    view: [...levels, "invite", "export"],
    invite: ["invite"],
    export: ["export"],
  },
  member: levelCoverage,
  user: levelCoverage,
  team: { ...levelCoverage, view: [...levels, "invite"], invite: ["invite"] },
  teamMember: {
    ...levelCoverage,
    view: [...levels, "manage"],
    manage: ["manage"],
  },
  accessGrant: levelCoverage,
  pageGroup: levelCoverage,
  page: levelCoverage,
  document: {
    view: ["view", "comment", "archive", "edit", "share", "export"],
    comment: ["comment", "edit", "share"],
    archive: ["archive", "edit", "share"],
    edit: ["edit", "share"],
    share: ["share"],
    export: ["export"],
  },
  collection: levelCoverage,
  bookmark: levelCoverage,
};

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

/** The user's supplied session or API key must still be live in the database. */
export const liveCredential = {
  OR: [
    {
      $if: { control: "actor", path: "session", exists: true },
      sessions: {
        some: { id: { actor: "session" }, expiresAt: { gt: { now: true } } },
      },
    },
    {
      $if: { control: "actor", path: "key", exists: true },
      apiKeys: {
        some: {
          id: { actor: "key.id" },
          enabled: true,
          OR: [{ expiresAt: null }, { expiresAt: { gt: { now: true } } }],
        },
      },
    },
  ],
} satisfies Rule;

export const activeUser = {
  AND: [
    {
      OR: [
        { banned: null },
        { banned: false },
        { banExpires: { lte: { now: true } } },
      ],
    },
    liveCredential,
  ],
} satisfies Rule;

/** Readers only view; members and admins may exercise every declared action. */
const inOrg: Rule = (action) => ({
  organization: {
    is: {
      members: {
        some: {
          userId: { actor: "userId" },
          role: {
            in:
              action === "view"
                ? ["reader", "member", "admin"]
                : ["member", "admin"],
          },
          user: { is: activeUser },
        },
      },
    },
  },
});

const organizationAdmin = {
  members: { some: { userId: { actor: "userId" }, role: { in: ["admin"] } } },
} satisfies Rule;
const admin: Rule = (_action, model) =>
  model.name === "organization"
    ? organizationAdmin
    : { organization: { is: organizationAdmin } };

/** The recipients this application allows a grant to name. */
const recipients = [
  { userId: { actor: "userId" } },
  { everyone: true },
  {
    granteeTeam: {
      is: {
        children: {
          recurse: { depth: false },
          self: true,
          some: { members: { some: { userId: { actor: "userId" } } } },
        },
      },
    },
  },
  {
    OR: ["admin", "member", "reader"].map((role) => ({
      granteeRole: role,
      organization: {
        is: { members: { some: { userId: { actor: "userId" }, role } } },
      },
    })),
  },
];

/** A grant's level or action list must cover the requested action. */
const given: Rule = (action, model) => ({
  grants: {
    some: {
      AND: [
        {
          OR: [
            ...(model.name !== "document"
              ? [
                  {
                    level: {
                      in: (coverage[model.name]?.[action] ?? []).filter(
                        (name) => levels.some((level) => level === name)
                      ),
                    },
                  },
                ]
              : []),
            { actions: { hasSome: coverage[model.name]?.[action] ?? [] } },
          ],
        },
        { OR: recipients },
      ],
    },
  },
});

/** A grant must name at least one resource; the writer administers all of them. */
const administerGrant = {
  AND: [
    {
      OR: [
        { pageId: { not: null } },
        { groupId: { not: null } },
        { documentId: { not: null } },
        { collectionId: { not: null } },
      ],
    },
    { OR: [{ pageId: null }, { page: "full" }] },
    { OR: [{ groupId: null }, { group: "full" }] },
    { OR: [{ documentId: null }, { document: "share" }] },
    { OR: [{ collectionId: null }, { collection: "full" }] },
  ],
} satisfies Rule;

/** Each attached resource also bounds every level/action the new grant carries. */
const placeGrant = {
  AND: [
    administerGrant,
    ...[
      { relation: "page", key: "pageId", actions: levels, levels },
      { relation: "group", key: "groupId", actions: levels, levels },
      {
        relation: "document",
        key: "documentId",
        actions: Object.keys(coverage.document!),
        levels: [],
      },
      { relation: "collection", key: "collectionId", actions: levels, levels },
    ].flatMap(({ relation, key, actions, levels }) => [
      ...actions.map((action) => ({
        OR: [
          { [key]: null },
          { NOT: { actions: { has: action } } },
          { [relation]: action },
        ],
      })),
      ...levels.map((level) => ({
        OR: [
          { [key]: null },
          { level: null },
          { level: { not: level } },
          { [relation]: level },
        ],
      })),
    ]),
  ],
} satisfies Rule;

/** Tokens restrict every model's scopes, and documents to listed subtrees. */
export const tokenRestrictions: Rule = (action, model) => ({
  OR: [
    { $if: { control: "actor", path: "key", exists: false } },
    {
      $if: {
        control: "actor",
        path: `key.scopes.${model.name}`,
        hasSome: [...(coverage[model.name]?.[action] ?? [])],
      },
      ...(model.name === "document"
        ? {
            OR: [
              {
                $if: {
                  control: "actor",
                  path: "key.resources.document",
                  equals: "all",
                },
              },
              {
                parent: {
                  recurse: { depth: false },
                  self: true,
                  some: { id: { in: { actor: "key.resources.document" } } },
                },
              },
            ],
          }
        : {}),
    },
  ],
});

const pageGroupAccess: Rule = {
  OR: [{ createdById: { actor: "userId" } }, admin, given],
};

const pageAccess: Rule = {
  OR: [
    { ownerId: { actor: "userId" } },
    { AND: [{ personal: false }, admin] },
    given,
    (a: string) => ({ personal: false, group: a }),
  ],
};

export const documentOwnership: Rule = {
  OR: [
    {
      parent: {
        recurse: { depth: false },
        self: true,
        some: { ownerId: { actor: "userId" } },
      },
    },
    {
      AND: [
        admin,
        {
          parent: {
            recurse: { depth: false },
            self: true,
            some: { parentId: null, personal: false },
          },
        },
      ],
    },
  ],
};
const documentAccess: Rule = {
  OR: [
    documentOwnership,
    { parent: { recurse: { depth: false }, self: true, some: given } },
  ],
};

const collectionAccess: Rule = {
  OR: [
    { ownerId: { actor: "userId" } },
    { status: "draft", createdById: { actor: "userId" } },
    given,
  ],
};

const bookmarkAccess: Rule = {
  OR: [{ userId: { actor: "userId" } }, admin],
};

export const policy = rbac({
  actor: Actor,
  levels, // ordered: full implies edit implies view
  limit: tokenRestrictions,
  models: {
    organization: {
      view: { members: { some: { userId: { actor: "userId" } } } },
      invite: admin,
      export: {
        AND: [admin, { plan: "pro" }, { actor: { network: "office" } }],
      }, // a row fact, and a request fact
    },
    member: {
      mandatory: inOrg,
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
      mandatory: inOrg,
      view: {},
      invite: {
        OR: [
          admin,
          { members: { some: { userId: { actor: "userId" }, role: "lead" } } },
        ],
      },
      edit: admin, // `parents` is read by the grant recipient rule: only admins re-parent
    },
    teamMember: {
      view: { team: "view" },
      manage: { team: "invite" },
      create: { team: "invite" },
      operations: { update: "manage", delete: "manage" },
    },
    accessGrant: {
      view: { OR: [{ userId: { actor: "userId" } }, administerGrant] },
      edit: administerGrant,
      create: placeGrant, // admin, one thing at least, contents bounded by what is held
      operations: { delete: "edit" },
    },
    pageGroup: {
      operations: { delete: "full" },
      mandatory: inOrg,
      "view, edit, full": pageGroupAccess,
    },
    page: {
      operations: { delete: "full" },
      mandatory: inOrg,
      "view, edit, full": pageAccess,
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
      mandatory: inOrg,
      actions: {
        view: [],
        comment: ["view"],
        archive: ["view"],
        edit: ["comment", "archive"],
        share: ["edit"],
        export: ["view"],
      },
      "view, comment, archive, edit, share, export": documentAccess,
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
      operations: { delete: "full" },
      mandatory: inOrg,
      "view, edit, full": collectionAccess,
      create: { createdById: { actor: "userId" } },
      fields: { budget: { read: "full" } },
    },
    // The fixture's polymorphic model (W-R9): a user's pins of pages and
    // documents; its `subject` arm reads under the target's own `view`.
    bookmark: {
      operations: { delete: "full" },
      mandatory: inOrg,
      "view, edit, full": bookmarkAccess,
    },
  },
});

// The stored-role variant: the ceiling read from `rolePermission` rows instead of declared.
const inOrgStored: Rule = (action, model) => ({
  organization: {
    is: {
      OR: ["admin", "member", "reader"].map((role) => ({
        members: {
          some: { userId: { actor: "userId" }, role, user: { is: activeUser } },
        },
        permissions: {
          some: { role, action: { in: coverage[model.name]?.[action] ?? [] } },
        },
      })),
    },
  },
});
const { models } = policy.config;
const mandatory = { mandatory: inOrgStored } as const;
export const storedPolicy = rbac({
  ...policy.config,
  models: {
    ...models,
    member: { ...models.member, ...mandatory },
    team: { ...models.team, ...mandatory },
    pageGroup: { ...models.pageGroup, ...mandatory },
    page: { ...models.page, ...mandatory },
    document: { ...models.document, ...mandatory },
    collection: { ...models.collection, ...mandatory },
    bookmark: { ...models.bookmark, ...mandatory },
  },
});

/**
 * The simplest case, a blog where the author edits and admins delete (§1.1),
 * on the fixture's `page`, whose required `organization` key §1.1's `post`
 * does not have: a created row's keys reach visible targets (R4), so the
 * fixture's organizations are listed, visible to all.
 */
export const blog = rbac({
  actor: v.object({ userId: v.string(), admin: v.boolean() }), // `admin`: an identity-provider claim, not a row of this database
  models: {
    page: {
      view: {},
      edit: { ownerId: { actor: "userId" } },
      delete: { actor: { admin: true } },
      create: { ownerId: { actor: "userId" } },
    },
    user: { view: {} },
    organization: { view: {} },
  },
});
