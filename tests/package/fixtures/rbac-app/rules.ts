// The §1.1 policy written by hand, as an application without `viborm/rbac`
// writes it: one plain `where` per (model, action), built per actor with the
// actor's facts inlined and the soft delete layer spelled out (`deletedAt:
// null` on every traversal of a tombstoned model). It is the "fixture's
// hand-written rule" W-H1 compares the helpers against, and the runners
// execute it through the base client against the oracle today, so the seed,
// the oracle and a second encoding of the policy agree before any engine
// unit lands. Plain data: no VibORM import. One exception to "one where":
// `accessGrant`'s `grants.admin` is too deep for the where validator when
// inlined, so it takes the administered ids read first (`administered`).
//
// `null` is false (an arm that folded false at build time, R6); `{}` is true.
// The readings A1..A7 are the oracle's (oracle.ts).

import { above, type GovernedModel } from "./oracle";
import type { Actor } from "./seed";

export type Where = Record<string, unknown>;
type Clause = Where | null;

const ROLES = ["admin", "member", "reader"] as const;
const isTrue = (w: Where) => Object.keys(w).length === 0;

/**
 * A clause that is only `{ [key]: [...] }` contributes its members: nested
 * `AND`s and `OR`s flatten, so the written nesting stays within the where
 * validator's bound on filter containers (16, src/validation/primitives/
 * filter-depth.ts), which the inlined grant administration otherwise meets.
 */
const members = (clause: Where, key: "AND" | "OR"): Where[] =>
  Object.keys(clause).length === 1 && Array.isArray(clause[key])
    ? (clause[key] as Where[])
    : [clause];

export function and(...clauses: Clause[]): Clause {
  if (clauses.some((c) => c === null)) return null;
  const kept = (clauses as Where[])
    .filter((c) => !isTrue(c))
    .flatMap((c) => members(c, "AND"));
  if (kept.length === 0) return {};
  return kept.length === 1 ? (kept[0] as Where) : { AND: kept };
}
function or(...clauses: Clause[]): Clause {
  const kept = clauses.filter((c): c is Where => c !== null);
  if (kept.length === 0) return null;
  if (kept.some(isTrue)) return {};
  const flat = kept.flatMap((c) => members(c, "OR"));
  return flat.length === 1 ? (flat[0] as Where) : { OR: flat };
}
/** `up(relation, arm)` (D2): the document itself or an ancestor satisfies the arm. */
const up = (arm: Clause): Clause =>
  arm === null
    ? null
    : { parent: { recurse: { depth: false }, self: true, some: arm } };

/** The things `grants.admin` reads, with the action that administers each (A5). */
export const ADMINISTERED = [
  ["pageId", "page", "page", "full"],
  ["groupId", "group", "pageGroup", "full"],
  ["documentId", "document", "document", "share"],
  ["collectionId", "collection", "collection", "full"],
] as const;
export type AdministeredThing = (typeof ADMINISTERED)[number][2];

export interface RuleOptions {
  readonly now: Date;
  readonly ceiling?: "declared" | "stored";
  /**
   * The ids of the things the actor administers, read beforehand with
   * `predicate(thing, action)`. Inlined, `grants.admin` nests a page's group
   * arm, its grants and their team walk under the grant: deeper than the
   * where validator's 16 filter levels (src/validation/primitives/
   * filter-depth.ts), so the hand-written form needs these two statements
   * where the plan's engine (K1) must state the rule in one.
   */
  readonly administered?: Readonly<
    Record<AdministeredThing, readonly string[]>
  >;
}

