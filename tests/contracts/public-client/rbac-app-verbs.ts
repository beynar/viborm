import { NestedWriteError, NotFoundError } from "@errors";
import { rbac } from "@src/rbac";
import { softDelete } from "@src/soft-delete/index";
import {
  actionsOf,
  createOracle,
  GOVERNED_MODELS,
  type GovernedModel,
  TOMBSTONED_MODELS,
} from "@tests/package/fixtures/rbac-app/oracle";
import {
  and,
  handRules,
  type Where,
} from "@tests/package/fixtures/rbac-app/rules";
import {
  type Actor,
  actors,
  seed,
} from "@tests/package/fixtures/rbac-app/seed";
import { policy } from "@tests/types/rbac/acceptance-policy";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  createRbacAppClient,
  loadRbacSeed,
  type RbacAppClient,
  type RbacAppSubstrate,
} from "./rbac-app-behavior";

/**
 * K3 on the RBAC acceptance estate (plan §4.3, R2, R3 as amended in §11.2,
 * R8): a `rows` member declares, per model, named predicates and the verbs
 * that take them, and every write is judged by the statement it emits. The
 * declaration is plain data, the hand-written policy of `rules.ts` with the
 * actor's facts inlined, one predicate per (model, action): `viborm/rbac`
 * does not compile it yet. Every expectation is the independent oracle's
 * (`oracle.ts`): a write succeeds, and touches exactly the rows, the oracle
 * holds at the action the write takes. Writes run in a transaction rolled
 * back after each probe, or are undone by the substrate's `restore`, so the
 * seed stays the oracle's.
 */

type Row = Record<string, unknown>;
interface LooseDelegate {
  findMany(args?: object): Promise<Row[]>;
  findUnique(args: object): Promise<Row | null>;
  update(args: object): Promise<Row>;
  updateMany(args: object): Promise<{ count: number }>;
  upsert(args: object): Promise<Row>;
  delete(args: object): Promise<Row>;
  deleteMany(args?: object): Promise<{ count: number }>;
}
type Loose = Record<string, LooseDelegate> & {
  $transaction<T>(body: (tx: Loose) => Promise<T>): Promise<T>;
};
const loose = (client: object) => client as unknown as Loose;

/** `{ OR: [] }`: an action the hand rules fold false. */
const NOTHING: Where = { OR: [] };

/** The action each write verb takes, per model (OD-3 and §1.1 `operations`). */
const UPDATE: Partial<Record<GovernedModel, string>> = { teamMember: "manage" };
const DELETE: Partial<Record<GovernedModel, string>> = {
  document: "share",
  teamMember: "manage",
  accessGrant: "edit",
  member: "edit",
};
/** `fields.write` of §1.1, and the team graph written at `invite` (W-W9). */
const WRITES: Partial<Record<GovernedModel, Record<string, string>>> = {
  page: { ownerId: "full" },
  document: { ownerId: "share", archivedAt: "archive" },
  team: { parents: "invite", children: "invite" },
};
const TOMBSTONED = new Set<string>(TOMBSTONED_MODELS);

/** `as: "given"`'s narrowing: a live grant to the actor (W-N4). */
const givenTo = (actor: Actor): Where => ({
  grants: { some: { deletedAt: null, userId: actor.userId } },
});

/**
 * The plain `rows` declaration of one actor's policy: per model its actions
 * as named predicates, `read` at `view` (live rows only on a tombstoned
 * model), each write verb at its action; `page` and `document` carry modes
 * that narrow by name.
 */
