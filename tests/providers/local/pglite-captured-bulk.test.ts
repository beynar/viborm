/**
 * PGlite provider suite — a root selected bulk mutation over a captured set,
 * on both of its routes.
 *
 * `OperationContext.capturedMutation` is the one owner of a captured
 * UPDATE/DELETE: the premises the captured set owes, the statement, and the
 * comparison of the row count it affected with the identities it captured,
 * which turns a shortfall into the verb's registered cardinality sentence.
 * Every cell here runs on PostgreSQL semantics, credential-free, on both
 * routes that judgement has: the INTERACTIVE one (a PGlite transaction, the
 * capture taken `FOR UPDATE`) and the ATOMIC-BATCH one (the pglite lane's
 * `atomicBatch` driver, `BatchOnlyPGliteDriver`, where the premises ride the
 * mutation's own batch). RETURNING is switched off on the driver's own
 * adapter, the provider profile on which a selected bulk mutation must capture
 * the rows it writes (as `tests/providers/docker/pg-captured-set-concurrency`
 * does on native PostgreSQL).
 *
 * The mismatch cells apply their drift from the statement hook, on the
 * operation's OWN connection, immediately before the write: after every
 * premise has answered and before the effect they stand in front of. It is
 * the position, not a concurrent writer — the multi-connection measurement is
 * the docker suite's.
 */

import { createClient } from "@client/client";
import type { QueryExecutionContext, QueryResult } from "@drivers";
import { PGliteDriver } from "@drivers/pglite";
import type { PGlite, Transaction } from "@electric-sql/pglite";
import { s } from "@schema";
import { BatchOnlyPGliteDriver } from "@tests/fixtures/drivers/pglite";
import { openTestPGlite } from "@tests/fixtures/pglite-lifecycle";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import { afterEach, describe, expect, test } from "vitest";

const note = s
  .model({
    id: s.string().id(),
    label: s.string(),
    active: s.boolean(),
  })
  .map("pgcap_notes");
const schema = { note };

/** The write a captured bulk mutation issues against the seeded table. */
const WRITE = /^(?:UPDATE|DELETE)\b[^;]*"pgcap_notes"/;
/** n1 stops matching `active: true` after the premises, before the write. */
const DRIFT = `UPDATE "pgcap_notes" SET "active" = false WHERE "id" = 'n1'`;

const CHANGED = (verb: string) =>
  `${verb} selected-row cardinality changed during its locked mutation.`;

interface Drifting {
  readonly statements: string[];
  drifted: boolean;
  driftBeforeWrite(): void;
}

class InteractiveCapturingPGlite extends PGliteDriver implements Drifting {
  readonly statements: string[] = [];
  drifted = false;
  private armed = false;

  constructor(database: PGlite) {
    super({ client: database });
    this.adapter.capabilities.supportsReturning = false;
  }

  driftBeforeWrite(): void {
    this.armed = true;
  }

  protected override async execute<T>(
    client: PGlite | Transaction,
    sql: string,
    params: unknown[],
    context?: QueryExecutionContext
  ): Promise<QueryResult<T>> {
    this.statements.push(sql);
    if (this.armed && WRITE.test(sql)) {
      this.armed = false;
      this.drifted = true;
      await client.query(DRIFT);
    }
    return await super.execute<T>(client, sql, params, context);
  }
}

class BatchCapturingPGlite extends BatchOnlyPGliteDriver implements Drifting {
  readonly statements: string[] = [];
  drifted = false;
  private armed = false;

  constructor(database: PGlite) {
    super({ client: database });
    this.adapter.capabilities.supportsReturning = false;
  }

  driftBeforeWrite(): void {
    this.armed = true;
  }

  protected override async execute<T>(
    client: PGlite | Transaction,
    sql: string,
    params: unknown[],
    context?: QueryExecutionContext
  ): Promise<QueryResult<T>> {
    this.statements.push(sql);
    if (this.armed && WRITE.test(sql)) {
      this.armed = false;
      this.drifted = true;
      await client.query(DRIFT);
    }
    return await super.execute<T>(client, sql, params, context);
  }
}

type Route = "interactive" | "atomicBatch";

const ROUTES: readonly Route[] = ["interactive", "atomicBatch"];

