import { ForbiddenError, NestedWriteError, NotFoundError } from "@errors";
import { verbsOf } from "@src/rbac/compile";
import {
  CREATES,
  createOracle,
  GOVERNED_MODELS,
  type GovernedModel,
  type OracleOptions,
} from "@tests/package/fixtures/rbac-app/oracle";
import { schema } from "@tests/package/fixtures/rbac-app/schema";
import {
  type AccessGrantRow,
  type Actor,
  actors,
  type RbacSeed,
  seed,
} from "@tests/package/fixtures/rbac-app/seed";
import {
  Actor as ActorSchema,
  policy,
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
 * K4 on the RBAC acceptance estate (plan §4.4, R4, OD-13 one statement,
 * OD-14 recommended; §7 W-P1..W-P16): the row a write produces is judged as
 * a value, against the rows before the write, inside the statement that
 * writes it. The declaration is the compiled §1.1 policy exactly as
 * `viborm/rbac` hands it to its `rows.verbs` (`verbsOf`): per model,
 *
 * - `place`: mandatory ∧ limit ∧ `create:` AND every key's target visible,
 *   `P(T, read)` inlined; nothing (`OR: []`) on a model that declares no
 *   `create:` or that the policy does not list (R9);
 * - `moves`: per written field, the placement's clause where it reads the
 *   field (OD-14), AND its target visible where it is a key;
 * - `acyclic`: `document.parent`, which `up("parent")` recurses over.
 *
 * The actor is a call argument (no bound view: that is the entry's, K6).
 * Every expectation is the independent oracle's (`oracle.ts`, `places` and
 * `produces`), read without tombstones as soft delete is not composed. A
 * probe runs in a transaction rolled back after it, or is followed by the
 * substrate's `restore` (D1).
 */

type Row = Record<string, unknown>;
interface LooseDelegate {
  create(args: object): Promise<Row>;
  createMany(args: object): Promise<{ count: number }>;
  update(args: object): Promise<Row>;
  upsert(args: object): Promise<Row>;
  findMany(args?: object): Promise<Row[]>;
  deleteMany(args?: object): Promise<{ count: number }>;
}
type Loose = Record<string, LooseDelegate> & {
  $transaction<T>(body: (tx: Loose) => Promise<T>): Promise<T>;
};
const loose = (client: object) => client as unknown as Loose;
const ROLLBACK = new Error("rolled back");
type Outcome = { outcome: string; value?: unknown };
async function outcomeOf(body: () => Promise<unknown>): Promise<Outcome> {
  try {
    return { outcome: "ok", value: await body() };
  } catch (error) {
    return { outcome: (error as Error).constructor.name };
  }
}

/** The actors whose writes are judged: every shape of page and document access the seed holds. */
const WRITERS = ["u03", "u04", "u05", "u20", "u22", "u42", "u45", "u56"];

const pick = <T>(rows: readonly T[], keep: (row: T) => boolean) =>
  rows.find(keep);

export function runRbacAppPlacement(substrate: RbacAppSubstrate): void {
  const oracle = createOracle(seed);
  const writers = substrate.actors ?? [
    ...WRITERS,
    "k41-no-resources",
    "u07-expired",
  ];
  const timeout = substrate.timeout ?? 120_000;
  const now = new Date();
  const opts: OracleOptions = { now, tombstones: false };
  const compiled = policy.compile(schema);
  const declaration = {
    name: "placement",
    controls: { actor: { schema: ActorSchema, required: true } },
    rows: {
      control: "as",
      default: "all",
      models: Object.fromEntries(GOVERNED_MODELS.map((m) => [m, { all: {} }])),
      verbs: verbsOf(compiled),
    },
  };
  /** The oracle over the rows a nested child's statement sees: the seed and its created parent. */
  const withCreated = (model: keyof RbacSeed, row: Row) =>
    createOracle({ ...seed, [model]: [...seed[model], row] } as RbacSeed);

  describe(`${substrate.name}: the produced row on the RBAC estate (K4)`, () => {
    let base: RbacAppClient;
    let db: Loose;
    const restore = () => substrate.restore!(base);
    /**
     * What `body` returns or throws, never kept: rolled back, or, without a
     * callback transaction (D1), undone when it wrote: by `undo` through the
     * base client, else by the substrate's `restore`. A refused write wrote
     * nothing (each witness checks it once), so it is not undone.
     */
    const probe = async (
      body: (tx: Loose) => Promise<unknown>,
      undo?: (base: Loose) => Promise<unknown>
    ): Promise<Outcome> => {
      if (substrate.restore) {
        const result = await outcomeOf(() => body(db));
        if (result.outcome === "ok")
          await (undo ? undo(loose(base)) : restore());
        return result;
      }
      let result: Outcome = { outcome: "none" };
      try {
        await db.$transaction(async (tx) => {
          result = await outcomeOf(() => body(tx));
          throw ROLLBACK;
        });
      } catch (error) {
        if (error !== ROLLBACK) throw error;
      }
      return result;
    };
    beforeAll(async () => {
      base = createRbacAppClient(substrate.createDriver());
      await substrate.prepare(base);
      await loadRbacSeed(base);
      db = loose(base.$extends(declaration as never));
    }, timeout);
    afterAll(async () => {
      await base?.$disconnect();
      await substrate.release?.();
    }, timeout);
    afterEach(() => new Promise((resolve) => setImmediate(resolve)));

    /** Takes a document tree a test created outside a probe back out. */
    const undo = async (id: string) => {
      if (substrate.restore) return restore();
      await loose(base).document!.deleteMany({ where: { id } });
    };
    const expected = (allowed: boolean, refused: string) =>
      allowed ? "ok" : refused;
    let serial = 0;
    const fresh = (prefix: string) => `${prefix}-k4-${serial++}`;
    const otherOrg = (actor: Actor) =>
      seed.organization.find((o) => o.id !== actor.organizationId)!.id;
    const someone = (actor: Actor) =>
      seed.user.find((u) => u.id !== actor.userId)!.id;

    /** Candidate pages: personal, in every kind of group, in the actor's and another organization. */
    const pageCandidates = (actor: Actor): Row[] => {
      const groups = seed.pageGroup.map((g) => g.id);
      const rows: Row[] = [];
      for (const organizationId of [actor.organizationId, otherOrg(actor)]) {
        const local = seed.pageGroup.filter(
          (g) => g.organizationId === organizationId
        );
        for (const groupId of [
          null,
          ...local.slice(0, 4).map((g) => g.id),
          groups.find((id) => !local.some((g) => g.id === id))!,
          "missing-group",
        ])
          for (const [ownerId, personal] of [
            [actor.userId, true],
            [actor.userId, false],
            [someone(actor), false],
          ] as const)
            rows.push({
              id: fresh("page"),
              organizationId,
              title: "k4",
              position: 0,
              ownerId,
              groupId,
              personal,
            });
      }
      return rows;
    };
    const documentCandidates = (actor: Actor): Row[] => {
      const local = seed.document.filter(
        (d) => d.organizationId === actor.organizationId
      );
      const rows: Row[] = [];
      for (const parentId of [
        null,
        ...local.slice(0, 6).map((d) => d.id),
        seed.document.find((d) => d.organizationId !== actor.organizationId)!
          .id,
        "missing-document",
      ])
        for (const ownerId of [actor.userId, someone(actor)])
          rows.push({
            id: fresh("doc"),
            organizationId: actor.organizationId,
            parentId,
            title: "k4",
            position: 0,
            ownerId,
          });
      return rows;
    };
    /** A grant on one thing, at one level or one action list, to the actor or another user. */
    const grantCandidates = (actor: Actor): Row[] => {
      const rows: Row[] = [];
      const things: [string, string][] = [
        ...seed.page
          .filter((p) => p.organizationId === actor.organizationId)
          .slice(0, 4)
          .map((p) => ["pageId", p.id] as [string, string]),
        ...seed.document
          .filter((d) => d.organizationId === actor.organizationId)
          .slice(0, 4)
          .map((d) => ["documentId", d.id] as [string, string]),
        ...seed.pageGroup
          .filter((g) => g.organizationId === actor.organizationId)
          .slice(0, 2)
          .map((g) => ["groupId", g.id] as [string, string]),
      ];
      for (const [key, id] of things)
        for (const [level, actions] of [
          [key === "documentId" ? null : "view", []],
          [key === "documentId" ? null : "full", []],
          [null, key === "documentId" ? ["share"] : ["edit"]],
          [null, key === "documentId" ? ["export"] : ["full"]],
        ] as const)
          rows.push(
            grantRow(actor, {
              [key]: id,
              level,
              actions: [...actions],
              userId: actor.userId,
            })
          );
      return rows;
    };
    const grantRow = (actor: Actor, values: Row): Row => {
      const id = fresh("grant");
      return {
        id,
        key: id,
        organizationId: actor.organizationId,
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
        grantedBy: null,
        ...values,
      };
    };
    /**
     * Every candidate created once, against the oracle: the disagreements
     * (none expected), and how many the oracle admits and refuses.
     */
    const createsAgainstOracle = async (
      model: GovernedModel,
      candidates: (actor: Actor) => Row[]
    ) => {
      const seen = { ok: 0, refused: 0, disagreements: [] as string[] };
      for (const name of writers) {
        const actor = actors[name]!;
        for (const row of candidates(actor)) {
          const allowed = oracle.places(actor, model, row, opts);
          const created = await probe(
            (tx) =>
              tx[model]!.create({ data: row, actor, select: { id: true } }),
            (b) => b[model]!.deleteMany({ where: { id: row.id } })
          );
          const wanted = expected(allowed, ForbiddenError.name);
          if (created.outcome !== wanted)
            seen.disagreements.push(
              `${name} ${model} ${JSON.stringify(row)}: ${created.outcome}, oracle ${wanted}`
            );
          seen[allowed ? "ok" : "refused"] += 1;
        }
      }
      return seen;
    };

    test(
      "W-P1, W-P7, W-P16: a root create is written where the oracle places it, and is ForbiddenError elsewhere: outside `mandatory`, a hidden and a missing key target alike",
      async () => {
        {
          const seen = await createsAgainstOracle("page", pageCandidates);
          expect(seen.disagreements).toEqual([]);
          expect(seen.ok, "page admitted").toBeGreaterThan(0);
          expect(seen.refused, "page refused").toBeGreaterThan(0);
        }
        {
          const seen = await createsAgainstOracle(
            "document",
            documentCandidates
          );
          expect(seen.disagreements).toEqual([]);
          expect(seen.ok, "document admitted").toBeGreaterThan(0);
          expect(seen.refused, "document refused").toBeGreaterThan(0);
        }
      },
      timeout
    );

    test(
      "R9 (U6 Q2): a model that declares no create: and a model the policy does not list create nothing, at the root (ForbiddenError) and nested (NestedWriteError), before any constraint",
      async () => {
        const uncreated = Object.keys(schema).filter(
          (model) => !CREATES.has(model as GovernedModel)
        );
        expect(uncreated.sort()).toEqual(
          [
            "apiKey",
            "bookmark",
            "organization",
            "pageGroup",
            "rolePermission",
            "session",
            "team",
            "user",
          ].sort()
        );
        for (const name of writers.slice(0, 3)) {
          const actor = actors[name]!;
          for (const model of uncreated) {
            // A copy of a seeded row under a fresh id (a bookmark without its
            // subject, whose connect would be judged first): a duplicate of
            // every other unique value, which no constraint is reached to refuse.
            const [first] = seed[model as keyof RbacSeed] as unknown as Row[];
            const { subject: _subject, ...row } = createDataOf(model, first!);
            if ("id" in row) row.id = fresh(model);
            if (GOVERNED_MODELS.includes(model as GovernedModel))
              expect(
                oracle.places(actor, model as GovernedModel, row, opts)
              ).toBe(false);
            expect(
              (await probe((tx) => tx[model]!.create({ data: row, actor })))
                .outcome,
              `${name} ${model}`
            ).toBe(ForbiddenError.name);
          }
          // Nested: a bookmark created under a page the actor edits.
          const page = oracle.rows(actor, "page", "edit", opts)[0];
          if (page === undefined) continue;
          expect(
            (
              await probe((tx) =>
                tx.page!.update({
                  where: { id: page },
                  data: {
                    bookmarks: {
                      create: {
                        id: fresh("bookmark"),
                        organizationId: actor.organizationId,
                        userId: actor.userId,
                      },
                    },
                  },
                  actor,
                })
              )
            ).outcome,
            name
          ).toBe(NestedWriteError.name);
        }
      },
      timeout
    );

    test(
      "W-P10, W-P12, W-P15: a grant is placed only by whoever administers every thing it attaches to, never above what the writer holds there; a grant never justifies itself",
      async () => {
        {
          const seen = await createsAgainstOracle(
            "accessGrant",
            grantCandidates
          );
          expect(seen.disagreements).toEqual([]);
          expect(seen.ok, "accessGrant admitted").toBeGreaterThan(0);
          expect(seen.refused, "accessGrant refused").toBeGreaterThan(0);
        }
        // The arc: a page the actor administers beside a group it does not.
        let arcs = 0;
        for (const name of writers) {
          const actor = actors[name]!;
          const full = oracle.rows(actor, "page", "full", opts)[0];
          const group = seed.pageGroup.find(
            (g) =>
              g.organizationId === actor.organizationId &&
              !oracle.rows(actor, "pageGroup", "full", opts).includes(g.id)
          );
          if (full === undefined || group === undefined) continue;
          arcs += 1;
          const row = grantRow(actor, {
            pageId: full,
            groupId: group.id,
            userId: actor.userId,
            level: "view",
          });
          expect(oracle.places(actor, "accessGrant", row, opts)).toBe(false);
          expect(
            (await probe((tx) => tx.accessGrant!.create({ data: row, actor })))
              .outcome,
            name
          ).toBe(ForbiddenError.name);
        }
        expect(arcs).toBeGreaterThan(0);
      },
      timeout
    );

    test(
      "W-P2: createMany is one judgement per row inside its statement: one refused row refuses every row",
      async () => {
        let mixed = 0;
        for (const name of writers) {
          const actor = actors[name]!;
          const rows = pageCandidates(actor);
          const placed = rows.filter((row) =>
            oracle.places(actor, "page", row, opts)
          );
          const refused = rows.filter(
            (row) => !oracle.places(actor, "page", row, opts)
          );
          if (placed.length >= 2) {
            const both = await probe(
              (tx) => tx.page!.createMany({ data: placed.slice(0, 2), actor }),
              (b) =>
                b.page!.deleteMany({
                  where: { id: { in: placed.slice(0, 2).map((r) => r.id) } },
                })
            );
            expect(both, name).toEqual({ outcome: "ok", value: { count: 2 } });
          }
          if (placed.length === 0 || refused.length === 0) continue;
          mixed += 1;
          // Outside any transaction of the caller's: the statement itself is
          // the unit, and a refused one leaves nothing behind to roll back.
          const outcome = await outcomeOf(() =>
            db.page!.createMany({ data: [placed[0], refused[0]], actor })
          );
          const written = await loose(base).page!.findMany({
            where: { id: { in: [placed[0]!.id, refused[0]!.id] } },
            select: { id: true },
          });
          expect(
            { outcome: outcome.outcome, written: written.length },
            name
          ).toEqual({ outcome: ForbiddenError.name, written: 0 });
        }
        expect(mixed).toBeGreaterThan(0);
      },
      timeout
    );

    /** Pages the actor edits, with the group moves R4 judges on each. */
    const groupMoves = (actor: Actor) => {
      const edit = oracle.rows(actor, "page", "edit", opts);
      const local = seed.pageGroup.filter(
        (g) => g.organizationId === actor.organizationId
      );
      const targets = [
        ...local.slice(0, 5).map((g) => g.id),
        seed.pageGroup.find((g) => g.organizationId !== actor.organizationId)!
          .id,
        "missing-group",
        null,
      ];
      return seed.page
        .filter((p) => edit.includes(p.id))
        .slice(0, 4)
        .flatMap((page) =>
          targets
            .filter((groupId) => groupId !== page.groupId)
            .map((groupId) => ({ page, groupId }))
        );
    };

    test(
      "W-P5, W-P16: a scalar-key move: the old row at edit, the new row under what judged it, at placement (it writes what create reads) and with its group visible; a hidden and a missing group give one error",
      async () => {
        const seen = { ok: 0, refused: 0 };
        for (const name of writers) {
          const actor = actors[name]!;
          for (const { page, groupId } of groupMoves(actor)) {
            const after = { ...page, groupId };
            const allowed = oracle.produces(
              actor,
              "page",
              after,
              ["groupId"],
              ["edit"],
              opts
            );
            const moved = await probe(
              (tx) =>
                tx.page!.update({
                  where: { id: page.id },
                  data: { groupId },
                  actor,
                  select: { id: true },
                }),
              (b) =>
                b.page!.update({
                  where: { id: page.id },
                  data: { groupId: page.groupId },
                })
            );
            expect(moved.outcome, `${name} ${page.id} -> ${groupId}`).toBe(
              expected(allowed, ForbiddenError.name)
            );
            seen[allowed ? "ok" : "refused"] += 1;
          }
        }
        expect(seen.ok).toBeGreaterThan(0);
        expect(seen.refused).toBeGreaterThan(0);
      },
      timeout
    );

    test(
      "W-P6: a connect move: a hidden or missing target is not found (NestedWriteError); a visible one is the key holder's update, refused where its new row is (ForbiddenError)",
      async () => {
        const seen = { ok: 0, refused: 0, hidden: 0 };
        for (const name of writers) {
          const actor = actors[name]!;
          const groups = oracle.rows(actor, "pageGroup", "view", opts);
          for (const { page, groupId } of groupMoves(actor)) {
            if (groupId === null) continue;
            const visible = groups.includes(groupId);
            const allowed =
              visible &&
              oracle.produces(
                actor,
                "page",
                { ...page, groupId },
                ["groupId", "group"],
                ["edit"],
                opts
              );
            const moved = await probe(
              (tx) =>
                tx.page!.update({
                  where: { id: page.id },
                  data: { group: { connect: { id: groupId } } },
                  actor,
                  select: { id: true },
                }),
              (b) =>
                b.page!.update({
                  where: { id: page.id },
                  data: { groupId: page.groupId },
                })
            );
            expect(moved.outcome, `${name} ${page.id} -> ${groupId}`).toBe(
              visible
                ? expected(allowed, ForbiddenError.name)
                : NestedWriteError.name
            );
            seen[visible ? (allowed ? "ok" : "refused") : "hidden"] += 1;
          }
        }
        expect(seen.ok).toBeGreaterThan(0);
        expect(seen.refused).toBeGreaterThan(0);
        expect(seen.hidden).toBeGreaterThan(0);
      },
      timeout
    );

    test(
      "W-P3: upsert, the create arm at placement and the update arm under what judged its old row",
      async () => {
        const seen = { create: 0, update: 0 };
        for (const name of writers) {
          const actor = actors[name]!;
          for (const row of pageCandidates(actor).slice(0, 6)) {
            const allowed = oracle.places(actor, "page", row, opts);
            const created = await probe(
              (tx) =>
                tx.page!.upsert({
                  where: { id: row.id },
                  create: row,
                  update: { title: "k4" },
                  actor,
                  select: { id: true },
                }),
              (b) => b.page!.deleteMany({ where: { id: row.id } })
            );
            expect(created.outcome, `${name} create ${row.id}`).toBe(
              expected(allowed, ForbiddenError.name)
            );
            if (!allowed) seen.create += 1;
          }
          for (const { page, groupId } of groupMoves(actor).slice(0, 4)) {
            const allowed = oracle.produces(
              actor,
              "page",
              { ...page, groupId },
              ["groupId"],
              ["edit"],
              opts
            );
            const updated = await probe(
              (tx) =>
                tx.page!.upsert({
                  where: { id: page.id },
                  create: { ...page, id: page.id },
                  update: { groupId },
                  actor,
                  select: { id: true },
                }),
              (b) =>
                b.page!.update({
                  where: { id: page.id },
                  data: { groupId: page.groupId },
                })
            );
            expect(updated.outcome, `${name} update ${page.id}`).toBe(
              expected(allowed, ForbiddenError.name)
            );
            if (!allowed) seen.update += 1;
          }
        }
        expect(seen.create).toBeGreaterThan(0);
        expect(seen.update).toBeGreaterThan(0);
      },
      timeout
    );

    test(
      "W-P4, W-P9: a nested create is its own placement: under an existing parent, under a parent the same call creates (as the values written to it), and connectOrCreate's create arm; a refused child rolls the call back",
      async () => {
        const seen = { ok: 0, refused: 0 };
        for (const name of writers) {
          const actor = actors[name]!;
          // Children of a new root document the actor owns, each with a parent
          // the oracle sees as the values the call writes to it.
          const root = {
            id: fresh("doc"),
            organizationId: actor.organizationId,
            parentId: null,
            title: "k4",
            position: 0,
            ownerId: actor.userId,
          };
          const rootPlaced = oracle.places(actor, "document", root, opts);
          const child = (ownerId: string) => ({
            id: fresh("doc"),
            organizationId: actor.organizationId,
            title: "k4 child",
            position: 0,
            ownerId,
          });
          for (const ownerId of [actor.userId, someone(actor)]) {
            const leaf = child(ownerId);
            const childPlaced = withCreated("document", {
              ...root,
              personal: false,
              archivedAt: null,
              createdAt: now,
              updatedAt: now,
            }).places(actor, "document", { ...leaf, parentId: root.id }, opts);
            // Outside a caller's transaction, so a refusal is the call's
            // own rollback (W-P9), read back from the base client.
            const outcome = await outcomeOf(() =>
              db.document!.create({
                data: { ...root, children: { create: [leaf] } },
                actor,
                select: { id: true },
              })
            );
            const written = await loose(base).document!.findMany({
              where: { id: { in: [root.id, leaf.id] } },
              select: { id: true },
            });
            const allowed = rootPlaced && childPlaced;
            expect(
              { outcome: outcome.outcome, written: written.length },
              `${name} nested under created`
            ).toEqual({
              outcome: allowed
                ? "ok"
                : rootPlaced
                  ? NestedWriteError.name
                  : ForbiddenError.name,
              written: allowed ? 2 : 0,
            });
            if (allowed) await undo(root.id);
            seen[allowed ? "ok" : "refused"] += 1;
          }
          // Under an existing parent the actor edits (the parent is bumped,
          // so it is judged at its update action, edit).
          const parent = seed.document.find((d) =>
            oracle.rows(actor, "document", "edit", opts).includes(d.id)
          );
          if (parent) {
            const leaf = { ...child(actor.userId), parentId: parent.id };
            const allowed = oracle.places(actor, "document", leaf, opts);
            const { parentId: _parent, ...nested } = leaf;
            const outcome = await probe(
              (tx) =>
                tx.document!.update({
                  where: { id: parent.id },
                  data: { children: { create: [nested] } },
                  actor,
                  select: { id: true },
                }),
              (b) => b.document!.deleteMany({ where: { id: leaf.id } })
            );
            expect(outcome.outcome, `${name} nested under ${parent.id}`).toBe(
              expected(allowed, NestedWriteError.name)
            );
            seen[allowed ? "ok" : "refused"] += 1;
          }
          // connectOrCreate's create arm, from a page the actor edits.
          const page = seed.page.find((p) =>
            oracle.rows(actor, "page", "edit", opts).includes(p.id)
          );
          if (page) {
            const created = grantRow(actor, {
              pageId: page.id,
              userId: actor.userId,
              level: "view",
            });
            const allowed = oracle.places(actor, "accessGrant", created, opts);
            const { pageId: _page, ...nested } = created;
            const outcome = await probe(
              (tx) =>
                tx.page!.update({
                  where: { id: page.id },
                  data: {
                    grants: {
                      connectOrCreate: {
                        where: { id: created.id },
                        create: nested,
                      },
                    },
                  },
                  actor,
                  select: { id: true },
                }),
              (b) => b.accessGrant!.deleteMany({ where: { id: created.id } })
            );
            expect(outcome.outcome, `${name} connectOrCreate`).toBe(
              expected(allowed, NestedWriteError.name)
            );
            seen[allowed ? "ok" : "refused"] += 1;
          }
        }
        expect(seen.ok).toBeGreaterThan(0);
        expect(seen.refused).toBeGreaterThan(0);
      },
      timeout
    );

    test(
      "W-P10: the grant arc's update form: moving a grant onto a thing the writer does not administer is refused",
      async () => {
        let cases = 0;
        for (const name of writers) {
          const actor = actors[name]!;
          const editable = oracle.rows(actor, "accessGrant", "edit", opts);
          for (const grant of seed.accessGrant
            .filter((g) => editable.includes(g.id) && g.pageId !== null)
            .slice(0, 3)) {
            for (const groupId of seed.pageGroup
              .filter((g) => g.organizationId === grant.organizationId)
              .slice(0, 3)
              .map((g) => g.id)) {
              const after = { ...grant, groupId };
              const allowed = oracle.produces(
                actor,
                "accessGrant",
                after,
                ["groupId"],
                ["edit"],
                opts
              );
              const moved = await probe(
                (tx) =>
                  tx.accessGrant!.update({
                    where: { id: grant.id },
                    data: { groupId },
                    actor,
                    select: { id: true },
                  }),
                (b) =>
                  b.accessGrant!.update({
                    where: { id: grant.id },
                    data: { groupId: grant.groupId },
                  })
              );
              expect(moved.outcome, `${name} ${grant.id} +${groupId}`).toBe(
                expected(allowed, ForbiddenError.name)
              );
              if (!allowed) cases += 1;
            }
          }
        }
        expect(cases).toBeGreaterThan(0);
      },
      timeout
    );

    test(
      "W-P11: a move on a model that declares no create: is judged under what judged its old row and its key's target",
      async () => {
        const seen = { ok: 0, refused: 0 };
        for (const name of writers) {
          const actor = actors[name]!;
          const editable = oracle.rows(actor, "team", "edit", opts);
          for (const team of seed.team
            .filter((t) => editable.includes(t.id))
            .slice(0, 2))
            for (const organizationId of seed.organization.map((o) => o.id)) {
              if (organizationId === team.organizationId) continue;
              const allowed = oracle.produces(
                actor,
                "team",
                { ...team, organizationId },
                ["organizationId"],
                ["edit"],
                opts
              );
              const moved = await probe(
                (tx) =>
                  tx.team!.update({
                    where: { id: team.id },
                    data: { organizationId },
                    actor,
                    select: { id: true },
                  }),
                (b) =>
                  b.team!.update({
                    where: { id: team.id },
                    data: { organizationId: team.organizationId },
                  })
              );
              expect(
                moved.outcome,
                `${name} ${team.id} -> ${organizationId}`
              ).toBe(expected(allowed, ForbiddenError.name));
              seen[allowed ? "ok" : "refused"] += 1;
            }
        }
        expect(seen.refused).toBeGreaterThan(0);
      },
      timeout
    );

    test(
      "W-P13: a personal page cannot be transferred (OD-14): its new owner leaves a row the actor no longer holds at full",
      async () => {
        let transfers = 0;
        for (const name of writers) {
          const actor = actors[name]!;
          const full = oracle.rows(actor, "page", "full", opts);
          const personal = seed.page.find(
            (p) =>
              p.personal && p.ownerId === actor.userId && full.includes(p.id)
          );
          if (personal === undefined) continue;
          const ownerId = someone(actor);
          const allowed = oracle.produces(
            actor,
            "page",
            { ...personal, ownerId },
            ["ownerId"],
            ["full"],
            opts
          );
          const moved = await probe(
            (tx) =>
              tx.page!.update({
                where: { id: personal.id },
                data: { ownerId },
                actor,
                select: { id: true },
              }),
            (b) =>
              b.page!.update({
                where: { id: personal.id },
                data: { ownerId: personal.ownerId },
              })
          );
          expect(moved.outcome, `${name} ${personal.id}`).toBe(
            expected(allowed, ForbiddenError.name)
          );
          if (!allowed) transfers += 1;
        }
        expect(transfers).toBeGreaterThan(0);
      },
      timeout
    );

    test(
      "W-P14: a document cannot move under itself or its own subtree, whatever the actor sees of it",
      async () => {
        const seen = { ok: 0, refused: 0 };
        const childrenOf = (id: string) =>
          seed.document.filter((d) => d.parentId === id);
        for (const name of writers) {
          const actor = actors[name]!;
          const edit = oracle.rows(actor, "document", "edit", opts);
          const moved = seed.document.find(
            (d) => edit.includes(d.id) && childrenOf(d.id).length > 0
          );
          if (moved === undefined) continue;
          const below = childrenOf(moved.id)[0]!;
          for (const parentId of [moved.id, below.id, moved.parentId]) {
            if (parentId === null) continue;
            const after = { ...moved, parentId };
            const allowed = oracle.produces(
              actor,
              "document",
              after,
              ["parentId"],
              ["edit"],
              opts
            );
            const outcome = await probe(
              (tx) =>
                tx.document!.update({
                  where: { id: moved.id },
                  data: { parentId },
                  actor,
                  select: { id: true },
                }),
              (b) =>
                b.document!.update({
                  where: { id: moved.id },
                  data: { parentId: moved.parentId },
                })
            );
            expect(
              outcome.outcome,
              `${name} ${moved.id} under ${parentId}`
            ).toBe(expected(allowed, ForbiddenError.name));
            seen[allowed ? "ok" : "refused"] += 1;
          }
        }
        expect(seen.refused).toBeGreaterThan(0);
      },
      timeout
    );

    test(
      "a refused produced row reveals nothing a NotFoundError would not: an update the old row refuses stays NotFoundError",
      async () => {
        let viewers = 0;
        for (const name of writers) {
          const actor = actors[name]!;
          const view = oracle.rows(actor, "page", "view", opts);
          const edit = oracle.rows(actor, "page", "edit", opts);
          const viewed = view.find((id) => !edit.includes(id));
          if (viewed === undefined) continue;
          viewers += 1;
          expect(
            (
              await probe((tx) =>
                tx.page!.update({
                  where: { id: viewed },
                  data: { groupId: "missing-group" },
                  actor,
                })
              )
            ).outcome,
            name
          ).toBe(NotFoundError.name);
        }
        expect(viewers).toBeGreaterThan(0);
      },
      timeout
    );
  });
}

/** The grant rows of the seed, for runners that sample them. */
export const SEEDED_GRANTS: readonly AccessGrantRow[] = seed.accessGrant;
export const firstOf = pick;
