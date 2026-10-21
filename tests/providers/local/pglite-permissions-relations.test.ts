/**
 * PGlite Driver Tests — PlanetScale Neki refuses a statement referencing more
 * than 256 relations (SQLSTATE 54000), and the PostgreSQL drivers bound each
 * statement to 256 (`capabilities.relationsPerStatement`). The nine `$access`
 * reads D1's statement budget runs (u02), as PGlite states them: each within
 * 256 as Neki counts them (every `FROM` item, aliased `q<n>` or a bare read
 * of a shared member), each past its in-place form escalated only as far as
 * it needs (its form pinned: walks in place, reaching sets, joined key sets),
 * and each answering what its in-place form answers.
 */

import { softDelete } from "@src/soft-delete/index";
import {
  createPermissionsAppClient,
  loadPermissionsSeed,
  type PermissionsAppClient,
} from "@tests/contracts/public-client/permissions-app-behavior";
import { createInMemoryPGliteDriver } from "@tests/fixtures/drivers/pglite";
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
  joined: statement.split('LEFT JOIN "__shared_').length - 1,
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

describe("PGlite: every $access read within Neki's 256 relations", () => {
  const opened: PermissionsAppClient[] = [];
  const statements: string[] = [];
  let budgeted: Governed;
  let inPlace: Governed;

  const open = async (budget: number | undefined) => {
    const driver = createInMemoryPGliteDriver();
    driver.adapter.capabilities.relationsPerStatement = budget;
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
      // A read that leaves its walks' place is past 256 in place.
      if (forms[line]!.reaching > 0) {
        const unbounded = statements.reduce((a, b) =>
          b.length > a.length ? b : a
        );
        expect(relationsOf(unbounded)).toBeGreaterThan(256);
      }
    }
    expect(forms).toEqual({
      "accessGrant $access": {
        relations: 251,
        inPlace: 7,
        reaching: 1,
        joined: 0,
      },
      "page $access": { relations: 95, inPlace: 1, reaching: 0, joined: 0 },
      "page $access, group $access": {
        relations: 111,
        inPlace: 1,
        reaching: 0,
        joined: 0,
      },
      "document $access": {
        relations: 180,
        inPlace: 15,
        reaching: 0,
        joined: 0,
      },
      "document roots $access at three depths": {
        relations: 253,
        inPlace: 10,
        reaching: 4,
        joined: 0,
      },
      "document roots $access at three depths, with grants": {
        relations: 252,
        inPlace: 0,
        reaching: 8,
        joined: 38,
      },
      "document every relation + $access": {
        relations: 253,
        inPlace: 0,
        reaching: 8,
        joined: 23,
      },
      "page $access at three depths through group and grants": {
        relations: 255,
        inPlace: 0,
        reaching: 8,
        joined: 46,
      },
      "accessGrant every relation + $access": {
        relations: 255,
        inPlace: 0,
        reaching: 8,
        joined: 36,
      },
    });
  }, 300_000);
});
