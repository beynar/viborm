import { createClient } from "@client/client";
import type { AnyDriver } from "@drivers";
import { ClientInitializationError } from "@errors";
import { defineExtension } from "@extensions/definition";
import { s } from "@schema";
import { v } from "@src/validation";
import { tenancy } from "@tests/fixtures/extension-recipes";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import { afterEach, describe, expect, test } from "vitest";

/**
 * Domain predicates as the Permissions plan's K1 and K2 make them (plan §4.1, §4.2,
 * §11.2 F1-F3), through public entry points, against oracles computed by
 * hand from the seed arrays below (no engine involved):
 *
 * - admission (K1(a)): each predicate is parsed once at `$extends` through
 *   its model's `where` schema; a misspelt key and a recursion without a
 *   written depth are refused there, and a predicate deeper than a caller's
 *   16 levels is admitted (W-K1a, W-K1b, W-K1f);
 * - layering (K1(b), R5): inside a layer's own traversals every other layer
 *   is read at its default and never the layer being lowered, so every cycle
 *   terminates with no depth number and no per-call mode widens a traversal
 *   (W-K1c, W-K1d, W-K1g);
 * - parameters (K2, R6, R7): a call value is read at lowering, conditions
 *   fold first, an absent required value matches nothing and an absent
 *   optional one drops its predicate, `null` is absent, and `{ now: true }`
 *   is the call's instant (W-K2b, W-K2d, W-K2e, W-K2g).
 *
 * Seed. Orgs o1-o6 (o3 named "y", o6 without a team). Teams (org, name): t1
 * (o1, core), t2 (o2, core), t3 (o3, core), t4 (o4, aux), t5 (o5, core), t6
 * (o1, aux). Members (team, user): m1 t1 u1, m2 t2 u1, m3 t3 u1, m4 t4 u1, m5
 * t5 u2. Leads: l1 t1, l3 t3, l4 t4, l5 t5, all u1. Documents (owner,
 * parent): d1 (u1) > d2 (u2) > d3 (u2) > d4 (u1); d5 (u1) > d6 (u1); d7 (u2) >
 * d8 (u2); d9 (no owner) under d1; d10 (no owner) a root. Accounts u1-u3; u1
 * holds sessions s1 and s2, u2 holds s3. Folders f1 (tenant t1), f2 (t2);
 * files and grants as below, `deletedAt` set on the tombstones.
 */

export interface DomainPredicateSubstrate {
  readonly name: string;
  readonly createDriver: () => AnyDriver;
  /**
   * Creates the schema's tables on an empty database (default: a live
   * `push`); a substrate without a migration capability (D1) runs the plan's
   * statements itself.
   */
  readonly prepare?: (client: Loose) => Promise<void>;
}

// The cases address models by name, as JavaScript would.
type Loose = any;

const account = s.model({
  id: s.string().id(),
  docs: s.toMany(() => doc),
  sessions: s.toMany(() => session),
});
const session = s.model({
  id: s.string().id(),
  accountId: s.string(),
  account: s
    .toOne(() => account)
    .fields("accountId")
    .references("id"),
});
const org = s.model({
  id: s.string().id(),
  name: s.string(),
  teams: s.toMany(() => team),
});
const team = s.model({
  id: s.string().id(),
  orgId: s.string(),
  name: s.string(),
  org: s
    .toOne(() => org)
    .fields("orgId")
    .references("id"),
  members: s.toMany(() => member),
  leads: s.toMany(() => lead),
});
const member = s.model({
  id: s.string().id(),
  teamId: s.string(),
  userId: s.string(),
  team: s
    .toOne(() => team)
    .fields("teamId")
    .references("id"),
});
const lead = s.model({
  id: s.string().id(),
  teamId: s.string(),
  userId: s.string(),
  team: s
    .toOne(() => team)
    .fields("teamId")
    .references("id"),
});
const doc = s.model({
  id: s.string().id(),
  ownerId: s.string().nullable(),
  owner: s
    .toOne(() => account)
    .fields("ownerId")
    .references("id"),
  parentId: s.string().nullable(),
  parent: s
    .toOne(() => doc)
    .fields("parentId")
    .references("id")
    .name("tree"),
  children: s.toMany(() => doc).name("tree"),
  expiresAt: s.dateTime().nullable(),
});
const folder = s.model({
  id: s.string().id(),
  tenantId: s.string().nullable(),
  files: s.toMany(() => file),
});
const file = s.model({
  id: s.string().id(),
  tenantId: s.string().nullable(),
  folderId: s.string(),
  deletedAt: s.dateTime().nullable(),
  folder: s
    .toOne(() => folder)
    .fields("folderId")
    .references("id"),
  grants: s.toMany(() => grant),
});
const grant = s.model({
  id: s.string().id(),
  tenantId: s.string().nullable(),
  fileId: s.string(),
  userId: s.string(),
  deletedAt: s.dateTime().nullable(),
  file: s
    .toOne(() => file)
    .fields("fileId")
    .references("id"),
});

