// The rule helpers of viborm/rbac (plan §3.3 D2): an application's recurring
// shapes, written once. Each is a `where`, or a function of the action and the
// model it is read at; `rbac()` evaluates every function once per declared
// action (R1), so what reaches the engine is plain data, the same for every
// actor. The actor's facts are `{ control: "actor", path }` values and
// `{ $if: … }` conditions (K2), folded per call.
//
// The helpers read the actor's `userId`, and these columns of the rows they
// reach: a membership's `userId` and `role` through `members`; a user's
// `sessions` (`id`, `expiresAt`), `apiKeys` (`id`, `enabled`, `expiresAt`),
// `banned` and `banExpires`; a grant's `everyone`.

import { refuse } from "./actor";

/** A `where` over a model's relations and the actor's facts, held as data. */
export type Where = { readonly [key: string]: unknown };
/** A `where`, or one per action and model (R1). */
export type Rule = Where | ((action: string, model: PolicyModel) => Rule);

/** What a rule function reads of the model it is evaluated at. */
export interface PolicyModel {
  readonly name: string;
  /** Its actions, in declaration order (none for a model the policy does not list). */
  readonly actions: readonly string[];
  /** The policy's `levels`, lowest first. */
  readonly levels: readonly string[];
  /** Whether its actions are the `levels`, so a grant's level speaks for it. */
  readonly leveled: boolean;
  /** ↑a: the actions that are `action` (one of `actions`) or imply it. */
  above(action: string): readonly string[];
  /** The model a relation of it reaches. */
  related(relation: string): PolicyModel | undefined;
  /** The foreign key behind a to-one relation of it. */
  foreignKey(relation: string): readonly string[] | undefined;
  /** The values of an enum field of it. */
  values(field: string): readonly string[] | undefined;
  /** Whether a relation of that name on some model reaches this one. */
  reachedBy(relation: string): boolean;
}

/** The value of an actor field (K2). */
export const actor = (path: string) => ({ control: "actor", path }) as const;
const NOW = { now: true } as const;
const carries = (path: string) => ({ control: "actor", path, exists: true });
/** A `where` no row satisfies. */
export const FALSE: Where = Object.freeze({ OR: Object.freeze([]) });

/** The row's `field` is the actor. */
export const owner = (field: string): Where => ({ [field]: actor("userId") });

/** A grant to everyone. */
export const everyone = (): Where => ({ everyone: true });

/** A user not banned, or whose ban has expired. */
export const notBanned = (): Where => ({
  OR: [{ banned: null }, { banned: false }, { banExpires: { lte: NOW } }],
});

/**
 * A user holding the credential the actor calls with (OD-6): its live session,
 * or its enabled, unexpired API key; each arm only when the actor carries it.
 */
export const session = (): Where => ({
  OR: [
    {
      $if: carries("session"),
      sessions: { some: { id: actor("session"), expiresAt: { gt: NOW } } },
    },
    {
      $if: carries("key"),
      apiKeys: {
        some: {
          id: actor("key.id"),
          enabled: true,
          OR: [{ expiresAt: null }, { expiresAt: { gt: NOW } }],
        },
      },
    },
  ],
});

/** The row or one of its ancestors through `relation` satisfies `rule` (D2). */
export const up = (relation: string, rule: Rule): Where => ({
  [relation]: { recurse: { depth: false }, self: true, some: rule },
});

/** The actor is a member of the team `relation` reaches, or of one below it. */
export const team = (
  relation: string,
  { below, memberOf }: { readonly below: string; readonly memberOf: string }
): Where => ({
  [relation]: {
    is: {
      [below]: {
        recurse: { depth: false },
        self: true,
        some: { [memberOf]: { some: { userId: actor("userId") } } },
      },
    },
  },
});

/** The membership `via` reaches holds the role an enum `field` names. */
export const role =
  (field: string, { via }: { readonly via: string }): Rule =>
  (_action, model) => {
    const roles =
      model.values(field) ??
      refuse(`role("${field}") on ${model.name}: the field is not an enum`);
    return {
      OR: roles.map((name) => ({
        [field]: name,
        [via]: {
          is: { members: { some: { userId: actor("userId"), role: name } } },
        },
      })),
    };
  };

/** A role ceiling: declared per role as a level, or stored as rows. */
export type Ceiling =
  | { readonly [role: string]: string }
  | { readonly relation: string; readonly action: string };

export interface MemberOptions {
  /** The relation to the membership's owner; absent on the owner itself. */
  readonly via?: string;
  /** The roles admitted; with a stored ceiling, the roles it may store. */
  readonly roles?: readonly string[];
  readonly ceiling?: Ceiling;
  /** What the member's user must satisfy. */
  readonly user?: Rule;
}

const isStored = (
  ceiling: Ceiling
): ceiling is { readonly relation: string; readonly action: string } =>
  typeof ceiling.relation === "string" && typeof ceiling.action === "string";

/**
 * The actor is a member of the row's owner (`via`), capped at the action by
 * its role (R1: the ceiling admits a role iff its allowed set holds the
 * action; the top level allows every action of every model). On the owner
 * itself (a model `via` reaches) it reads the row's own `members`.
 */
