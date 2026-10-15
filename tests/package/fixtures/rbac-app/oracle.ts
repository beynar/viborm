// The independent oracle of the RBAC acceptance fixture (plan §6.1 U0, §7).
//
// A plain evaluator of the plan's one formula R1 over the seeded rows, written
// from the policy of plan §1.1 and the rules of §3.2, never from an engine's
// output: it imports nothing from VibORM and reads only `seed.ts`.
//
//   P(M, a) = within(M)(a) ∧ limit(M, a) ∧ ( ⋁_{b ⊒ a} rule(M, b) ∨ ⋁_{g ∈ arms(M)} g(a) )
//
// What a caller observes at action `a` is `P(M, view) ∧ P(M, a)` (R2: every
// verb and every evidence projection is conjoined with the read predicate), and
// a row's `$access` is the set of actions holding on it (D6). The policy's own
// traversals read the other layers at their default mode and never rbac's own
// (R5): with soft delete composed (plan §1.1 `server.ts`), a tombstoned
// member, team member, page or grant is invisible to every traversal, whatever
// the call's `deleted` mode, which chooses only the root rows of those models.
//
// Readings the plan leaves open are fixed here and named (A1..A7); a unit that
// rules otherwise amends the reading and this file together.
//
//   A1  A role ceiling admits a role at `a` iff `a` is in the role's allowed set:
//       declared, `reader: "view"` allows {view}; `full`, the top of `levels`,
//       allows every action of every model (document's included). Stored,
//       iff a `rolePermission` row (organization, role, a) exists; the seed
//       stores each allowed action explicitly, so the two agree (W-A6).
//   A2  `member({ via: "organization" })` on `organization` itself reads the
//       row's own `members`; `admin` checks neither ban nor session (§1.1
//       passes `user:` to `inOrg` only).
//   A3  `session()` (OD-6, recommended form): a session row whose id is the
//       actor's `session` and that has not expired, or an API key row whose id
//       is the actor's `key.id`, `enabled` true and not expired, each owned by
//       the member's user. `notBanned()`: `banned` is not true, or the ban has
//       expired.
//   A4  `given(a)` on a model whose actions are the levels: a live grant on the
//       row whose `level` is in ↑a or whose `actions` meet ↑a; on `document`
//       (its own action map) only `actions` count. Grantees: the actor's user;
//       everyone; a team whose closure below (itself and every team under it
//       through `children`) has the actor as a live member; a role equal to the
//       actor's live membership role in the grant's organization.
//   A5  `grant.administer(...)` as `grants.admin`: at least one thing key set,
//       and every set key's row (live) satisfies its administering action
//       (page full, pageGroup full, document share, collection full).
//   A6  `keyLimit`: an actor without a key is unlimited; with a key, the key's
//       scope list for the model must contain an action b ⊒ a, and on
//       `document` the row or an ancestor must be in `key.resources.document`
//       unless it is "all" (an empty list admits nothing).
//   A7  A rule key that is neither a level nor in a model's `actions` names an
//       action implying `view` only (D3); an action with no rule and no arm is
//       false (R9).

import {
  type AccessGrantRow,
  type Actor,
  DOCUMENT_ACTIONS,
  type DocumentRow,
  LEVELS,
  type MemberRow,
  type RbacSeed,
} from "./seed";

/** The models the §1.1 policy lists; every other model of the schema is false at every verb (R9). */
export const GOVERNED_MODELS = [
  "organization",
  "member",
  "user",
  "team",
  "teamMember",
  "accessGrant",
  "pageGroup",
  "page",
  "document",
  "collection",
] as const;
export type GovernedModel = (typeof GOVERNED_MODELS)[number];

/** Models whose root rows soft delete's `deleted` mode chooses (§1.1 `tombstones`). */
export const TOMBSTONED_MODELS = [
  "page",
  "member",
  "teamMember",
  "accessGrant",
] as const;