export function domainPredicateSchema() {
  return {
    account,
    session,
    org,
    team,
    member,
    lead,
    doc,
    folder,
    file,
    grant,
  };
}

type Doc = { id: string; ownerId: string | null; parentId: string | null };

const ACCOUNTS = [{ id: "u1" }, { id: "u2" }, { id: "u3" }];
const SESSIONS = [
  { id: "s1", accountId: "u1" },
  { id: "s2", accountId: "u1" },
  { id: "s3", accountId: "u2" },
];
const ORGS = [
  { id: "o1", name: "x" },
  { id: "o2", name: "x" },
  { id: "o3", name: "y" },
  { id: "o4", name: "x" },
  { id: "o5", name: "x" },
  { id: "o6", name: "x" },
];
const TEAMS = [
  { id: "t1", orgId: "o1", name: "core" },
  { id: "t2", orgId: "o2", name: "core" },
  { id: "t3", orgId: "o3", name: "core" },
  { id: "t4", orgId: "o4", name: "aux" },
  { id: "t5", orgId: "o5", name: "core" },
  { id: "t6", orgId: "o1", name: "aux" },
];
const MEMBERS = [
  { id: "m1", teamId: "t1", userId: "u1" },
  { id: "m2", teamId: "t2", userId: "u1" },
  { id: "m3", teamId: "t3", userId: "u1" },
  { id: "m4", teamId: "t4", userId: "u1" },
  { id: "m5", teamId: "t5", userId: "u2" },
];
const LEADS = [
  { id: "l1", teamId: "t1", userId: "u1" },
  { id: "l3", teamId: "t3", userId: "u1" },
  { id: "l4", teamId: "t4", userId: "u1" },
  { id: "l5", teamId: "t5", userId: "u1" },
];
const EARLY = new Date("2020-01-01T00:00:00.000Z");
const LATE = new Date("2099-01-01T00:00:00.000Z");
const DOCS: readonly (Doc & { expiresAt: Date | null })[] = [
  { id: "d1", ownerId: "u1", parentId: null, expiresAt: LATE },
  { id: "d2", ownerId: "u2", parentId: "d1", expiresAt: EARLY },
  { id: "d3", ownerId: "u2", parentId: "d2", expiresAt: null },
  { id: "d4", ownerId: "u1", parentId: "d3", expiresAt: EARLY },
  { id: "d5", ownerId: "u1", parentId: null, expiresAt: null },
  { id: "d6", ownerId: "u1", parentId: "d5", expiresAt: LATE },
  { id: "d7", ownerId: "u2", parentId: null, expiresAt: LATE },
  { id: "d8", ownerId: "u2", parentId: "d7", expiresAt: null },
  { id: "d9", ownerId: null, parentId: "d1", expiresAt: null },
  { id: "d10", ownerId: null, parentId: null, expiresAt: null },
];
const FOLDERS = [
  { id: "f1", tenantId: "t1" },
  { id: "f2", tenantId: "t2" },
];
const FILES = [
  { id: "a", tenantId: "t1", folderId: "f1", deletedAt: null },
  { id: "b", tenantId: "t1", folderId: "f1", deletedAt: null },
  { id: "c", tenantId: "t1", folderId: "f1", deletedAt: EARLY },
  { id: "d", tenantId: "t2", folderId: "f2", deletedAt: null },
  { id: "e", tenantId: "t2", folderId: "f2", deletedAt: null },
  { id: "f", tenantId: "t1", folderId: "f1", deletedAt: EARLY },
  { id: "g", tenantId: "t1", folderId: "f1", deletedAt: null },
];
const GRANTS = [
  { id: "ga", tenantId: "t1", fileId: "a", userId: "u1", deletedAt: null },
  { id: "gb", tenantId: "t1", fileId: "b", userId: "u1", deletedAt: EARLY },
  { id: "gc", tenantId: "t1", fileId: "c", userId: "u1", deletedAt: null },
  { id: "gd", tenantId: "t2", fileId: "d", userId: "u1", deletedAt: null },
  { id: "ge", tenantId: "t1", fileId: "e", userId: "u1", deletedAt: null },
  { id: "gf", tenantId: "t1", fileId: "f", userId: "u1", deletedAt: EARLY },
  { id: "gg", tenantId: "t1", fileId: "g", userId: "u2", deletedAt: null },
];