export const member =
  ({ via, roles, ceiling, user }: MemberOptions = {}): Rule =>
  (action, model) => {
    const owner = via === undefined ? model : model.related(via);
    if (owner === undefined && !model.reachedBy(via!))
      refuse(`member({ via: "${via}" }) on ${model.name}: no such relation`);
    const membership = (role?: unknown) => ({
      members: {
        some: {
          userId: actor("userId"),
          ...(role === undefined ? {} : { role }),
          ...(user === undefined ? {} : { user: { is: user } }),
        },
      },
    });
    let held: Rule;
    if (ceiling !== undefined && isStored(ceiling)) {
      const stored =
        roles ??
        refuse(
          `member() on ${model.name}: a stored ceiling enumerates its roles`
        );
      held = {
        OR: stored.map((name) => ({
          ...membership(name),
          [ceiling.relation]: {
            some: { role: name, [ceiling.action]: action },
          },
        })),
      };
    } else {
      const top = model.levels.at(-1);
      const admitted = (roles ?? Object.keys(ceiling ?? {})).filter(
        (name) =>
          ceiling === undefined ||
          ceiling[name] === top ||
          model.above(action).includes(ceiling[name]!)
      );
      held =
        roles === undefined && ceiling === undefined
          ? membership()
          : admitted.length === 0
            ? FALSE
            : membership({ in: admitted });
    }
    return owner === undefined || owner === model
      ? held
      : { [via!]: { is: held } };
  };

/** A grant row's shape: the relation to the grants, and what each one holds. */
export interface GrantShape {
  readonly level?: string;
  readonly actions?: string;
}

/** The single-field foreign key behind a to-one relation. */
function keyOf(model: PolicyModel, relation: string): string {
  const key = model.foreignKey(relation);
  if (key?.length !== 1)
    refuse(
      `grant.administer on ${model.name}: "${relation}" is not a to-one relation with a single-field key`
    );
  return key[0]!;
}

export const grant = {
  /**
   * A live grant on the row, per action (A4): one of `grantees` holds it, and
   * its `level` is in ↑a (where the model's actions are the levels) or its
   * `actions` meet ↑a.
   */
  to:
    (
      grantees: readonly Rule[],
      { relation, level, actions }: GrantShape & { readonly relation: string }
    ): Rule =>
    (action, model) => {
      const wanted = model.above(action);
      const levels = wanted.filter((name) => model.levels.includes(name));
      const covers = [
        ...(level !== undefined && model.leveled && levels.length > 0
          ? [{ [level]: { in: levels } }]
          : []),
        ...(actions === undefined ? [] : [{ [actions]: { hasSome: wanted } }]),
      ];
      return {
        [relation]: { some: { AND: [{ OR: covers }, { OR: grantees }] } },
      };
    },
  /**
   * Who writes a row attached to `things` (R10): at least one attached, and
   * every attached one held at its administering action (`admin`); placement
   * also bounds what the row holds by what the writer holds there (`place`).
   */
  administer(
    things: { readonly [relation: string]: string },
    { level, actions }: GrantShape
  ): { readonly admin: Rule; readonly place: Rule } {
    const admin: Rule = (_action, model) => {
      const keys = Object.keys(things).map((relation) =>
        keyOf(model, relation)
      );
      return {
        AND: [
          { OR: keys.map((key) => ({ [key]: { not: null } })) },
          ...Object.entries(things).map(([relation, held], index) => ({
            OR: [{ [keys[index]!]: null }, { [relation]: held }],
          })),
        ],
      };
    };
    const place: Rule = (_action, model) => ({
      AND: [
        admin,
        ...Object.keys(things).flatMap((relation) => {
          const key = keyOf(model, relation);
          const thing = model.related(relation)!;
          return [
            ...(actions === undefined
              ? []
              : thing.actions.map((name) => ({
                  OR: [
                    { [key]: null },
                    { NOT: { [actions]: { has: name } } },
                    { [relation]: name },
                  ],
                }))),
            ...(level === undefined || !thing.leveled
              ? []
              : thing.levels.map((name) => ({
                  OR: [
                    { [key]: null },
                    { [level]: null },
                    { [level]: { not: name } },
                    { [relation]: name },
                  ],
                }))),
          ];
        }),
      ],
    });
    return { admin, place };
  },
};

/** What a key or delegated token holds, read from the actor (D10). */
export interface KeyLimit {
  /** The actor path that carries the key; an actor without one is unlimited. */
  readonly when: string;
  /** The path of its per-model action lists. */
  readonly scopes: string;
  /** Per model, the path of its row ids (`"all"`, or a list), and the relation they reach the row through. */
  readonly ids?: {
    readonly [model: string]: {
      readonly path: string;
      readonly through?: string;
    };
  };
}

/**
 * `$if` the actor carries a key ⇒ its scopes for the model meet ↑a, and on a
 * model with ids the row or an ancestor through `through` is listed (or the
 * list is `"all"`). A model the scopes do not name is a path the actor lacks:
 * false, creation included.
 */
export const keyLimit = <const Limit extends KeyLimit>({
  when,
  scopes,
  ids,
}: Limit): Rule & { readonly "~limit"?: Limit } => {
  const limit = (action: string, model: PolicyModel): Rule => {
    const listed = ids?.[model.name];
    const row =
      listed === undefined
        ? {}
        : {
            OR: [
              { $if: { control: "actor", path: listed.path, equals: "all" } },
              listed.through === undefined
                ? { id: { in: actor(listed.path) } }
                : up(listed.through, { id: { in: actor(listed.path) } }),
            ],
          };
    return {
      OR: [
        { $if: { control: "actor", path: when, exists: false } },
        {
          $if: {
            control: "actor",
            path: `${scopes}.${model.name}`,
            hasSome: [...model.above(action)],
          },
          ...row,
        },
      ],
    };
  };
  return limit;
};
