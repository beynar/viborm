// parity-04: on SQLite, an m:n include over a small target table keeps a
// junction-driven plan once planner statistics exist (ANALYZE). The target is
// searched by primary key from the junction rows of each parent; it is never
// scanned once per parent row.
//
// Scale: 10,000 posts (15 columns), 50 tags, 30,000 junction rows, ANALYZE.
// The emitted SELECT and its bound values are captured through a wrapper on
// the better-sqlite3 handle and replayed under EXPLAIN QUERY PLAN. Timings
// against a hand-written junction-first query are evidence only.
import Database from "better-sqlite3";
import { s } from "viborm";
import { createMigrationClient } from "viborm/migrations";
import { createClient } from "viborm/sqlite3";

export const meta = {
  id: "parity-04",
  title: "SQLite m:n include stays junction-driven on a small ANALYZE'd target",
  plan: "track-b/parity-04",
  needs: [],
  source:
    "docs/architecture/adversarial-review-2026-10-09/evidence/parity/probes/sqlperf01-test-with-analyze.mjs, bench/m2m-analyze.mjs; tests/providers/local/sqlite3-adapter-adversarial.test.ts:251",
};

const POSTS = 10_000;
const TAGS = 50;
const TAGS_PER_POST = 3;
const PAGE = 100;
const BATCH = 1000;
const RUNS = 60;
// The target table wherever the statement names it: after FROM, or after JOIN
// when the page reads from the junction.
const TARGET_ALIAS = /"tag" AS "(q\d+)"/;

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
  tags: s.toMany(() => tag),
});
const tag = s.model({
  id: s.int().id().increment(),
  name: s.string().unique(),
  color: s.string(),
  createdAt: s.dateTime().now(),
  posts: s.toMany(() => post),
});

/** Records every executed statement with its bound values. */
function recordStatements(raw) {
  const log = [];
  const prepare = raw.prepare.bind(raw);
  raw.prepare = (sql) => {
    const statement = prepare(sql);
    for (const method of ["all", "get", "run", "iterate"]) {
      const original = statement[method].bind(statement);
      statement[method] = (...values) => {
        log.push({ sql, values });
        return original(...values);
      };
    }
    return statement;
  };
  return log;
}

function junctionOf(raw) {
  for (const { name } of raw
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all()) {
    const keys = raw.prepare(`PRAGMA foreign_key_list("${name}")`).all();
    const toPost = keys.find((key) => key.table === "post");
    const toTag = keys.find((key) => key.table === "tag");
    if (toPost && toTag)
      return { name, postKey: toPost.from, tagKey: toTag.from };
  }
  throw new Error("no junction table between post and tag");
}