const byId = <T extends { id: string }>(
  rows: readonly T[],
  id: string | null
): T | undefined => rows.find((row) => row.id === id);
const ancestorsAndSelf = (d: Doc): Doc[] => {
  const out = [d];
  for (let at = byId(DOCS, d.parentId); at; at = byId(DOCS, at.parentId))
    out.push(at);
  return out;
};
/** A result's ids, nested lists' ids too, every list sorted. */
function shape(value: unknown): unknown {
  if (Array.isArray(value))
    return value
      .map(shape)
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  if (value !== null && typeof value === "object" && !(value instanceof Date))
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, shape(item)])
    );
  return value;
}
const idsOf = (rows: readonly { id: string }[]) =>
  rows.map(({ id }) => ({ id }));

/** A one-mode rows extension: `models` is its `on` mode's predicates. */
const rows = (name: string, models: Record<string, unknown>) =>
  defineExtension({
    name,
    rows: {
      control: `${name}Mode`,
      default: "on",
      models: Object.fromEntries(
        Object.entries(models).map(([model, on]) => [model, { on }])
      ),
    },
  } as never);

/** Soft delete's rows and deletion, as the official entry declares them. */
const tombstones = (models: readonly string[]) =>
  defineExtension({
    name: "tombstones",
    controls: { mode: { oneOf: ["soft", "hard"] } },
    rows: {
      control: "deleted",
      default: "without",
      models: Object.fromEntries(
        models.map((model) => [
          model,
          {
            without: {
              root: { deletedAt: null },
              related: { deletedAt: null },
            },
            with: {},
            only: {
              root: { deletedAt: { not: null } },
              related: { deletedAt: null },
            },
          },
        ])
      ),
    },
    deletion: {
      removeWhen: { mode: "hard" },
      models: Object.fromEntries(
        models.map((model) => [model, { at: "deletedAt", assign: {} }])
      ),
    },
  } as never);

/** The actor control of the K2 cases: an object, required on every model. */
const actorControl = {
  actor: {
    schema: v.object({
      userId: v.nullable(v.string()),
      session: v.optional(v.string()),
      roles: v.optional(v.array(v.string())),
      docs: v.optional(v.array(v.string())),
    }),
    required: true,
  },
} as const;
const actorRows = (models: Record<string, unknown>) =>
  defineExtension({
    name: "actor",
    controls: actorControl,
    rows: {
      control: "actorMode",
      default: "on",
      models: Object.fromEntries(
        Object.entries(models).map(([model, root]) => [
          model,
          { on: { root, related: root } },
        ])
      ),
    },
  } as never);
const actor = (path: string) => ({ control: "actor", path });

