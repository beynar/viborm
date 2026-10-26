/**
 * The migration commands on a PlanetScale Neki router that enforces
 * `checkTaint` (Pyxel's production branch, 2026-10-26): once a transaction
 * changed the schema, no statement is planned against any relation, and
 * VibORM's own ledger and marker writes are refused (`NK013`, "[817] Planning
 * against relation public._viborm_migration_log is unavailable: earlier DDL
 * in this transaction is not reflected in the router's schema view"). Its
 * `reset()` ran its drops, then wrote its ledger row in the same transaction,
 * and failed there every time; the `pre-prod` branch's router did not refuse.
 *
 * On Neki every migration statement now commits alone and the control writes
 * run in their own; a reset stopped part way resumes from its stored plan.
 */

import { createClient } from "@drivers/pglite";
import { VibORMErrorCode } from "@errors";
import { createMigrationClient, MemoryEstateStorage } from "@migrations";
import { s } from "@schema";
import { sql } from "@sql";
import { asNeki } from "@tests/fixtures/neki-simulation";
import { openTestPGlite } from "@tests/fixtures/pglite-lifecycle";
import { beforeAll, describe, expect, it } from "vitest";

const database = openTestPGlite();
const simulation = asNeki(database);

const retired = {
  document: s
    .model({ id: s.string().id(), title: s.string(), body: s.string() })
    .map("document"),
  note: s
    .model({ id: s.string().id(), text: s.string(), documentId: s.string() })
    .index(["documentId"])
    .map("note"),
};
const fresh = (stage: number) => ({
  account: s
    .model({
      id: s.string().id(),
      email: s.string().unique(),
      role: s.enum(["member", "admin"]).default("member").map("account_role"),
      ...(stage >= 1 ? { nickname: s.string().nullable() } : {}),
    })
    .map("account"),
  component: s
    .model({ id: s.string().id(), kind: s.string() })
    .index(["kind"])
    .map("component"),
});

const tables = async (namespace: string) =>
  (
    await database.query<{ name: string }>(
      "SELECT tablename AS name FROM pg_catalog.pg_tables WHERE schemaname = $1 AND tablename NOT LIKE '\\_viborm%' ORDER BY 1",
      [namespace]
    )
  ).rows.map((row) => row.name);

const BEGIN = /^\s*BEGIN\b/i;
const RESET_STEP = /^reset-/;

/** The transactions the log opened: on Neki none. */
const transactions = () =>
  simulation.log.filter((text) => BEGIN.test(text)).length;

/** A database on the retired history, its rows, and the fresh history. */
async function retiredDatabase(namespace: string) {
  await database.exec(`CREATE SCHEMA "${namespace}"`);
  const old = createMigrationClient(
    createClient({ client: database, schema: retired, namespace }),
    { storage: new MemoryEstateStorage() }
  );
  await old.generate({ name: "retired" });
  await old.apply();
  await database.exec(
    `INSERT INTO "${namespace}"."document" VALUES ('d1', 't', 'b'); INSERT INTO "${namespace}"."note" VALUES ('n1', 'x', 'd1')`
  );
  const storage = new MemoryEstateStorage();
  const at = (stage: number) =>
    createMigrationClient(
      createClient({ client: database, schema: fresh(stage), namespace }),
      { storage }
    );
  const root = (await at(0).generate({ name: "fresh-root" })).stateId!;
  return { at, root };
}

