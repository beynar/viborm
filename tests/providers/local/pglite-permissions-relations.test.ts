/**
 * PGlite Driver Tests — PlanetScale Neki refuses a statement referencing more
 * than 256 relations (SQLSTATE 54000), and a PostgreSQL driver given
 * `relationsPerStatement: 256` bounds each statement to it; one given none
 * keeps every statement's form. The nine `$access`
 * reads D1's statement budget runs (u02), as PGlite states them: each within
 * 256 as Neki counts them (every `FROM` item, aliased `q<n>` or a bare read
 * of a shared member), each past its in-place form escalated only as far as
 * it needs (its form pinned: walks in place, reaching sets, joined key sets),
 * and each answering what its in-place form answers.
 */

import { PGliteDriver } from "@drivers/pglite";
import { softDelete } from "@src/soft-delete/index";
import {
  createPermissionsAppClient,
  loadPermissionsSeed,
  type PermissionsAppClient,
} from "@tests/contracts/public-client/permissions-app-behavior";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import { TOMBSTONED_MODELS } from "@tests/package/fixtures/permissions-app/oracle";
import { schema } from "@tests/package/fixtures/permissions-app/schema";
import { actors } from "@tests/package/fixtures/permissions-app/seed";
import { policy } from "@tests/types/permissions/acceptance-policy";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

const tombstones = softDelete({
  models: Object.fromEntries(
    TOMBSTONED_MODELS.map((model) => [model, { deletedAt: "deletedAt" }])
  ),
});
type Read = (args?: object) => Promise<unknown>;
type Governed = {
  $as(actor: unknown): Record<string, { findMany: Read }>;
};

const relationsOf = (statement: string) =>
  (statement.match(/ AS "q\d+"/g) ?? []).length +
  (statement.match(/(?:FROM|JOIN) "__shared_\d+"(?! AS)/g) ?? []).length;
const formOf = (statement: string) => ({
  relations: relationsOf(statement),
  inPlace: statement.split("EXISTS (WITH RECURSIVE").length - 1,
  // A reaching set's recursive term reads its own member, aliased.
  reaching: (statement.match(/FROM "__shared_\d+" AS "q\d+"/g) ?? []).length,
  // PostgreSQL joins a one-column key set held as an array.
  joined: statement.split('CROSS JOIN "__shared_').length - 1,
});

const relationNames = (model: string) =>
  Object.keys(
    (
      schema[model as keyof typeof schema] as unknown as {
        "~": { state: { relations: Record<string, unknown> } };
      }
    )["~"].state.relations
  );
const withEvidence = (model: string) =>
  Object.fromEntries(
    relationNames(model).map((relation) => [
      relation,
      { include: { $access: true } },
    ])
  );

const READS: [string, object, string][] = [
  ["accessGrant $access", { include: { $access: true } }, "accessGrant"],
  ["page $access", { include: { $access: true } }, "page"],
  [
    "page $access, group $access",
    { include: { $access: true, group: { include: { $access: true } } } },
    "page",
  ],
  ["document $access", { include: { $access: true } }, "document"],
  [
    "document roots $access at three depths",
    {
      where: { parentId: null },
      include: {
        $access: true,
        children: {
          include: { $access: true, children: { include: { $access: true } } },
        },
      },
    },
    "document",
  ],
  [
    "document roots $access at three depths, with grants",
    {
      where: { parentId: null },
      include: {
        $access: true,
        grants: { include: { $access: true } },
        children: {
          include: {
            $access: true,
            children: {
              include: {
                $access: true,
                grants: { include: { $access: true } },
              },
            },
          },
        },
      },
    },
    "document",
  ],
  [
    "document every relation + $access",
    { include: { $access: true, ...withEvidence("document") } },
    "document",
  ],
  [
    "page $access at three depths through group and grants",
    {
      include: {
        $access: true,
        group: {
          include: {
            $access: true,
            grants: {
              include: {
                $access: true,
                document: { include: { $access: true } },
              },
            },
            pages: { include: { $access: true } },
          },
        },
        grants: {
          include: { $access: true, page: { include: { $access: true } } },
        },
      },
    },
    "page",
  ],
  [
    "accessGrant every relation + $access",
    { include: { $access: true, ...withEvidence("accessGrant") } },
    "accessGrant",
  ],
];