export function runDomainPredicateBehavior(
  substrate: DomainPredicateSubstrate
): void {
  const open: { $disconnect(): Promise<void> }[] = [];
  afterEach(async () => {
    for (const client of open.splice(0)) await client.$disconnect();
  });
  const seeded = async (): Promise<Loose> => {
    const base: Loose = createClient({
      schema: domainPredicateSchema(),
      driver: substrate.createDriver(),
    });
    open.push(base);
    await (substrate.prepare ?? syncLiveSchema)(base);
    await base.account.createMany({ data: ACCOUNTS });
    await base.session.createMany({ data: SESSIONS });
    await base.org.createMany({ data: ORGS });
    await base.team.createMany({ data: TEAMS });
    await base.member.createMany({ data: MEMBERS });
    await base.lead.createMany({ data: LEADS });
    for (const data of DOCS) await base.doc.create({ data });
    await base.folder.createMany({ data: FOLDERS });
    await base.file.createMany({ data: FILES });
    await base.grant.createMany({ data: GRANTS });
    return base;
  };
  /** The `ClientInitializationError` `run` throws at `$extends`. */
  const refusal = (run: () => unknown): ClientInitializationError => {
    try {
      run();
    } catch (error) {
      if (error instanceof ClientInitializationError) return error;
      throw error;
    }
    throw new Error("expected a refusal at $extends");
  };

  describe(`${substrate.name}: domain predicates admitted, layered and parameterized`, () => {
    test("W-K1a: recurse true or {} is refused at $extends; a written depth: false reads the whole closure", async () => {
      const base = await seeded();
      for (const recurse of [true, {}])
        expect(
          refusal(() =>
            base.$extends(
              rows("closure", {
                doc: {
                  root: {
                    parent: { recurse, self: true, some: { ownerId: "u1" } },
                  },
                },
              })
            )
          ).message
        ).toContain('rows.doc.on.root at "parent.recurse"');
      const db = base.$extends(
        rows("closure", {
          doc: {
            root: {
              parent: {
                recurse: { depth: false },
                self: true,
                some: { ownerId: "u1" },
              },
            },
          },
        })
      );
      expect(shape(await db.doc.findMany({ select: { id: true } }))).toEqual(
        shape(
          idsOf(
            DOCS.filter((d) =>
              ancestorsAndSelf(d).some((m) => m.ownerId === "u1")
            )
          )
        )
      );
    });

    test("W-K1b: a misspelt nested key is refused at $extends, naming the extension, model, predicate and path", async () => {
      const base = await seeded();
      const error = refusal(() =>
        base.$extends(
          rows("typo", { doc: { root: { parent: { is: { nope: 1 } } } } })
        )
      );
      expect(error.message).toContain(
        'Extension "typo" rows.doc.on.root at "parent.is.nope"'
      );
      expect(error.meta).toMatchObject({ model: "doc" });
    });

    test("W-K1c S-B: a self relation in root and related reads its own layer raw", async () => {
      const base = await seeded();
      const ownedParent = { parent: { is: { ownerId: "u1" } } };
      const db = base.$extends(
        rows("sb", { doc: { root: ownedParent, related: ownedParent } })
      );
      const visible = (d: Doc) => byId(DOCS, d.parentId)?.ownerId === "u1";
      expect(
        shape(
          await db.doc.findMany({
            select: { id: true, children: { select: { id: true } } },
          })
        )
      ).toEqual(
        shape(
          DOCS.filter(visible).map((d) => ({
            id: d.id,
            children: idsOf(
              DOCS.filter((c) => c.parentId === d.id && visible(c))
            ),
          }))
        )
      );
    });

    test("W-K1c S-X1: a cross-model cycle inside one layer", async () => {
      const base = await seeded();
      const db = base.$extends(
        rows("x1", {
          org: { related: { teams: { some: {} } } },
          team: { related: { org: { is: { name: "x" } } } },
        })
      );
      const orgVisible = (o: { id: string }) =>
        TEAMS.some((t) => t.orgId === o.id);
      const teamVisible = (t: { orgId: string }) =>
        byId(ORGS, t.orgId)?.name === "x";
      expect(
        shape(
          await db.team.findMany({
            select: { id: true, org: { select: { id: true } } },
          })
        )
      ).toEqual(
        shape(
          TEAMS.map((t) => {
            const o = byId(ORGS, t.orgId)!;
            return { id: t.id, org: orgVisible(o) ? { id: o.id } : null };
          })
        )
      );
      expect(
        shape(
          await db.org.findMany({
            select: { id: true, teams: { select: { id: true } } },
          })
        )
      ).toEqual(
        shape(
          ORGS.map((o) => ({
            id: o.id,
            teams: idsOf(
              TEAMS.filter((t) => t.orgId === o.id && teamVisible(t))
            ),
          }))
        )
      );
    });

    test("W-K1c S-X1b: the same cycle across two layers, each reading the other at its default", async () => {
      const base = await seeded();
      const db = base
        .$extends(rows("la", { org: { related: { teams: { some: {} } } } }))
        .$extends(
          rows("lb", { team: { related: { org: { is: { name: "x" } } } } })
        );
      const teamB = (t: { orgId: string }) => byId(ORGS, t.orgId)?.name === "x";
      const orgA = (o: { id: string }) =>
        TEAMS.some((t) => t.orgId === o.id && teamB(t));
      const orgARaw = (o: { id: string }) =>
        TEAMS.some((t) => t.orgId === o.id);
      const teamBUnderA = (t: { orgId: string }) => {
        const o = byId(ORGS, t.orgId)!;
        return o.name === "x" && orgARaw(o);
      };
      expect(
        shape(
          await db.org.findMany({
            select: { id: true, teams: { select: { id: true } } },
          })
        )
      ).toEqual(
        shape(
          ORGS.map((o) => ({
            id: o.id,
            teams: idsOf(
              TEAMS.filter((t) => t.orgId === o.id && teamBUnderA(t))
            ),
          }))
        )
      );
      expect(
        shape(
          await db.team.findMany({
            select: { id: true, org: { select: { id: true } } },
          })
        )
      ).toEqual(
        shape(
          TEAMS.map((t) => {
            const o = byId(ORGS, t.orgId)!;
            return { id: t.id, org: orgA(o) ? { id: o.id } : null };
          })
        )
      );
    });

    test("W-K1c S-X3 and S-X4: a self relation, related only, plain and as a closure", async () => {
      const base = await seeded();
      const plain = base.$extends(
        rows("x3", { doc: { related: { parent: { is: { ownerId: "u1" } } } } })
      );
      expect(
        shape(
          await plain.doc.findMany({
            select: { id: true, children: { select: { id: true } } },
          })
        )
      ).toEqual(
        shape(
          DOCS.map((d) => ({
            id: d.id,
            children: idsOf(
              DOCS.filter(
                (c) =>
                  c.parentId === d.id &&
                  byId(DOCS, c.parentId)?.ownerId === "u1"
              )
            ),
          }))
        )
      );
      const closure = base.$extends(
        rows("x4", {
          doc: {
            related: {
              parent: {
                recurse: { depth: false },
                self: true,
                some: { ownerId: "u1" },
              },
            },
          },
        })
      );
      const visible = (c: Doc) =>
        ancestorsAndSelf(c).some((m) => m.ownerId === "u1");
      expect(
        shape(
          await closure.doc.findMany({
            select: { id: true, children: { select: { id: true } } },
          })
        )
      ).toEqual(
        shape(
          DOCS.map((d) => ({
            id: d.id,
            children: idsOf(
              DOCS.filter((c) => c.parentId === d.id && visible(c))
            ),
          }))
        )
      );
    });

    test("W-K1c: a ring of three layers terminates at the layer count, no depth written", async () => {
      const base = await seeded();
      const db = base
        .$extends(
          rows("ra", {
            org: { related: { teams: { some: { name: "core" } } } },
          })
        )
        .$extends(
          rows("rb", {
            team: { related: { members: { some: { userId: "u1" } } } },
          })
        )
        .$extends(
          rows("rc", {
            member: {
              related: { team: { is: { org: { is: { name: "x" } } } } },
            },
          })
        );
      // A member is read under C: its team under B (C excluded: members
      // raw), the team's org under A (C excluded), whose teams under B (A and
      // C excluded: members raw again).
      const rawMemberU1 = (t: { id: string }) =>
        MEMBERS.some((m) => m.teamId === t.id && m.userId === "u1");
      const orgAInC = (o: { id: string }) =>
        TEAMS.some(
          (t) => t.orgId === o.id && t.name === "core" && rawMemberU1(t)
        );
      const memberC = (m: { teamId: string }) => {
        const t = byId(TEAMS, m.teamId)!;
        const o = byId(ORGS, t.orgId)!;
        return rawMemberU1(t) && orgAInC(o) && o.name === "x";
      };
      expect(
        shape(
          await db.team.findMany({
            select: { id: true, members: { select: { id: true } } },
          })
        )
      ).toEqual(
        shape(
          TEAMS.map((t) => ({
            id: t.id,
            members: idsOf(
              MEMBERS.filter((m) => m.teamId === t.id && memberC(m))
            ),
          }))
        )
      );
    });

    test("W-K1d: a layer's traversal lowers on the statement's one alias counter (alias shadowing)", async () => {
      const base = await seeded();
      const db = base
        .$extends(
          rows("p", { org: { root: { teams: { some: { name: "core" } } } } })
        )
        .$extends(
          rows("k", {
            team: {
              related: {
                org: { is: { name: "x" } },
                members: { some: { userId: "u1" } },
                leads: { some: { userId: "u1" } },
              },
            },
          })
        );
      const teamK = (t: { id: string; orgId: string }) =>
        byId(ORGS, t.orgId)?.name === "x" &&
        MEMBERS.some((m) => m.teamId === t.id && m.userId === "u1") &&
        LEADS.some((l) => l.teamId === t.id && l.userId === "u1");
      const orgs = ORGS.filter((o) =>
        TEAMS.some((t) => t.orgId === o.id && t.name === "core" && teamK(t))
      );
      expect(shape(await db.org.findMany({ select: { id: true } }))).toEqual(
        shape(idsOf(orgs))
      );
      expect(
        shape(
          await db.org.findMany({
            select: { id: true, teams: { select: { id: true } } },
          })
        )
      ).toEqual(
        shape(
          orgs.map((o) => ({
            id: o.id,
            teams: idsOf(TEAMS.filter((t) => t.orgId === o.id && teamK(t))),
          }))
        )
      );
    });

    test("W-K1f: a predicate deeper than a caller's 16 levels is admitted, and a 101-deep tree inherits through a closure", async () => {
      const base = await seeded();
      let deep: Record<string, unknown> = { ownerId: "u1" };
      for (let depth = 0; depth < 20; depth++) deep = { AND: [deep] };
      const nested = base.$extends(rows("deep", { doc: { root: deep } }));
      expect(
        shape(await nested.doc.findMany({ select: { id: true } }))
      ).toEqual(shape(idsOf(DOCS.filter((d) => d.ownerId === "u1"))));
      // A chain of 101 documents below d10's sibling root r0, owned by u1 at
      // its root only.
      const chain = Array.from({ length: 102 }, (_, index) => ({
        id: `r${index}`,
        ownerId: index === 0 ? "u3" : null,
        parentId: index === 0 ? null : `r${index - 1}`,
      }));
      for (const data of chain) await base.doc.create({ data });
      const inherits = base.$extends(
        rows("up", {
          doc: {
            root: {
              id: { startsWith: "r" },
              parent: {
                recurse: { depth: false },
                self: true,
                some: { ownerId: "u3" },
              },
            },
          },
        })
      );
      const leaf = await inherits.doc.findUnique({
        where: { id: "r101" },
        select: { id: true },
      });
      expect(leaf).toEqual({ id: "r101" });
      expect(await inherits.doc.count()).toBe(102);
    });

    test('W-K1g: deleted "with" / "only" and scope "all" revive nothing inside a traversal', async () => {
      const base = await seeded();
      const sees = { grants: { some: { userId: "u1" } } };
      const db = base
        .$extends(tenancy(["folder", "file", "grant"]))
        .$extends(rows("policy", { file: { root: sees, related: sees } }))
        .$extends(tombstones(["file", "grant"]));
      // The policy reads grants at every other layer's default: live, and in
      // the call's tenant (t1), whatever mode the call passes.
      const granted = (f: { id: string }) =>
        GRANTS.some(
          (g) =>
            g.fileId === f.id &&
            g.userId === "u1" &&
            g.deletedAt === null &&
            g.tenantId === "t1"
        );
      const t1 = (f: { tenantId: string }) => f.tenantId === "t1";
      const live = (f: { deletedAt: Date | null }) => f.deletedAt === null;
      const cases: [
        Record<string, unknown>,
        (f: (typeof FILES)[number]) => boolean,
      ][] = [
        [{}, (f) => t1(f) && live(f)],
        [{ deleted: "with" }, t1],
        [{ deleted: "only" }, (f) => t1(f) && !live(f)],
        [{ scope: "all" }, live],
        [{ scope: "all", deleted: "with" }, () => true],
      ];
      for (const [controls, kept] of cases)
        expect(
          shape(
            await db.file.findMany({
              tenant: "t1",
              ...controls,
              select: { id: true },
            })
          ),
          JSON.stringify(controls)
        ).toEqual(shape(idsOf(FILES.filter((f) => kept(f) && granted(f)))));
      for (const [controls, kept, folders] of [
        [{ deleted: "with" }, t1, FOLDERS.filter(t1)],
        [{ scope: "all" }, live, FOLDERS],
      ] as const)
        expect(
          shape(
            await db.folder.findMany({
              tenant: "t1",
              ...controls,
              select: { id: true, files: { select: { id: true } } },
            })
          ),
          JSON.stringify(controls)
        ).toEqual(
          shape(
            folders.map((fo) => ({
              id: fo.id,
              files: idsOf(
                FILES.filter(
                  (f) => f.folderId === fo.id && kept(f) && granted(f)
                )
              ),
            }))
          )
        );
    });

    test("W-K2b: a parameterized predicate selects what the same predicate with its values written in selects, for every actor", async () => {
      const base = await seeded();
      const predicate = (userId: unknown) => ({
        OR: [
          { ownerId: userId },
          { parent: { is: { ownerId: userId } } },
          { owner: { is: { sessions: { some: { accountId: userId } } } } },
        ],
      });
      const db = base.$extends(actorRows({ doc: predicate(actor("userId")) }));
      for (const userId of ["u1", "u2", "u3", "nobody"]) {
        const given = await db.doc.findMany({
          actor: { userId },
          select: { id: true, children: { select: { id: true } } },
        });
        const written = predicate(userId);
        const expected = await base.doc.findMany({
          where: written,
          select: {
            id: true,
            children: { where: written, select: { id: true } },
          },
        });
        expect(shape(given), userId).toEqual(shape(expected));
      }
    });

    test("W-K2d: an absent required path under NOT matches nothing; present, the NOT reads it", async () => {
      const base = await seeded();
      const db = base.$extends(
        actorRows({
          doc: {
            NOT: {
              owner: { is: { sessions: { some: { id: actor("session") } } } },
            },
          },
        })
      );
      expect(
        await db.doc.findMany({ actor: { userId: "u1" }, select: { id: true } })
      ).toEqual([]);
      const held = (sessionId: string) =>
        SESSIONS.find((row) => row.id === sessionId)?.accountId;
      expect(
        shape(
          await db.doc.findMany({
            actor: { userId: "u1", session: "s1" },
            select: { id: true },
          })
        )
      ).toEqual(shape(idsOf(DOCS.filter((d) => d.ownerId !== held("s1")))));
    });

    test("W-K2e: an absent optional control still drops its predicate, and the statement is the base client's", async () => {
      const base = await seeded();
      const optional = defineExtension({
        name: "optionalTenant",
        controls: { tenant: { schema: v.string() } },
        rows: {
          control: "scope",
          default: "tenant",
          models: {
            file: {
              tenant: {
                root: { tenantId: { control: "tenant" } },
                related: { tenantId: { control: "tenant" } },
              },
            },
          },
        },
      } as never);
      const db = base.$extends(optional);
      expect(shape(await db.file.findMany({ select: { id: true } }))).toEqual(
        shape(idsOf(FILES))
      );
      expect(
        shape(await db.file.findMany({ tenant: "t2", select: { id: true } }))
      ).toEqual(shape(idsOf(FILES.filter((f) => f.tenantId === "t2"))));
      expect(
        shape(
          await db.folder.findMany({
            select: { id: true, files: { select: { id: true } } },
          })
        )
      ).toEqual(
        shape(
          await base.folder.findMany({
            select: { id: true, files: { select: { id: true } } },
          })
        )
      );
    });

    test("W-L4 (G4): an array path is the field's list operand, of any length and with duplicates, in and notIn; absent, it matches nothing", async () => {
      const base = await seeded();
      const listed = base.$extends(
        actorRows({ doc: { id: { in: actor("docs") } } })
      );
      const excluded = base.$extends(
        actorRows({ doc: { id: { notIn: actor("docs") } } })
      );
      const read = async (db: Loose, docs?: string[]) =>
        shape(
          await db.doc.findMany({
            actor: { userId: "u1", ...(docs && { docs }) },
            select: { id: true, children: { select: { id: true } } },
          })
        );
      // The related predicate is the root's: a child is read where it is listed.
      const expected = (keep: (d: Doc) => boolean) =>
        shape(
          DOCS.filter(keep).map((d) => ({
            id: d.id,
            children: DOCS.filter((c) => c.parentId === d.id && keep(c)).map(
              ({ id }) => ({ id })
            ),
          }))
        );
      for (const docs of [
        ["d1"],
        ["d1", "d2", "d9", "d1"],
        [],
        ["missing"],
        DOCS.map((d) => d.id),
      ]) {
        expect(await read(listed, docs), String(docs)).toEqual(
          expected((d) => docs.includes(d.id))
        );
        expect(await read(excluded, docs), String(docs)).toEqual(
          expected((d) => !docs.includes(d.id))
        );
      }
      expect(await read(listed)).toEqual([]);
      expect(await read(excluded)).toEqual([]);
    });

    test("W-K2g: a null value is absent, never IS NULL: userId null matches no orphaned row", async () => {
      const base = await seeded();
      // The memo path read a control's null as `IS NULL`: d9 and d10.
      const owned = base.$extends(
        defineExtension({
          name: "owned",
          controls: {
            owner: { schema: v.nullable(v.string()), required: true },
          },
          rows: {
            control: "ownedMode",
            default: "on",
            models: {
              doc: { on: { root: { ownerId: { control: "owner" } } } },
            },
          },
        } as never)
      );
      expect(
        await owned.doc.findMany({ owner: null, select: { id: true } })
      ).toEqual([]);
      const db = base.$extends(
        actorRows({ doc: { ownerId: actor("userId") } })
      );
      expect(
        await db.doc.findMany({ actor: { userId: null }, select: { id: true } })
      ).toEqual([]);
      expect(
        shape(
          await base.doc.findMany({
            where: { ownerId: null },
            select: { id: true },
          })
        )
      ).toEqual(shape(idsOf(DOCS.filter((d) => d.ownerId === null))));
      expect(
        shape(
          await db.doc.findMany({
            actor: { userId: "u2" },
            select: { id: true },
          })
        )
      ).toEqual(shape(idsOf(DOCS.filter((d) => d.ownerId === "u2"))));
    });

    test("conditions fold per call before absence: a false one removes its arm, a held one is true, under OR and NOT", async () => {
      const base = await seeded();
      const isAdmin = {
        $if: { control: "actor", path: "roles", has: "admin" },
      };
      const db = base.$extends(
        actorRows({
          doc: {
            OR: [
              isAdmin,
              {
                AND: [
                  { $if: { control: "actor", path: "session", exists: true } },
                  { ownerId: actor("userId") },
                ],
              },
              {
                $if: { control: "actor", path: "roles", hasSome: ["auditor"] },
                NOT: { ownerId: actor("userId") },
                parentId: null,
              },
            ],
          },
        })
      );
      const read = (value: Record<string, unknown>) =>
        db.doc.findMany({ actor: value, select: { id: true } });
      expect(shape(await read({ userId: "u1", roles: ["admin"] }))).toEqual(
        shape(idsOf(DOCS))
      );
      // No session: the owner arm folds false with its parameter; no role.
      expect(await read({ userId: "u1" })).toEqual([]);
      expect(shape(await read({ userId: "u1", session: "s1" }))).toEqual(
        shape(idsOf(DOCS.filter((d) => d.ownerId === "u1")))
      );
      expect(shape(await read({ userId: "u1", roles: ["auditor"] }))).toEqual(
        shape(
          // `NOT` over a null owner is unknown, so d10 is not read.
          idsOf(
            DOCS.filter(
              (d) =>
                d.parentId === null && d.ownerId !== null && d.ownerId !== "u1"
            )
          )
        )
      );
      for (const [spec, reason] of [
        [{ control: "actor", path: "roles" }, "no test"],
        [{ control: "actor", exists: true, equals: 1 }, "two tests"],
        [{ path: "roles", exists: true }, "no control"],
        [{ control: "actor", in: "admin" }, "a list test without a list"],
      ] as const)
        expect(
          refusal(() => base.$extends(actorRows({ doc: { $if: spec } })))
            .message,
          reason
        ).toContain('rows.doc.on.root at "$if"');
    });

    test("relation chains and repeated quantifiers answer as their oracle: a chain read through its outer row, merged some, is, none and isNot", async () => {
      const base = await seeded();
      type Lead = (typeof LEADS)[number];
      const hidden = base.$extends(
        rows("hide", { member: { related: { id: { not: "m1" } } } })
      );
      const read = async (db: Loose, root: object) =>
        shape(
          await db
            .$extends(rows("chain", { lead: { root } }))
            .lead.findMany({ select: { id: true } })
        );
      const oracle = (holds: (lead: Lead) => boolean) =>
        shape(idsOf(LEADS.filter(holds)));
      const orgOf = (lead: Lead) => byId(TEAMS, lead.teamId)!.orgId;
      const teamHas = (
        teamId: string,
        member: (row: (typeof MEMBERS)[number]) => boolean
      ) => MEMBERS.some((row) => row.teamId === teamId && member(row));
      const own = (lead: Lead) =>
        teamHas(lead.teamId, (row) => row.userId === lead.userId);
      const sameUser = (up: number) => ({ userId: { $row: "userId", up } });
      // Two bodies down, and four: each relation body below the first is
      // a conjunct reading the lead itself.
      const twoDown = { team: { is: { members: { some: sameUser(2) } } } };
      expect(await read(base, twoDown)).toEqual(oracle(own));
      expect(
        await read(hidden, twoDown),
        "each hop keeps its related rows"
      ).toEqual(
        oracle((lead) =>
          teamHas(
            lead.teamId,
            (row) => row.id !== "m1" && row.userId === lead.userId
          )
        )
      );
      expect(
        await read(base, {
          team: {
            is: {
              org: {
                is: { teams: { some: { members: { some: sameUser(4) } } } },
              },
            },
          },
        })
      ).toEqual(
        oracle((lead) =>
          TEAMS.some(
            (team) =>
              team.orgId === orgOf(lead) &&
              teamHas(team.id, (row) => row.userId === lead.userId)
          )
        )
      );
      expect(
        await read(base, { team: { is: { members: { none: sameUser(2) } } } })
      ).toEqual(oracle((lead) => !own(lead)));
      // Quantifiers over one relation, OR-ed or (negated) AND-ed.
      expect(
        await read(base, {
          OR: [
            { team: { is: { members: { some: { userId: "u2" } } } } },
            { team: { is: { members: { some: { id: "m3" } } } } },
          ],
        })
      ).toEqual(
        oracle((lead) =>
          teamHas(lead.teamId, (row) => row.userId === "u2" || row.id === "m3")
        )
      );
      expect(
        await read(base, {
          AND: [
            { team: { is: { members: { none: { userId: "u2" } } } } },
            { team: { is: { members: { none: { id: "m3" } } } } },
          ],
        })
      ).toEqual(
        oracle(
          (lead) =>
            !teamHas(
              lead.teamId,
              (row) => row.userId === "u2" || row.id === "m3"
            )
        )
      );
      expect(
        await read(base, {
          AND: [
            { team: { isNot: { name: "aux" } } },
            { team: { isNot: { orgId: "o3" } } },
          ],
        })
      ).toEqual(
        oracle((lead) => {
          const team = byId(TEAMS, lead.teamId)!;
          return team.name !== "aux" && team.orgId !== "o3";
        })
      );
      // Merged, the chain sits under the body's OR: no longer a conjunct.
      expect(
        await read(base, {
          OR: [
            { team: { is: { orgId: "o5" } } },
            {
              team: {
                is: {
                  members: { some: { ...sameUser(2), id: { not: "m1" } } },
                },
              },
            },
          ],
        })
      ).toEqual(
        oracle(
          (lead) =>
            orgOf(lead) === "o5" ||
            teamHas(
              lead.teamId,
              (row) => row.id !== "m1" && row.userId === lead.userId
            )
        )
      );
    });

    test("{ now: true } is the call's one instant (R7), never one frozen at $extends", async () => {
      const base = await seeded();
      const db = base.$extends(
        rows("live", {
          doc: { root: { expiresAt: { gt: { now: true } } } },
        })
      );
      const at = Date.now();
      expect(shape(await db.doc.findMany({ select: { id: true } }))).toEqual(
        shape(
          idsOf(
            DOCS.filter(
              (d) => d.expiresAt !== null && d.expiresAt.getTime() > at
            )
          )
        )
      );
    });
  });
}
