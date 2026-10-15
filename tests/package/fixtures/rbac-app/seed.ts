// The deterministic seed of the RBAC acceptance fixture (plan §1.1, §6.1 U0)
// and the actors the oracle and the runners judge. Plain data: no VibORM
// import, no clock, no randomness beyond a fixed-seed generator, so every
// substrate loads the same rows and the oracle reads the same facts.
//
// Scale: 3 organizations, 60 users (two overlapping memberships, two
// outsiders), 20 teams in a graph with shared parents (diamonds), 15 page
// groups, 200 pages, 150 documents in trees up to depth 6, 30 collections,
// ~280 grants of every arc kind, grantee kind, level and action, tombstoned
// members, team members, pages and grants, sessions and API keys live,
// expired and disabled.
//
// Every instant is either far in the past or far in the future, so the
// verdicts do not depend on when a run happens (the oracle still takes the
// call's instant, plan R7).

export const PAST = new Date("2020-01-01T00:00:00.000Z");
export const FUTURE = new Date("2099-01-01T00:00:00.000Z");
const CREATED = new Date("2026-01-01T00:00:00.000Z");

export const LEVELS = ["view", "edit", "full"] as const;
export const DOCUMENT_ACTIONS = [
  "view",
  "comment",
  "archive",
  "edit",
  "share",
  "export",
] as const;
/** Every action name a §1.1 model declares; what `member` and `admin` store in `rolePermission`. */
export const ALL_ACTIONS = [
  "view",
  "edit",
  "full",
  "invite",
  "export",
  "comment",
  "archive",
  "share",
  "manage",
] as const;

export interface OrganizationRow {
  id: string;
  name: string;
  slug: string;
  logo: string | null;
  plan: "free" | "pro";
  createdAt: Date;
  metadata: string | null;
}
export interface UserRow {
  id: string;
  name: string;
  email: string;
  createdAt: Date;
  updatedAt: Date;
  banned: boolean | null;
  banExpires: Date | null;
}
export interface SessionRow {
  id: string;
  expiresAt: Date;
  token: string;
  createdAt: Date;
  updatedAt: Date;
  userId: string;
  activeOrganizationId: string | null;
}
export interface ApiKeyRow {
  id: string;
  referenceId: string;
  key: string;
  enabled: boolean;
  expiresAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}
export interface MemberRow {
  id: string;
  organizationId: string;
  userId: string;
  role: string;
  createdAt: Date;
  deletedAt: Date | null;
}
export interface RolePermissionRow {
  organizationId: string;
  role: string;
  action: string;
}
export interface TeamRow {
  id: string;
  organizationId: string;
  name: string;
  createdAt: Date;
}
export interface TeamParentEdge {
  childId: string;
  parentId: string;
}
export interface TeamMemberRow {
  teamId: string;
  userId: string;
  role: string;
  createdAt: Date;
  deletedAt: Date | null;
}
export interface PageGroupRow {
  id: string;
  organizationId: string;
  label: string;
  icon: string;
  position: number;
  createdById: string | null;
  createdAt: Date;
}
export interface PageRow {
  id: string;
  organizationId: string;
  title: string;
  position: number;
  ownerId: string | null;
  groupId: string | null;
  personal: boolean;
  deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}
export interface DocumentRow {
  id: string;
  organizationId: string;
  parentId: string | null;
  title: string;
  position: number;
  ownerId: string | null;
  personal: boolean;
  archivedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}
export interface CollectionRow {
  id: string;
  organizationId: string;
  name: string;
  ownerId: string | null;
  personal: boolean;
  status: "draft" | "active" | "archived";
  createdById: string | null;
  budget: number;
  createdAt: Date;
}
export interface AccessGrantRow {
  id: string;
  key: string;
  organizationId: string;
  pageId: string | null;
  groupId: string | null;
  documentId: string | null;
  collectionId: string | null;
  userId: string | null;
  granteeTeamId: string | null;
  granteeRole: "admin" | "member" | "reader" | null;
  everyone: boolean;
  level: (typeof LEVELS)[number] | null;
  actions: string[];
  grantedBy: string | null;
  createdAt: Date;
  deletedAt: Date | null;
}

