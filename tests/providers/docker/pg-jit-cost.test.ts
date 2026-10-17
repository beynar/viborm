/**
 * The one PostgreSQL JIT cost witness (E5.5). Every other Docker PG suite
 * connects with JIT off (`pg-fixtures.ts`): a governed statement is
 * estimated over the server's JIT thresholds on tables nobody ANALYZEd, and
 * the server then compiles thousands of functions before it runs it (E4,
 * `permissions/e4/pg-cost.md`). This file keeps that cost visible on the server's
 * own configuration: one governed read, the §1.1 grant read of a session
 * actor through `viborm/permissions`, run with the server's `jit` and with JIT off.
 *
 * It asserts the two answers are one and records the durations and the
 * JIT work the server reports; it asserts no time bound, the duration being
 * the server's and the machine's. The drivers set nothing: a deployment on a
 * default-configured server pays this, and the guide says how to turn it off.
 *
 * NOTE: requires a running PostgreSQL database (PG_TEST_CONNECTION_STRING).
 */

import { randomBytes } from "node:crypto";
import { PgDriver } from "@drivers/pg";
import { softDelete } from "@src/soft-delete/index";
import {
  createPermissionsAppClient,
  loadPermissionsSeed,
} from "@tests/contracts/public-client/permissions-app-behavior";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import { actors } from "@tests/package/fixtures/permissions-app/seed";
import { policy } from "@tests/types/permissions/acceptance-policy";
import pg from "pg";
import { afterAll, describe, expect, test } from "vitest";
import {
  SERVER_CONNECTION_STRING,
  TEST_CONNECTION_STRING,
} from "./pg-fixtures";

const describeIf = SERVER_CONNECTION_STRING ? describe : describe.skip;
const namespace = `viborm_permissions_jit_${randomBytes(5).toString("hex")}`;
const TIMEOUT = 600_000;

async function on<T>(
  url: string,
  run: (client: pg.Client) => Promise<T>
): Promise<T> {
  const connection = new pg.Client({ connectionString: url });
  await connection.connect();
  try {
    return await run(connection);
  } finally {
    await connection.end();
  }
}

const tombstones = softDelete({
  models: Object.fromEntries(
    ["page", "member", "teamMember", "accessGrant"].map((model) => [
      model,
      { deletedAt: "deletedAt" },
    ])
  ),
});

/** The governed client over `url`, and the statements it sends. */
function governed(url: string) {
  const statements: { text: string; values: unknown[] }[] = [];
  const base = createPermissionsAppClient(
    new PgDriver({ databaseUrl: url, namespace })
  );
  const recorded = base.$extends({
    name: "statements",
    statement(context) {
      statements.push({
        text: context.statement.toStatement("$n"),
        values: context.statement.values,
      });
      return context.statement;
    },
  });
  const db = policy.methods(
    tombstones.methods(policy.rows(tombstones.rows(recorded)))
  );
  return { base, db, statements };
}

describeIf("pg: the cost of PostgreSQL's JIT on a governed statement", () => {
  afterAll(async () => {
    await on(TEST_CONNECTION_STRING!, (c) =>
      c.query(`DROP SCHEMA IF EXISTS "${namespace}" CASCADE`)
    );
  }, TIMEOUT);

  test(
    "the grant read of a session actor: one answer with the server's JIT and without it, its cost recorded",
    async () => {
      await on(TEST_CONNECTION_STRING!, (c) =>
        c.query(`CREATE SCHEMA "${namespace}"`)
      );
      const seeding = createPermissionsAppClient(
        new PgDriver({ databaseUrl: TEST_CONNECTION_STRING!, namespace })
      );
      await syncLiveSchema(seeding);
      await loadPermissionsSeed(seeding);
      await seeding.$disconnect();

      const actor = actors.u02!;
      const answers: unknown[] = [];
      const durations: number[] = [];
      let statement: { text: string; values: unknown[] } | undefined;
      for (const url of [SERVER_CONNECTION_STRING!, TEST_CONNECTION_STRING!]) {
        const { base, db, statements } = governed(url);
        try {
          const started = performance.now();
          answers.push(await db.$as(actor).accessGrant.findMany());
          durations.push(performance.now() - started);
          statement ??= statements.at(-1);
        } finally {
          await base.$disconnect();
        }
      }
      expect(answers[0]).toEqual(answers[1]);
      expect(statement).toBeDefined();

      // What the server did with its own setting: its JIT work, as reported.
      const plan = await on(SERVER_CONNECTION_STRING!, async (c) => {
        const { rows } = await c.query(
          `EXPLAIN (ANALYZE, FORMAT JSON) ${statement!.text}`,
          statement!.values
        );
        return rows[0]["QUERY PLAN"][0] as {
          "Execution Time": number;
          JIT?: { Functions: number; Timing: { Total: number } };
        };
      });
      const jit = await on(SERVER_CONNECTION_STRING!, async (c) => {
        const { rows } = await c.query("SHOW jit");
        return rows[0].jit as string;
      });
      // The record this witness exists for.
      console.info(
        `pg JIT cost (server jit=${jit}): grant read ${durations[0]!.toFixed(0)} ms, ` +
          `with JIT off ${durations[1]!.toFixed(0)} ms; EXPLAIN ANALYZE ` +
          `${plan["Execution Time"].toFixed(0)} ms, ` +
          (plan.JIT
            ? `${plan.JIT.Functions} functions JIT-compiled in ${plan.JIT.Timing.Total.toFixed(0)} ms`
            : "no JIT")
      );
    },
    TIMEOUT
  );
});
