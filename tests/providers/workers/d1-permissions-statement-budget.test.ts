/**
 * D1 Driver Tests — W-K2f (plan §4.2, §8 "D1 per statement", M1 exit): every
 * statement `viborm/permissions` issues for §1.1's reads and writes stays inside
 * D1's budget, 100 bound values and 100 KB of text. The statements are read
 * off the D1 binding (`d1-statements.ts`), not from the engine: the values
 * the driver binds and the text it prepares, for the sampled actors, on
 * every governed model, with every relation included, at every action as a
 * mode and through `can`, and the heaviest writes (a grant `updateMany`,
 * edits and archives, a nested create under a document). D1 itself refuses a
 * statement over its limits; this pins the margin and reports it.
 *
 * `$access` (review 2, COST-3) is measured apart: the reads the review used,
 * each run on D1, and each refusal replayed on the binding to read the limit
 * D1 names. Two more limits than the published two apply: a statement whose
 * compiled program D1 cannot hold fails `SQLITE_NOMEM` (SQLite's
 * `SQLITE_LIMIT_VDBE_OP`, a value D1 does not publish), and text over
 * 100 KB fails `SQLITE_TOOBIG`. The refused lines are pinned as measured,
 * not hidden: one that starts to run turns this red, to be moved.
 */

import { env } from "cloudflare:test";
import type { D1Database } from "@cloudflare/workers-types";
import { D1Driver } from "@src/drivers/d1";
import { ForbiddenError, NotFoundError } from "@src/errors";
import { createMigrationClient } from "@src/migrations/client";
import { softDelete } from "@src/soft-delete/index";
import {
  createPermissionsAppClient,
  loadPermissionsSeed,
  type PermissionsAppClient,
} from "@tests/contracts/public-client/permissions-app-behavior";
import { SAMPLED_ACTORS } from "@tests/contracts/public-client/permissions-sampled-actors";
import {
  actionsOf,
  GOVERNED_MODELS,
  TOMBSTONED_MODELS,
} from "@tests/package/fixtures/permissions-app/oracle";
import { schema } from "@tests/package/fixtures/permissions-app/schema";
import { actors, seed } from "@tests/package/fixtures/permissions-app/seed";
import { policy } from "@tests/types/permissions/acceptance-policy";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { RecordingD1 } from "./d1-statements";

declare module "cloudflare:test" {
  interface ProvidedEnv {
    DB: D1Database;
  }
}

/** D1's published limits per statement (plan §2 Y4): provider facts. */
const D1_BOUND_VALUES = 100;
const D1_STATEMENT_BYTES = 100_000;
/** The result code D1 names a refusal by. */
const SQLITE_CODE = /SQLITE_[A-Z]+/;

type Delegate = Record<string, (args?: object) => Promise<unknown>> & {
  can(action: string, where: object): Promise<boolean>;
};
type Governed = Record<string, Delegate> & { $as(actor: unknown): Governed };

const tombstones = softDelete({
  models: Object.fromEntries(
    TOMBSTONED_MODELS.map((model) => [model, { deletedAt: "deletedAt" }])
  ),
});

/** Every relation of a model, one level deep: the widest read of it. */
const everyRelation = (model: string) =>
  Object.fromEntries(
    Object.keys(
      (
        schema[model as keyof typeof schema] as unknown as {
          "~": { state: { relations: Record<string, unknown> } };
        }
      )["~"].state.relations
    ).map((relation) => [relation, true])
  );
const keyOf = (model: string) =>
  model === "teamMember" ? { teamId: true, userId: true } : { id: true };
const firstKey = (model: string) => {
  const [row] = seed[model as keyof typeof seed] as unknown as Record<
    string,
    unknown
  >[];
  return model === "teamMember"
    ? { teamId_userId: { teamId: row!.teamId, userId: row!.userId } }
    : { id: row!.id };
};

