// S4 step 4 (do-06): apply starts again when there is no marker and the
// ledger holds only closed attempts.
// Gate route (chosen so that S4 step 3's resolve guard cannot apply): a
// stepwise FIRST migration whose origin check fails AFTER `started` was
// written and BEFORE any dispatch ran, so the attempt has no step at all,
// opaque or proven. The cause is fixed (the seed table is created), the
// attempt is closed with resolve({ outcome: "rolled-back" }) unless the
// implementation already closed it (S3 step 4's `failed` event), and apply
// runs again. The client is scoped to `account`, so the unmanaged seed table
// does not trip the separate empty-target V11009. 1.1.0 refuses the second
// apply with V11009 "Migration ledger history exists without a current marker".
// Run on PGlite: 1.2.0 refuses stepwise work on SQLite outright (plan S5), so a
// first attempt left open by a stepwise failure exists only on PostgreSQL and
// MySQL. (A failed transactional first attempt closes itself with S3's
// `failed` event; the same restart covers it.)
import { PGlite } from "@electric-sql/pglite";
import { s, sql } from "viborm";
import { createMigrationClient, MemoryEstateStorage } from "viborm/migrations";
import { createClient } from "viborm/pglite";

export const meta = {
  id: "S4-apply-restart",
  title:
    "apply starts again after a rolled-back first attempt (no V11009 dead end)",
  plan: "phase-1/lane-O/S4",
  needs: [],
  source:
    "migrations-durable-objects-review-2026-10-09/lanes/durable-objects.md (do-06); src/migrations/control.ts:135-146; apply-v1.ts:286-315",
};

const exists = (table) => ({
  kind: "trusted-read",
  query: sql.raw(`SELECT to_regclass('"${table}"') IS NOT NULL AS ok`),
  equals: true,
});

const failure = (error) =>
  `${error.code} ${String(error.message).split("\n")[0].slice(0, 90)}`;

export default async function probe() {
  const pg = new PGlite();
  const client = createClient({
    client: pg,
    schema: { account: s.model({ id: s.string().id(), balance: s.int() }) },
  });
  try {
    const migrations = createMigrationClient(client, {
      storage: new MemoryEstateStorage(),
      tables: ["account"],
    });
    await migrations.generate({
      name: "first",
      manualMigration: {
        transitions: [
          {
            from: null,
            execution: "stepwise",
            originChecks: [exists("seed_source")],
            up: [
              sql.raw(
                `CREATE TABLE "account" ("id" TEXT NOT NULL, "balance" INTEGER NOT NULL, CONSTRAINT "account_pkey" PRIMARY KEY ("id"))`
              ),
              sql.raw(
                `INSERT INTO "account" ("id", "balance") SELECT "id", 0 FROM "seed_source"`
              ),
            ],
            rollback: {
              kind: "manual",
              execution: "stepwise",
              sql: [sql.raw(`DROP TABLE IF EXISTS "account"`)],
            },
          },
        ],
        destinationChecks: [exists("account")],
      },
    });
    let first = "applied";
    try {
      await migrations.apply();
    } catch (error) {
      first = failure(error);
    }
    const ledger = (await migrations.log())
      .map((event) => `${event.kind}:${event.effectState}`)
      .sort()
      .join(",");
    await pg.exec(`CREATE TABLE "seed_source" ("id" TEXT)`);
    await pg.exec(`INSERT INTO "seed_source" ("id") VALUES ('a'), ('b')`);
    let close = "already closed";
    if ((await migrations.status()).unfinished) {
      try {
        await migrations.resolve({ outcome: "rolled-back" });
        close = "resolve rolled-back";
      } catch (error) {
        close = `resolve refused ${failure(error)}`;
      }
    }
    let again;
    try {
      again = (await migrations.apply()).outcome;
    } catch (error) {
      again = failure(error);
    }
    const rows = (
      await pg.query(`SELECT to_regclass('"account"') IS NOT NULL AS present`)
    ).rows[0].present
      ? (await pg.query(`SELECT count(*)::int AS n FROM "account"`)).rows[0].n
      : "absent";
    return {
      status: again === "applied" && rows === 2 ? "pass" : "fail",
      evidence: `first apply ${first}; ledger [${ledger}]; ${close}; apply again: ${again}; account rows ${rows}`,
    };
  } finally {
    await client.$disconnect();
    await pg.close();
  }
}