export interface RbacSeed {
  readonly organization: readonly OrganizationRow[];
  readonly user: readonly UserRow[];
  readonly session: readonly SessionRow[];
  readonly apiKey: readonly ApiKeyRow[];
  readonly member: readonly MemberRow[];
  readonly rolePermission: readonly RolePermissionRow[];
  readonly team: readonly TeamRow[];
  readonly teamParent: readonly TeamParentEdge[];
  readonly teamMember: readonly TeamMemberRow[];
  readonly pageGroup: readonly PageGroupRow[];
  readonly page: readonly PageRow[];
  /** Parents before children: the order a loader inserts them in. */
  readonly document: readonly DocumentRow[];
  readonly collection: readonly CollectionRow[];
  readonly accessGrant: readonly AccessGrantRow[];
}

/**
 * The Park-Miller minimal standard generator: a fixed-seed sequence in plain
 * arithmetic (every product stays below 2^53), the same on every run.
 */
function generator(seed: number) {
  const MODULUS = 2_147_483_647;
  let state = (seed % (MODULUS - 1)) + 1;
  const next = () => {
    state = (state * 48_271) % MODULUS;
    return (state - 1) / (MODULUS - 1);
  };
  const below = (n: number) => Math.floor(next() * n);
  const pick = <T>(items: readonly T[]): T => {
    const item = items[below(items.length)];
    if (item === undefined) throw new Error("seed: pick from an empty list");
    return item;
  };
  return { next, below, pick, chance: (p: number) => next() < p };
}

const pad = (n: number, width = 2) => String(n).padStart(width, "0");
export const userId = (n: number) => `user-${pad(n)}`;

const ORGANIZATIONS: readonly OrganizationRow[] = [
  ["org-1", "Northwind", "pro"],
  ["org-2", "Southbank", "free"],
  ["org-3", "Eastfield", "pro"],
].map(([id, name, plan]) => ({
  id: id as string,
  name: name as string,
  slug: (name as string).toLowerCase(),
  logo: null,
  plan: plan as "free" | "pro",
  createdAt: CREATED,
  metadata: null,
}));

/** Users by organization, in membership order (the first two are admins, every fourth a reader). */
const ROSTERS: Record<string, readonly number[]> = {
  "org-1": range(1, 25),
  "org-2": range(20, 45),
  "org-3": range(40, 58),
};
/** Memberships that exist only as tombstones (soft-deleted). */
const TOMBSTONED_MEMBERS = new Set([
  "org-1:user-08",
  "org-1:user-59",
  "org-3:user-44",
]);

function range(from: number, to: number): number[] {
  return Array.from({ length: to - from + 1 }, (_, i) => from + i);
}

/** Team graph: [id, organization, name, parents]. Diamonds: t1-web, t1-guild, t2-emea, t3-field. */
const TEAMS: readonly (readonly [string, string, string, readonly string[]])[] =
  [
    ["t1-root", "org-1", "Company", []],
    ["t1-eng", "org-1", "Engineering", ["t1-root"]],
    ["t1-design", "org-1", "Design", ["t1-root"]],
    ["t1-web", "org-1", "Web", ["t1-eng", "t1-design"]],
    ["t1-mobile", "org-1", "Mobile", ["t1-eng"]],
    ["t1-infra", "org-1", "Infrastructure", ["t1-eng"]],
    ["t1-ops", "org-1", "Operations", ["t1-root"]],
    ["t1-guild", "org-1", "Frontend guild", ["t1-web", "t1-mobile"]],
    ["t2-root", "org-2", "Company", []],
    ["t2-sales", "org-2", "Sales", ["t2-root"]],
    ["t2-support", "org-2", "Support", ["t2-root"]],
    ["t2-emea", "org-2", "EMEA", ["t2-sales", "t2-support"]],
    ["t2-apac", "org-2", "APAC", ["t2-sales"]],
    ["t2-tier2", "org-2", "Tier 2", ["t2-support"]],
    ["t2-lone", "org-2", "Standalone", []],
    ["t3-root", "org-3", "Company", []],
    ["t3-research", "org-3", "Research", ["t3-root"]],
    ["t3-lab", "org-3", "Lab", ["t3-research"]],
    ["t3-field", "org-3", "Field", ["t3-research", "t3-root"]],
    ["t3-solo", "org-3", "Solo", []],
  ];

