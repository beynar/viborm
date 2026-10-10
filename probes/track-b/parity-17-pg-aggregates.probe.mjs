// parity-17 (aggregates half): re-measure Postgres aggregates on PGlite.
// The plan keeps 1.1.0's improvement as the bar: an unpaged count / aggregate
// / groupBy is ONE statement that reads the filtered table directly (no
// derived-table wrapper). The SQL shape (json_build_object or plain columns)
// and the time against hand-written SQL are recorded as evidence only: the
// plan sets no target for them.
//
// Scale: 10,000 posts with 15 columns. Statements are counted by wrapping the
// PGlite handle's `query`.
import { PGlite } from "@electric-sql/pglite";
import { s } from "viborm";
import { createMigrationClient } from "viborm/migrations";
import { createClient } from "viborm/pglite";

export const meta = {
  id: "parity-17-pg-aggregates",
  title:
    "Unpaged Postgres aggregates are one statement over the filtered table",
  plan: "track-b/parity-09-17",
  needs: [],
  source:
    "docs/architecture/adversarial-review-2026-10-09.md (parity-17); CHANGELOG.md 1.1.0 Performance; docs/architecture/completion-plan-2026-10/code-check/tenant-api.md (TrackB-parity-09/17)",
};

const ROWS = 10_000;
const BATCH = 1000;
const RUNS = 25;
const DERIVED_TABLE = /\bFROM\s*\(\s*SELECT\b/i;
const JSON_BUILD = /json_build_object/i;

const post = s.model({
  id: s.int().id().increment(),
  title: s.string(),
  slug: s.string().unique(),
  body: s.string(),
  authorName: s.string(),
  status: s.enum(["draft", "review", "published", "archived"]).default("draft"),
  locale: s.enum(["en", "fr", "de"]).default("en"),
  views: s.int().default(0),
  wordCount: s.int(),
  rating: s.number().nullable(),
  featured: s.boolean().default(false),
  metadata: s.json().nullable(),
  publishedAt: s.dateTime().nullable(),
  createdAt: s.dateTime().now(),
  updatedAt: s.dateTime().updatedAt(),
});

function median(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

async function time(run) {
  for (let n = 0; n < 5; n++) await run();
  const samples = [];
  for (let n = 0; n < RUNS; n++) {
    const start = performance.now();
    await run();
    samples.push(performance.now() - start);
  }
  return median(samples);
}

export default async function probe() {
  const pg = new PGlite();
  const log = { on: false, sql: [] };
  const query = pg.query.bind(pg);
  pg.query = (sql, ...rest) => {
    if (log.on) log.sql.push(sql);
    return query(sql, ...rest);
  };
  const db = createClient({ client: pg, schema: { post } });
  try {
    const live = createMigrationClient(db);
    await live.push({ consent: (await live.push({ dryRun: true })).consent });
    for (let offset = 0; offset < ROWS; offset += BATCH) {
      await db.post.createMany({
        data: Array.from({ length: BATCH }, (_, k) => {
          const n = offset + k;
          return {
            title: `Post ${n}`,
            slug: `post-${n}`,
            body: `Body ${n} `.repeat(6),
            authorName: `author-${n % 97}`,
            status: ["draft", "review", "published", "archived"][n % 4],
            locale: ["en", "fr", "de"][n % 3],
            views: (n * 7919) % 100_000,
            wordCount: 200 + (n % 1800),
            rating: n % 5 === 0 ? null : (n % 50) / 10,
            featured: n % 11 === 0,
            metadata: { rank: n % 13 },
          };
        }),
      });
    }
    await query("ANALYZE");

    const where = { status: "published", views: { gte: 1000 } };
    const operations = {
      count: () => db.post.count({ where }),
      aggregate: () =>
        db.post.aggregate({
          where,
          _count: true,
          _avg: { views: true, rating: true },
          _sum: { wordCount: true },
          _min: { views: true },
          _max: { views: true },
        }),
      groupBy: () =>
        db.post.groupBy({
          by: ["locale"],
          where,
          _count: true,
          _avg: { views: true },
        }),
    };
    const hand = {
      count: `SELECT COUNT(*) FROM "post" WHERE "status" = 'published' AND "views" >= 1000`,
      aggregate: `SELECT COUNT(*), AVG("views"), AVG("rating"), SUM("wordCount"), MIN("views"), MAX("views") FROM "post" WHERE "status" = 'published' AND "views" >= 1000`,
      groupBy: `SELECT "locale", COUNT(*), AVG("views") FROM "post" WHERE "status" = 'published' AND "views" >= 1000 GROUP BY "locale"`,
    };

    const problems = [];
    const facts = [];
    for (const [name, run] of Object.entries(operations)) {
      log.sql.length = 0;
      log.on = true;
      await run();
      log.on = false;
      const statements = [...log.sql];
      const sql = statements.join(" ; ");
      const ormMs = await time(run);
      const handMs = await time(() => query(hand[name]));
      const shape = `${statements.length} stmt, ${DERIVED_TABLE.test(sql) ? "derived table" : "direct"}, ${JSON_BUILD.test(sql) ? "json_build_object" : "plain columns"}`;
      facts.push(
        `${name}: ${shape}, ${ormMs.toFixed(2)} ms vs hand SQL ${handMs.toFixed(2)} ms (${(ormMs / handMs).toFixed(2)}x)`
      );
      if (statements.length !== 1 || DERIVED_TABLE.test(sql)) {
        problems.push(
          `${name} is not one direct statement: ${sql.slice(0, 200)}`
        );
      }
    }
    return {
      status: problems.length === 0 ? "pass" : "fail",
      evidence: [...problems, `PGlite, ${ROWS} rows: ${facts.join("; ")}`].join(
        " | "
      ),
    };
  } finally {
    await db.$disconnect();
    await pg.close();
  }
}