const EXTRA_ACTIONS: Record<GovernedModel, readonly string[]> = {
  organization: ["invite", "export"],
  member: [],
  user: [],
  team: ["invite"],
  teamMember: ["manage"],
  accessGrant: [],
  pageGroup: [],
  page: [],
  document: [],
  collection: [],
};

/** Each model's actions with what each one directly implies (D3). */
const DOCUMENT_IMPLIES: Readonly<Record<string, readonly string[]>> = {
  view: [],
  comment: ["view"],
  archive: ["view"],
  edit: ["comment", "archive"],
  share: ["edit"],
  export: ["view"],
};
const ladder = (model: GovernedModel): Record<string, readonly string[]> => {
  const implied: Record<string, readonly string[]> = {
    view: [],
    edit: ["view"],
    full: ["edit"],
  };
  for (const extra of EXTRA_ACTIONS[model]) implied[extra] = ["view"];
  return implied;
};
const IMPLIES = {} as Record<
  GovernedModel,
  Readonly<Record<string, readonly string[]>>
>;
for (const model of GOVERNED_MODELS) {
  IMPLIES[model] = model === "document" ? DOCUMENT_IMPLIES : ladder(model);
}

export function actionsOf(model: GovernedModel): readonly string[] {
  return Object.keys(IMPLIES[model]);
}

/** b ⊒ a: b is a or implies it, transitively. */
function implies(model: GovernedModel, b: string, a: string): boolean {
  if (b === a) return true;
  return (IMPLIES[model][b] ?? []).some((next) => implies(model, next, a));
}

/** ↑a: every action of the model that is a or implies it. */
export function above(model: GovernedModel, a: string): readonly string[] {
  return actionsOf(model).filter((b) => implies(model, b, a));
}

export interface OracleOptions {
  /** The call's one instant (R7). */
  readonly now: Date;
  /** Soft delete composed below rbac (§1.1 `server.ts`); default true. */
  readonly tombstones?: boolean;
  /** The root mode of soft delete's `deleted` control; default "default". */
  readonly deleted?: "default" | "with" | "only";
  /** Declared ceiling (§1.1) or the stored-role variant; default "declared". */
  readonly ceiling?: "declared" | "stored";
}

type Row = Record<string, unknown> & { id?: string };

/** A row's key: its id, or `teamId:userId` for the compound-keyed team member. */
export function rowKey(model: string, row: object): string {
  const r = row as Row;
  if (model === "teamMember") return `${r.teamId}:${r.userId}`;
  return String(r.id);
}