/** The hand-written rules for one actor. */
export function handRules(actor: Actor, options: RuleOptions) {
  const { now } = options;
  const me = actor.userId;
  const liveMembership = { userId: me, deletedAt: null };

  const notBanned: Where = {
    OR: [{ banned: null }, { banned: false }, { banExpires: { lte: now } }],
  };
  const session = or(
    actor.session === undefined
      ? null
      : { sessions: { some: { id: actor.session, expiresAt: { gt: now } } } },
    actor.key === undefined
      ? null
      : {
          apiKeys: {
            some: {
              id: actor.key.id,
              enabled: true,
              OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
            },
          },
        }
  );

  /** The role clause of `inOrg` at `a`, declared or stored (A1). */
  const ceiling = (a: string): Where =>
    options.ceiling === "stored"
      ? {
          OR: ROLES.map((role) => ({
            role,
            organization: { permissions: { some: { role, action: a } } },
          })),
        }
      : { role: { in: a === "view" ? [...ROLES] : ["admin", "member"] } };

  const inOrg = (a: string): Clause => {
    const user = and(notBanned, session);
    if (user === null) return null;
    return {
      organization: {
        members: { some: { ...liveMembership, AND: [ceiling(a)], user } },
      },
    };
  };
  const adminHere: Where = {
    members: { some: { ...liveMembership, role: "admin" } },
  };
  const admin: Where = { organization: adminHere };

  const limit = (model: GovernedModel, a: string): Clause => {
    const key = actor.key;
    if (key === undefined) return {};
    const scope = key.scopes[model];
    if (scope === undefined) return null;
    if (!above(model, a).some((b) => scope.includes(b))) return null;
    if (model !== "document" || key.resources.document === "all") return {};
    const list = key.resources.document;
    return list.length === 0 ? null : up({ id: { in: [...list] } });
  };

  const grantees: Where = {
    OR: [
      { userId: me },
      { everyone: true },
      {
        granteeTeam: {
          children: {
            recurse: { depth: false },
            self: true,
            some: { members: { some: liveMembership } },
          },
        },
      },
      ...ROLES.map((role) => ({
        granteeRole: role,
        organization: { members: { some: { ...liveMembership, role } } },
      })),
    ],
  };
  const covers = (model: GovernedModel, a: string): Where => {
    const wanted = [...above(model, a)];
    return model === "document"
      ? { actions: { hasSome: wanted } }
      : {
          OR: [{ level: { in: wanted } }, { actions: { hasSome: wanted } }],
        };
  };
  const given = (model: GovernedModel, a: string): Where => ({
    grants: {
      some: { deletedAt: null, AND: [covers(model, a), grantees] },
    },
  });

  /** ⋁_{b ⊒ a} rule(M, b). */
  const anyRule = (
    model: GovernedModel,
    a: string,
    rules: Record<string, () => Clause>
  ): Clause => or(...above(model, a).map((b) => rules[b]?.() ?? null));

  const P = (model: GovernedModel, a: string): Clause => {
    switch (model) {
      case "organization":
        return and(
          limit(model, a),
          anyRule(model, a, {
            view: () => ({ members: { some: liveMembership } }),
            invite: () => adminHere,
            export: () =>
              and(
                adminHere,
                { plan: "pro" },
                actor.network === "office" ? {} : null
              ),
          })
        );
      case "member":
        return and(
          inOrg(a),
          limit(model, a),
          anyRule(model, a, { view: () => ({}), edit: () => admin })
        );
      case "user":
        return and(
          limit(model, a),
          anyRule(model, a, {
            view: () => ({
              members: {
                some: {
                  organizationId: actor.organizationId,
                  deletedAt: null,
                },
              },
            }),
          })
        );
      case "team":
        return and(
          inOrg(a),
          limit(model, a),
          anyRule(model, a, {
            view: () => ({}),
            invite: () =>
              or(admin, {
                members: {
                  some: { userId: me, role: "lead", deletedAt: null },
                },
              }),
            edit: () => admin,
          })
        );
      case "teamMember": {
        const teamAt = (b: string) => {
          const team = P("team", b);
          return team === null ? null : { team: { is: team } };
        };
        return and(
          limit(model, a),
          anyRule(model, a, {
            view: () => teamAt("view"),
            manage: () => teamAt("invite"),
          })
        );
      }
      case "accessGrant": {
        const administers = and(
          {
            OR: [
              { pageId: { not: null } },
              { groupId: { not: null } },
              { documentId: { not: null } },
              { collectionId: { not: null } },
            ],
          },
          ...ADMINISTERED.map(([key, relation, thing, action]) => {
            const known = options.administered?.[thing];
            if (known !== undefined) {
              return or({ [key]: null }, { [key]: { in: [...known] } });
            }
            const held = P(thing, action);
            const target =
              held === null
                ? null
                : thing === "page"
                  ? and({ deletedAt: null }, held)
                  : held;
            return or(
              { [key]: null },
              target && { [relation]: { is: target } }
            );
          })
        );
        return and(
          limit(model, a),
          anyRule(model, a, {
            view: () => or({ userId: me }, administers),
            edit: () => administers,
          })
        );
      }
      case "pageGroup":
        return and(
          inOrg(a),
          limit(model, a),
          or({ createdById: me }, admin, given(model, a))
        );
      case "page": {
        const group = P("pageGroup", a);
        return and(
          inOrg(a),
          limit(model, a),
          or(
            { ownerId: me },
            and({ personal: false }, admin),
            given(model, a),
            group === null ? null : { personal: false, group: { is: group } }
          )
        );
      }
      case "document":
        return and(
          inOrg(a),
          limit(model, a),
          or(
            up({ ownerId: me }),
            and(admin, up({ parentId: null, personal: false })),
            up(given(model, a))
          )
        );
      case "collection":
        return and(
          inOrg(a),
          limit(model, a),
          or(
            { ownerId: me },
            { status: "draft", createdById: me },
            given(model, a)
          )
        );
      default:
        return null;
    }
  };

  return {
    /** R1 at (model, action), or `null` when it folds false. */
    predicate: P,
    /** What a root read observes at `a`: `P(view) ∧ P(a)` (R2). */
    observed: (model: GovernedModel, a: string): Clause =>
      and(P(model, "view"), P(model, a)),
  };
}