function declaration(actor: Actor, now: Date, stamped = false) {
  const rules = handRules(actor, { now });
  const verbs: Record<string, object> = {};
  for (const model of GOVERNED_MODELS) {
    const predicates: Record<string, Where> = {};
    for (const action of actionsOf(model))
      predicates[action] = rules.predicate(model, action) ?? NOTHING;
    if (TOMBSTONED.has(model))
      predicates.view = and({ deletedAt: null }, predicates.view!) ?? NOTHING;
    verbs[model] = {
      predicates,
      read: "view",
      update: UPDATE[model] ?? "edit",
      delete: DELETE[model] ?? "full",
      ...(WRITES[model] && { writes: WRITES[model] }),
    };
  }
  const modes = {
    all: {},
    view: { root: "view" },
    edit: { root: "edit" },
    given: { root: givenTo(actor) },
  };
  return {
    name: "verbs",
    rows: {
      control: "as",
      default: "all",
      models: { page: modes, document: modes },
      verbs,
    },
    // An audit stamp on every document update (W-W5′).
    ...(stamped && {
      data: { models: { document: { update: { searchKey: "audited" } } } },
    }),
  };
}

/**
 * The same judgements through `viborm/rbac` (plan §1.1): the §1.1 policy,
 * with soft delete composed as `server.ts` composes it (rows steps first,
 * OD-1 option 2), so its traversals and the oracle both read live
 * memberships, team members and grants only. Two declarations of the hand
 * policy the §1.1 text does not make are restated so each witness keeps the
 * shape it was written for: `team`'s links written at `invite` (a lead links
 * the teams it leads, W-W9, W-W10; §1.1 writes them at `edit`, its admins
 * only), and a `given` domain of the grants to the actor's own user (W-N4).
 * Every expectation stays the oracle's.
 */
const { models } = policy.config;
const entryPolicy = rbac({
  ...policy.config,
  models: {
    ...models,
    team: {
      ...models.team,
      fields: { parents: { write: "invite" }, children: { write: "invite" } },
    },
    page: {
      ...models.page,
      domains: { given: { grants: { some: { userId: { actor: "userId" } } } } },
    },
  },
});
const tombstones = softDelete({
  models: Object.fromEntries(
    TOMBSTONED_MODELS.map((model) => [model, { deletedAt: "deletedAt" }])
  ),
});
/** An audit stamp on every document update (W-W5′), between the steps. */
const AUDIT = {
  name: "audit",
  data: { models: { document: { update: { searchKey: "audited" } } } },
};
function throughEntry(base: RbacAppClient, stamped: boolean) {
  const rows = entryPolicy.rows(tombstones.rows(base));
  return entryPolicy.methods(
    tombstones.methods(stamped ? rows.$extends(AUDIT as never) : rows)
  );
}

export interface VerbsRun {
  /** `"entry"`: judge through `viborm/rbac` instead of the plain `rows` member. */
  readonly through?: "entry";
}

const ROLLBACK = new Error("rolled back");
type Outcome = { outcome: string; value?: unknown; seen?: unknown };

/** What `body` returns, or the class of what it throws. */
async function outcomeOf(body: () => Promise<unknown>): Promise<Outcome> {
  try {
    return { outcome: "ok", value: await body() };
  } catch (error) {
    return { outcome: (error as Error).constructor.name };
  }
}

/**
 * What `body` returns, or the class of what it throws; never kept: rolled
 * back, or, where the substrate has no callback transaction, followed by
 * `restore`.
 */
async function probeOnce(
  client: Loose,
  body: (tx: Loose) => Promise<unknown>,
  restore?: () => Promise<void>
): Promise<Outcome> {
  if (restore) {
    try {
      return await outcomeOf(() => body(client));
    } finally {
      await restore();
    }
  }
  let result: Outcome = { outcome: "none" };
  try {
    await client.$transaction(async (tx) => {
      result = await outcomeOf(() => body(tx));
      throw ROLLBACK;
    });
  } catch (error) {
    if (error !== ROLLBACK) throw error;
  }
  return result;
}

const minus = (left: readonly string[], right: readonly string[]) =>
  left.filter((item) => !right.includes(item));
const ids = (rows: readonly Row[]) => rows.map((row) => String(row.id)).sort();

/** The actors whose writes are judged: every shape of page and document access the seed holds. */
const WRITERS = ["u03", "u04", "u05", "u20", "u22", "u42", "u45", "u56"];

