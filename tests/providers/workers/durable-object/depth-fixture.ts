/**
 * A workspace page tree and its policy, shaped like a real Durable Object
 * application's (Flarion, 2026-11): four ordered levels, every level reached
 * through a share on the page or an ancestor (one recursive walk), a
 * teamspace list read from the actor, and admins. The essentials are copied
 * here; nothing is imported from that application.
 */
import { permissions, type Rule } from "@src/permissions";
import { s } from "@src/schema";
import { v } from "@src/validation";

export const LEVELS = ["read", "comment", "update", "full"] as const;

const page = s
  .model({
    id: s.string().id(),
    parentId: s.string().nullable().map("parent_id"),
    parent: s
      .toOne(() => page)
      .fields("parentId")
      .references("id")
      .onDelete("restrict"),
    children: s.toMany(() => page),
    teamspaceId: s.string().nullable().map("teamspace_id"),
    teamspace: s
      .toOne(() => teamspace)
      .fields("teamspaceId")
      .references("id")
      .onDelete("restrict"),
    title: s.string().default(""),
    createdById: s.string().map("created_by"),
    grants: s.toMany(() => grant),
  })
  .map("page")
  .index(["parentId"])
  .index(["teamspaceId"]);

const teamspace = s
  .model({
    id: s.string().id(),
    name: s.string(),
    privacy: s.string().default("open"),
    defaultLevel: s.string().default("update").map("default_level"),
    members: s.toMany(() => teamspaceMember),
    pages: s.toMany(() => page),
    grants: s.toMany(() => grant),
  })
  .map("teamspace");

const teamspaceMember = s
  .model({
    teamspaceId: s.string().map("teamspace_id"),
    teamspace: s
      .toOne(() => teamspace)
      .fields("teamspaceId")
      .references("id")
      .onDelete("cascade"),
    userId: s.string().map("user_id"),
    role: s.string().default("member"),
  })
  .id(["teamspaceId", "userId"])
  .map("teamspace_member");

const grant = s
  .model({
    id: s.string().id(),
    pageId: s.string().map("page_id"),
    page: s
      .toOne(() => page)
      .fields("pageId")
      .references("id")
      .onDelete("cascade"),
    subjectKind: s.string().map("subject_kind"),
    subjectId: s.string().nullable().map("subject_id"),
    teamspaceId: s.string().nullable().map("teamspace_id"),
    teamspace: s
      .toOne(() => teamspace)
      .fields("teamspaceId")
      .references("id")
      .onDelete("cascade"),
    subjectKey: s.string().map("subject_key"),
    level: s.string(),
    token: s.string().nullable(),
    deletedAt: s.dateTime().nullable().map("deleted_at"),
  })
  .index(["pageId"])
  .map("grant");

export const workspaceSchema = { page, teamspace, teamspaceMember, grant };

const actorSchema = v.object({
  userId: v.optional(v.string()),
  admin: v.boolean(),
  guest: v.boolean(),
  shareToken: v.optional(v.string()),
  subjects: v.array(v.string()),
  teamspaces: v.object({
    read: v.array(v.string()),
    comment: v.array(v.string()),
    update: v.array(v.string()),
    full: v.array(v.string()),
  }),
});

const isMember = { members: { some: { userId: { actor: "userId" } } } } as const;
const isOwner = {
  members: { some: { userId: { actor: "userId" }, role: "owner" } },
} as const;

/** Who holds a share at `level`: one OR over the four kinds of subject. */
const sharedWith = (level: string) => ({
  grants: {
    some: {
      level,
      deletedAt: null,
      OR: [
        { subjectKind: "user", subjectId: { actor: "userId" } },
        { subjectKind: "workspace", actor: { guest: false } },
        { subjectKind: "teamspace", teamspace: { is: isMember } },
        { subjectKind: "public", token: { actor: "shareToken" } },
      ],
    },
  },
});

/**
 * One level's rule. `levels` ORs the rule of every level at or above the one
 * asked, so `read` carries four copies of it, each with its ancestor walk.
 */
const access = (level: string): Rule => ({
  OR: [
    { actor: { admin: true } },
    { teamspace: { is: { defaultLevel: level, ...isMember } } },
    { teamspaceId: null, createdById: { actor: "userId" } },
    {
      parent: {
        recurse: { depth: false },
        self: true,
        some: sharedWith(level),
      },
    },
  ],
});

const levelsFrom = (level: string) =>
  LEVELS.slice(LEVELS.indexOf(level as (typeof LEVELS)[number]));

/** The same access with the level as data: one `in` list, one share key list. */
const compactAccess = (level: string): Rule => ({
  OR: [
    { actor: { admin: true } },
    { teamspaceId: { in: { actor: `teamspaces.${level}` } } },
    {
      parent: {
        recurse: { depth: false },
        self: true,
        some: {
          OR: [
            {
              grants: {
                some: {
                  level: { in: levelsFrom(level) },
                  deletedAt: null,
                  subjectKey: { in: { actor: "subjects" } },
                },
              },
            },
            {
              parentId: null,
              teamspaceId: null,
              createdById: { actor: "userId" },
            },
          ],
        },
      },
    },
  ],
});

const pageRules = (rule: (level: string) => Rule) =>
  ({
    operations: { delete: "full" },
    "read, comment, update": rule,
    full: (level: string) => ({
      OR: [rule(level), { teamspace: { is: isOwner } }],
    }),
    create: { OR: [{ parent: "update" }, { teamspace: { is: isMember } }] },
    fields: { parentId: { write: "full" }, teamspaceId: { write: "full" } },
  }) as const;

const supportingRules = {
  teamspace: {
    read: {
      OR: [
        {
          AND: [
            { privacy: { in: ["open", "closed"] } },
            { actor: { guest: false } },
          ],
        },
        isMember,
      ],
    },
    "update, full": isOwner,
    create: { actor: { guest: false } },
  },
  teamspaceMember: {
    read: { teamspace: "read" },
    create: { teamspace: "update" },
    update: { teamspace: "update" },
    delete: { teamspace: "update" },
  },
  grant: {
    read: { page: "read" },
    "create, update": { page: "full" },
    operations: { delete: "update" },
  },
} as const;

/** Every share kind spelled out per level: the deeper of the two. */
export const sketchPolicy = permissions({
  actor: actorSchema,
  levels: LEVELS,
  models: { page: pageRules(access), ...supportingRules },
});

/** The level as data, shares matched by key. */
export const compactPolicy = permissions({
  actor: actorSchema,
  levels: LEVELS,
  models: { page: pageRules(compactAccess), ...supportingRules },
});

/** A teamspace owner, with every fact the policy reads. */
export const owner = {
  userId: "bob",
  admin: false,
  guest: false,
  subjects: ["user:bob", "workspace", "teamspace:ts0"],
  teamspaces: {
    read: ["ts0"],
    comment: ["ts0"],
    update: ["ts0"],
    full: ["ts0"],
  },
};