function buildSeed(): RbacSeed {
  const random = generator(20_261_015);

  const users: UserRow[] = range(1, 60).map((n) => ({
    id: userId(n),
    name: `User ${pad(n)}`,
    email: `user${pad(n)}@example.test`,
    createdAt: CREATED,
    updatedAt: CREATED,
    // 13: banned, no expiry; 31: banned until FUTURE; 46: a ban that expired;
    // 22: `banned` null (not banned).
    banned: n === 13 || n === 31 || n === 46 ? true : n === 22 ? null : false,
    banExpires: n === 31 ? FUTURE : n === 46 ? PAST : null,
  }));

  const members: MemberRow[] = [];
  for (const [organizationId, roster] of Object.entries(ROSTERS)) {
    roster.forEach((n, index) => {
      const role = index < 2 ? "admin" : index % 4 === 3 ? "reader" : "member";
      members.push({
        id: `mem-${organizationId}-${pad(n)}`,
        organizationId,
        userId: userId(n),
        role,
        createdAt: CREATED,
        deletedAt: TOMBSTONED_MEMBERS.has(`${organizationId}:${userId(n)}`)
          ? PAST
          : null,
      });
    });
  }
  // user-59: a membership that exists only as a tombstone.
  members.push({
    id: "mem-org-1-59",
    organizationId: "org-1",
    userId: userId(59),
    role: "admin",
    createdAt: CREATED,
    deletedAt: PAST,
  });

  const firstOrganization = (user: string) =>
    members.find((m) => m.userId === user && m.deletedAt === null)
      ?.organizationId ?? null;

  const sessions: SessionRow[] = [];
  for (const n of range(1, 60)) {
    const id = userId(n);
    // Users 07, 17, 27, 37, 47, 57 have no live session.
    if (n % 10 !== 7) {
      sessions.push({
        id: `ses-${pad(n)}-live`,
        expiresAt: FUTURE,
        token: `tok-${pad(n)}-live`,
        createdAt: CREATED,
        updatedAt: CREATED,
        userId: id,
        activeOrganizationId: firstOrganization(id),
      });
    }
    if (n % 3 === 0 || n % 10 === 7) {
      sessions.push({
        id: `ses-${pad(n)}-old`,
        expiresAt: PAST,
        token: `tok-${pad(n)}-old`,
        createdAt: CREATED,
        updatedAt: CREATED,
        userId: id,
        activeOrganizationId: firstOrganization(id),
      });
    }
  }

  const apiKeys: ApiKeyRow[] = (
    [
      ["key-02-a", 2, true, null],
      ["key-02-b", 2, false, null],
      ["key-03-a", 3, true, PAST],
      ["key-05-a", 5, true, FUTURE],
      ["key-21-a", 21, true, null],
      ["key-41-a", 41, true, FUTURE],
      ["key-50-a", 50, true, null],
      ["key-50-b", 50, false, FUTURE],
    ] as const
  ).map(([id, n, enabled, expiresAt]) => ({
    id,
    referenceId: userId(n),
    key: `secret-${id}`,
    enabled,
    expiresAt,
    createdAt: CREATED,
    updatedAt: CREATED,
  }));

  const rolePermissions: RolePermissionRow[] = [];
  for (const { id } of ORGANIZATIONS) {
    for (const role of ["admin", "member", "reader"]) {
      for (const action of role === "reader" ? ["view"] : ALL_ACTIONS) {
        rolePermissions.push({ organizationId: id, role, action });
      }
    }
  }

  const teams: TeamRow[] = TEAMS.map(([id, organizationId, name]) => ({
    id,
    organizationId,
    name,
    createdAt: CREATED,
  }));
  const teamParents: TeamParentEdge[] = TEAMS.flatMap(
    ([childId, , , parents]) =>
      parents.map((parentId) => ({ childId, parentId }))
  );

  const rosterOf = (organizationId: string) =>
    members
      .filter((m) => m.organizationId === organizationId)
      .map((m) => m.userId);
  const liveRosterOf = (organizationId: string) =>
    members
      .filter((m) => m.organizationId === organizationId && !m.deletedAt)
      .map((m) => m.userId);

  const teamMembers: TeamMemberRow[] = [];
  let teamMemberCount = 0;
  for (const team of teams) {
    const roster = rosterOf(team.organizationId);
    const size = 3 + random.below(3);
    const chosen = new Set<string>();
    while (chosen.size < size) chosen.add(random.pick(roster));
    [...chosen].forEach((user, index) => {
      teamMemberCount += 1;
      teamMembers.push({
        teamId: team.id,
        userId: user,
        role: index === 0 ? "lead" : "member",
        createdAt: CREATED,
        deletedAt: teamMemberCount % 7 === 0 ? PAST : null,
      });
    });
  }

  const pageGroups: PageGroupRow[] = [];
  for (const { id: organizationId } of ORGANIZATIONS) {
    for (const n of range(1, 5)) {
      pageGroups.push({
        id: `grp-${organizationId.slice(4)}-${n}`,
        organizationId,
        label: `Group ${n}`,
        icon: "folder",
        position: n,
        createdById: n === 5 ? null : random.pick(liveRosterOf(organizationId)),
        createdAt: CREATED,
      });
    }
  }

  const pages: PageRow[] = [];
  const PAGES: Record<string, number> = {
    "org-1": 80,
    "org-2": 70,
    "org-3": 50,
  };
  for (const [organizationId, count] of Object.entries(PAGES)) {
    const groups = pageGroups.filter(
      (g) => g.organizationId === organizationId
    );
    const roster = rosterOf(organizationId);
    for (let i = 0; i < count; i += 1) {
      const n = pages.length + 1;
      pages.push({
        id: `page-${pad(n, 3)}`,
        organizationId,
        title: `Page ${n}`,
        position: n,
        ownerId: random.chance(0.1) ? null : random.pick(roster),
        groupId: random.chance(0.25) ? null : random.pick(groups).id,
        personal: random.chance(0.15),
        deletedAt: random.chance(0.08) ? PAST : null,
        createdAt: CREATED,
        updatedAt: CREATED,
      });
    }
  }

  const documents: DocumentRow[] = [];
  const DOCUMENTS: Record<string, number> = {
    "org-1": 60,
    "org-2": 50,
    "org-3": 40,
  };
  for (const [organizationId, count] of Object.entries(DOCUMENTS)) {
    const roster = rosterOf(organizationId);
    const depth = new Map<string, number>();
    const local: DocumentRow[] = [];
    for (let i = 0; i < count; i += 1) {
      const n = documents.length + local.length + 1;
      let parent: DocumentRow | undefined;
      if (i >= 5 && i < 10) {
        // One chain per organization reaches depth 6: root 0 -> 5 -> 6 -> 7 -> 8 -> 9.
        parent = local[i === 5 ? 0 : i - 1];
      } else if (i >= 10) {
        const candidates = local.filter((d) => (depth.get(d.id) ?? 1) < 6);
        parent = random.pick(candidates);
      }
      const isRoot = parent === undefined;
      const row: DocumentRow = {
        id: `doc-${pad(n, 3)}`,
        organizationId,
        parentId: parent?.id ?? null,
        title: `Document ${n}`,
        position: n,
        ownerId: random.chance(0.15) ? null : random.pick(roster),
        personal: random.chance(isRoot ? 0.3 : 0.1),
        archivedAt: random.chance(0.1) ? PAST : null,
        createdAt: CREATED,
        updatedAt: CREATED,
      };
      depth.set(row.id, parent ? (depth.get(parent.id) ?? 1) + 1 : 1);
      local.push(row);
    }
    documents.push(...local);
  }

  const collections: CollectionRow[] = [];
  const STATUSES = ["draft", "active", "archived"] as const;
  for (const { id: organizationId } of ORGANIZATIONS) {
    const roster = rosterOf(organizationId);
    for (const n of range(1, 10)) {
      collections.push({
        id: `col-${organizationId.slice(4)}-${pad(n)}`,
        organizationId,
        name: `Collection ${n}`,
        ownerId: random.chance(0.2) ? null : random.pick(roster),
        personal: random.chance(0.2),
        status: STATUSES[(n + random.below(2)) % 3] ?? "draft",
        createdById: random.chance(0.15) ? null : random.pick(roster),
        budget: random.below(100_000),
        createdAt: CREATED,
      });
    }
  }

  const grants: AccessGrantRow[] = [];
  const thingKinds = ["page", "pageGroup", "document", "collection"] as const;
  type ThingKind = (typeof thingKinds)[number];
  const thingsOf = (kind: ThingKind, organizationId: string): string[] => {
    const rows =
      kind === "page"
        ? pages
        : kind === "pageGroup"
          ? pageGroups
          : kind === "document"
            ? documents
            : collections;
    return rows
      .filter((r) => r.organizationId === organizationId)
      .map((r) => r.id);
  };
  const thingKey = {
    page: "pageId",
    pageGroup: "groupId",
    document: "documentId",
    collection: "collectionId",
  } as const;
  const GRANTS = 280;
  for (let i = 0; i < GRANTS; i += 1) {
    const organizationId = random.pick([
      "org-1",
      "org-1",
      "org-2",
      "org-2",
      "org-3",
    ]);
    const kind = thingKinds[i % 4] as ThingKind;
    const roster = rosterOf(organizationId);
    const teamsHere = teams.filter((t) => t.organizationId === organizationId);
    const row: AccessGrantRow = {
      id: `grant-${pad(i + 1, 3)}`,
      key: `grant-key-${pad(i + 1, 3)}`,
      organizationId,
      pageId: null,
      groupId: null,
      documentId: null,
      collectionId: null,
      userId: null,
      granteeTeamId: null,
      granteeRole: null,
      everyone: false,
      level: null,
      actions: [],
      grantedBy: random.chance(0.2) ? null : random.pick(roster),
      createdAt: CREATED,
      deletedAt: random.chance(0.07) ? PAST : null,
    };
    row[thingKey[kind]] = random.pick(thingsOf(kind, organizationId));
    // Every 23rd grant is attached to a second thing: the arc is a convention only.
    if (i % 23 === 11) {
      const second = thingKinds[(i + 1 + random.below(3)) % 4] as ThingKind;
      row[thingKey[second]] = random.pick(thingsOf(second, organizationId));
    }
    const grantee = random.next();
    if (grantee < 0.4) row.userId = random.pick(roster);
    else if (grantee < 0.65) row.granteeTeamId = random.pick(teamsHere).id;
    else if (grantee < 0.85)
      row.granteeRole = random.pick(["admin", "member", "reader"] as const);
    else row.everyone = true;

    if (kind === "document" && row.documentId !== null && row.pageId === null) {
      // A document grant carries actions; a level beside them is ignored there.
      const first = random.pick(DOCUMENT_ACTIONS);
      row.actions = random.chance(0.3)
        ? [first, random.pick(DOCUMENT_ACTIONS)].filter(
            (action, index, all) => all.indexOf(action) === index
          )
        : [first];
      if (random.chance(0.3)) row.level = random.pick(LEVELS);
      if (random.chance(0.05)) row.actions = [];
    } else {
      const shape = random.next();
      if (shape < 0.55) row.level = random.pick(LEVELS);
      else if (shape < 0.75) row.actions = [random.pick(LEVELS)];
      else if (shape < 0.9) {
        row.level = random.pick(LEVELS);
        row.actions = [random.pick(LEVELS)];
      }
      // else: no level, no actions: a grant that grants nothing.
    }
    grants.push(row);
  }

  return {
    organization: ORGANIZATIONS,
    user: users,
    session: sessions,
    apiKey: apiKeys,
    member: members,
    rolePermission: rolePermissions,
    team: teams,
    teamParent: teamParents,
    teamMember: teamMembers,
    pageGroup: pageGroups,
    page: pages,
    document: documents,
    collection: collections,
    accessGrant: grants,
  };
}

