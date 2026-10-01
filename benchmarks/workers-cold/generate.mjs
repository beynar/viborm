/**
 * Generate one Worker project per arm for the Workers cold-start measurement.
 * Every arm defines the same two-model schema at module scope, creates a
 * client per request over the D1 binding, runs one query (`?q=`), and logs
 * whether the request was its isolate's first. CPU and wall time come from
 * Workers Logs (observability), not from in-Worker clocks, which do not
 * advance during CPU work.
 *
 *   node benchmarks/workers-cold/generate.mjs --out /abs/dir \
 *     --arm viborm-now=/abs/dist --arm viborm-before=/abs/dist \
 *     --arm drizzle=/abs/dir-with-node_modules/drizzle-orm \
 *     --database-id <uuid> --zone viborm.dev --host perf.viborm.dev
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";

const { values: o } = parseArgs({
  options: {
    out: { type: "string" },
    arm: { type: "string", multiple: true },
    "database-id": { type: "string" },
    zone: { type: "string" },
    host: { type: "string" },
  },
});

const QUERIES = {
  viborm: {
    unique: 'c.user.findUnique({ where: { id: "u42" } })',
    rows20: 'c.post.findMany({ orderBy: { id: "asc" }, take: 20 })',
    filtered20:
      'c.post.findMany({ where: { published: true }, select: { id: true, title: true, views: true }, orderBy: { views: "desc" }, take: 20 })',
    relation20:
      'c.post.findMany({ select: { id: true, title: true, author: { select: { id: true, name: true } } }, orderBy: { id: "asc" }, take: 20 })',
  },
  drizzle: {
    unique: 'c.query.users.findFirst({ where: { id: "u42" } })',
    rows20: 'c.query.posts.findMany({ orderBy: { id: "asc" }, limit: 20 })',
    filtered20:
      'c.query.posts.findMany({ where: { published: true }, columns: { id: true, title: true, views: true }, orderBy: { views: "desc", id: "asc" }, limit: 20 })',
    relation20:
      'c.query.posts.findMany({ columns: { id: true, title: true }, with: { author: { columns: { id: true, name: true } } }, orderBy: { id: "asc" }, limit: 20 })',
  },
};

const queryTable = (lib) =>
  `const queries = {\n${Object.entries(QUERIES[lib])
    .map(([k, v]) => `  ${k}: (c) => ${v},`)
    .join("\n")}\n};`;

const handler = (arm, makeClient) => `
let served = 0;
export default {
  async fetch(request, env) {
    const q = new URL(request.url).searchParams.get("q") ?? "unique";
    const run = queries[q];
    if (!run) return new Response("unknown query", { status: 400 });
    const cold = served++ === 0;
    const c = ${makeClient};
    const result = await run(c);
    const rows = Array.isArray(result) ? result.length : result ? 1 : 0;
    console.log(JSON.stringify({ probe: "${arm}", q, cold, rows }));
    return Response.json({ arm: "${arm}", q, cold, rows });
  },
};
`;

const source = (arm, lib, path) =>
  lib === "drizzle"
    ? `import { defineRelations } from "${path}/index.js";
import { sqliteTable, text, integer } from "${path}/sqlite-core/index.js";
import { drizzle } from "${path}/d1/index.js";
const users = sqliteTable("users", { id: text("id").primaryKey(), name: text("name"), email: text("email").notNull(), age: integer("age") });
const posts = sqliteTable("posts", { id: text("id").primaryKey(), title: text("title").notNull(), content: text("content"), published: integer("published", { mode: "boolean" }).notNull(), views: integer("views").notNull(), authorId: text("authorId").notNull() });
const relations = defineRelations({ users, posts }, (r) => ({ users: { posts: r.many.posts() }, posts: { author: r.one.users({ from: r.posts.authorId, to: r.users.id }) } }));
${queryTable("drizzle")}
${handler(arm, "drizzle(env.DB, { relations })")}`
    : `import { s } from "${path}/schema.mjs";
import { createClient } from "${path}/index.mjs";
import { D1Driver } from "${path}/d1.mjs";
const user = s.model({ id: s.string().id(), name: s.string().nullable(), email: s.string(), age: s.int().nullable(), posts: s.toMany(() => post) }).map("users");
const post = s.model({ id: s.string().id(), title: s.string(), content: s.string().nullable(), published: s.boolean(), views: s.int(), authorId: s.string(), author: s.toOne(() => user).fields("authorId").references("id") }).map("posts");
const schema = { user, post };
${queryTable("viborm")}
${handler(arm, "createClient({ schema, driver: new D1Driver({ database: env.DB }) })")}`;

for (const spec of o.arm ?? []) {
  const [arm, path] = spec.split("=");
  const lib = arm.startsWith("drizzle") ? "drizzle" : "viborm";
  const dir = `${o.out}/${arm}`;
  mkdirSync(`${dir}/src`, { recursive: true });
  writeFileSync(`${dir}/src/index.js`, source(arm, lib, path));
  writeFileSync(
    `${dir}/wrangler.jsonc`,
    JSON.stringify(
      {
        name: `viborm-perf-${arm}`,
        main: "src/index.js",
        compatibility_date: "2026-09-01",
        observability: { enabled: true, head_sampling_rate: 1 },
        d1_databases: [
          {
            binding: "DB",
            database_name: "viborm-perf",
            database_id: o["database-id"],
          },
        ],
        routes: [{ pattern: `${o.host}/${arm}*`, zone_name: o.zone }],
        workers_dev: false,
      },
      null,
      2
    )
  );
}