describe("D1: W-K2f, every governed statement inside D1's budget", () => {
  const recorder = new RecordingD1(env.DB);
  let base: PermissionsAppClient;
  let db: Governed;

  beforeAll(async () => {
    base = createPermissionsAppClient(
      new D1Driver({ database: recorder.database })
    );
    const preview = await createMigrationClient(base).push({ dryRun: true });
    for (const statement of preview.statements)
      await env.DB.prepare(statement.sql).run();
    await loadPermissionsSeed(base);
    db = policy.methods(
      tombstones.methods(policy.rows(tombstones.rows(base)))
    ) as unknown as Governed;
  }, 900_000);

  afterAll(async () => {
    await base?.$disconnect();
  });

  /** The largest statement by `key`, and the call that issued it. */
  const widest = (
    measured: readonly { origin: string; values: number; bytes: number }[],
    key: "values" | "bytes"
  ) => {
    const top = measured.reduce((a, b) => (b[key] > a[key] ? b : a));
    return { [key]: top[key], [`${key}From`]: top.origin };
  };
  /** The statements `body`'s calls issue, each named by its call. */
  const measure = async (
    body: (
      attempt: (label: string, run: () => Promise<unknown>) => Promise<void>
    ) => Promise<void>
  ) => {
    recorder.statements.length = 0;
    const origins: string[] = [];
    const refused = new Set<string>();
    await body(async (label, run) => {
      const from = recorder.statements.length;
      try {
        await run();
      } catch (error) {
        // Hidden rows are expected. SQL/provider failures must fail this test.
        if (
          !(error instanceof NotFoundError || error instanceof ForbiddenError)
        )
          throw new Error(`Unexpected failure in ${label}`, { cause: error });
        refused.add(label);
      } finally {
        for (let at = from; at < recorder.statements.length; at++)
          origins[at] = label;
      }
    });
    const encoder = new TextEncoder();
    const measured = recorder.statements.map(({ sql, values }, at) => ({
      origin: origins[at]!,
      values: values.length,
      bytes: encoder.encode(sql).length,
    }));
    return {
      measured,
      refused,
      most: {
        statements: measured.length,
        ...widest(measured, "values"),
        ...widest(measured, "bytes"),
      },
    };
  };
  const over = <M extends { values: number; bytes: number }>(
    measured: readonly M[]
  ) =>
    measured.filter(
      (m) => m.values > D1_BOUND_VALUES || m.bytes > D1_STATEMENT_BYTES
    );

  test("§1.1's reads and writes, every action as a mode and through can, and the heaviest writes: at most 100 bound values and 100 KB each", async () => {
    const { measured, most, refused } = await measure(async (attempt) => {
      for (const name of SAMPLED_ACTORS) {
        const actor = actors[name]!;
        const call = db.$as(actor);
        for (const model of GOVERNED_MODELS) {
          const delegate = call[model]!;
          await attempt(`${name} ${model}.findMany`, () =>
            delegate.findMany!()
          );
          await attempt(`${name} ${model}.count`, () => delegate.count!());
          for (const action of actionsOf(model)) {
            await attempt(`${name} ${model}.findMany as ${action}`, () =>
              delegate.findMany!({ as: action, select: keyOf(model) })
            );
            await attempt(`${name} ${model}.can ${action}`, () =>
              delegate.can(action, firstKey(model))
            );
          }
        }
        // §1.1 server.ts, the lines M1 serves ($access and field reads are M2).
        const page = seed.page.find(
          (p) => p.organizationId === actor.organizationId
        )!;
        const group = seed.pageGroup.find(
          (g) => g.organizationId === actor.organizationId
        )!;
        const document = seed.document.find(
          (d) =>
            d.organizationId === actor.organizationId && d.parentId === null
        )!;
        const child = seed.document.find((d) => d.parentId === document.id);
        const team = seed.team.find(
          (t) => t.organizationId === actor.organizationId
        )!;
        const lines: [string, () => Promise<unknown>][] = [
          [
            "page include group",
            () => call.page!.findMany!({ include: { group: true } }),
          ],
          ["page as given", () => call.page!.findMany!({ as: "given" })],
          [
            "page deleted with",
            () => call.page!.findMany!({ deleted: "with" }),
          ],
          [
            "document roots with children",
            () =>
              call.document!.findMany!({
                where: { parentId: null },
                include: { children: true },
              }),
          ],
          [
            "page title",
            () =>
              call.page!.update!({
                where: { id: page.id },
                data: { title: "t" },
              }),
          ],
          [
            "page owner",
            () =>
              call.page!.update!({
                where: { id: page.id },
                data: { ownerId: actor.userId },
              }),
          ],
          [
            "page group",
            () =>
              call.page!.update!({
                where: { id: page.id },
                data: { groupId: group.id },
              }),
          ],
          [
            "page group connect",
            () =>
              call.page!.update!({
                where: { id: page.id },
                data: { group: { connect: { id: group.id } } },
              }),
          ],
          [
            "document archive",
            () =>
              call.document!.update!({
                where: { id: document.id },
                data: { archivedAt: new Date() },
              }),
          ],
          [
            "document move",
            () =>
              call.document!.update!({
                where: { id: document.id },
                data: { parentId: child?.id ?? null },
              }),
          ],
          [
            "document delete as update",
            () =>
              call.document!.delete!({
                where: { id: document.id },
                as: "update",
              }),
          ],
          [
            "team parents connect",
            () =>
              call.team!.update!({
                where: { id: team.id },
                data: { parents: { connect: { id: team.id } } },
              }),
          ],
          ["team can invite", () => call.team!.can("invite", { id: team.id })],
          [
            "organization can export",
            () =>
              call.organization!.can("export", { id: actor.organizationId }),
          ],
          [
            "grant updateMany",
            () => call.accessGrant!.updateMany!({ data: { level: "read" } }),
          ],
          [
            "page updateMany",
            () => call.page!.updateMany!({ data: { title: "t" } }),
          ],
          [
            "document children.create",
            () =>
              call.document!.update!({
                where: { id: document.id },
                data: {
                  children: {
                    create: {
                      id: `budget-${name}`,
                      organizationId: document.organizationId,
                      title: "child",
                      position: 0,
                    },
                  },
                },
              }),
          ],
        ];
        for (const [line, run] of lines) await attempt(`${name} ${line}`, run);
      }
    });
    console.info(
      `W-K2f on D1, §1.1: ${JSON.stringify({ ...most, refused: refused.size })}`
    );
    expect(refused.size).toBeLessThan(measured.length);
    // Named by the call that issued them, so a breach says where it is.
    expect(over(measured)).toEqual([]);
  }, 900_000);

  test("beyond §1.1, measured: every relation of every model included at once (local D1 enforces the text limit: SQLITE_TOOBIG)", async () => {
    const { measured, most } = await measure(async (attempt) => {
      for (const name of SAMPLED_ACTORS) {
        const call = db.$as(actors[name]!);
        for (const model of GOVERNED_MODELS)
          await attempt(`${name} ${model} include every relation`, () =>
            call[model]!.findMany!({ include: everyRelation(model) })
          );
      }
    });
    const breaches = [
      ...new Set(over(measured).map((m) => m.origin.split(" ")[1])),
    ];
    console.info(
      `W-K2f on D1, every relation: ${JSON.stringify({ ...most, breaches })}`
    );
    expect(most["values"]).toBeLessThanOrEqual(D1_BOUND_VALUES);
    // Local workerd refuses text over 100 KB as D1 does (review 2, COST-7).
    expect(most["bytes"]).toBeLessThanOrEqual(D1_STATEMENT_BYTES);
  }, 900_000);

  test("$access, measured (review 2, COST-3): the reads D1 runs stay inside 100 bound values and 100 KB; the ones it refuses are named by their limit", async () => {
    const call = db.$as(actors.u02!);
    const withEvidence = (model: string) =>
      Object.fromEntries(
        Object.keys(everyRelation(model)).map((relation) => [
          relation,
          { include: { $access: true } },
        ])
      );
    const lines: [string, () => Promise<unknown>][] = [
      [
        "accessGrant $access",
        () => call.accessGrant!.findMany!({ include: { $access: true } }),
      ],
      [
        "page $access",
        () => call.page!.findMany!({ include: { $access: true } }),
      ],
      [
        "page $access, group $access",
        () =>
          call.page!.findMany!({
            include: { $access: true, group: { include: { $access: true } } },
          }),
      ],
      [
        "document $access",
        () => call.document!.findMany!({ include: { $access: true } }),
      ],
      [
        "document roots $access at three depths",
        () =>
          call.document!.findMany!({
            where: { parentId: null },
            include: {
              $access: true,
              children: {
                include: {
                  $access: true,
                  children: { include: { $access: true } },
                },
              },
            },
          }),
      ],
      [
        "document roots $access at three depths, with grants",
        () =>
          call.document!.findMany!({
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
          }),
      ],
      [
        "document every relation + $access",
        () =>
          call.document!.findMany!({
            include: { $access: true, ...withEvidence("document") },
          }),
      ],
      [
        "page $access at three depths through group and grants",
        () =>
          call.page!.findMany!({
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
                include: {
                  $access: true,
                  page: { include: { $access: true } },
                },
              },
            },
          }),
      ],
      [
        "accessGrant every relation + $access",
        () =>
          call.accessGrant!.findMany!({
            include: { $access: true, ...withEvidence("accessGrant") },
          }),
      ],
    ];
    const encoder = new TextEncoder();
    const outcomes: Record<string, string> = {};
    const sizes: Record<string, { bytes: number; values: number }> = {};
    for (const [line, run] of lines) {
      recorder.statements.length = 0;
      let refused = false;
      try {
        await run();
      } catch {
        refused = true;
      }
      const widestStatement = recorder.statements.reduce((a, b) =>
        encoder.encode(b.sql).length > encoder.encode(a.sql).length ? b : a
      );
      sizes[line] = {
        bytes: encoder.encode(widestStatement.sql).length,
        values: widestStatement.values.length,
      };
      if (!refused) {
        outcomes[line] = "runs";
        expect(
          over(
            recorder.statements.map((statement) => ({
              values: statement.values.length,
              bytes: encoder.encode(statement.sql).length,
            }))
          )
        ).toEqual([]);
        continue;
      }
      // The driver redacts D1's reason: the binding names it.
      const last = recorder.statements.at(-1)!;
      try {
        await env.DB.prepare(last.sql)
          .bind(...last.values)
          .all();
        outcomes[line] = "refused, and runs alone";
      } catch (error) {
        const limit = SQLITE_CODE.exec((error as Error).message);
        outcomes[line] = `refused: ${limit?.[0] ?? (error as Error).message}`;
      }
    }
    console.info(
      `W-K2f on D1, $access (u02): ${JSON.stringify({ outcomes, sizes })}`
    );
    expect(outcomes).toEqual({
      "accessGrant $access": "runs",
      "page $access": "runs",
      "page $access, group $access": "runs",
      "document $access": "runs",
      "document roots $access at three depths": "runs",
      // Measured (u02) at 1.3.3: 89,678 B and 84,796 B, under the text
      // limit since the 1.3.3 merged quantifiers and projection trims (they
      // were 106,197 B and 100,850 B, refused SQLITE_TOOBIG), so the program
      // D1 compiles is what refuses them now.
      "document roots $access at three depths, with grants":
        "refused: SQLITE_NOMEM",
      "document every relation + $access": "refused: SQLITE_NOMEM",
      // 75,514 B and 68,874 B at 1.3.3 (83,620 and 76,878 before; 82,780 and
      // 76,038 at 9c50a3191): inside the published limits, refused for the
      // program D1 compiles.
      "page $access at three depths through group and grants":
        "refused: SQLITE_NOMEM",
      "accessGrant every relation + $access": "refused: SQLITE_NOMEM",
    });
  }, 900_000);
});
