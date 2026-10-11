// D5 follow-up (owner decision 2026-10-11): a soft-delete estate's no-op.
// PostgreSQL deparses an index predicate its own way (`"deletedAt" IS NULL`
// reads back as `("deletedAt" IS NULL)`), so the one-query catalog digest
// abstained on every partial index and the no-op of every soft-delete estate
// took the locked proof. Target: such an estate's no-op apply sends at most 3
// statements and still refuses a live index whose predicate alone differs.
// Before: 37 statements on 1.1.0, 32 with D5 alone. Counted on PGlite over
// 10,000 rows.
import { PGlite } from "@electric-sql/pglite";
import { s } from "viborm";
import { createMigrationClient, MemoryEstateStorage } from "viborm/migrations";
import { createClient } from "viborm/pglite";

export const meta = {
  id: "d5-partial-index-noop",
  title:
    "A soft-delete estate's no-op apply in <= 3 statements, still refusing predicate drift",
  plan: "phase-2/D5 (partial-index follow-up)",
  needs: [],
  source:
    "D5-roundtrips report, open question 2; src/migrations/drivers/postgres/catalog-digest.ts; src/migrations/apply-v1.ts provenNoop",
};

const ROWS = 10_000;
const NOOP_MAX = 3;
const decoder = new TextDecoder();

const schema = () => ({
  account: s
    .model({
      id: s.string().id(),
      email: s.string(),
      status: s.enum(["trial", "active", "churned"]).default("trial"),
      country: s.string().default("FR"),
      deletedAt: s.dateTime().nullable(),
    })
    .index(["email"], {
      name: "accounts_live_email",
      unique: true,
      where: `"deletedAt" IS NULL`,
    })
    .index(["country", "status"], {
      name: "accounts_live_country",
      where: `"deletedAt" IS NULL AND "status" <> 'churned'`,
    })
    .map("accounts"),
});

/** Every statement PGlite runs while `command` runs (Parse or simple Query). */
async function record(db, command) {
  const send = db.execProtocolStream;
  const statements = [];
  db.execProtocolStream = (message, options) => {
    if (message[0] === 0x50 || message[0] === 0x51) {
      const start = message[0] === 0x50 ? message.indexOf(0, 5) + 1 : 5;
      statements.push(
        decoder.decode(message.subarray(start, message.indexOf(0, start)))
      );
    }
    return send.call(db, message, options);
  };
  try {
    return { result: await command(), statements };
  } finally {
    db.execProtocolStream = send;
  }
}

export default async function probe() {
  const db = new PGlite();
  try {
    const migrations = createMigrationClient(
      createClient({ client: db, schema: schema() }),
      { storage: new MemoryEstateStorage() }
    );
    await migrations.generate({ name: "v1" });
    await migrations.apply();
    await db.query(
      `INSERT INTO "accounts" ("id", "email", "deletedAt")
       SELECT 'acct-' || g, 'user' || (g % 9000) || '@example.com', CASE WHEN g > 9000 THEN now() END
       FROM generate_series(1, ${ROWS}) g`
    );

    const noop = await record(db, () => migrations.apply());

    await db.exec(
      `DROP INDEX "accounts_live_email";
       CREATE UNIQUE INDEX "accounts_live_email" ON "accounts" ("email") WHERE "deletedAt" IS NOT NULL`
    );
    let drift;
    try {
      drift = `not refused (${(await migrations.apply()).outcome})`;
    } catch (error) {
      drift = `refused ${error?.code}`;
    }

    const problems = [];
    if (noop.result.outcome !== "noop")
      problems.push(`no-op outcome ${noop.result.outcome}`);
    if (noop.statements.length > NOOP_MAX)
      problems.push(
        `no-op apply sent ${noop.statements.length} statements (max ${NOOP_MAX})`
      );
    if (drift !== "refused V11014") problems.push(`predicate drift ${drift}`);
    const evidence = `no-op: ${noop.result.outcome} in ${noop.statements.length} statements; predicate-only drift: ${drift}`;
    return {
      status: problems.length === 0 ? "pass" : "fail",
      evidence:
        problems.length === 0
          ? evidence
          : `${problems.join("; ")} | ${evidence}`,
    };
  } finally {
    await db.close();
  }
}
