import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { REPOSITORY_ROOT } from "@tests/fixtures/repo-paths";
import {
  actionsOf,
  createOracle,
  GOVERNED_MODELS,
  MODEL_ACTIONS,
} from "@tests/package/fixtures/rbac-app/oracle";
import {
  type Actor,
  actors,
  seed,
} from "@tests/package/fixtures/rbac-app/seed";
import { WITNESSES } from "@tests/package/fixtures/rbac-app/witnesses";
import { describe, expect, test } from "vitest";

/**
 * The RBAC estate's database-free half (plan §6.1 U0): the seed's scale, the
 * oracle's verdicts on the actors built to exercise each clause of §1.1, and
 * the witness table (§7). Read by the SQLite3 runner only; the substrate
 * runners compare the oracle with a database.
 */

const NOW = new Date("2026-10-15T00:00:00.000Z");
const oracle = createOracle(seed);
const actor = (name: string) => actors[name] as Actor;
const rows = (
  name: string,
  model: (typeof GOVERNED_MODELS)[number],
  action = "view"
) => oracle.rows(actor(name), model, action, { now: NOW });

/** Models whose every action is under `within: inOrg` (an active member, a live credential). */
const IN_ORG = [
  "member",
  "team",
  "pageGroup",
  "page",
  "document",
  "collection",
] as const;
/** Actions no rule and no arm declares: false for everyone (R9, A7). */
const UNDECLARED = new Set([
  "organization.edit",
  "organization.full",
  "member.full",
  "user.edit",
  "user.full",
  "team.full",
  "teamMember.edit",
  "teamMember.full",
  "accessGrant.full",
]);

/** Plan §7's witness ids, spelled out: the table must hold exactly these. */
const PLAN_WITNESS_IDS = [
  ...series("W-R", 9),
  ..."abcdefg".split("").map((s) => `W-K1${s}`),
  ..."abcdefg".split("").map((s) => `W-K2${s}`),
  ...series("W-W", 10),
  ...series("W-P", 16),
  ...series("W-AS", 7),
  ...series("W-CAN", 6),
  ...series("W-EV", 4),
  ...series("W-F", 8),
  ...series("W-L", 8),
  ...series("W-N", 4),
  ...series("W-D", 12),
  ...series("W-C", 8),
  "W-X1",
  "W-H1",
  ...series("W-A", 6),
];
function series(prefix: string, count: number): string[] {
  return Array.from({ length: count }, (_, i) => `${prefix}${i + 1}`);
}