export function runRbacAppVerbs(
  substrate: RbacAppSubstrate,
  run: VerbsRun = {}
): void {
  const oracle = createOracle(seed);
  const writers = substrate.actors ?? WRITERS;
  const timeout = substrate.timeout ?? 120_000;
  const entry = run.through === "entry";
  /** The mode a call takes when it names none. */
  const unnamed = entry ? "default" : "all";
  const label = entry ? "through viborm/rbac" : "(K3)";

  describe(`${substrate.name}: verbs and written fields on the RBAC estate ${label}`, () => {
    let base: RbacAppClient;
    const restore = substrate.restore && (() => substrate.restore!(base));
    const probe = (client: Loose, body: (tx: Loose) => Promise<unknown>) =>
      probeOnce(client, body, restore);
    const now = new Date();
    const at = (actor: Actor, model: GovernedModel, action: string) =>
      oracle.rows(actor, model, action, { now });
    const entries = new Map<boolean, ReturnType<typeof throughEntry>>();
    const governed = (actor: Actor, stamped = false) => {
      if (!entry)
        return loose(
          Reflect.apply(Reflect.get(base, "$extends"), base, [
            declaration(actor, now, stamped),
          ])
        );
      let client = entries.get(stamped);
      if (client === undefined) {
        client = throughEntry(base, stamped);
        entries.set(stamped, client);
      }
      return loose(client.$as(actor));
    };

    beforeAll(async () => {
      base = createRbacAppClient(substrate.createDriver());
      await substrate.prepare(base);
      await loadRbacSeed(base);
    }, timeout);

    afterAll(async () => {
      await base?.$disconnect();
      await substrate.release?.();
    }, timeout);

    test(
      "W-W1, W-W4: an update takes the action of the fields it writes, and updateMany writes exactly the rows the oracle holds there",
      async () => {
        let edited = 0;
        for (const name of writers) {
          const actor = actors[name]!;
          const db = governed(actor);
          const view = at(actor, "page", "view");
          const edit = at(actor, "page", "edit");
          const full = at(actor, "page", "full");
          const titled = await probe(db, async (tx) => {
            const { count } = await tx.page!.updateMany({
              data: { title: "w1-title" },
            });
            const rows = await tx.page!.findMany({
              where: { title: "w1-title" },
              select: { id: true },
            });
            return { count, rows: ids(rows) };
          });
          expect(titled.value, `${name} title`).toEqual({
            count: edit.length,
            rows: edit,
          });
          // The actor as every row's owner keeps each row it writes at full,
          // so the new rows (R4, K4) refuse none: the count is the old rows'.
          const owned = await probe(db, (tx) =>
            tx.page!.updateMany({ data: { ownerId: actor.userId } })
          );
          expect(owned.value, `${name} ownerId`).toEqual({
            count: full.length,
          });
          // W-W4: no count reveals a row the call sees and may not edit.
          const hidden = await probe(db, (tx) =>
            tx.page!.updateMany({
              where: { id: { in: minus(view, edit) } },
              data: { title: "w4" },
            })
          );
          expect(hidden.value, `${name} viewed only`).toEqual({ count: 0 });
          const editOnly = minus(edit, full)[0];
          if (editOnly !== undefined) {
            edited += 1;
            const owner = seed.page.find((p) => p.id === editOnly)!.ownerId;
            expect(
              (
                await probe(db, (tx) =>
                  tx.page!.update({
                    where: { id: editOnly },
                    data: { title: "w1" },
                  })
                )
              ).outcome
            ).toBe("ok");
            // The same value is still a write of `ownerId`, judged at full.
            expect(
              (
                await probe(db, (tx) =>
                  tx.page!.update({
                    where: { id: editOnly },
                    data: { ownerId: owner },
                  })
                )
              ).outcome
            ).toBe(NotFoundError.name);
          }
        }
        expect(edited).toBeGreaterThan(0);
      },
      timeout
    );

    test(
      "W-W2: an archive-only writer archives and cannot edit; archive and edit together need both",
      async () => {
        const instant = new Date("2031-01-01T00:00:00.000Z");
        let archivers = 0;
        for (const name of writers) {
          const actor = actors[name]!;
          const db = governed(actor);
          const archive = at(actor, "document", "archive");
          const edit = at(actor, "document", "edit");
          const archived = await probe(db, async (tx) => {
            const { count } = await tx.document!.updateMany({
              data: { archivedAt: instant },
            });
            const rows = await tx.document!.findMany({
              where: { archivedAt: instant },
              select: { id: true },
            });
            return { count, rows: ids(rows) };
          });
          expect(archived.value, `${name} archive`).toEqual({
            count: archive.length,
            rows: archive,
          });
          const both = await probe(db, (tx) =>
            tx.document!.updateMany({
              data: { archivedAt: instant, title: "w2" },
            })
          );
          expect(both.value, `${name} archive and edit`).toEqual({
            count: edit.length,
          });
          const only = minus(archive, edit)[0];
          if (only === undefined) continue;
          archivers += 1;
          const write = (data: object) =>
            probe(db, (tx) =>
              tx.document!.update({ where: { id: only }, data })
            );
          expect((await write({ archivedAt: instant })).outcome).toBe("ok");
          expect((await write({ title: "w2" })).outcome).toBe(
            NotFoundError.name
          );
          expect(
            (await write({ archivedAt: instant, title: "w2" })).outcome
          ).toBe(NotFoundError.name);
        }
        expect(archivers).toBeGreaterThan(0);
      },
      timeout
    );

    test(
      "W-W5′: with an audit stamp on every update, an archive-only write stays at archive and is stamped",
      async () => {
        const instant = new Date("2031-01-01T00:00:00.000Z");
        let archivers = 0;
        for (const name of writers) {
          const actor = actors[name]!;
          const archive = at(actor, "document", "archive");
          const only = minus(archive, at(actor, "document", "edit"))[0];
          if (only === undefined) continue;
          archivers += 1;
          const db = governed(actor, true);
          const stamped = await probe(db, async (tx) => {
            const { count } = await tx.document!.updateMany({
              data: { archivedAt: instant },
            });
            const rows = await tx.document!.findMany({
              where: { searchKey: "audited" },
              select: { id: true },
            });
            return { count, rows: ids(rows) };
          });
          expect(stamped.value, name).toEqual({
            count: archive.length,
            rows: archive,
          });
          const one = await probe(db, (tx) =>
            tx.document!.update({
              where: { id: only },
              data: { archivedAt: instant },
              select: { searchKey: true },
            })
          );
          expect(one).toEqual({
            outcome: "ok",
            value: { searchKey: "audited" },
          });
        }
        expect(archivers).toBeGreaterThan(0);
      },
      timeout
    );

    test(
      "W-W3: a grant is written under the grant model's own predicates: an editor of its page cannot, the page's full holder can",
      async () => {
        const pageOnly = seed.accessGrant.filter(
          (g) =>
            g.pageId !== null &&
            g.groupId === null &&
            g.documentId === null &&
            g.collectionId === null &&
            g.deletedAt === null
        );
        let editors = 0;
        let holders = 0;
        for (const name of writers) {
          const actor = actors[name]!;
          const db = governed(actor);
          const writable = at(actor, "accessGrant", "edit");
          const written = await probe(db, (tx) =>
            tx.accessGrant!.updateMany({ data: { everyone: false } })
          );
          expect(written.value, name).toEqual({ count: writable.length });
          const edit = at(actor, "page", "edit");
          const full = at(actor, "page", "full");
          const onEdited = pageOnly.find(
            (g) => edit.includes(g.pageId!) && !full.includes(g.pageId!)
          );
          const onFull = pageOnly.find((g) => full.includes(g.pageId!));
          const write = (id: string) =>
            probe(db, (tx) =>
              tx.accessGrant!.update({
                where: { id },
                data: { level: "view" },
              })
            );
          if (onEdited) {
            editors += 1;
            expect((await write(onEdited.id)).outcome, name).toBe(
              NotFoundError.name
            );
          }
          if (onFull) {
            holders += 1;
            expect((await write(onFull.id)).outcome, name).toBe("ok");
          }
        }
        expect(editors).toBeGreaterThan(0);
        expect(holders).toBeGreaterThan(0);
      },
      timeout
    );

    test(
      "W-W6: `data: {}` emits an UPDATE (the page's updatedAt), so a viewer gets NotFoundError; a row with nothing to stamp, only addressed, is read",
      async () => {
        let viewers = 0;
        let leads = 0;
        for (const name of writers) {
          const actor = actors[name]!;
          const db = governed(actor);
          const view = at(actor, "page", "view");
          const edit = at(actor, "page", "edit");
          const bumped = await probe(db, (tx) =>
            tx.page!.updateMany({ data: {} })
          );
          expect(bumped.value, name).toEqual({ count: edit.length });
          const viewed = minus(view, edit)[0];
          if (viewed !== undefined) {
            viewers += 1;
            expect(
              (
                await probe(db, (tx) =>
                  tx.page!.update({ where: { id: viewed }, data: {} })
                )
              ).outcome,
              name
            ).toBe(NotFoundError.name);
          }
          // `team` has no updatedAt: a team addressed only to reach its
          // members emits no UPDATE, so it is read at view, and a lead who
          // may not edit it writes its members at their own verb.
          const led = minus(
            at(actor, "team", "invite"),
            at(actor, "team", "edit")
          )[0];
          if (led !== undefined) {
            leads += 1;
            const through = await probe(db, async (tx) => {
              const team = await tx.team!.update({
                where: { id: led },
                data: {
                  members: {
                    updateMany: { where: {}, data: { role: "w6" } },
                  },
                },
                select: { members: { select: { role: true } } },
              });
              return [...new Set((team.members as Row[]).map((m) => m.role))];
            });
            expect(through, name).toEqual({ outcome: "ok", value: ["w6"] });
          }
        }
        expect(leads).toBeGreaterThan(0);
        expect(viewers).toBeGreaterThan(0);
      },
      timeout
    );

    test(
      "W-W7: a nested create under a parent it bumps is a write of the parent: refused under a viewed one, accepted under an editable one",
      async () => {
        let viewers = 0;
        let editors = 0;
        for (const name of writers) {
          const actor = actors[name]!;
          const db = governed(actor);
          const edit = at(actor, "document", "edit");
          const nested = (parent: string) =>
            probe(db, async (tx) => {
              await tx.document!.update({
                where: { id: parent },
                data: {
                  children: {
                    create: {
                      id: `w7-${parent}`,
                      organizationId: seed.document.find(
                        (d) => d.id === parent
                      )!.organizationId,
                      position: 0,
                    },
                  },
                },
              });
              return (
                await tx.document!.findMany({
                  where: { id: `w7-${parent}` },
                  select: { id: true },
                })
              ).length;
            });
          const viewed = minus(at(actor, "document", "view"), edit)[0];
          if (viewed !== undefined) {
            viewers += 1;
            expect((await nested(viewed)).outcome, name).toBe(
              NotFoundError.name
            );
          }
          const editable = edit[0];
          if (editable !== undefined) {
            editors += 1;
            const accepted = await nested(editable);
            // The child is visible where its parent is (up()).
            expect(accepted, name).toEqual({ outcome: "ok", value: 1 });
          }
        }
        expect(viewers).toBeGreaterThan(0);
        expect(editors).toBeGreaterThan(0);
      },
      timeout
    );

    test(
      "W-W8: an upsert on a row the actor views and may not edit takes its create arm, as on a row it cannot see; the row is unchanged",
      async () => {
        let cases = 0;
        for (const name of writers) {
          const actor = actors[name]!;
          const db = governed(actor);
          const view = at(actor, "page", "view");
          const viewed = minus(view, at(actor, "page", "edit"))[0];
          const hidden = seed.page.find(
            (p) => p.deletedAt === null && !view.includes(p.id)
          );
          if (viewed === undefined || hidden === undefined) continue;
          cases += 1;
          const created = (id: string) => ({
            id,
            organizationId: seed.page.find((p) => p.id === id)!.organizationId,
            title: "w8",
            position: 0,
          });
          const upsert = (id: string) =>
            probe(db, async (tx) => {
              await tx.page!.upsert({
                where: { id },
                update: { title: "w8" },
                create: created(id),
              });
            });
          // Outcome stated: the create arm inserts a key that exists. Through
          // the entry the created row is judged first, before any constraint
          // (R4, K4): `ForbiddenError` where the actor may not place it.
          const expected = (id: string) =>
            entry && !oracle.places(actor, "page", created(id), { now })
              ? "ForbiddenError"
              : "UniqueConstraintError";
          const onViewed = await upsert(viewed);
          const onHidden = await upsert(hidden.id);
          expect(onViewed.outcome, name).toBe(expected(viewed));
          expect(onHidden.outcome, name).toBe(expected(hidden.id));
          const stored = await loose(base).page!.findUnique({
            where: { id: viewed },
            select: { title: true },
          });
          expect(stored?.title).toBe(
            seed.page.find((p) => p.id === viewed)!.title
          );
        }
        expect(cases).toBeGreaterThan(0);
      },
      timeout
    );

    /** Every team edge, as `child>parent`. */
    const edges = async (tx: Loose) =>
      (
        await loose(tx).team!.findMany({
          select: { id: true, parents: { select: { id: true } } },
        })
      )
        .flatMap((team) =>
          (team.parents as Row[]).map((parent) => `${team.id}>${parent.id}`)
        )
        .sort();
    const SEEDED_EDGES = new Set(
      seed.teamParent.map((edge) => `${edge.childId}>${edge.parentId}`)
    );

    test(
      "W-W9: a many-to-many connect judges both rows it links: refused from the attacker's side and from the target's; a lead of both links them",
      async () => {
        let attacks = 0;
        let links = 0;
        for (const name of [...writers, "u21", "u40"]) {
          const actor = actors[name]!;
          const db = governed(actor);
          const invite = at(actor, "team", "invite");
          const viewedOnly = minus(at(actor, "team", "view"), invite);
          const mine = invite.find((team) =>
            viewedOnly.some((other) => !SEEDED_EDGES.has(`${team}>${other}`))
          );
          if (mine !== undefined) {
            attacks += 1;
            const target = viewedOnly.find(
              (other) => !SEEDED_EDGES.has(`${mine}>${other}`)
            )!;
            const fromMine = await probe(db, async (tx) => {
              await tx.team!.update({
                where: { id: mine },
                data: { parents: { connect: { id: target } } },
              });
            });
            expect(fromMine.outcome, name).toBe(NestedWriteError.name);
            const fromTarget = await probe(db, async (tx) => {
              await tx.team!.update({
                where: { id: target },
                data: { children: { connect: { id: mine } } },
              });
            });
            expect(fromTarget.outcome, name).toBe(NotFoundError.name);
          }
          const pair = invite.flatMap((child) =>
            invite
              .filter(
                (parent) =>
                  parent !== child && !SEEDED_EDGES.has(`${child}>${parent}`)
              )
              .map((parent) => [child, parent] as const)
          )[0];
          if (pair === undefined) continue;
          links += 1;
          const linked = await probe(db, async (tx) => {
            await tx.team!.update({
              where: { id: pair[0] },
              data: { parents: { connect: { id: pair[1] } } },
            });
            return (await edges(tx)).includes(`${pair[0]}>${pair[1]}`);
          });
          expect(linked, name).toEqual({ outcome: "ok", value: true });
        }
        expect(attacks).toBeGreaterThan(0);
        expect(links).toBeGreaterThan(0);
        expect(await edges(loose(base))).toEqual([...SEEDED_EDGES].sort());
      },
      timeout
    );

    test(
      "W-W10: set [] refuses a link the actor sees and may not write (NestedWriteError), as a disconnect naming it does; links it may write are cleared",
      async () => {
        let refusals = 0;
        let clears = 0;
        for (const name of [...writers, "u21", "u40"]) {
          const actor = actors[name]!;
          const db = governed(actor);
          const invite = at(actor, "team", "invite");
          const view = at(actor, "team", "view");
          const childrenOf = (team: string) =>
            seed.teamParent
              .filter((edge) => edge.parentId === team)
              .map((edge) => edge.childId);
          const clear = (team: string) =>
            probe(db, async (tx) => {
              await tx.team!.update({
                where: { id: team },
                data: { children: { set: [] } },
              });
              return (await edges(tx)).filter((edge) =>
                edge.endsWith(`>${team}`)
              );
            });
          const guarded = invite.find((team) =>
            childrenOf(team).some(
              (child) => view.includes(child) && !invite.includes(child)
            )
          );
          if (guarded !== undefined) {
            refusals += 1;
            expect((await clear(guarded)).outcome, name).toBe(
              NestedWriteError.name
            );
            const child = childrenOf(guarded).find(
              (c) => view.includes(c) && !invite.includes(c)
            )!;
            const disconnected = await probe(db, async (tx) => {
              await tx.team!.update({
                where: { id: guarded },
                data: { children: { disconnect: { id: child } } },
              });
            });
            expect(disconnected.outcome, name).toBe(NestedWriteError.name);
          }
          const free = invite.find(
            (team) =>
              childrenOf(team).length > 0 &&
              childrenOf(team).every((child) => invite.includes(child))
          );
          if (free === undefined) continue;
          clears += 1;
          expect(await clear(free), name).toEqual({ outcome: "ok", value: [] });
        }
        expect(refusals).toBeGreaterThan(0);
        expect(clears).toBeGreaterThan(0);
        expect(await edges(loose(base))).toEqual([...SEEDED_EDGES].sort());
      },
      timeout
    );

    test(
      "W-W11: a to-one `delete: true` takes its target at the target's delete verb: a grantee team the call sees and may not delete is NestedWriteError, and the grant keeps its key",
      async () => {
        // No actor of the estate may delete a team (§1.1 declares no team
        // `full`): the deletable arm is the core witness's
        // (extension-verbs.core.test.ts).
        let refusals = 0;
        const stateOf = async (tx: Loose) => ({
          grants: (
            await tx.accessGrant!.findMany({
              select: { id: true, granteeTeamId: true },
              orderBy: { id: "asc" },
            })
          ).map((row) => `${row.id}:${row.granteeTeamId}`),
          teams: ids(await tx.team!.findMany({ select: { id: true } })),
        });
        const before = await stateOf(loose(base));
        for (const name of writers) {
          const actor = actors[name]!;
          const db = governed(actor);
          const editable = at(actor, "accessGrant", "edit");
          const seen = at(actor, "team", "view");
          const deletable = at(actor, "team", "full");
          const held = seed.accessGrant.filter(
            (grant) =>
              grant.granteeTeamId !== null && editable.includes(grant.id)
          );
          const drop = (grant: string) =>
            probe(db, async (tx) => {
              await tx.accessGrant!.update({
                where: { id: grant },
                data: { granteeTeam: { delete: true } },
              });
            });
          const guarded = held.find(
            (grant) =>
              seen.includes(grant.granteeTeamId!) &&
              !deletable.includes(grant.granteeTeamId!)
          );
          if (guarded === undefined) continue;
          refusals += 1;
          expect((await drop(guarded.id)).outcome, name).toBe(
            NestedWriteError.name
          );
        }
        expect(refusals).toBeGreaterThan(0);
        expect(await stateOf(loose(base))).toEqual(before);
      },
      timeout
    );

    test(
      "W-W12: the lax `delete: true` through a self relation: a parent document the call sees and may not delete is NestedWriteError; an empty slot deletes nothing and succeeds",
      async () => {
        let refusals = 0;
        let empties = 0;
        const documents = async (tx: Loose) =>
          ids(await tx.document!.findMany({ select: { id: true } }));
        const before = await documents(loose(base));
        for (const name of writers) {
          const actor = actors[name]!;
          const db = governed(actor);
          const editable = at(actor, "document", "edit");
          const seen = at(actor, "document", "view");
          const deletable = at(actor, "document", DELETE.document!);
          const drop = (document: string) =>
            probe(db, async (tx) => {
              await tx.document!.update({
                where: { id: document },
                data: { parent: { delete: true } },
              });
              return (await documents(tx)).length;
            });
          const visible = seen.length;
          const guarded = seed.document.find(
            (document) =>
              document.parentId !== null &&
              editable.includes(document.id) &&
              seen.includes(document.parentId) &&
              !deletable.includes(document.parentId)
          );
          if (guarded !== undefined) {
            refusals += 1;
            expect((await drop(guarded.id)).outcome, name).toBe(
              NestedWriteError.name
            );
          }
          const root = seed.document.find(
            (document) =>
              document.parentId === null && editable.includes(document.id)
          );
          if (root === undefined) continue;
          empties += 1;
          expect(await drop(root.id), name).toEqual({
            outcome: "ok",
            value: visible,
          });
        }
        expect(refusals).toBeGreaterThan(0);
        expect(empties).toBeGreaterThan(0);
        expect(await documents(loose(base))).toEqual(before);
      },
      timeout
    );

    test(
      "W-N4: a mode only narrows a verb: update as view by a viewer, delete as edit by a non-deleter are NotFoundError; deleteMany as given counts deletable rows only",
      async () => {
        let viewers = 0;
        let editors = 0;
        let given = 0;
        for (const name of writers) {
          const actor = actors[name]!;
          const db = governed(actor);
          const pageView = at(actor, "page", "view");
          const pageEdit = at(actor, "page", "edit");
          const viewed = minus(pageView, pageEdit)[0];
          if (viewed !== undefined) {
            viewers += 1;
            expect(
              (
                await probe(db, (tx) =>
                  tx.page!.update({
                    where: { id: viewed },
                    data: { title: "n4" },
                    as: "view",
                  })
                )
              ).outcome,
              name
            ).toBe(NotFoundError.name);
          }
          const editable = pageEdit[0];
          if (editable !== undefined)
            expect(
              (
                await probe(db, (tx) =>
                  tx.page!.update({
                    where: { id: editable },
                    data: { title: "n4" },
                    as: "view",
                  })
                )
              ).outcome,
              name
            ).toBe("ok");
          const share = at(actor, "document", "share");
          const editOnly = minus(at(actor, "document", "edit"), share)[0];
          if (editOnly !== undefined) {
            editors += 1;
            for (const as of ["edit", unnamed])
              expect(
                (
                  await probe(db, (tx) =>
                    tx.document!.delete({ where: { id: editOnly }, as })
                  )
                ).outcome,
                `${name} as ${as}`
              ).toBe(NotFoundError.name);
          }
          const narrowed = ids(
            await loose(base).page!.findMany({
              where: { ...givenTo(actor), deletedAt: null },
              select: { id: true },
            })
          );
          const full = at(actor, "page", "full");
          const deletable = narrowed.filter((id) => full.includes(id));
          if (
            narrowed.filter((id) => pageView.includes(id)).length >
            deletable.length
          )
            given += 1;
          const counted = await probe(db, (tx) =>
            tx.page!.deleteMany({ as: "given" })
          );
          expect(counted.value, name).toEqual({ count: deletable.length });
        }
        expect(viewers).toBeGreaterThan(0);
        expect(editors).toBeGreaterThan(0);
        expect(given).toBeGreaterThan(0);
      },
      timeout
    );
  });
}