function median(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

async function time(run) {
  for (let n = 0; n < 10; n++) await run(n);
  const samples = [];
  for (let n = 0; n < RUNS; n++) {
    const start = performance.now();
    await run(n);
    samples.push(performance.now() - start);
  }
  return median(samples);
}

export default async function probe() {
  const raw = new Database(":memory:");
  const db = createClient({ client: raw, schema: { post, tag } });
  try {
    const live = createMigrationClient(db);
    await live.push({ consent: (await live.push({ dryRun: true })).consent });
    await db.tag.createMany({
      data: Array.from({ length: TAGS }, (_, n) => ({
        name: `tag-${n}`,
        color: `#${(n * 4099).toString(16).padStart(6, "0").slice(0, 6)}`,
      })),
    });
    for (let offset = 0; offset < POSTS; offset += BATCH) {
      await db.post.createMany({
        data: Array.from({ length: BATCH }, (_, k) => {
          const n = offset + k;
          return {
            title: `Post ${n}`,
            slug: `post-${n}`,
            body: `Body of post ${n} `.repeat(8),
            authorName: `author-${n % 97}`,
            status: ["draft", "review", "published", "archived"][n % 4],
            locale: ["en", "fr", "de"][n % 3],
            views: (n * 7919) % 100_000,
            wordCount: 200 + (n % 1800),
            rating: n % 5 === 0 ? null : (n % 50) / 10,
            featured: n % 11 === 0,
            metadata: { source: "seed", rank: n % 13, labels: [`l${n % 7}`] },
            publishedAt:
              n % 4 === 2 ? new Date(Date.UTC(2026, 0, 1 + (n % 300))) : null,
          };
        }),
      });
    }
    const junction = junctionOf(raw);
    const insert = raw.prepare(
      `INSERT INTO "${junction.name}" ("${junction.postKey}", "${junction.tagKey}") VALUES (?, ?)`
    );
    raw.transaction(() => {
      for (let postId = 1; postId <= POSTS; postId++) {
        for (let k = 0; k < TAGS_PER_POST; k++)
          insert.run(postId, 1 + ((postId * 7 + k * 13) % TAGS));
      }
    })();

    const log = recordStatements(raw);
    const page = (n) =>
      db.post.findMany({
        where: { id: { gte: 1 + ((n * 37) % (POSTS - PAGE)) } },
        orderBy: { id: "asc" },
        take: PAGE,
        include: { tags: true },
      });
    const explain = async () => {
      log.length = 0;
      const rows = await page(0);
      const tagged = rows.reduce((sum, row) => sum + row.tags.length, 0);
      if (rows.length !== PAGE || tagged !== PAGE * TAGS_PER_POST) {
        throw new Error(
          `include returned ${rows.length} posts with ${tagged} tags`
        );
      }
      const emitted = log.find((entry) => TARGET_ALIAS.test(entry.sql));
      if (!emitted)
        throw new Error(
          `no statement read "tag": ${log.map((e) => e.sql.slice(0, 60)).join(" / ")}`
        );
      const alias = TARGET_ALIAS.exec(emitted.sql)[1];
      const plan = raw
        .prepare(`EXPLAIN QUERY PLAN ${emitted.sql}`)
        .all(...emitted.values)
        .map((row) => row.detail);
      return {
        alias,
        plan,
        targetScan: plan.filter((detail) => detail.startsWith(`SCAN ${alias}`)),
        targetByKey: plan.some((detail) =>
          detail.startsWith(`SEARCH ${alias} USING INTEGER PRIMARY KEY`)
        ),
      };
    };
    const control = await explain();
    raw.exec("ANALYZE");
    const { alias, plan, targetScan, targetByKey } = await explain();

    const junctionFirst = raw.prepare(
      `SELECT p."id", p."title", (SELECT json_group_array(json_object('id', t."id", 'name', t."name", 'color', t."color", 'createdAt', t."createdAt")) FROM (SELECT t."id", t."name", t."color", t."createdAt" FROM "${junction.name}" j JOIN "tag" t ON t."id" = j."${junction.tagKey}" WHERE j."${junction.postKey}" = p."id" ORDER BY t."id") t) AS tags FROM "post" p WHERE p."id" >= ? ORDER BY p."id" LIMIT ?`
    );
    const ormMs = await time(page);
    const handMs = await time((n) =>
      junctionFirst.all(1 + ((n * 37) % (POSTS - PAGE)), PAGE)
    );

    const verdict = targetScan.length === 0 && targetByKey;
    return {
      status: verdict ? "pass" : "fail",
      evidence: `${verdict ? "junction-driven" : `target "tag" (${alias}) ${targetScan.length > 0 ? "scanned" : "not searched by primary key"}`} after ANALYZE (${POSTS} posts, ${TAGS} tags): plan [${plan.join(" | ")}]; median page of ${PAGE} with tags: viborm ${ormMs.toFixed(3)} ms vs junction-first SQL ${handMs.toFixed(3)} ms (${(ormMs / handMs).toFixed(1)}x); control without ANALYZE: target ${control.targetScan.length > 0 ? "scanned" : "searched"}`,
    };
  } finally {
    await db.$disconnect();
    raw.close();
  }
}