/** The oracle over one seed: indexes built once, verdicts computed per actor. */
export function createOracle(seed: RbacSeed) {
  const byId = <T extends { id: string }>(rows: readonly T[]) =>
    new Map(rows.map((row) => [row.id, row]));
  const users = byId(seed.user);
  const organizations = byId(seed.organization);
  const teams = byId(seed.team);
  const pages = byId(seed.page);
  const pageGroups = byId(seed.pageGroup);
  const documents = byId(seed.document);
  const collections = byId(seed.collection);

  const childrenOf = new Map<string, string[]>();
  for (const { childId, parentId } of seed.teamParent) {
    childrenOf.set(parentId, [...(childrenOf.get(parentId) ?? []), childId]);
  }
  /** A team and every team below it through `children` (the graph is acyclic; diamonds visit once). */
  const below = (teamId: string): Set<string> => {
    const seen = new Set<string>();
    const walk = (id: string) => {
      if (seen.has(id)) return;
      seen.add(id);
      for (const child of childrenOf.get(id) ?? []) walk(child);
    };
    walk(teamId);
    return seen;
  };

  /** A document and its ancestors through `parent` (`up()`, `self: true`). */
  const lineage = (document: DocumentRow): DocumentRow[] => {
    const chain: DocumentRow[] = [];
    const seen = new Set<string>();
    let current: DocumentRow | undefined = document;
    while (current && !seen.has(current.id)) {
      seen.add(current.id);
      chain.push(current);
      current =
        current.parentId === null ? undefined : documents.get(current.parentId);
    }
    return chain;
  };

  const thingKey = {
    page: "pageId",
    pageGroup: "groupId",
    document: "documentId",
    collection: "collectionId",
  } as const;
  type Thing = keyof typeof thingKey;

  function evaluate(actor: Actor, options: OracleOptions) {
    const tombstones = options.tombstones ?? true;
    const live = (row: { deletedAt: Date | null }) =>
      !tombstones || row.deletedAt === null;
    const now = options.now.getTime();

    const liveMembers = seed.member.filter(live);
    const liveTeamMembers = seed.teamMember.filter(live);
    const liveGrants = seed.accessGrant.filter(live);

    const membershipsOf = (organizationId: string): MemberRow[] =>
      liveMembers.filter(
        (m) => m.organizationId === organizationId && m.userId === actor.userId
      );

    // A3: the member's user is not banned and holds a live credential.
    const notBanned = (userId: string) => {
      const user = users.get(userId);
      if (!user) return false;
      return (
        user.banned !== true ||
        (user.banExpires !== null && user.banExpires.getTime() <= now)
      );
    };
    const liveCredential = (userId: string) => {
      const session =
        actor.session !== undefined &&
        seed.session.some(
          (s) =>
            s.id === actor.session &&
            s.userId === userId &&
            s.expiresAt.getTime() > now
        );
      const key =
        actor.key !== undefined &&
        seed.apiKey.some(
          (k) =>
            k.id === actor.key?.id &&
            k.referenceId === userId &&
            k.enabled === true &&
            (k.expiresAt === null || k.expiresAt.getTime() > now)
        );
      return session || key;
    };

    // A1: the ceiling, declared or stored.
    const ceilingAdmits = (organizationId: string, role: string, a: string) => {
      if (options.ceiling === "stored") {
        return seed.rolePermission.some(
          (p) =>
            p.organizationId === organizationId &&
            p.role === role &&
            p.action === a
        );
      }
      if (role === "member" || role === "admin") return true;
      return role === "reader" && a === "view";
    };

    /** `inOrg`: an active member of the row's organization, capped at `a` by its role. */
    const inOrg = (organizationId: string, a: string) =>
      membershipsOf(organizationId).some(
        (m) =>
          ceilingAdmits(organizationId, m.role, a) &&
          notBanned(m.userId) &&
          liveCredential(m.userId)
      );
    /** `member()` with no argument (A2). */
    const isMember = (organizationId: string) =>
      membershipsOf(organizationId).length > 0;
    /** `admin`: `member({ via: "organization", roles: ["admin"] })` (A2). */
    const isAdmin = (organizationId: string) =>
      membershipsOf(organizationId).some((m) => m.role === "admin");

    /** A6: the key limit. */
    const limit = (model: GovernedModel, a: string, row: Row) => {
      const key = actor.key;
      if (key === undefined) return true;
      const scope = key.scopes[model];
      if (scope === undefined) return false;
      if (!above(model, a).some((b) => scope.includes(b))) return false;
      if (model !== "document") return true;
      const resources = key.resources.document;
      if (resources === "all") return true;
      return lineage(row as unknown as DocumentRow).some((d) =>
        resources.includes(d.id)
      );
    };

    /** A4: the grantee arms of `grant.to(...)`. */
    const namesActor = (grant: AccessGrantRow) => {
      if (grant.userId === actor.userId) return true;
      if (grant.everyone) return true;
      if (grant.granteeTeamId !== null) {
        const reach = below(grant.granteeTeamId);
        if (
          liveTeamMembers.some(
            (tm) => reach.has(tm.teamId) && tm.userId === actor.userId
          )
        ) {
          return true;
        }
      }
      if (grant.granteeRole !== null) {
        return membershipsOf(grant.organizationId).some(
          (m) => m.role === grant.granteeRole
        );
      }
      return false;
    };
    const covers = (grant: AccessGrantRow, model: Thing, a: string) => {
      const wanted = above(model, a);
      if (grant.actions.some((x) => wanted.includes(x))) return true;
      return (
        model !== "document" &&
        grant.level !== null &&
        wanted.includes(grant.level)
      );
    };
    const given = (model: Thing, rowId: string, a: string) =>
      liveGrants.some(
        (g) =>
          g[thingKey[model]] === rowId && covers(g, model, a) && namesActor(g)
      );

    const memo = new Map<string, boolean>();
    /** R1 for one row. */
    const P = (model: GovernedModel, a: string, subject: object): boolean => {
      const row = subject as Row;
      if (!actionsOf(model).includes(a)) return false;
      const memoKey = `${model}|${a}|${rowKey(model, row)}`;
      const known = memo.get(memoKey);
      if (known !== undefined) return known;
      const verdict = limit(model, a, row) && judge(model, a, row);
      memo.set(memoKey, verdict);
      return verdict;
    };
    /** ⋁_{b ⊒ a} rule(M, b) for models whose rules are written under actions. */
    const anyRule = (
      model: GovernedModel,
      a: string,
      rules: Record<string, () => boolean>
    ) => above(model, a).some((b) => rules[b]?.() === true);

    const judge = (model: GovernedModel, a: string, row: Row): boolean => {
      const organizationId = row.organizationId as string;
      switch (model) {
        case "organization": {
          const id = row.id as string;
          return anyRule(model, a, {
            view: () => isMember(id),
            invite: () => isAdmin(id),
            export: () =>
              isAdmin(id) &&
              organizations.get(id)?.plan === "pro" &&
              actor.network === "office",
          });
        }
        case "member":
          return (
            inOrg(organizationId, a) &&
            anyRule(model, a, {
              view: () => true,
              edit: () => isAdmin(organizationId),
            })
          );
        case "user":
          return anyRule(model, a, {
            view: () =>
              liveMembers.some(
                (m) =>
                  m.userId === row.id &&
                  m.organizationId === actor.organizationId
              ),
          });
        case "team":
          return (
            inOrg(organizationId, a) &&
            anyRule(model, a, {
              view: () => true,
              invite: () =>
                isAdmin(organizationId) ||
                liveTeamMembers.some(
                  (tm) =>
                    tm.teamId === row.id &&
                    tm.userId === actor.userId &&
                    tm.role === "lead"
                ),
              edit: () => isAdmin(organizationId),
            })
          );
        case "teamMember": {
          const team = teams.get(row.teamId as string);
          if (!team) return false;
          return anyRule(model, a, {
            view: () => P("team", "view", team),
            manage: () => P("team", "invite", team),
          });
        }
        case "accessGrant": {
          const grant = row as unknown as AccessGrantRow;
          const administered = () => administers(grant);
          return anyRule(model, a, {
            view: () => grant.userId === actor.userId || administered(),
            edit: administered,
          });
        }
        case "pageGroup":
          return (
            inOrg(organizationId, a) &&
            (row.createdById === actor.userId ||
              isAdmin(organizationId) ||
              given("pageGroup", row.id as string, a))
          );
        case "page": {
          if (!inOrg(organizationId, a)) return false;
          if (row.ownerId === actor.userId) return true;
          if (row.personal === false && isAdmin(organizationId)) return true;
          if (given("page", row.id as string, a)) return true;
          const group =
            row.groupId === null
              ? undefined
              : pageGroups.get(row.groupId as string);
          return (
            row.personal === false &&
            group !== undefined &&
            P("pageGroup", a, group)
          );
        }
        case "document": {
          if (!inOrg(organizationId, a)) return false;
          const chain = lineage(row as unknown as DocumentRow);
          if (chain.some((d) => d.ownerId === actor.userId)) return true;
          if (
            isAdmin(organizationId) &&
            chain.some((d) => d.parentId === null && d.personal === false)
          ) {
            return true;
          }
          return chain.some((d) => given("document", d.id, a));
        }
        case "collection":
          return (
            inOrg(organizationId, a) &&
            (row.ownerId === actor.userId ||
              (row.status === "draft" && row.createdById === actor.userId) ||
              given("collection", row.id as string, a))
          );
        default:
          return false;
      }
    };

    /** A5: `grants.admin`. */
    const ADMINISTERS: Record<Thing, string> = {
      page: "full",
      pageGroup: "full",
      document: "share",
      collection: "full",
    };
    const thingRow = (model: Thing, id: string): Row | undefined => {
      if (model === "page") {
        const page = pages.get(id);
        return page && live(page) ? (page as unknown as Row) : undefined;
      }
      const table =
        model === "pageGroup"
          ? pageGroups
          : model === "document"
            ? documents
            : collections;
      return table.get(id) as unknown as Row | undefined;
    };
    const administers = (grant: AccessGrantRow) => {
      const attached = (Object.keys(thingKey) as Thing[]).filter(
        (model) => grant[thingKey[model]] !== null
      );
      return (
        attached.length > 0 &&
        attached.every((model) => {
          const thing = thingRow(model, grant[thingKey[model]] as string);
          return thing !== undefined && P(model, ADMINISTERS[model], thing);
        })
      );
    };

    const rootRows = (model: GovernedModel): readonly Row[] => {
      const rows = seed[model] as unknown as readonly (Row & {
        deletedAt?: Date | null;
      })[];
      if (!(TOMBSTONED_MODELS as readonly string[]).includes(model))
        return rows;
      if (!tombstones) return rows;
      const mode = options.deleted ?? "default";
      if (mode === "with") return rows;
      return rows.filter((r) =>
        mode === "only" ? r.deletedAt !== null : r.deletedAt === null
      );
    };

    /** What the caller observes at `a`: `P(view) ∧ P(a)` (R2). */
    const holds = (model: GovernedModel, a: string, row: Row) =>
      P(model, "view", row) && P(model, a, row);

    return { holds, rootRows };
  }

  return {
    /** The keys of the root rows an actor reaches at (model, action), sorted. */
    rows(
      actor: Actor,
      model: GovernedModel,
      action: string,
      options: OracleOptions
    ): string[] {
      const { holds, rootRows } = evaluate(actor, options);
      return rootRows(model)
        .filter((row) => holds(model, action, row))
        .map((row) => rowKey(model, row))
        .sort();
    },
    /** Per root row the actor views, the actions it holds there (`$access`, D6). */
    access(
      actor: Actor,
      model: GovernedModel,
      options: OracleOptions
    ): Map<string, string[]> {
      const { holds, rootRows } = evaluate(actor, options);
      const evidence = new Map<string, string[]>();
      for (const row of rootRows(model)) {
        if (!holds(model, "view", row)) continue;
        evidence.set(
          rowKey(model, row),
          actionsOf(model).filter((a) => holds(model, a, row))
        );
      }
      return evidence;
    },
    /** The highest held level, for a model whose actions are ordered (`$access` with `levels`). */
    highestLevel(held: readonly string[]): (typeof LEVELS)[number] | undefined {
      return [...LEVELS].reverse().find((level) => held.includes(level));
    },
  };
}

export type Oracle = ReturnType<typeof createOracle>;

/** Every (model, action) pair the policy declares, in a stable order. */
export const MODEL_ACTIONS: readonly (readonly [GovernedModel, string])[] =
  GOVERNED_MODELS.flatMap((model) =>
    actionsOf(model).map((action) => [model, action] as const)
  );

/** Document's action map, re-exported for witnesses that enumerate it. */
export const DOCUMENT_ACTION_NAMES = DOCUMENT_ACTIONS;
