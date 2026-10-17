// The §1.1 policy written by hand, as an application without `viborm/permissions`
// writes it: one plain `where` per (model, action), built per actor with the
// actor's facts inlined and the soft delete layer spelled out (`deletedAt:
// null` on every traversal of a tombstoned model). It is the "fixture's
// hand-written rule" W-H1 compares the helpers against, and the runners
// execute it through the base client against the oracle today, so the seed,
// the oracle and a second encoding of the policy agree before any engine
// unit lands. Plain data: no VibORM import. One exception to "one where":
// `accessGrant`'s administration and creation rules exceed the ordinary where
// nesting bound when inlined, so the baseline pre-reads target permission ids.
//
// `null` is false (an arm that folded false at build time, R6); `{}` is true.
// The readings A1..A7 are the oracle's (oracle.ts).

import { above, actionsOf, CREATES, type GovernedModel } from "./oracle";
import { type Actor, LEVELS } from "./seed";

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
   * Target ids per permission, independently read before the grant query.
   * Grant administration and creation traverse each target's policy; inlining
   * those policies exceeds the ordinary where validator's 16-level bound.
   * Only the handwritten baseline uses these extra reads. The production
   * policy checks the same conditions in its protected database statement.
   */
  readonly permissions?: Readonly<
    Record<AdministeredThing, Readonly<Record<string, readonly string[]>>>
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
      : { role: { in: a === "read" ? [...ROLES] : ["admin", "member"] } };

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
          OR: [
            {
              level: {
                in: wanted.filter((name) =>
                  LEVELS.some((level) => level === name)
                ),
              },
            },
            { actions: { hasSome: wanted } },
          ],
        };
  };
  const given = (model: GovernedModel, a: string): Where => ({
    grants: {
      some: { deletedAt: null, AND: [covers(model, a), grantees] },
    },
  });

  /** One direct declaration; P alone combines inherited grants. */
  const directRule = (a: string, rules: Record<string, () => Clause>): Clause =>
    rules[a]?.() ?? null;

  /**
   * R1 at (model, action): the declaration at `a` and every declaration
   * inherited into it. Every declaration of this application is monotone
   * in the action (a higher action narrows the role ceiling, the key's
   * scopes, the grant coverage and the targets' own predicates), so an
   * inherited one is contained in `a`'s own and adds no row: only `a`'s is
   * written, as the library's absorption leaves it, within Neki's 256
   * relations per statement. `create` is not of that shape (a placement
   * over the proposed row): where the graph makes it imply `a`, its arm
   * stays. The oracle, written apart, checks this on every substrate.
   */
  const P = (model: GovernedModel, a: string): Clause => {
    const own = declaration(model, a);
    if (own === null)
      return or(
        ...above(model, a).map((declared) => declaration(model, declared))
      );
    return or(
      own,
      ...above(model, a)
        .filter((declared) => declared === "create" && declared !== a)
        .map((declared) => declaration(model, declared))
    );
  };

  const administerGrant = (): Clause =>
    and(
      {
        OR: [
          { pageId: { not: null } },
          { groupId: { not: null } },
          { documentId: { not: null } },
          { collectionId: { not: null } },
        ],
      },
      ...ADMINISTERED.map(([key, relation, thing, action]) => {
        const known = options.permissions?.[thing]?.[action];
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
        return or({ [key]: null }, target && { [relation]: { is: target } });
      })
    );

  const createRule = (model: GovernedModel): Clause => {
    const related = (
      relation: string,
      target: GovernedModel,
      action: string
    ): Clause => {
      const known =
        target === "page" ||
        target === "pageGroup" ||
        target === "document" ||
        target === "collection"
          ? options.permissions?.[target]?.[action]
          : undefined;
      if (known !== undefined)
        return { [relation]: { is: { id: { in: [...known] } } } };
      const held = P(target, action);
      return held === null ? null : { [relation]: { is: held } };
    };
    switch (model) {
      case "member":
        return related("organization", "organization", "invite");
      case "teamMember":
        return related("team", "team", "invite");
      case "page":
        return or(related("group", "pageGroup", "update"), {
          groupId: null,
          personal: true,
          ownerId: me,
        });
      case "document":
        return or(related("parent", "document", "update"), {
          parentId: null,
          ownerId: me,
        });
      case "collection":
        return { createdById: me };
      case "accessGrant":
        return and(
          administerGrant(),
          ...ADMINISTERED.flatMap(([key, relation, target]) => [
            ...(target === "document" ? actionsOf(target) : LEVELS).map(
              (action) =>
                or(
                  { [key]: null },
                  { NOT: { actions: { has: action } } },
                  related(relation, target, action)
                )
            ),
            ...(target === "document"
              ? []
              : LEVELS.map((level) =>
                  or(
                    { [key]: null },
                    { level: null },
                    { level: { not: level } },
                    related(relation, target, level)
                  )
                )),
          ])
        );
      default:
        return null;
    }
  };
  const capped = new Set<GovernedModel>([
    "member",
    "team",
    "pageGroup",
    "page",
    "document",
    "collection",
    "bookmark",
  ]);
  const declaration = (model: GovernedModel, a: string): Clause => {
    if (a === "create")
      return CREATES.has(model)
        ? and(
            limit(model, a),
            capped.has(model) ? inOrg(a) : {},
            createRule(model)
          )
        : null;
    switch (model) {
      case "organization":
        return and(
          limit(model, a),
          directRule(a, {
            read: () => ({ members: { some: liveMembership } }),
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
          directRule(a, { read: () => ({}), update: () => admin })
        );
      case "user":
        return and(
          limit(model, a),
          directRule(a, {
            read: () => ({
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
          directRule(a, {
            read: () => ({}),
            invite: () =>
              or(admin, {
                members: {
                  some: { userId: me, role: "lead", deletedAt: null },
                },
              }),
            update: () => admin,
          })
        );
      case "teamMember": {
        const teamAt = (b: string) => {
          const team = P("team", b);
          return team === null ? null : { team: { is: team } };
        };
        return and(
          limit(model, a),
          directRule(a, {
            read: () => teamAt("read"),
            manage: () => teamAt("invite"),
          })
        );
      }
      case "accessGrant": {
        const administers = administerGrant();
        return and(
          limit(model, a),
          directRule(a, {
            read: () => or({ userId: me }, administers),
            update: () => administers,
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
      case "bookmark":
        return and(inOrg(a), limit(model, a), or({ userId: me }, admin));
      default:
        return null;
    }
  };

  return {
    /** R1 at (model, action), or `null` when it folds false. */
    predicate: P,
    /** What a root read observes at `a`: `P(read) ∧ P(a)` (R2). */
    observed: (model: GovernedModel, a: string): Clause =>
      and(P(model, "read"), P(model, a)),
  };
}
