/**
 * `down` lets the migration lock go while its resolver answers (an operator
 * reading a prompt), then takes it again for the rollback. Another command can
 * run in that gap: a deploy's stepwise `apply` that fails leaves its attempt
 * open and the marker where it was. `down` must see that attempt when it takes
 * the lock again, and run nothing: dropping the tables under it would leave an
 * attempt whose origin no longer exists, which no command can settle.
 *
 * NOTE: requires a running PostgreSQL database (PG_TEST_CONNECTION_STRING).
 */

import { createClient } from "@drivers/pg";
import { VibORMErrorCode } from "@errors";
import { createMigrationClient } from "@migrations";
import { MemoryEstateStorage } from "@migrations/storage/memory";
import { s } from "@schema";
import { sql } from "@sql";
import { Pool } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { TEST_CONNECTION_STRING } from "./pg-fixtures";

const describeIf = TEST_CONNECTION_STRING ? describe : describe.skip;

const NAMESPACE = "viborm_down_resolver_gap";
const ROWS = 10_000;

const account = () =>
  s
    .model({
      id: s.string().id(),
      email: s.string().unique(),
      name: s.string(),
      balance: s.int().default(0),
      createdAt: s.dateTime().now(),
    })
    .map("account");
const note = (unique: boolean) =>
  s
    .model({
      id: s.string().id(),
      accountId: s.string(),
      body: unique ? s.string().unique() : s.string(),
      createdAt: s.dateTime().now(),
    })
    .map("note");

const indexExists = (exists: boolean) =>
  ({
    kind: "trusted-read",
    query: sql.raw(
      `SELECT ${exists ? "" : "NOT "}EXISTS (SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = '${NAMESPACE}' AND c.relname = 'note_body_key') AS ok`
    ),
    equals: true,
  }) as const;

describeIf("down after its resolver let the lock go (PostgreSQL)", () => {
  const pool = new Pool({ connectionString: TEST_CONNECTION_STRING });
  const clients: { $disconnect(): Promise<void> }[] = [];
  afterAll(async () => {
    for (const client of clients) await client.$disconnect();
    await pool.query(`DROP SCHEMA IF EXISTS "${NAMESPACE}" CASCADE`);
    await pool.end();
  });

  it("refuses an attempt another command left open meanwhile, and runs nothing", async () => {
    await pool.query(`DROP SCHEMA IF EXISTS "${NAMESPACE}" CASCADE`);
    await pool.query(`CREATE SCHEMA "${NAMESPACE}"`);
    const storage = new MemoryEstateStorage();
    const migrationsFor = (schema: Record<string, unknown>) => {
      const client = createClient({
        databaseUrl: TEST_CONNECTION_STRING,
        namespace: NAMESPACE,
        schema: schema as never,
      });
      clients.push(client);
      return createMigrationClient(client, { storage });
    };
    const v1 = migrationsFor({ account: account() });
    await v1.generate({ name: "v1" });
    await v1.apply();
    const operator = migrationsFor({ account: account(), note: note(false) });
    const v2 = (await operator.generate({ name: "v2" })).stateId;
    await operator.apply();
    // Ten thousand notes, many with the same body.
    await pool.query(
      `INSERT INTO "${NAMESPACE}"."note" ("id", "accountId", "body")
       SELECT 'note-' || g, 'acct-' || (g % 100), 'body-' || (g % 1000)
       FROM generate_series(1, ${ROWS}) g`
    );
    // A deploy's low-lock step: a unique index built CONCURRENTLY, which the
    // duplicates refuse after it began, leaving its attempt open.
    const deploy = migrationsFor({ account: account(), note: note(true) });
    await deploy.generate({
      name: "v3",
      manualMigration: {
        transitions: [
          {
            from: v2,
            execution: "stepwise",
            originChecks: [indexExists(false)],
            up: [
              sql.raw(
                `CREATE UNIQUE INDEX CONCURRENTLY "note_body_key" ON "${NAMESPACE}"."note" ("body")`
              ),
            ],
            rollback: { kind: "irreversible", reason: "the index stays" },
          },
        ],
        destinationChecks: [indexExists(true)],
      },
    });
    const notes = async () =>
      Number(
        (
          await pool.query<{ n: number }>(
            `SELECT count(*)::int AS n FROM "${NAMESPACE}"."note"`
          )
        ).rows[0]?.n
      );

    const deployed: unknown[] = [];
    const down = operator.down({
      steps: 1,
      resolve: async (change) => {
        deployed.push(
          await deploy.apply().catch((failure: unknown) => failure)
        );
        return change.type === "destructive" ? change.proceed() : undefined;
      },
    });

    await expect(down).rejects.toMatchObject({
      code: VibORMErrorCode.MIGRATION_MARKER_CONFLICT,
    });
    expect(deployed).toEqual([
      expect.objectContaining({
        code: VibORMErrorCode.MIGRATION_AMBIGUOUS_COMMIT,
      }),
    ]);
    expect(await notes()).toBe(ROWS);
    const status = await operator.status();
    expect(status.marker?.stateId).toBe(v2);
    expect(status.unfinished).toBe(true);

    // Not wedged: the deploy's attempt resolves, and down runs again.
    await expect(deploy.resolve({ outcome: "rolled-back" })).resolves.toEqual({
      outcome: "rolled-back",
    });
    await expect(
      operator.down({
        steps: 1,
        resolve: (change) =>
          change.type === "destructive" ? change.proceed() : undefined,
      })
    ).resolves.toMatchObject({ path: [v2], preview: false });
    expect((await operator.status()).unfinished).toBe(false);
  }, 60_000);
});