// The relations each read references without a bound: its walks in place
// but the one to the actor's teams only repeated bodies read, one reaching
// set. The six past 256 are those a bound of 256 escalates.
const PINNED_IN_PLACE = {
  "accessGrant $access": { relations: 275, reaching: 1 },
  "page $access": { relations: 92, reaching: 1 },
  "page $access, group $access": { relations: 108, reaching: 1 },
  "document $access": { relations: 177, reaching: 1 },
  "document roots $access at three depths": { relations: 390, reaching: 1 },
  "document roots $access at three depths, with grants": {
    relations: 631,
    reaching: 1,
  },
  "document every relation + $access": { relations: 607, reaching: 1 },
  "page $access at three depths through group and grants": {
    relations: 499,
    reaching: 1,
  },
  "accessGrant every relation + $access": { relations: 459, reaching: 1 },
};

describe("PGlite: every $access read within Neki's 256 relations", () => {
  const opened: PermissionsAppClient[] = [];
  const statements: string[] = [];
  let budgeted: Governed;
  let inPlace: Governed;

  const open = async (budget: number | undefined) => {
    const driver = new PGliteDriver(
      budget === undefined ? {} : { relationsPerStatement: budget }
    );
    const base = createPermissionsAppClient(driver);
    opened.push(base);
    await syncLiveSchema(base);
    await loadPermissionsSeed(base);
    const recorded = base.$extends({
      name: "statements",
      statement(context) {
        statements.push(context.statement.toStatement());
        return context.statement;
      },
    });
    return policy.methods(
      tombstones.methods(policy.rows(tombstones.rows(recorded)))
    ) as unknown as Governed;
  };

  beforeAll(async () => {
    budgeted = await open(256);
    inPlace = await open(undefined);
  }, 300_000);
  afterAll(async () => {
    for (const client of opened) await client.$disconnect();
  });

  test("each fits, escalated only as far as it needs, with its in-place rows", async () => {
    const forms: Record<string, ReturnType<typeof formOf>> = {};
    for (const [line, args, model] of READS) {
      statements.length = 0;
      const rows = await budgeted.$as(actors.u02!)[model]!.findMany(args);
      const widest = statements.reduce((a, b) => (b.length > a.length ? b : a));
      forms[line] = formOf(widest);
      expect(forms[line]!.relations).toBeLessThanOrEqual(256);
      statements.length = 0;
      expect(rows).toEqual(
        await inPlace.$as(actors.u02!)[model]!.findMany(args)
      );
      // A read escalated past its unbounded form is past 256 in place.
      const unbounded = formOf(
        statements.reduce((a, b) => (b.length > a.length ? b : a))
      );
      if (forms[line]!.reaching > unbounded.reaching || forms[line]!.joined > 0)
        expect(unbounded.relations).toBeGreaterThan(256);
    }
    expect(forms).toEqual({
      "accessGrant $access": {
        relations: 248,
        inPlace: 6,
        reaching: 2,
        joined: 0,
      },
      "page $access": { relations: 92, inPlace: 0, reaching: 1, joined: 0 },
      "page $access, group $access": {
        relations: 108,
        inPlace: 0,
        reaching: 1,
        joined: 0,
      },
      "document $access": {
        relations: 177,
        inPlace: 14,
        reaching: 1,
        joined: 0,
      },
      "document roots $access at three depths": {
        relations: 250,
        inPlace: 9,
        reaching: 5,
        joined: 0,
      },
      "document roots $access at three depths, with grants": {
        relations: 253,
        inPlace: 0,
        reaching: 8,
        joined: 36,
      },
      "document every relation + $access": {
        relations: 250,
        inPlace: 0,
        reaching: 8,
        joined: 23,
      },
      "page $access at three depths through group and grants": {
        relations: 253,
        inPlace: 0,
        reaching: 8,
        joined: 42,
      },
      "accessGrant every relation + $access": {
        relations: 253,
        inPlace: 0,
        reaching: 8,
        joined: 33,
      },
    });
  }, 300_000);
  test("without relationsPerStatement, a read keeps its walks in place but those only repeated bodies read, past 256 or not", async () => {
    const relations: Record<string, { relations: number; reaching: number }> =
      {};
    for (const [line, args, model] of READS) {
      statements.length = 0;
      await inPlace.$as(actors.u02!)[model]!.findMany(args);
      const widest = statements.reduce((a, b) => (b.length > a.length ? b : a));
      const form = formOf(widest);
      expect(form.joined).toBe(0);
      relations[line] = { relations: form.relations, reaching: form.reaching };
    }
    expect(relations).toEqual(PINNED_IN_PLACE);
  }, 300_000);
});
