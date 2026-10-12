// parity-17 (nested create half): a nested create of a children list sends ONE
// batched INSERT for the children, not one INSERT per child, on SQLite and on
// Postgres (PGlite).
//
// Statements are counted by wrapping the driver handle the client is given
// (better-sqlite3 statement execution; PGlite `query` and the transaction's
// `query`), so every round trip VibORM makes is seen. The tables already hold
// 10,000 posts; the nested create adds an author with 25 posts.
import { PGlite } from "@electric-sql/pglite";
import Database from "better-sqlite3";
import { s } from "viborm";
import { createMigrationClient } from "viborm/migrations";
import { createClient as createPgliteClient } from "viborm/pglite";
import { createClient as createSqliteClient } from "viborm/sqlite3";

export const meta = {
  id: "parity-17-nested-create",
  title: "A nested create list sends one batched INSERT for its children",
  plan: "track-b/parity-09-17",
  needs: [],
  source:
    "docs/architecture/completion-plan-2026-10/code-check-probes/tenant-api/probes/trackb-nested-create.mjs; docs/architecture/adversarial-review-2026-10-09/evidence/parity/bench/counts-*.jsonl",
};

const SEEDED = 10_000;
const BATCH = 1000;
const CHILDREN = 25;
// Anywhere in the statement, so an INSERT inside a CTE counts too.
const INSERT_INTO = /\bINSERT\s+INTO\s+(?:"?\w+"?\.)?"?(\w+)"?/gi;

const author = s.model({
  id: s.int().id().increment(),
  email: s.string().unique(),
  displayName: s.string(),
  bio: s.string().nullable(),
  role: s.enum(["reader", "writer", "editor"]).default("writer"),
  locale: s.enum(["en", "fr", "de"]).default("en"),
  karma: s.int().default(0),
  verified: s.boolean().default(false),
  preferences: s.json().nullable(),
  lastSeenAt: s.dateTime().nullable(),
  createdAt: s.dateTime().now(),
  updatedAt: s.dateTime().updatedAt(),
  posts: s.toMany(() => post),
});
const post = s.model({
  id: s.int().id().increment(),
  title: s.string(),
  slug: s.string().unique(),
  body: s.string(),
  status: s.enum(["draft", "review", "published", "archived"]).default("draft"),
  views: s.int().default(0),
  wordCount: s.int(),
  rating: s.number().nullable(),
  featured: s.boolean().default(false),
  metadata: s.json().nullable(),
  publishedAt: s.dateTime().nullable(),
  createdAt: s.dateTime().now(),
  updatedAt: s.dateTime().updatedAt(),
  authorId: s.int(),
  author: s
    .toOne(() => author)
    .fields("authorId")
    .references("id"),
});
const schema = { author, post };

const postData = (n) => ({
  title: `Post ${n}`,
  slug: `post-${n}`,
  body: `Body ${n} `.repeat(6),
  status: ["draft", "review", "published", "archived"][n % 4],
  wordCount: 100 + (n % 900),
  rating: n % 3 === 0 ? null : (n % 50) / 10,
  metadata: { rank: n % 13 },
  publishedAt: null,
});

function countSqlite(raw, log) {
  const prepare = raw.prepare.bind(raw);
  raw.prepare = (sql) => {
    const statement = prepare(sql);
    for (const method of ["all", "get", "run", "iterate"]) {
      const original = statement[method].bind(statement);
      statement[method] = (...values) => {
        if (log.on) log.sql.push(sql);
        return original(...values);
      };
    }
    return statement;
  };
  const exec = raw.exec.bind(raw);
  raw.exec = (sql) => {
    if (log.on) log.sql.push(sql);
    return exec(sql);
  };
}

function countPglite(pg, log) {
  const wrapQuery = (target) => {
    const query = target.query.bind(target);
    target.query = (sql, ...rest) => {
      if (log.on) log.sql.push(sql);
      return query(sql, ...rest);
    };
  };
  wrapQuery(pg);
  const transaction = pg.transaction.bind(pg);
  pg.transaction = (callback) =>
    transaction((tx) => {
      if (log.on) log.sql.push("BEGIN (transaction)");
      wrapQuery(tx);
      return callback(tx);
    });
}

async function measure(label, client, log) {
  const live = createMigrationClient(client);
  await live.push({ consent: (await live.push({ dryRun: true })).consent });
  const seed = await client.author.create({
    data: { email: "seed@example.com", displayName: "seed" },
  });
  for (let offset = 0; offset < SEEDED; offset += BATCH) {
    await client.post.createMany({
      data: Array.from({ length: BATCH }, (_, k) => ({
        ...postData(offset + k),
        authorId: seed.id,
      })),
    });
  }
  log.sql.length = 0;
  log.on = true;
  const created = await client.author.create({
    data: {
      email: "nested@example.com",
      displayName: "nested",
      preferences: { theme: "dark" },
      posts: {
        create: Array.from({ length: CHILDREN }, (_, k) =>
          postData(SEEDED + k)
        ),
      },
    },
    include: { posts: true },
  });
  log.on = false;
  if (created.posts.length !== CHILDREN)
    throw new Error(`${label}: created ${created.posts.length} posts`);
  const inserts = {};
  for (const sql of log.sql) {
    for (const table of new Set(
      [...sql.matchAll(INSERT_INTO)].map((m) => m[1])
    )) {
      inserts[table] = (inserts[table] ?? 0) + 1;
    }
  }
  return {
    label,
    statements: log.sql.length,
    inserts,
    childInserts: inserts.post ?? 0,
  };
}

export default async function probe() {
  const results = [];
  const raw = new Database(":memory:");
  const sqliteLog = { on: false, sql: [] };
  countSqlite(raw, sqliteLog);
  const sqlite = createSqliteClient({ client: raw, schema });
  try {
    results.push(await measure("sqlite", sqlite, sqliteLog));
  } finally {
    await sqlite.$disconnect();
    raw.close();
  }
  const pg = new PGlite();
  const pgliteLog = { on: false, sql: [] };
  countPglite(pg, pgliteLog);
  const pglite = createPgliteClient({ client: pg, schema });
  try {
    results.push(await measure("pglite", pglite, pgliteLog));
  } finally {
    await pglite.$disconnect();
    await pg.close();
  }
  const batched = results.every((result) => result.childInserts === 1);
  return {
    status: batched ? "pass" : "fail",
    evidence: results
      .map(
        (r) =>
          `${r.label}: author.create with ${CHILDREN} posts.create sent ${r.statements} statements, INSERTs ${JSON.stringify(r.inserts)} (child INSERTs ${r.childInserts}, target 1)`
      )
      .join(" | "),
  };
}
