// Application-specific acceptance policy, shared by packed type checks and the
// independent authorization oracle. Every schema convention is written here;
// viborm/rbac supplies only the predicate and action language.

import { type Rule, rbac, type Where } from "@src/rbac";
import { v } from "@src/validation";

// Application grant/token vocabulary. These explicit tables describe which
// stored values cover each requested action; they are not a graph interpreter.
const levels = ["read", "update", "full"] as const;
const levelCoverage = {
  read: [...levels, "create"],
  update: ["update", "full"],
  full: ["full"],
  create: ["create"],
};
const coverage: Readonly<
  Record<string, Readonly<Record<string, readonly string[]>>>
> = {
  organization: {
    ...levelCoverage,
    read: [...levels, "invite", "export"],
    invite: ["invite"],
    export: ["export"],
  },
  member: levelCoverage,
  user: levelCoverage,
  team: { ...levelCoverage, read: [...levels, "invite"], invite: ["invite"] },
  teamMember: {
    ...levelCoverage,
    read: [...levels, "manage", "create"],
    manage: ["manage"],
  },
  accessGrant: levelCoverage,
  pageGroup: levelCoverage,
  page: levelCoverage,
  document: {
    create: ["create"],
    read: ["read", "comment", "archive", "update", "share", "export", "create"],
    comment: ["comment", "update", "share"],
    archive: ["archive", "update", "share"],
    update: ["update", "share"],
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

/** Readers only read; members and admins may exercise every declared action. */
const inOrg: Rule = (action) => ({
  organization: {
    is: {
      members: {
        some: {
          userId: { actor: "userId" },
          role: {
            in:
              action === "read"
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

const memberBoundary: Where = {
  organization: {
    is: {
      members: {
        some: {
          userId: { actor: "userId" },
          user: { is: activeUser },
        },
      },
    },
  },
};

// Application-owned restrictions live in named grants. They are evaluated for
// the action declared by that grant, then inherited without reinterpretation.
export function policyFor(
  ceiling: Rule = inOrg,
  documentRule: Rule = documentAccess
) {
  const token = (rule: Rule): Rule => ({ AND: [tokenRestrictions, rule] });
  const capped = (rule: Rule): Rule => ({
    AND: [ceiling, tokenRestrictions, rule],
  });
  return rbac({
    actor: Actor,
    levels, // ordered: full implies update implies read
    models: {
      organization: {
        actions: {
          read: [],
          update: ["read"],
          full: ["update"],
          invite: ["read"],
          export: ["read"],
        },
        read: token({ members: { some: { userId: { actor: "userId" } } } }),
        invite: token(admin),
        export: token({
          AND: [admin, { plan: "pro" }, { actor: { network: "office" } }],
        }), // a row fact, and a request fact
      },
      member: {
        mandatory: memberBoundary,
        read: capped({}),
        update: capped(admin), // the new row too: no move into an org the actor does not run
        create: capped({ organization: "invite" }), // the invited user must be visible to the actor
        operations: { delete: "update" },
      },
      user: {
        read: token({
          members: { some: { organizationId: { actor: "organizationId" } } },
        }),
      },
      team: {
        actions: {
          read: [],
          update: ["read"],
          full: ["update"],
          invite: ["read"],
        },
        mandatory: memberBoundary,
        read: capped({}),
        invite: capped({
          OR: [
            admin,
            {
              members: { some: { userId: { actor: "userId" }, role: "lead" } },
            },
          ],
        }),
        update: capped(admin), // `parents` is read by the grant recipient rule: only admins re-parent
      },
      teamMember: {
        actions: {
          read: [],
          update: ["read"],
          full: ["update"],
          manage: ["read"],
          create: ["read"],
        },
        read: token({ team: "read" }),
        manage: token({ team: "invite" }),
        create: token({ team: "invite" }),
        operations: { update: "manage", delete: "manage" },
      },
      accessGrant: {
        read: token({ OR: [{ userId: { actor: "userId" } }, administerGrant] }),
        update: token(administerGrant),
        create: token(placeGrant), // admin, one thing at least, contents bounded by what is held
        operations: { delete: "update" },
      },
      pageGroup: {
        operations: { delete: "full" },
        mandatory: memberBoundary,
        "read, update, full": capped(pageGroupAccess),
      },
      page: {
        operations: { delete: "full" },
        mandatory: memberBoundary,
        "read, update, full": capped(pageAccess),
        create: capped({
          OR: [
            { group: "update" },
            { groupId: null, personal: true, ownerId: { actor: "userId" } },
          ],
        }),
        fields: { ownerId: { write: "full" } },
        domains: { given }, // `as: "given"`: P(read) ∧ given(read)
      },
      document: {
        mandatory: memberBoundary,
        actions: {
          read: [],
          create: ["read"],
          comment: ["read"],
          archive: ["read"],
          update: ["comment", "archive"],
          share: ["update"],
          export: ["read"],
        },
        "read, comment, archive, update, share, export": capped(documentRule),
        operations: { delete: "share" },
        create: capped({
          OR: [
            { parent: "update" },
            { parentId: null, ownerId: { actor: "userId" } },
          ],
        }),
        fields: {
          ownerId: { write: "share" },
          archivedAt: { write: "archive" },
        },
      },
      collection: {
        operations: { delete: "full" },
        mandatory: memberBoundary,
        "read, update, full": capped(collectionAccess),
        create: capped({ createdById: { actor: "userId" } }),
        fields: { budget: { read: "full" } },
      },
      // The fixture's polymorphic model (W-R9): a user's pins of pages and
      // documents; its `subject` arm reads under the target's own `read`.
      bookmark: {
        operations: { delete: "full" },
        mandatory: memberBoundary,
        "read, update, full": capped(bookmarkAccess),
      },
    },
  });
}
export const policy = policyFor(inOrg);

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
export const storedPolicy = policyFor(inOrgStored);

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
      read: {},
      update: { ownerId: { actor: "userId" } },
      delete: { actor: { admin: true } },
      create: { ownerId: { actor: "userId" } },
    },
    user: { read: {} },
    organization: { read: {} },
  },
});
