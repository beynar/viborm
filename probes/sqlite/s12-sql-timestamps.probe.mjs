// S12: timestamps written by SQL migrations. A manual SQLite migration that
// writes SQLite's own zone-less UTC spellings (datetime('now'),
// CURRENT_TIMESTAMP, datetime('now','subsec'), time('now')) applies, and
// afterwards every stored DateTime / Time value is canonical text
// (YYYY-MM-DDTHH:mm:ss.sssZ / HH:mm:ss.sss), read as UTC. A malformed value
// aborts the transition. DateTime-list members end canonical, or the
// transition is refused before effects (the plan allows either).
import { join } from "node:path";
import Database from "better-sqlite3";
import { s, sql } from "viborm";
import { createMigrationClient, isMigrationError } from "viborm/migrations";
import { createFsStorageWriter } from "viborm/migrations/storage/fs";
import { createClient } from "viborm/sqlite3";

export const meta = {
  id: "S12-apply",
  title:
    "SQL-written SQLite timestamps are canonicalized at apply; malformed ones abort",
  plan: "phase-1/lane-L/S12",
  needs: [],
  source:
    "docs/architecture/migrations-durable-objects-review-2026-10-09 FI-07 (evidence/fault-injection/probes/p08-datetime-sql-migration.mjs); completion-plan-2026-10/code-check/migrations-sqlite.md S12; plan decision 4",
};

const ROWS = 10_000;
const CANONICAL_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const CANONICAL_TIME = /^\d{2}:\d{2}:\d{2}\.\d{3}$/;
const CLOCK_SLACK_MS = 120_000;

const schema = () => ({
  event: s.model({
    id: s.string().id(),
    title: s.string(),
    kind: s.enum(["meeting", "call", "task"]),
    location: s.string().nullable(),
    payload: s.json().nullable(),
    priority: s.int().default(0),
    durationMinutes: s.int(),
    occurredAt: s.dateTime(),
    startsAt: s.time(),
    reminders: s.dateTime().array(),
    cancelled: s.boolean().default(false),
    notes: s.string().nullable(),
    createdAt: s.dateTime().now(),
    updatedAt: s.dateTime().updatedAt(),
  }),
});

/** A database at v1 holding ROWS canonical events, then one manual transition with `up`. */
async function scenario(tmpDir, name, up) {
  const dir = join(tmpDir, name);
  const dbPath = join(dir, "db.sqlite");
  const client = createClient({ schema: schema(), dataDir: dbPath });
  const migrations = createMigrationClient(client, {
    storage: createFsStorageWriter(join(dir, "estate")),
  });
  const result = { name, dbPath };
  try {
    const v1 = await migrations.generate({ name: "v1" });
    await migrations.apply();
    for (let start = 0; start < ROWS; start += 1000) {
      await client.event.createMany({
        data: Array.from({ length: 1000 }, (_, k) => {
          const i = start + k;
          return {
            id: `evt-${i}`,
            title: `Event ${i}`,
            kind: ["meeting", "call", "task"][i % 3],
            payload: { seats: i % 12 },
            durationMinutes: 30,
            occurredAt: new Date(Date.UTC(2025, 0, 1, 0, 0, i % 60)),
            startsAt: new Date(Date.UTC(1970, 0, 1, 9, i % 60, 0)),
            reminders: [new Date(Date.UTC(2025, 0, 1))],
          };
        }),
      });
    }
    await migrations.generate({
      name: "sql-backfill",
      manualMigration: {
        transitions: [
          {
            from: v1.stateId,
            execution: "transactional",
            up: up.map((text) => sql.raw(text)),
            rollback: { kind: "irreversible", reason: "probe" },
          },
        ],
      },
    });
    result.startedAt = Date.now();
    try {
      result.outcome = (await migrations.apply()).outcome;
    } catch (error) {
      result.error = error;
      result.outcome = `${isMigrationError(error) ? "MigrationError" : error?.name}/${error?.code}: ${String(error?.message).slice(0, 120)}`;
    }
    result.finishedAt = Date.now();
  } finally {
    await client.$disconnect();
  }
  return result;
}

const read = (dbPath, text) => {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db.prepare(text).all();
  } finally {
    db.close();
  }
};