describe("migration commands on a Neki router that enforces checkTaint", () => {
  beforeAll(() => {
    simulation.enabled = true;
    simulation.taint = true;
  });

  it("resets a database on a retired history: drops and replay commit alone, the ledger in its own", async () => {
    const namespace = "taint_reset";
    const { at, root } = await retiredDatabase(namespace);
    expect((await at(0).status()).markerState).toBe("unknown");

    simulation.log.length = 0;
    await expect(at(0).reset()).resolves.toEqual({
      preview: false,
      path: [root],
    });
    expect(simulation.refusals).toEqual([]);
    expect(transactions()).toBe(0);
    expect(await tables(namespace)).toEqual(["account", "component"]);
    const status = await at(0).status();
    expect(status.marker?.stateId).toBe(root);
    expect(status.unfinished).toBe(false);
    await expect(at(0).verify()).resolves.toEqual({ ok: true });
  });

  it.each([
    ["its clear", 'DROP TABLE IF EXISTS "taint_resume_clear"."note"'],
    ["its replay", 'CREATE TABLE "taint_resume_replay"."component"'],
  ])("resumes a reset stopped in %s from its stored plan", async (_label, fail) => {
    const namespace = fail.includes("_clear")
      ? "taint_resume_clear"
      : "taint_resume_replay";
    const { at, root } = await retiredDatabase(namespace);

    simulation.fail = fail;
    await expect(at(0).reset()).rejects.toMatchObject({
      code: VibORMErrorCode.MIGRATION_FAILED,
      // On Neki the clear runs stepwise too, and says so.
      meta: {
        step: expect.stringMatching(RESET_STEP),
        stateId: root,
        strategy: "stepwise",
      },
    });
    simulation.fail = undefined;
    const stopped = await at(0).status();
    expect(stopped.unfinished).toBe(true);
    // Other commands see the reset's open attempt.
    await expect(at(0).apply()).rejects.toMatchObject({
      code: VibORMErrorCode.MIGRATION_UNFINISHED_ATTEMPT,
    });

    await expect(at(0).reset()).resolves.toEqual({
      preview: false,
      path: [root],
    });
    expect(simulation.refusals).toEqual([]);
    expect(await tables(namespace)).toEqual(["account", "component"]);
    const done = await at(0).status();
    expect(done.marker?.stateId).toBe(root);
    expect(done.unfinished).toBe(false);
    await expect(at(0).verify()).resolves.toEqual({ ok: true });
  });

  it("an apply stopped at a generated statement is finished by resolve({ outcome: 'retry' })", async () => {
    const namespace = "taint_retry";
    const { at } = await retiredDatabase(namespace);
    await at(0).reset();
    const next = (await at(1).generate({ name: "nickname" })).stateId!;
    simulation.fail = 'ADD COLUMN "nickname"';
    await expect(at(1).apply()).rejects.toMatchObject({
      code: VibORMErrorCode.MIGRATION_FAILED,
      meta: { step: "apply", stateId: next, strategy: "stepwise" },
    });
    simulation.fail = undefined;
    expect((await at(1).status()).unfinished).toBe(true);
    // The open attempt blocks ordinary work until it is resolved.
    await expect(at(1).apply()).rejects.toMatchObject({
      code: VibORMErrorCode.MIGRATION_UNFINISHED_ATTEMPT,
    });
    await expect(at(1).resolve({ outcome: "retry" })).resolves.toEqual({
      outcome: "retry",
    });
    const done = await at(1).status();
    expect(done.marker?.stateId).toBe(next);
    expect(done.unfinished).toBe(false);
    await expect(at(1).verify()).resolves.toEqual({ ok: true });
    expect(simulation.refusals).toEqual([]);
  });

  it("applies and rolls back states under the same router, no transaction opened", async () => {
    const namespace = "taint_apply";
    const { at, root } = await retiredDatabase(namespace);
    await at(0).reset();
    const next = (await at(1).generate({ name: "nickname" })).stateId!;

    simulation.log.length = 0;
    await expect(at(1).apply()).resolves.toMatchObject({
      outcome: "applied",
      path: [next],
    });
    expect(transactions()).toBe(0);
    await expect(at(1).verify()).resolves.toEqual({ ok: true });
    await at(1).down({
      resolve: (change) =>
        change.type === "destructive" &&
        change.operation === "dropColumn" &&
        change.column === "nickname"
          ? change.proceed()
          : change.reject(),
    });
    expect((await at(0).status()).marker?.stateId).toBe(root);
    expect(simulation.refusals).toEqual([]);
  });

  it("rolls back a state whose manual rollback adds a column, then fills it: the preflight lets a commit come between them", async () => {
    // Before, down's preflight refused it (V11021) as if one transaction ran it.
    const namespace = "taint_down";
    await database.exec(`CREATE SCHEMA "${namespace}"`);
    const table = `"${namespace}"."person"`;
    const person = (legacy: boolean) => ({
      person: s
        .model({
          id: s.string().id(),
          email: s.string(),
          ...(legacy ? { oldEmail: s.string().nullable() } : {}),
        })
        .map("person"),
    });
    const storage = new MemoryEstateStorage();
    const at = (legacy: boolean) =>
      createMigrationClient(
        createClient({ client: database, schema: person(legacy), namespace }),
        { storage }
      );
    const v1 = (await at(true).generate({ name: "with-old-email" })).stateId!;
    await at(true).apply();
    await database.exec(
      `INSERT INTO ${table} ("id", "email") VALUES ('p1', 'a@b')`
    );
    await at(false).generate({
      name: "drop-old-email",
      manualMigration: {
        transitions: [
          {
            from: v1,
            execution: "transactional",
            up: [sql.raw(`ALTER TABLE ${table} DROP COLUMN "oldEmail"`)],
            rollback: {
              kind: "manual",
              execution: "transactional",
              sql: [
                sql.raw(`ALTER TABLE ${table} ADD COLUMN "oldEmail" text`),
                sql.raw(`UPDATE ${table} SET "oldEmail" = "email"`),
              ],
            },
          },
        ],
      },
    });
    await at(false).apply();

    await expect(at(false).down()).resolves.toBeDefined();
    expect((await at(true).status()).marker?.stateId).toBe(v1);
    const { rows } = await database.query<{ old: string }>(
      `SELECT "oldEmail" AS old FROM ${table}`
    );
    expect(rows).toEqual([{ old: "a@b" }]);
    expect(simulation.refusals).toEqual([]);
  });
});