export const seed: RbacSeed = buildSeed();

// ---------------------------------------------------------------------------
// Actors: the request facts `db.$as(actor)` binds (plan §1.1 `Actor`).
// ---------------------------------------------------------------------------

export interface ActorKey {
  readonly id: string;
  readonly scopes: Readonly<Record<string, readonly string[]>>;
  readonly resources: { readonly document: "all" | readonly string[] };
}
export interface Actor {
  readonly userId: string;
  readonly organizationId: string;
  readonly network: string;
  readonly session?: string;
  readonly key?: ActorKey;
}

const rootDocuments = (organizationId: string) =>
  seed.document
    .filter((d) => d.organizationId === organizationId && d.parentId === null)
    .map((d) => d.id);

function buildActors(): Readonly<Record<string, Actor>> {
  const actors: Record<string, Actor> = {};
  for (const n of range(1, 60)) {
    if (n % 10 === 7) continue;
    const id = userId(n);
    const organizationId =
      seed.member.find((m) => m.userId === id && m.deletedAt === null)
        ?.organizationId ?? "org-1";
    actors[`u${pad(n)}`] = {
      userId: id,
      organizationId,
      network: n % 2 === 0 ? "office" : "public",
      session: `ses-${pad(n)}-live`,
    };
  }
  const special: Record<string, Actor> = {
    // An expired session, no session at all, an unknown session id.
    "u07-expired": {
      userId: userId(7),
      organizationId: "org-1",
      network: "public",
      session: "ses-07-old",
    },
    "u17-no-credential": {
      userId: userId(17),
      organizationId: "org-1",
      network: "office",
    },
    "u27-unknown-session": {
      userId: userId(27),
      organizationId: "org-2",
      network: "office",
      session: "ses-ghost",
    },
    // A member of org-1 and org-2 calling for org-2 (users are read through it).
    "u22-in-org-2": {
      userId: userId(22),
      organizationId: "org-2",
      network: "office",
      session: "ses-22-live",
    },
    // Session and key at once: either credential keeps the membership active.
    "u21-session-and-key": {
      userId: userId(21),
      organizationId: "org-2",
      network: "office",
      session: "ses-21-live",
      key: {
        id: "key-21-a",
        scopes: { page: ["edit"] },
        resources: { document: "all" },
      },
    },
    "k02-pages-view": {
      userId: userId(2),
      organizationId: "org-1",
      network: "office",
      key: {
        id: "key-02-a",
        scopes: { page: ["view"] },
        resources: { document: rootDocuments("org-1").slice(0, 2) },
      },
    },
    "k02-disabled-key": {
      userId: userId(2),
      organizationId: "org-1",
      network: "office",
      key: {
        id: "key-02-b",
        scopes: { page: ["full"], document: ["share"] },
        resources: { document: "all" },
      },
    },
    "k03-expired-key": {
      userId: userId(3),
      organizationId: "org-1",
      network: "office",
      key: {
        id: "key-03-a",
        scopes: { page: ["full"] },
        resources: { document: "all" },
      },
    },
    "k05-documents-share": {
      userId: userId(5),
      organizationId: "org-1",
      network: "public",
      key: {
        id: "key-05-a",
        scopes: { document: ["share"], organization: ["view"] },
        resources: { document: rootDocuments("org-1").slice(0, 3) },
      },
    },
    "k21-everything": {
      userId: userId(21),
      organizationId: "org-2",
      network: "office",
      key: {
        id: "key-21-a",
        scopes: {
          organization: ["invite", "export"],
          member: ["edit"],
          user: ["view"],
          team: ["edit", "invite"],
          teamMember: ["manage"],
          accessGrant: ["edit"],
          pageGroup: ["full"],
          page: ["full"],
          document: ["share", "export"],
          collection: ["full"],
        },
        resources: { document: "all" },
      },
    },
    "k41-no-resources": {
      userId: userId(41),
      organizationId: "org-2",
      network: "office",
      key: {
        id: "key-41-a",
        scopes: { document: ["view"], page: ["view"] },
        resources: { document: [] },
      },
    },
    "k50-unknown-key": {
      userId: userId(50),
      organizationId: "org-3",
      network: "office",
      key: {
        id: "key-ghost",
        scopes: { page: ["full"] },
        resources: { document: "all" },
      },
    },
  };
  return Object.freeze({ ...actors, ...special });
}

export const actors: Readonly<Record<string, Actor>> = buildActors();