/** Stored DateTime/Time text that is not canonical, by column, with one sample each. */
function nonCanonical(dbPath) {
  const rows = read(
    dbPath,
    `SELECT "id", "occurredAt", "createdAt", "updatedAt", "startsAt", "reminders" FROM "event"`
  );
  const bad = {};
  const note = (column, value) => {
    bad[column] ??= { count: 0, sample: value };
    bad[column].count += 1;
  };
  for (const row of rows) {
    for (const column of ["occurredAt", "createdAt", "updatedAt"]) {
      if (!CANONICAL_DATETIME.test(row[column])) note(column, row[column]);
    }
    if (!CANONICAL_TIME.test(row.startsAt)) note("startsAt", row.startsAt);
    for (const member of JSON.parse(row.reminders)) {
      if (!CANONICAL_DATETIME.test(member)) note("reminders[]", member);
    }
  }
  return bad;
}

const showBad = (bad) =>
  Object.entries(bad)
    .map(
      ([column, { count, sample }]) => `${column} ${count}x e.g. '${sample}'`
    )
    .join(", ") || "none";

export default async function probe(ctx) {
  const failures = [];
  const lines = [];

  // (1) SQLite's zone-less UTC spellings: the transition applies, storage ends canonical UTC.
  const zoneless = await scenario(ctx.tmpDir, "zoneless", [
    `UPDATE "event" SET "occurredAt" = datetime('now') WHERE rowid % 2 = 0`,
    `UPDATE "event" SET "updatedAt" = CURRENT_TIMESTAMP WHERE rowid % 3 = 0`,
    `UPDATE "event" SET "startsAt" = time('now') WHERE rowid % 5 = 0`,
    `INSERT INTO "event" ("id", "title", "kind", "durationMinutes", "occurredAt", "startsAt", "reminders", "createdAt", "updatedAt") VALUES ('evt-sql', 'from sql', 'call', 15, datetime('now', 'subsec'), time('now'), '[]', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
  ]);
  const zonelessBad = nonCanonical(zoneless.dbPath);
  lines.push(
    `zoneless: apply=${zoneless.outcome}; non-canonical after: ${showBad(zonelessBad)}`
  );
  if (zoneless.outcome !== "applied") {
    failures.push(
      `datetime('now') migration did not apply (${zoneless.outcome})`
    );
  } else if (Object.keys(zonelessBad).length > 0) {
    failures.push(
      `non-canonical DateTime/Time text left after apply (${showBad(zonelessBad)})`
    );
  } else {
    // Read as UTC: the rewritten datetime('now') values are the apply's own instant.
    const [{ at }] = read(
      zoneless.dbPath,
      `SELECT "occurredAt" AS at FROM "event" WHERE "id" = 'evt-sql'`
    );
    const instant = Date.parse(at);
    const inWindow =
      instant >= zoneless.startedAt - CLOCK_SLACK_MS &&
      instant <= zoneless.finishedAt + CLOCK_SLACK_MS;
    lines.push(
      `zoneless: evt-sql occurredAt '${at}' (apply ran ${new Date(zoneless.startedAt).toISOString()})`
    );
    if (!inWindow) failures.push(`zone-less text not read as UTC ('${at}')`);
  }

  // (2) A malformed value aborts the transition: nothing of it is stored.
  const malformed = await scenario(ctx.tmpDir, "malformed", [
    `UPDATE "event" SET "occurredAt" = 'next tuesday' WHERE "id" = 'evt-7'`,
  ]);
  const [{ stored }] = read(
    malformed.dbPath,
    `SELECT "occurredAt" AS stored FROM "event" WHERE "id" = 'evt-7'`
  );
  lines.push(
    `malformed: apply=${malformed.outcome}; evt-7 occurredAt '${stored}'`
  );
  if (!malformed.error || stored === "next tuesday") {
    failures.push(
      `malformed DateTime did not abort the transition (apply ${malformed.outcome}, stored '${stored}')`
    );
  }

  // (3) DateTime-list members: canonical after apply, or refused before effects.
  const list = await scenario(ctx.tmpDir, "list", [
    `UPDATE "event" SET "reminders" = json_array(datetime('now'), '2026-01-01T00:00:00.000Z') WHERE rowid % 7 = 0`,
  ]);
  const listBad = nonCanonical(list.dbPath);
  lines.push(
    `list: apply=${list.outcome}; non-canonical after: ${showBad(listBad)}`
  );
  const listRefused =
    isMigrationError(list.error) && Object.keys(listBad).length === 0;
  const listCanonical =
    list.outcome === "applied" && Object.keys(listBad).length === 0;
  if (!(listRefused || listCanonical)) {
    failures.push(
      `DateTime-list member left non-canonical (${showBad(listBad)})`
    );
  }

  return failures.length === 0
    ? {
        status: "pass",
        evidence: `datetime('now') migration applied and canonicalized as UTC; malformed value aborted; list members handled\n${lines.join("\n")}`,
      }
    : {
        status: "fail",
        evidence: `${failures.join("; ")}\n${lines.join("\n")}`,
      };
}