const settle = async <T>(
  run: () => PromiseLike<T>
): Promise<{ error?: unknown; value?: T }> =>
  await Promise.resolve(run()).then(
    (value) => ({ value }),
    (error: unknown) => ({ error })
  );

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

interface Progress {
  readonly atomicity?: string;
  readonly phase?: string;
  readonly committedSegments?: number;
}

const progressOf = (error: unknown): Progress | undefined =>
  (error as { meta?: { recordSeriesProgress?: Progress } } | undefined)?.meta
    ?.recordSeriesProgress;

describe("PGlite captured selected bulk mutations", () => {
  let disconnect: (() => Promise<void>) | undefined;

  afterEach(async () => {
    await disconnect?.();
    disconnect = undefined;
  });

  async function world(route: Route) {
    const database = openTestPGlite();
    const driver =
      route === "interactive"
        ? new InteractiveCapturingPGlite(database)
        : new BatchCapturingPGlite(database);
    const client = createClient({ schema, driver });
    disconnect = () => client.$disconnect();
    await syncLiveSchema(client);
    for (const seed of [
      { id: "n1", label: "one", active: true },
      { id: "n2", label: "two", active: true },
      { id: "n3", label: "three", active: false },
    ])
      await client.note.create({ data: seed });
    driver.statements.length = 0;
    const rows = async () =>
      (await client.note.findMany({ orderBy: { id: "asc" } })).map((row) => [
        row.id,
        row.label,
        row.active,
      ]);
    return { client, driver: driver satisfies Drifting, rows };
  }

  for (const route of ROUTES) {
    test(`${route}: a captured updateMany writes and publishes every captured row`, async () => {
      const { client: current, driver, rows } = await world(route);
      const updated = await current.note.updateMany({
        where: { active: true },
        data: { label: "renamed" },
        select: { id: true, label: true },
      });

      expect(updated).toEqual([
        { id: "n1", label: "renamed" },
        { id: "n2", label: "renamed" },
      ]);
      expect(driver.statements.some((sql) => WRITE.test(sql))).toBe(true);
      expect(await rows()).toEqual([
        ["n1", "renamed", true],
        ["n2", "renamed", true],
        ["n3", "three", false],
      ]);
    });

    test(`${route}: a captured deleteMany removes and publishes every captured row`, async () => {
      const { client: current, rows } = await world(route);
      const deleted = await current.note.deleteMany({
        where: { active: true },
        select: { id: true, label: true },
      });

      expect(deleted).toEqual([
        { id: "n1", label: "one" },
        { id: "n2", label: "two" },
      ]);
      expect(await rows()).toEqual([["n3", "three", false]]);
    });

    for (const verb of ["updateMany", "deleteMany"] as const) {
      test(`${route}: a captured row that stops matching before the ${verb} write is answered by the cardinality sentence`, async () => {
        const { client: current, driver, rows } = await world(route);
        driver.driftBeforeWrite();

        const outcome = await settle(() =>
          verb === "updateMany"
            ? current.note.updateMany({
                where: { active: true },
                data: { label: "renamed" },
                select: { id: true, label: true },
              })
            : current.note.deleteMany({
                where: { active: true },
                select: { id: true, label: true },
              })
        );

        expect(driver.drifted).toBe(true);
        expect(outcome.value).toBeUndefined();
        expect(messageOf(outcome.error)).toContain(CHANGED(verb));
        if (route === "interactive") {
          // The capture and its write are one region: the whole unit, drift
          // included, rolls back at its owner.
          expect(progressOf(outcome.error)).toBeUndefined();
          expect(await rows()).toEqual([
            ["n1", "one", true],
            ["n2", "two", true],
            ["n3", "three", false],
          ]);
          return;
        }
        // The batch already acknowledged: what it committed stands, and the
        // RESULT-phase failure says so. The row that stopped matching was
        // left alone by the write's own selector (D-65).
        expect(progressOf(outcome.error)).toMatchObject({
          atomicity: "segment",
          phase: "result",
          committedSegments: 1,
        });
        expect(await rows()).toEqual(
          verb === "updateMany"
            ? [
                ["n1", "one", false],
                ["n2", "renamed", true],
                ["n3", "three", false],
              ]
            : [
                ["n1", "one", false],
                ["n3", "three", false],
              ]
        );
      });
    }
  }
});