export function runRbacOracleChecks(): void {
  describe("the RBAC acceptance fixture: seed, oracle and witness table", () => {
    test("the seed holds the scale the plan asks for", () => {
      expect(
        Object.fromEntries(
          Object.entries(seed).map(([model, list]) => [model, list.length])
        )
      ).toEqual({
        organization: 3,
        user: 60,
        session: 78,
        apiKey: 8,
        member: 71,
        rolePermission: 57,
        team: 20,
        teamParent: 19,
        teamMember: 84,
        pageGroup: 15,
        page: 200,
        document: 150,
        collection: 30,
        accessGrant: 280,
      });
      const depth = (id: string | null): number =>
        id === null
          ? 0
          : 1 + depth(seed.document.find((d) => d.id === id)?.parentId ?? null);
      expect(Math.max(...seed.document.map((d) => depth(d.id)))).toBe(6);
      const parents = new Map<string, number>();
      for (const { childId } of seed.teamParent) {
        parents.set(childId, (parents.get(childId) ?? 0) + 1);
      }
      expect([...parents.values()].filter((n) => n > 1)).toHaveLength(4);
      const grants = seed.accessGrant;
      expect(grants.some((g) => g.userId !== null)).toBe(true);
      expect(grants.some((g) => g.everyone)).toBe(true);
      expect(grants.some((g) => g.granteeTeamId !== null)).toBe(true);
      expect(grants.some((g) => g.granteeRole !== null)).toBe(true);
      for (const key of [
        "pageId",
        "groupId",
        "documentId",
        "collectionId",
      ] as const) {
        expect(
          grants.some((g) => g[key] !== null),
          key
        ).toBe(true);
      }
      expect(
        grants.filter(
          (g) =>
            [g.pageId, g.groupId, g.documentId, g.collectionId].filter(
              (k) => k !== null
            ).length > 1
        ).length
      ).toBeGreaterThan(5);
      for (const level of ["view", "edit", "full"]) {
        expect(
          grants.some((g) => g.level === level),
          level
        ).toBe(true);
      }
      for (const action of actionsOf("document")) {
        expect(
          grants.some(
            (g) => g.documentId !== null && g.actions.includes(action)
          ),
          action
        ).toBe(true);
      }
      expect(grants.some((g) => g.deletedAt !== null)).toBe(true);
      expect(seed.member.some((m) => m.deletedAt !== null)).toBe(true);
      expect(seed.teamMember.some((m) => m.deletedAt !== null)).toBe(true);
      expect(seed.page.some((p) => p.deletedAt !== null)).toBe(true);
    });

    test("every declared action is reached by some actor; an undeclared one by none", () => {
      for (const [model, action] of MODEL_ACTIONS) {
        const reached = Object.values(actors).some(
          (a) => oracle.rows(a, model, action, { now: NOW }).length > 0
        );
        expect(reached, `${model}.${action}`).toBe(
          !UNDECLARED.has(`${model}.${action}`)
        );
      }
    });

    test("no live credential, a ban, a tombstoned or absent membership: no row under `within`", () => {
      for (const name of [
        "u07-expired",
        "u17-no-credential",
        "u27-unknown-session",
        "k02-disabled-key",
        "k03-expired-key",
        "k50-unknown-key",
        "u13",
        "u31",
        "u59",
        "u60",
      ]) {
        for (const model of IN_ORG) {
          expect(rows(name, model), `${name} ${model}`).toEqual([]);
        }
      }
      // A ban that expired bans nothing; `banned: null` is not a ban.
      expect(rows("u46", "page").length).toBeGreaterThan(0);
      expect(rows("u22", "page").length).toBeGreaterThan(0);
      // Without a credential, `organization.view: member()` and `user.view` still hold (A2).
      expect(rows("u17-no-credential", "organization")).toEqual(["org-1"]);
    });

    test("a key narrows: actions, models and documents through the tree", () => {
      expect(rows("k02-pages-view", "page").length).toBeGreaterThan(0);
      expect(rows("k02-pages-view", "page", "edit")).toEqual([]);
      for (const model of GOVERNED_MODELS.filter((m) => m !== "page")) {
        expect(rows("k02-pages-view", model), model).toEqual([]);
      }
      expect(rows("k41-no-resources", "document")).toEqual([]);
      const shared = rows("k05-documents-share", "document");
      const roots = new Set(
        seed.document
          .filter((d) => d.organizationId === "org-1" && d.parentId === null)
          .slice(0, 3)
          .map((d) => d.id)
      );
      const rootOf = (id: string): string => {
        const parent = seed.document.find((d) => d.id === id)?.parentId ?? null;
        return parent === null ? id : rootOf(parent);
      };
      expect(shared.length).toBeGreaterThan(0);
      for (const id of shared) expect(roots.has(rootOf(id)), id).toBe(true);
      expect(
        rows("k05-documents-share", "document", "share").length
      ).toBeGreaterThan(0);
      expect(rows("k05-documents-share", "document", "export")).toEqual([]);
      // Session and key at once: the key's scopes still narrow.
      expect(rows("u21-session-and-key", "document")).toEqual([]);
      expect(
        rows("u21-session-and-key", "page", "edit").length
      ).toBeGreaterThan(0);
    });

    test("a request fact and a row attribute: export needs an admin, a pro plan and the office", () => {
      expect(rows("u02", "organization", "export")).toEqual(["org-1"]);
      expect(rows("u01", "organization", "export")).toEqual([]);
      expect(rows("u01", "organization", "invite")).toEqual(["org-1"]);
      expect(rows("u20", "organization", "export")).toEqual([]);
    });

    test("tombstones grant nothing; a root mode chooses the roots only", () => {
      let widened = 0;
      for (const a of Object.values(actors)) {
        for (const [model, action] of MODEL_ACTIONS) {
          const composed = oracle.rows(a, model, action, { now: NOW });
          const bare = oracle.rows(a, model, action, {
            now: NOW,
            tombstones: false,
          });
          for (const id of composed)
            expect(bare, `${model}.${action}`).toContain(id);
          if (bare.length > composed.length) widened += 1;
        }
      }
      expect(widened).toBeGreaterThan(0);
      const withTombstones = oracle.rows(actor("u01"), "page", "view", {
        now: NOW,
        deleted: "with",
      });
      const only = oracle.rows(actor("u01"), "page", "view", {
        now: NOW,
        deleted: "only",
      });
      expect(only.length).toBeGreaterThan(0);
      expect(withTombstones).toEqual([...rows("u01", "page"), ...only].sort());
    });

    test("the stored ceiling equals the declared one on the seed (W-A6); $access projects the same verdicts", () => {
      for (const a of Object.values(actors)) {
        for (const [model, action] of MODEL_ACTIONS) {
          expect(
            oracle.rows(a, model, action, { now: NOW, ceiling: "stored" })
          ).toEqual(oracle.rows(a, model, action, { now: NOW }));
        }
        for (const model of GOVERNED_MODELS) {
          const evidence = oracle.access(a, model, { now: NOW });
          expect([...evidence.keys()].sort()).toEqual(
            oracle.rows(a, model, "view", { now: NOW })
          );
          for (const [id, held] of evidence) {
            expect(held, `${model} ${id}`).toContain("view");
          }
        }
      }
      // A1: a reader's ceiling is view. A reader in every organization it
      // belongs to holds nothing above view under `within`, even where a grant
      // gives it edit or full; and such a grant exists in the seed.
      const readersOnly = Object.entries(actors).filter(([, a]) => {
        const live = seed.member.filter(
          (m) => m.userId === a.userId && m.deletedAt === null
        );
        return live.length > 0 && live.every((m) => m.role === "reader");
      });
      expect(readersOnly.length).toBeGreaterThan(0);
      for (const [name, a] of readersOnly) {
        for (const model of IN_ORG) {
          for (const action of actionsOf(model).filter((x) => x !== "view")) {
            expect(
              oracle.rows(a, model, action, { now: NOW }),
              `${name} ${model}.${action}`
            ).toEqual([]);
          }
        }
      }
      expect(
        seed.accessGrant.some(
          (g) =>
            g.deletedAt === null &&
            (g.level === "edit" || g.level === "full") &&
            readersOnly.some(([, a]) => a.userId === g.userId)
        )
      ).toBe(true);
    });

    test("the witness table holds plan §7's ids once each, every landed case with its file", () => {
      const ids = WITNESSES.map((w) => w.id);
      expect(new Set(ids).size).toBe(ids.length);
      expect([...ids].sort()).toEqual([...PLAN_WITNESS_IDS].sort());
      for (const witness of WITNESSES) {
        if (witness.status === "pending") {
          expect(witness.test, witness.id).toBeUndefined();
          continue;
        }
        expect(witness.test, witness.id).toBeDefined();
        expect(
          existsSync(resolve(REPOSITORY_ROOT, witness.test as string)),
          `${witness.id}: ${witness.test}`
        ).toBe(true);
      }
    });
  });
}
