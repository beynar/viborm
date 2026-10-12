// engine-08: a counter upsert (update arm uses increment) runs as ONE
// INSERT ... ON CONFLICT DO UPDATE statement on both paths, like the set-only
// shapes already do through the targeted fold.
import { s } from "viborm";
import { instrumentation } from "viborm/instrumentation";
import { createMigrationClient } from "viborm/migrations";
import { createClient as pgliteClient } from "viborm/pglite";
import { createClient as sqliteClient } from "viborm/sqlite3";

export const meta = {
  id: "engine-08",
  title: "Counter upsert is a single ON CONFLICT DO UPDATE statement",
  plan: "track-a/engine-08",
  needs: [],
  source:
    "docs/architecture/adversarial-review-2026-10-09/evidence/engine/probes/h05-upsert.mjs; src/query-engine/raptor3/commands/commands.ts:1855,1906",
};

const account = s
  .model({
    id: s.int().id(),
    email: s.string().unique(),
    name: s.string(),
    visits: s.int().default(0),
    balance: s.number().default(0),
    plan: s.enum(["free", "pro", "team"]).default("free"),
    prefs: s.json().nullable(),
    country: s.string().nullable(),
    locale: s.string().default("en"),
    verified: s.boolean().default(false),
    lastSeenAt: s.dateTime().nullable(),
    notes: s.string().nullable(),
    createdAt: s.dateTime().now(),
    updatedAt: s.dateTime().updatedAt(),
  })
  .map("account");

const SEED = 10_000;

async function statementsPerPath(make) {
  const log = [];
  let capture = false;
  const base = make({ account });
  const db = base.$extends(
    instrumentation({
      logging: {
        query: (event) => {
          if (capture) log.push(String(event.sql ?? ""));
        },
        includeSql: true,
      },
    })
  );
  try {
    await createMigrationClient(base).push();
    for (let i = 0; i < SEED; i += 2000)
      await db.account.createMany({
        data: Array.from({ length: 2000 }, (_, k) => ({
          id: i + k + 1,
          email: `u${i + k + 1}@x.io`,
          name: `user ${i + k + 1}`,
          prefs: { theme: "dark" },
        })),
      });
    const shape = (update) => () =>
      db.account.upsert({
        where: { email: "counter@x.io" },
        create: { id: SEED + 1, email: "counter@x.io", name: "c", visits: 1 },
        update,
      });
    const count = async (run) => {
      log.length = 0;
      capture = true;
      await run();
      capture = false;
      return log.length;
    };
    const counter = shape({ visits: { increment: 1 } });
    const insert = await count(counter);
    const update = await count(counter);
    const setOnly = await count(shape({ name: "renamed" }));
    const row = await db.account.findUnique({
      where: { email: "counter@x.io" },
    });
    return { insert, update, setOnly, visits: row.visits };
  } finally {
    await base.$disconnect();
  }
}

export default async function probe() {
  const lines = [];
  let ok = true;
  for (const [dialect, make] of [
    ["sqlite", (schema) => sqliteClient({ schema })],
    ["pglite", (schema) => pgliteClient({ schema })],
  ]) {
    const r = await statementsPerPath(make);
    ok &&= r.insert === 1 && r.update === 1 && r.visits === 2;
    lines.push(
      `${dialect}: increment upsert insert-path ${r.insert} stmt, update-path ${r.update} stmt (visits=${r.visits}); set-only update-path ${r.setOnly} stmt`
    );
  }
  return { status: ok ? "pass" : "fail", evidence: lines.join("; ") };
}
