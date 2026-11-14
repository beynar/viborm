/**
 * SQL Server: the Permissions acceptance estate cannot run, and says so.
 *
 * Its policy walks two closures, a document's ancestors (depth 5 in the
 * seed) and a grantee team's sub-teams (depth 3, with diamonds), nested in
 * one another, and SQL Server refuses `recurse` (no WITH inside a
 * subquery). Unrolled to the seed's depths, the document rule alone nests
 * about 15 filter levels before it reaches a grant, and the where
 * validator stops at 16: no equivalent policy without recursion exists, so
 * the estate's six suites (app, compiled policy, entry, evidence,
 * placement, verbs) are not registered here. This file proves the typed
 * refusal on the estate itself, written by hand and through
 * `viborm/permissions`; the judged writes are proven by the produced-row,
 * judged-write, adversarial, `on` and ordering suites, whose policies do
 * not recurse. Set MSSQL_TEST_CONNECTION_STRING to run.
 */

import { permissions } from "@src/permissions";
import {
  createPermissionsAppClient,
  loadPermissionsSeed,
} from "@tests/contracts/public-client/permissions-app-behavior";
import { expectRecursionRefused } from "@tests/contracts/recursion";
import { handRules } from "@tests/package/fixtures/permissions-app/rules";
import { actors, seed } from "@tests/package/fixtures/permissions-app/seed";
import { policy } from "@tests/types/permissions/acceptance-policy";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { isolatedSchema, TEST_CONNECTION_STRING } from "./mssql-fixtures";

const describeIf = TEST_CONNECTION_STRING ? describe : describe.skip;
const substrate = isolatedSchema("viborm_permissions_estate");
const READER = actors.u03!;

describeIf("SQL Server: the Permissions acceptance estate", () => {
  const client = createPermissionsAppClient(substrate.createDriver());

  beforeAll(async () => {
    await substrate.prepare(client);
    await loadPermissionsSeed(client);
  }, 120_000);
  afterAll(async () => {
    await client.$disconnect();
    await substrate.release();
  });

  test("its hand-written rules are refused for their recursion", async () => {
    const rules = handRules(READER, { now: new Date() });
    for (const model of ["document", "page"] as const) {
      const where = rules.observed(model, "read");
      expect(where, model).not.toBeNull();
      await expectRecursionRefused(() =>
        (
          client[model] as unknown as {
            findMany(args: object): Promise<unknown>;
          }
        ).findMany({ where, select: { id: true } })
      );
    }
  });

  test("its viborm/permissions policy is refused for its recursion", async () => {
    const governed = permissions(policy.config)(client).$as(READER);
    await expectRecursionRefused(() =>
      governed.document.findMany({ select: { id: true } })
    );
    await expectRecursionRefused(() =>
      governed.page.findMany({ select: { id: true } })
    );
  });

  test("a rule without recursion runs on the same estate", async () => {
    const owner = Object.values(actors).find((actor) =>
      seed.document.some((document) => document.ownerId === actor.userId)
    )!;
    const own = permissions({
      actor: policy.config.actor,
      models: { document: { read: { ownerId: { actor: "userId" } } } },
    })(client).$as(owner);
    const mine = await own.document.findMany({ select: { ownerId: true } });
    expect(mine.length).toBe(
      seed.document.filter((document) => document.ownerId === owner.userId)
        .length
    );
    for (const row of mine) expect(row.ownerId).toBe(owner.userId);
  });
});
