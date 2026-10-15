import {
  ClientInitializationError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from "@errors";
import { owner, rbac } from "@src/rbac";
import { softDelete } from "@src/soft-delete/index";
import { v } from "@src/validation";
import {
  above,
  actionsOf,
  createOracle,
  GOVERNED_MODELS,
  type GovernedModel,
  MODEL_ACTIONS,
  type OracleOptions,
  rowKey,
  TOMBSTONED_MODELS,
} from "@tests/package/fixtures/rbac-app/oracle";
import { schema } from "@tests/package/fixtures/rbac-app/schema";
import {
  type AccessGrantRow,
  type Actor,
  actors,
  seed,
} from "@tests/package/fixtures/rbac-app/seed";
import {
  Actor as ActorSchema,
  blog,
  policy,
  storedPolicy,
} from "@tests/types/rbac/acceptance-policy";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";
import {
  createDataOf,
  createRbacAppClient,
  loadRbacSeed,
  type RbacAppClient,
  type RbacAppSubstrate,
} from "./rbac-app-behavior";

/**
 * `viborm/rbac` itself (plan §1.1, §3.3 D0, D8, D11; §7 C1, C7, C10, C11,
 * C12, C13): `rbac(§1.1)` applied to the seeded rbac-app client with soft
 * delete composed as `server.ts` composes it (rows steps first, OD-1 option
 * 2), and every call made through `db.$as(actor)`. Each expectation is the
 * independent oracle's (`oracle.ts`, read with tombstones, as soft delete is
 * composed); the oracle never sees an engine result. A statement meter (a
 * statement transform after the entry) shows which refusals come before any
 * statement.
 */

type Row = Record<string, unknown>;
interface LooseDelegate {
  findMany(args?: object): Promise<Row[]>;
  findFirst(args?: object): Promise<Row | null>;
  findFirstOrThrow(args?: object): Promise<Row>;
  count(args?: object): Promise<number>;
  aggregate(args: object): Promise<Row>;
  groupBy(args: object): Promise<Row[]>;
  create(args: object): Promise<Row>;
  update(args: object): Promise<Row>;
  updateMany(args: object): Promise<{ count: number }>;
  deleteMany(args?: object): Promise<{ count: number }>;
  can(action: string, where: object): Promise<boolean>;
  assert(action: string, where: object): Promise<void>;
  restore(args: object): Promise<Row>;
}
type Loose = Record<string, LooseDelegate> & {
  $as(actor: unknown): Loose;
  $transaction<T>(body: (tx: Loose) => Promise<T>): Promise<T>;
  $extends(definition: object): Loose;
  $queryRawUnsafe(sql: string): Promise<Row[]>;
};
const loose = (client: unknown) => client as Loose;

export interface EntrySubstrate extends RbacAppSubstrate {
  /** Run W-X1: raw SQL through the governed client (SQLite3 spelling). */
  readonly raw?: boolean;
  /**
   * `false` on a server, where each governed statement is planned afresh:
   * W-N2 reads page and document actions only, W-CAN6 organization and
   * page-group rows only. Every model otherwise.
   */
  readonly exhaustive?: boolean;
}

/** The models of the schema the policy does not list (R9). */
const UNLISTED = Object.keys(schema).filter(
  (model) => !(GOVERNED_MODELS as readonly string[]).includes(model)
);
/** The actors whose finer reads are judged: every shape of access the seed holds. */
const READERS = ["u01", "u03", "u04", "u05", "u20", "u22", "u42", "u56"];
const ROLLBACK = new Error("rolled back");

const tombstones = softDelete({
  models: Object.fromEntries(
    TOMBSTONED_MODELS.map((model) => [model, { deletedAt: "deletedAt" }])
  ),
});

/**
 * §1.1's `server.ts` chain over `client`: soft delete's and rbac's rows
 * steps, then `between` (an extension that comes after every rows step),
 * then their methods steps.
 */
function governedOver(client: RbacAppClient, between?: object): Loose {
  const rows = policy.rows(tombstones.rows(client));
  const middle = between === undefined ? rows : loose(rows).$extends(between);
  return loose(policy.methods(tombstones.methods(middle as typeof rows)));
}

/** A copy of the model's first seeded row under new keys: valid create data. */
const freshRow = (model: string): Row => {
  const [first] = seed[model as keyof typeof seed] as unknown as Row[];
  const copy: Row = createDataOf(model, first!);
  if ("id" in copy) copy.id = `fresh-${model}`;
  if ("token" in copy) copy.token = "fresh-token";
  if ("key" in copy) copy.key = "fresh-key";
  if ("action" in copy) copy.action = "fresh";
  return copy;
};

const keyOf = (model: string) =>
  model === "teamMember" ? { teamId: true, userId: true } : { id: true };
const keys = (model: string, rows: readonly Row[]) =>
  rows.map((row) => rowKey(model, row)).sort();
const minus = (left: readonly string[], right: readonly string[]) =>
  left.filter((item) => !right.includes(item));

/** The class of what `body` throws, or "ok". */
async function outcomeOf(body: () => Promise<unknown>): Promise<string> {
  try {
    await body();
    return "ok";
  } catch (error) {
    return (error as Error).constructor.name;
  }
}

/**
 * `given(view)` of plan §1.1 on a page, read from the seed as oracle reading
 * A4 states it: a live grant on the page whose level or actions cover view,
 * to the actor's user, to everyone, to a team the actor is a live member of
 * or below, or to the actor's live role in the grant's organization.
 */
function givenPages(actor: Actor): Set<string> {
  const children = new Map<string, string[]>();
  for (const { childId, parentId } of seed.teamParent)
    children.set(parentId, [...(children.get(parentId) ?? []), childId]);
  const below = (team: string, seen = new Set<string>()): Set<string> => {
    if (seen.has(team)) return seen;
    seen.add(team);
    for (const child of children.get(team) ?? []) below(child, seen);
    return seen;
  };
  const wanted = above("page", "view");
  const names = (grant: AccessGrantRow) =>
    grant.userId === actor.userId ||
    grant.everyone ||
    (grant.granteeTeamId !== null &&
      seed.teamMember.some(
        (tm) =>
          tm.deletedAt === null &&
          tm.userId === actor.userId &&
          below(grant.granteeTeamId!).has(tm.teamId)
      )) ||
    (grant.granteeRole !== null &&
      seed.member.some(
        (m) =>
          m.deletedAt === null &&
          m.userId === actor.userId &&
          m.organizationId === grant.organizationId &&
          m.role === grant.granteeRole
      ));
  return new Set(
    seed.accessGrant
      .filter(
        (grant) =>
          grant.deletedAt === null &&
          grant.pageId !== null &&
          (grant.actions.some((a) => wanted.includes(a)) ||
            (grant.level !== null && wanted.includes(grant.level))) &&
          names(grant)
      )
      .map((grant) => grant.pageId!)
  );
}

export function runRbacEntryBehavior(substrate: EntrySubstrate): void {
  const oracle = createOracle(seed);
  const judged = substrate.actors ?? Object.keys(actors);
  const exhaustive = substrate.exhaustive !== false;
  const modeled = (model: GovernedModel) =>
    exhaustive || model === "page" || model === "document";
  const timeout = substrate.timeout ?? 120_000;
  const now = new Date();
  const at = (
    actor: Actor,
    model: GovernedModel,
    action: string,
    options: Partial<OracleOptions> = {}
  ) => oracle.rows(actor, model, action, { now, ...options });

  describe(`${substrate.name}: viborm/rbac against the oracle`, () => {
    let base: RbacAppClient;
    let db: Loose;
    const statements: string[] = [];
    /** The governed client, its statements metered. */
    let metered: Loose;
    const as = (name: string) => metered.$as(actors[name]!);
    /**
     * What `body` returns, rolled back, or, where the substrate has no
     * callback transaction, followed by its `restore`.
     */
    const rolledBack = async <T>(
      client: Loose,
      body: (tx: Loose) => Promise<T>
    ): Promise<T> => {
      if (substrate.restore)
        try {
          return await body(client);
        } finally {
          await substrate.restore(base);
        }
      let result: T | undefined;
      try {
        await client.$transaction(async (tx) => {
          result = await body(tx);
          throw ROLLBACK;
        });
      } catch (error) {
        if (error !== ROLLBACK) throw error;
      }
      return result as T;
    };
    /** The statements `body` issues before it settles. */
    const issued = async (body: () => Promise<unknown>) => {
      statements.length = 0;
      const outcome = await outcomeOf(body);
      return { outcome, statements: statements.length };
    };

    beforeAll(async () => {
      base = createRbacAppClient(substrate.createDriver());
      await substrate.prepare(base);
      await loadRbacSeed(base);
      db = governedOver(base);
      metered = db.$extends({
        name: "meter",
        statement: (context: { statement: unknown; model?: string }) => {
          statements.push(String(context.model));
          return context.statement;
        },
      });
    }, timeout);

    afterAll(async () => {
      await base?.$disconnect();
      await substrate.release?.();
    }, timeout);

    // PGlite answers in microtasks: a macrotask turn between tests keeps the
    // worker's RPC alive on long runs (see rbac-compiled-policy-behavior.ts).
    afterEach(() => new Promise((resolve) => setImmediate(resolve)));

    // --- C1: filtering at every scope ------------------------------------

    test(
      "W-R1: root reads, counts, aggregates and groupBy select exactly the oracle's view rows, on every model, for every judged actor",
      async () => {
        for (const name of judged) {
          const actor = actors[name]!;
          const call = db.$as(actor);
          for (const model of GOVERNED_MODELS) {
            const expected = at(actor, model, "view");
            const where = `${name} ${model}`;
            expect(
              keys(
                model,
                await call[model]!.findMany({ select: keyOf(model) })
              ),
              where
            ).toEqual(expected);
            expect(await call[model]!.count(), where).toBe(expected.length);
          }
          const pages = new Set(at(actor, "page", "view"));
          const visible = seed.page.filter((page) => pages.has(page.id));
          expect(
            await call.page!.aggregate({ _count: { _all: true } }),
            name
          ).toEqual({ _count: { _all: visible.length } });
          const groups = await call.page!.groupBy({
            by: ["organizationId"],
            _count: { _all: true },
          });
          const counted: Record<string, number> = {};
          for (const page of visible)
            counted[page.organizationId] =
              (counted[page.organizationId] ?? 0) + 1;
          expect(
            Object.fromEntries(
              groups.map((group) => [
                group.organizationId,
                (group._count as { _all: number })._all,
              ])
            ),
            name
          ).toEqual(counted);
        }
      },
      timeout
    );

    test(
      "W-R2, distinct: a cursor on a hidden row is a missing cursor; one on a visible row starts there; distinct reads visible rows only",
      async () => {
        let hiddenCursors = 0;
        for (const name of READERS) {
          const actor = actors[name]!;
          const call = db.$as(actor);
          const view = at(actor, "page", "view");
          const hidden = seed.page.find(
            (page) => page.deletedAt === null && !view.includes(page.id)
          );
          const page = (cursor: string) =>
            call.page!.findMany({
              cursor: { id: cursor },
              orderBy: { id: "asc" },
              take: 3,
              select: { id: true },
            });
          if (hidden !== undefined) {
            hiddenCursors += 1;
            expect(await page(hidden.id), name).toEqual([]);
          }
          const first = view[0];
          if (first !== undefined)
            expect(keys("page", await page(first)), name).toEqual(
              view.slice(0, 3)
            );
          const distinct = await call.page!.findMany({
            distinct: ["groupId"],
            select: { groupId: true },
          });
          expect(
            distinct.map((row) => String(row.groupId)).sort(),
            name
          ).toEqual(
            [
              ...new Set(
                seed.page
                  .filter((p) => view.includes(p.id))
                  .map((p) => String(p.groupId))
              ),
            ].sort()
          );
        }
        expect(hiddenCursors).toBeGreaterThan(0);
      },
      timeout
    );

    test(
      "W-R3, W-R4, W-R7: an included to-one reads null where its target is hidden, a to-many and a relation count hold visible members only",
      async () => {
        let hiddenGroups = 0;
        for (const name of READERS) {
          const actor = actors[name]!;
          const call = db.$as(actor);
          const pages = new Set(at(actor, "page", "view"));
          const groups = new Set(at(actor, "pageGroup", "view"));
          const withGroups = await call.page!.findMany({
            select: { id: true, group: { select: { id: true } } },
          });
          const expectedGroup = (id: string) => {
            const { groupId } = seed.page.find((p) => p.id === id)!;
            return groupId !== null && groups.has(groupId) ? groupId : null;
          };
          for (const row of withGroups) {
            const read = (row.group as Row | null)?.id ?? null;
            expect(read, `${name} ${row.id}`).toBe(
              expectedGroup(String(row.id))
            );
            const { groupId } = seed.page.find((p) => p.id === row.id)!;
            if (groupId !== null && read === null) hiddenGroups += 1;
          }
          const members = (group: string) =>
            seed.page
              .filter((p) => p.groupId === group && pages.has(p.id))
              .map((p) => p.id)
              .sort();
          const withPages = await call.pageGroup!.findMany({
            select: {
              id: true,
              pages: { select: { id: true } },
              _count: { select: { pages: true } },
            },
          });
          expect(keys("pageGroup", withPages), name).toEqual(
            [...groups].sort()
          );
          for (const group of withPages) {
            const expected = members(String(group.id));
            expect(keys("page", group.pages as Row[]), name).toEqual(expected);
            expect((group._count as Row).pages, name).toBe(expected.length);
          }
          const ordered = await call.pageGroup!.findMany({
            orderBy: [{ pages: { _count: "desc" } }, { id: "asc" }],
            select: { id: true },
          });
          expect(
            ordered.map((group) => String(group.id)),
            name
          ).toEqual(
            [...groups].sort(
              (a, b) =>
                members(b).length - members(a).length || a.localeCompare(b)
            )
          );
        }
        expect(hiddenGroups).toBeGreaterThan(0);
      },
      timeout
    );

    test(
      "W-R5, W-R6: some, every, none and is quantify over visible members and targets only",
      async () => {
        for (const name of READERS) {
          const actor = actors[name]!;
          const call = db.$as(actor);
          const pages = new Set(at(actor, "page", "view"));
          const groups = at(actor, "pageGroup", "view");
          const visibleIn = (group: string) =>
            seed.page.filter((p) => p.groupId === group && pages.has(p.id));
          const where = async (filter: object) =>
            keys(
              "pageGroup",
              await call.pageGroup!.findMany({
                where: { pages: filter },
                select: { id: true },
              })
            );
          expect(await where({ some: {} }), name).toEqual(
            groups.filter((g) => visibleIn(g).length > 0)
          );
          expect(await where({ none: {} }), name).toEqual(
            groups.filter((g) => visibleIn(g).length === 0)
          );
          expect(await where({ every: { personal: false } }), name).toEqual(
            groups.filter((g) => visibleIn(g).every((p) => !p.personal))
          );
          const groupSet = new Set(groups);
          expect(
            keys(
              "page",
              await call.page!.findMany({
                where: { group: { is: {} } },
                select: { id: true },
              })
            ),
            name
          ).toEqual(
            [...pages]
              .filter((id) => {
                const { groupId } = seed.page.find((p) => p.id === id)!;
                return groupId !== null && groupSet.has(groupId);
              })
              .sort()
          );
        }
      },
      timeout
    );

    test(
      "W-R8: a recursive read walks visible nodes only: the §1.1 tree is the oracle's, and under an owner-only policy a hidden document cuts its branch",
      async () => {
        type Tree = { id: string; children: Tree[] };
        const sortTree = (node: Row): Tree => ({
          id: String(node.id),
          children: (node.children as Row[])
            .map(sortTree)
            .sort((a, b) => a.id.localeCompare(b.id)),
        });
        let cut = 0;
        for (const name of READERS) {
          const actor = actors[name]!;
          const view = new Set(at(actor, "document", "view"));
          const treeOf = (id: string): Tree => ({
            id,
            children: seed.document
              .filter((d) => d.parentId === id && view.has(d.id))
              .map((d) => treeOf(d.id))
              .sort((a, b) => a.id.localeCompare(b.id)),
          });
          const roots = await db.$as(actor).document!.findMany({
            where: { parentId: null },
            select: {
              id: true,
              children: { recurse: { depth: false }, select: { id: true } },
            },
          });
          expect(
            roots.map(sortTree).sort((a, b) => a.id.localeCompare(b.id)),
            name
          ).toEqual(
            seed.document
              .filter((d) => d.parentId === null && view.has(d.id))
              .map((d) => treeOf(d.id))
              .sort((a, b) => a.id.localeCompare(b.id))
          );
        }
        // §1.1 inherits down the tree (every arm is `up()`), so no visible
        // node has a hidden child; an owner-only policy cuts branches.
        const owned = loose(
          rbac({
            actor: ActorSchema,
            models: { document: { view: owner("ownerId") } },
          })(base)
        );
        for (const name of READERS) {
          const actor = actors[name]!;
          const mine = (d: { ownerId: string | null }) =>
            d.ownerId === actor.userId;
          const ownedOf = (id: string): Tree => ({
            id,
            children: seed.document
              .filter((d) => d.parentId === id && mine(d))
              .map((d) => ownedOf(d.id))
              .sort((a, b) => a.id.localeCompare(b.id)),
          });
          const walked = await owned.$as(actor).document!.findMany({
            where: { parentId: null },
            select: {
              id: true,
              children: { recurse: { depth: false }, select: { id: true } },
            },
          });
          expect(
            walked.map(sortTree).sort((a, b) => a.id.localeCompare(b.id)),
            name
          ).toEqual(
            seed.document
              .filter((d) => d.parentId === null && mine(d))
              .map((d) => ownedOf(d.id))
              .sort((a, b) => a.id.localeCompare(b.id))
          );
          cut += seed.document.filter(
            (d) =>
              !mine(d) &&
              d.parentId !== null &&
              mine(seed.document.find((p) => p.id === d.parentId)!)
          ).length;
        }
        expect(cut).toBeGreaterThan(0);
      },
      timeout
    );

    test(
      "W-R9: a polymorphic arm reads under its target's P(view): a bookmark's subject is its variant and row where the actor views the target, null where it does not, and a filter through the arm reads the same",
      async () => {
        type Arm = { type: "page" | "document"; id: string } | null;
        const sorted = (arms: Iterable<[string, Arm]>) =>
          [...arms].sort(([a], [b]) => a.localeCompare(b));
        let shown = 0;
        let hidden = 0;
        for (const name of judged) {
          const actor = actors[name]!;
          const want = oracle.subjects(actor, { now });
          const call = db.$as(actor);
          const rows = (await call.bookmark!.findMany({
            include: { subject: true },
          })) as unknown as {
            id: string;
            subject: { type: "page" | "document"; data: Row } | null;
          }[];
          expect(
            sorted(
              rows.map((row): [string, Arm] => [
                row.id,
                row.subject === null
                  ? null
                  : { type: row.subject.type, id: String(row.subject.data.id) },
              ])
            ),
            name
          ).toEqual(sorted(want));
          for (const type of ["page", "document"] as const) {
            const through = await call.bookmark!.findMany({
              where: { subject: { type, is: {} } },
              select: { id: true },
            });
            expect(keys("bookmark", through), `${name} ${type}`).toEqual(
              [...want]
                .filter(([, arm]) => arm?.type === type)
                .map(([id]) => id)
                .sort()
            );
          }
          for (const [id, arm] of want) {
            if (arm !== null) shown += 1;
            else if (seed.bookmark.find((b) => b.id === id)!.subjectId !== null)
              hidden += 1;
          }
        }
        // Both readings occur among the judged actors on every substrate.
        if (judged.length > 3) {
          expect(shown).toBeGreaterThan(0);
          expect(hidden).toBeGreaterThan(0);
        }
      },
      timeout
    );

    if (substrate.raw === true)
      test("W-X1: raw SQL on the governed client is not filtered: it reads every row", async () => {
        const call = db.$as(actors.u04!);
        expect(await call.page!.count()).toBeLessThan(seed.page.length);
        const rows = await call.$queryRawUnsafe('SELECT id FROM "page"');
        expect(rows).toHaveLength(seed.page.length);
      });

    // --- C10: modes narrow only -------------------------------------------

    test(
      'W-N1, W-N2: as an action reads P(view) ∧ P(action), on every (model, action); as "given" reads P(view) ∧ given(view)',
      async () => {
        for (const name of judged) {
          const actor = actors[name]!;
          const call = db.$as(actor);
          for (const [model, action] of MODEL_ACTIONS.filter(([model]) =>
            modeled(model)
          ))
            expect(
              keys(
                model,
                await call[model]!.findMany({
                  as: action,
                  select: keyOf(model),
                })
              ),
              `${name} ${model} as ${action}`
            ).toEqual(at(actor, model, action));
          const given = givenPages(actor);
          expect(
            keys(
              "page",
              await call.page!.findMany({ as: "given", select: { id: true } })
            ),
            `${name} as given`
          ).toEqual(at(actor, "page", "view").filter((id) => given.has(id)));
        }
      },
      timeout
    );

    test("W-N3: an `as` no model declares is the rows control's ValidationError, before any statement", async () => {
      expect(
        await issued(() => as("u03").page!.findMany({ as: "nope" }))
      ).toEqual({ outcome: ValidationError.name, statements: 0 });
    });

    // --- C11: default deny -------------------------------------------------

    test("W-D1: without an actor every operation of every model is refused before any statement; the actor is never an argument", async () => {
      for (const model of Object.keys(schema)) {
        const refusal = await metered[model]!.findMany().catch((e) => e);
        expect(refusal, model).toBeInstanceOf(ValidationError);
        expect((refusal as Error).message, model).toContain(
          'Control "actor" is required'
        );
      }
      expect(await issued(() => metered.page!.count())).toEqual({
        outcome: ValidationError.name,
        statements: 0,
      });
      expect(
        await issued(() => as("u03").page!.findMany({ actor: actors.u01 }))
      ).toEqual({ outcome: ValidationError.name, statements: 0 });
    });

    test("W-D2: a model the policy does not list is refused at the root before any statement, and reads empty through a relation", async () => {
      expect(UNLISTED.sort()).toEqual(["apiKey", "rolePermission", "session"]);
      const call = as("u01");
      for (const model of UNLISTED)
        for (const operation of [
          () => call[model]!.findMany(),
          () => call[model]!.count(),
          () => call[model]!.deleteMany(),
          // Valid data: an invalid create fails its validation first.
          () => call[model]!.create({ data: freshRow(model) }),
        ])
          expect(await issued(operation), model).toEqual({
            outcome: ForbiddenError.name,
            statements: 0,
          });
      const users = await call.user!.findMany({
        select: {
          id: true,
          sessions: { select: { id: true } },
          apiKeys: { select: { id: true } },
        },
      });
      expect(users.length).toBeGreaterThan(0);
      for (const user of users) {
        expect(user.sessions).toEqual([]);
        expect(user.apiKeys).toEqual([]);
      }
    });

    test(
      "W-D3: a verb a model does not declare matches nothing below the root: team declares no delete, so an admin's nested deleteMany of a team's children deletes none",
      async () => {
        let cases = 0;
        for (const name of READERS) {
          const actor = actors[name]!;
          const parent = at(actor, "team", "edit").find((team) =>
            seed.teamParent.some((edge) => edge.parentId === team)
          );
          if (parent === undefined) continue;
          cases += 1;
          const left = await rolledBack(db.$as(actor), async (tx) => {
            await tx.team!.update({
              where: { id: parent },
              data: { children: { deleteMany: {} } },
            });
            return await tx.team!.count({
              where: { parents: { some: { id: parent } } },
            });
          });
          expect(left, name).toBe(
            seed.teamParent.filter((edge) => edge.parentId === parent).length
          );
        }
        expect(cases).toBeGreaterThan(0);
      },
      timeout
    );

    test(
      "W-D4, W-D5, W-D7: an absent credential folds false (OD-6 session()): no session, an expired or unknown one, a disabled, expired or unknown key reach what the oracle says, on every model",
      async () => {
        const special = [
          "u17-no-credential",
          "u07-expired",
          "u27-unknown-session",
          "u21-session-and-key",
          "k02-pages-view",
          "k02-disabled-key",
          "k03-expired-key",
          "k50-unknown-key",
        ];
        let reachedNothing = 0;
        for (const name of special) {
          const actor = actors[name]!;
          const call = db.$as(actor);
          for (const model of GOVERNED_MODELS) {
            const expected = at(actor, model, "view");
            expect(
              keys(
                model,
                await call[model]!.findMany({ select: keyOf(model) })
              ),
              `${name} ${model}`
            ).toEqual(expected);
            if (model === "page" && expected.length === 0) reachedNothing += 1;
          }
        }
        // The dead credentials and keys reach no page; a live one does.
        expect(reachedNothing).toBeGreaterThanOrEqual(6);
        expect(
          at(actors["k02-pages-view"]!, "page", "view").length
        ).toBeGreaterThan(0);
      },
      timeout
    );

    test("W-D6: a root call false when the policy is applied is refused before any statement with ForbiddenError (plan §5.3, D11, OD-7): a mode the model does not declare, a verb it does not declare", async () => {
      const call = as("u01");
      for (const [model, mode] of [
        ["page", "invite"],
        ["page", "comment"],
        ["user", "given"],
      ] as const) {
        const result = await issued(() => call[model]!.findMany({ as: mode }));
        expect(result, `${model} as ${mode}`).toEqual({
          outcome: ForbiddenError.name,
          statements: 0,
        });
        const refusal = (await call[model]!.findMany({ as: mode }).catch(
          (e) => e
        )) as ForbiddenError;
        expect(refusal.meta).toMatchObject({ model, operation: "findMany" });
        // `can` asks through the same mode: an action the model does not
        // declare is the same refusal, never a false that reads as hidden.
        expect(
          await issued(() => call[model]!.can(mode, { id: "none" })),
          `${model} can ${mode}`
        ).toEqual({ outcome: ForbiddenError.name, statements: 0 });
      }
      // organization and team declare no delete: their deletes are false.
      for (const model of ["organization", "team"])
        expect(await issued(() => call[model]!.deleteMany()), model).toEqual({
          outcome: ForbiddenError.name,
          statements: 0,
        });
      // A declared mode and verb run.
      expect(
        (await issued(() => call.page!.findMany({ as: "full" }))).outcome
      ).toBe("ok");
    });

    test("W-D8: the §1.1 policy, its stored-role variant and the blog apply to the fixture's client", async () => {
      expect(() => policy(base)).not.toThrow();
      expect(() => storedPolicy(base)).not.toThrow();
      expect(() => blog(base)).not.toThrow();
      const blogged = loose(blog(base)).$as({
        userId: "user-03",
        admin: false,
      });
      expect(await blogged.page!.count()).toBe(seed.page.length);
      expect(
        await issued(() =>
          loose(blog(base))
            .$as({ userId: "user-03", admin: false })
            .organization!.count()
        )
      ).toEqual({ outcome: ForbiddenError.name, statements: 0 });
    });

    test(
      "W-D9: a per-call fold takes the ordinary outcome: export off the office network is empty, NotFoundError on a unique read, false for can",
      async () => {
        const admin = actors.u01!;
        const org = seed.member.find(
          (m) => m.userId === admin.userId && m.role === "admin"
        )!.organizationId;
        for (const network of ["office", "public"]) {
          const actor = { ...admin, network };
          const call = db.$as(actor);
          const expected = at(actor, "organization", "export");
          expect(
            keys(
              "organization",
              await call.organization!.findMany({
                as: "export",
                select: { id: true },
              })
            ),
            network
          ).toEqual(expected);
          expect(
            await outcomeOf(() =>
              call.organization!.findFirstOrThrow({
                where: { id: org },
                as: "export",
              })
            ),
            network
          ).toBe(expected.includes(org) ? "ok" : NotFoundError.name);
          expect(
            await call.organization!.can("export", { id: org }),
            network
          ).toBe(expected.includes(org));
        }
        expect(
          at({ ...admin, network: "office" }, "organization", "export")
        ).toContain(org);
        expect(
          at({ ...admin, network: "public" }, "organization", "export")
        ).toEqual([]);
      },
      timeout
    );

    test("W-D10: an actor path the actor schema does not declare is refused when the policy is applied", () => {
      const misspelt = rbac({
        actor: ActorSchema,
        models: { page: { view: { ownerId: { actor: "usrId" } } } },
      } as never);
      expect(() => misspelt(base as never)).toThrow(ClientInitializationError);
      expect(() => misspelt(base as never)).toThrow('actor path "usrId"');
    });

    test("a read-gated key or foreign key is refused when the policy is applied (K5's admission)", () => {
      const gated = rbac({
        actor: ActorSchema,
        levels: ["view", "edit", "full"],
        models: { page: { fields: { groupId: { read: "full" } } } },
      } as never);
      expect(() => gated(base as never)).toThrow(ClientInitializationError);
      expect(() => gated(base as never)).toThrow(
        'rows.verbs.page at "reads.groupId": names a key or foreign key'
      );
    });

    test("W-D11: a null actor value matches nothing: no orphaned row is owned by an actor without a user", async () => {
      const orphans = seed.page.filter(
        (p) => p.ownerId === null && p.deletedAt === null
      );
      expect(orphans.length).toBeGreaterThan(0);
      const owners = loose(
        rbac({
          actor: v.object({ userId: v.string({ nullable: true }) }),
          models: { page: { view: owner("ownerId") } },
        })(base)
      );
      expect(await owners.$as({ userId: null }).page!.count()).toBe(0);
      expect(await owners.$as({ userId: "user-03" }).page!.count()).toBe(
        seed.page.filter((p) => p.ownerId === "user-03").length
      );
    });

    test("W-D12: a create without an actor is refused on every model, before any statement", async () => {
      for (const model of Object.keys(schema)) {
        const create = () => metered[model]!.create({ data: freshRow(model) });
        expect(await issued(create), model).toEqual({
          outcome: ValidationError.name,
          statements: 0,
        });
        expect(((await create().catch((e) => e)) as Error).message).toContain(
          'Control "actor" is required'
        );
      }
    });

    // --- C7: single-action answers ----------------------------------------

    test(
      "W-CAN1, W-CAN3, W-CAN4: can answers the oracle for a held, a lacking and a hidden row in one statement; assert throws ForbiddenError for both of the last",
      async () => {
        let hidden = 0;
        let lacking = 0;
        for (const name of READERS) {
          const actor = actors[name]!;
          const call = metered.$as(actor);
          for (const action of actionsOf("document")) {
            const holds = at(actor, "document", action);
            const view = at(actor, "document", "view");
            const cases = [
              holds[0],
              minus(view, holds)[0],
              seed.document.find((d) => !view.includes(d.id))?.id,
            ];
            for (const [index, id] of cases.entries()) {
              if (id === undefined) continue;
              if (index === 1) lacking += 1;
              if (index === 2) hidden += 1;
              statements.length = 0;
              const held = await call.document!.can(action, { id });
              expect(held, `${name} ${action} ${id}`).toBe(holds.includes(id));
              expect(statements, `${name} ${action}`).toHaveLength(1);
              expect(
                await outcomeOf(() => call.document!.assert(action, { id })),
                `${name} ${action} ${id}`
              ).toBe(held ? "ok" : ForbiddenError.name);
            }
          }
        }
        expect(hidden).toBeGreaterThan(0);
        expect(lacking).toBeGreaterThan(0);
      },
      timeout
    );

    test(
      "W-CAN5: organization-level actions: invite and export answer the oracle per organization",
      async () => {
        for (const name of judged) {
          const actor = actors[name]!;
          const call = db.$as(actor);
          for (const action of actionsOf("organization")) {
            const holds = at(actor, "organization", action);
            for (const { id } of seed.organization)
              expect(
                await call.organization!.can(action, { id }),
                `${name} ${action} ${id}`
              ).toBe(holds.includes(id));
          }
        }
      },
      timeout
    );

    const answered: readonly GovernedModel[] = exhaustive
      ? GOVERNED_MODELS
      : ["organization", "pageGroup"];
    for (const name of READERS.slice(0, 3))
      for (const model of answered)
        test(
          `W-CAN6: can equals the oracle on every seeded ${model} row, at every action, for ${name}`,
          async () => {
            const actor = actors[name]!;
            const call = db.$as(actor);
            const rows = seed[model] as unknown as Row[];
            for (const action of actionsOf(model)) {
              const holds = new Set(at(actor, model, action));
              const answers = await Promise.all(
                rows.map((row) =>
                  call[model]!.can(
                    action,
                    model === "teamMember"
                      ? { teamId: row.teamId, userId: row.userId }
                      : { id: row.id }
                  )
                )
              );
              expect(
                rows
                  .filter((_, index) => answers[index])
                  .map((row) => rowKey(model, row))
                  .sort(),
                `${name} ${model} ${action}`
              ).toEqual([...holds].sort());
              // A macrotask turn per action keeps PGlite's worker RPC alive.
              await new Promise((resolve) => setImmediate(resolve));
            }
          },
          timeout
        );

    // --- C12: composition is intersection ---------------------------------

    test(
      "W-C1: with soft delete composed rows steps first (OD-1 option 2), each deleted mode chooses root rows only, restore needs edit, and the order guard stands",
      async () => {
        let restored = 0;
        for (const name of READERS) {
          const actor = actors[name]!;
          const call = db.$as(actor);
          for (const deleted of ["with", "only"] as const)
            expect(
              keys(
                "page",
                await call.page!.findMany({ deleted, select: { id: true } })
              ),
              `${name} ${deleted}`
            ).toEqual(at(actor, "page", "view", { deleted }));
          const edit = at(actor, "page", "edit", { deleted: "only" });
          const view = at(actor, "page", "view", { deleted: "only" });
          const editable = edit[0];
          if (editable !== undefined) {
            restored += 1;
            expect(
              await rolledBack(call, async (tx) => {
                await tx.page!.restore({ where: { id: editable } });
                return (await tx.page!.findMany({ where: { id: editable } }))
                  .length;
              }),
              name
            ).toBe(1);
          }
          const viewedOnly = minus(view, edit)[0];
          if (viewedOnly !== undefined)
            expect(
              await outcomeOf(() =>
                rolledBack(call, (tx) =>
                  tx.page!.restore({ where: { id: viewedOnly } })
                )
              ),
              name
            ).toBe(NotFoundError.name);
        }
        expect(restored).toBeGreaterThan(0);
        expect(() => tombstones.rows(policy.rows(base))).toThrow(
          ClientInitializationError
        );
      },
      timeout
    );

    test(
      "W-C2: with tenancy composed below, a call sees the intersection: its tenant's rows the policy grants",
      async () => {
        const tenanted = [
          "member",
          "team",
          "accessGrant",
          "pageGroup",
          "page",
          "document",
          "collection",
        ] as const;
        const tenancy = {
          name: "tenancy",
          controls: { tenant: { schema: v.string(), required: true } },
          rows: {
            control: "scope",
            default: "tenant",
            models: Object.fromEntries(
              tenanted.map((model) => {
                const mine = { organizationId: { control: "tenant" } };
                return [model, { tenant: { root: mine, related: mine } }];
              })
            ),
          },
        };
        const governed = governedOver(
          loose(base).$extends(tenancy) as unknown as RbacAppClient
        );
        let split = 0;
        for (const name of [...READERS, "u22-in-org-2", "u42"]) {
          const actor = actors[name]!;
          const call = governed.$as(actor);
          for (const tenant of ["org-1", "org-2", "org-3"]) {
            for (const model of ["page", "document", "collection"] as const) {
              const rows = seed[model] as unknown as Row[];
              const inTenant = new Set(
                rows
                  .filter((row) => row.organizationId === tenant)
                  .map((row) => String(row.id))
              );
              const expected = at(actor, model, "view").filter((id) =>
                inTenant.has(id)
              );
              if (
                expected.length > 0 &&
                expected.length < at(actor, model, "view").length
              )
                split += 1;
              expect(
                keys(
                  model,
                  await call[model]!.findMany({ tenant, select: { id: true } })
                ),
                `${name} ${tenant} ${model}`
              ).toEqual(expected);
            }
          }
        }
        expect(split).toBeGreaterThan(0);
      },
      timeout
    );

    test(
      "W-C3: audit after the rows steps stamps the bound actor's userId (K7(c)) and takes no action: an archive-only writer archives exactly the oracle's rows",
      async () => {
        const audit = {
          name: "audit",
          data: {
            models: {
              document: {
                update: { searchKey: { control: "actor", path: "userId" } },
              },
            },
          },
        };
        const governed = governedOver(base, audit);
        const instant = new Date("2031-01-01T00:00:00.000Z");
        let archivers = 0;
        for (const name of READERS) {
          const actor = actors[name]!;
          const archive = at(actor, "document", "archive");
          if (minus(archive, at(actor, "document", "edit")).length > 0)
            archivers += 1;
          const stamped = await rolledBack(governed.$as(actor), async (tx) => {
            const { count } = await tx.document!.updateMany({
              data: { archivedAt: instant },
            });
            const rows = await tx.document!.findMany({
              where: { searchKey: actor.userId },
              select: { id: true },
            });
            return { count, rows: keys("document", rows) };
          });
          expect(stamped, name).toEqual({
            count: archive.length,
            rows: archive,
          });
        }
        expect(archivers).toBeGreaterThan(0);
      },
      timeout
    );

    test(
      "W-C4: a tombstoned grant or membership grants nothing, under every deleted mode",
      async () => {
        let revoked = 0;
        for (const name of judged) {
          const actor = actors[name]!;
          const live = new Set(at(actor, "page", "view", { deleted: "with" }));
          const lost = at(actor, "page", "view", {
            tombstones: false,
          }).filter(
            (id) =>
              !live.has(id) &&
              seed.page.find((p) => p.id === id)!.deletedAt === null
          );
          if (lost.length === 0) continue;
          revoked += 1;
          const call = db.$as(actor);
          for (const deleted of ["without", "with", "only"])
            expect(
              await call.page!.findMany({
                where: { id: { in: lost } },
                deleted,
                select: { id: true },
              }),
              `${name} ${deleted}`
            ).toEqual([]);
        }
        expect(revoked).toBeGreaterThan(0);
      },
      timeout
    );
  });
}
