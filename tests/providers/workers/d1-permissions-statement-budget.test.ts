/**
 * D1 Driver Tests — W-K2f (plan §4.2, §8 "D1 per statement", M1 exit): every
 * statement `viborm/permissions` issues for §1.1's reads and writes stays inside
 * D1's budget, 100 bound values and 100 KB of text. The statements are read
 * off the D1 binding (`d1-statements.ts`), not from the engine: the values
 * the driver binds and the text it prepares, for the sampled actors, on
 * every governed model, with every relation included, at every action as a
 * mode and through `can`, and the heaviest writes (a grant `updateMany`,
 * edits and archives, a nested create under a document). D1 itself refuses a
 * statement over its limits; this pins the margin and reports it. `$access`
 * is M2's and is not in this corpus.
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

  test("beyond §1.1, measured: every relation of every model included at once (local D1 does not enforce the text limit)", async () => {
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
  }, 900_000);
});
