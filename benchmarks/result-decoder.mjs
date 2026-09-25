#!/usr/bin/env node
/**
 * Raptor 3 result decoder — matched A/B of two immutable source trees
 * (`docs/architecture/raptor3-compiled-decoder-plan.md`, CD-04).
 *
 * Each tree is imported from its OWN built `dist/` (run `pnpm package:build`
 * in each first). Every measured value comes from a fresh child process, and
 * the two trees alternate within every round (A B, then B A), so drift in the
 * machine lands on both sides. Every result line carries its source identity:
 * git HEAD, tracked-dirty flag, a digest of `dist/**.mjs`, the digest of
 * `src/query-engine/raptor3/shared/query.ts`, the lockfile digest and Node's
 * version. The controller refuses two trees with different lockfiles.
 *
 * Workloads (in-memory SQLite, identical DDL and rows, ordered reads):
 *  - `flat`: `post.findMany`, six scalars including a boolean and an integer
 *    (the prototype's fixture);
 *  - `nested`: the same posts with a to-one `author` and a to-many
 *    `comments` (two per post) — physical root row plus carried documents;
 *  - `variant`: `pin.findMany` including a polymorphic to-one whose arms
 *    alternate between `post` and `author`;
 *  - `recursive`: root nodes with `kids: { recurse: { depth: 2 } }`, two
 *    children and two grandchildren per root.
 * Row counts are ROOT rows: 0 (the statement and the decoder's compilation
 * with nothing to read), 1, 20 and 1,000.
 *
 * Measures, one per process:
 *  - `time`: warmups, then a fixed iteration count per cell; wall
 *    (`performance.now`) and CPU (`process.cpuUsage`, user + system) per op.
 *  - `allocation`: a HEAP-GROWTH PROXY, not an allocation profile, not
 *    retained memory and not RSS. After warmups, each sampled op runs between
 *    a forced full GC and a `heapUsed` read, with a 64 MB semi-space so no
 *    collection runs inside the op; the proxy is the median bytes of heap
 *    growth across the op, and a sample during which the GC observer saw a
 *    collection is counted in `gcInWindow` (it would under-state growth).
 *  - `cold`: the FIRST operation of a fresh client in a fresh process, wall
 *    and CPU, then the second. The schema is pushed by a separate client over
 *    separate model objects and rows are seeded by raw SQL, so the measured
 *    client has prepared nothing.
 *  - `verify`: no timing. Per cell, the number of provider statements
 *    (instance `execute`/`executeRaw` calls) and a digest of the public
 *    result (key order, `bigint`, `Date` and bytes included). The controller
 *    requires both trees to agree. With `--provider pg|mysql` it runs against
 *    PostgreSQL (`PG_TEST_CONNECTION_STRING`) or MySQL
 *    (`MYSQL_TEST_CONNECTION_STRING`) in a scratch database it creates and
 *    drops; it reports statements and digests only — never wall time.
 *
 * Drizzle (`--drizzle`) is an EXTERNAL REFERENCE for the flat cell only,
 * resolved from the base tree's modules, on its own in-memory database with
 * the same DDL and rows; its result digest is checked against VibORM's.
 *
 * Run:
 *   node benchmarks/result-decoder.mjs --base <tree> --candidate <tree> \
 *     [--rounds 8] [--allocation-rounds 4] [--cold-rounds 8] [--drizzle] \
 *     [--shapes flat,nested,variant,recursive] [--rows 0,1,20,1000] \
 *     [--measures verify,time,allocation,cold] [--out runs.jsonl]
 *   node benchmarks/result-decoder.mjs --base <tree> --candidate <tree> \
 *     --provider pg|mysql
 */

import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { PerformanceObserver, performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const SHAPES = ["flat", "nested", "variant", "recursive"];
const ROWS = [0, 1, 20, 1000];
const SEED = 1000;
/** Fixed per-cell iteration counts, identical for every tree. */
const TIME_ITERATIONS = {
  flat: { 0: 7000, 1: 7000, 20: 3000, 1000: 700 },
  nested: { 0: 5000, 1: 5000, 20: 1500, 1000: 60 },
  variant: { 0: 5000, 1: 5000, 20: 1500, 1000: 80 },
  recursive: { 0: 5000, 1: 3000, 20: 400, 1000: 12 },
};
const ALLOCATION_SAMPLES = { 0: 40, 1: 40, 20: 20, 1000: 8 };
const WARMUPS = { 0: 200, 1: 200, 20: 60, 1000: 5 };

const pad = (n) => String(n).padStart(4, "0");

// ---------------------------------------------------------------------------
// Source identity
// ---------------------------------------------------------------------------

const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");

function distDigest(root) {
  const hash = createHash("sha256");
  const walk = (dir) => {
    const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name)
    );
    for (const entry of entries) {
      const path = `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith(".mjs"))
        hash.update(path.slice(root.length)).update(readFileSync(path));
    }
  };
  walk(`${root}/dist`);
  return hash.digest("hex").slice(0, 16);
}

function sourceIdentity(tree) {
  const git = (...args) =>
    execFileSync("git", ["-C", tree, ...args], { encoding: "utf8" }).trim();
  return {
    tree,
    head: git("rev-parse", "--short=9", "HEAD"),
    trackedDirty: git("status", "--porcelain", "--untracked-files=no") !== "",
    dist: distDigest(tree),
    queryTs: sha(
      readFileSync(`${tree}/src/query-engine/raptor3/shared/query.ts`)
    ).slice(0, 16),
    lockfile: sha(readFileSync(`${tree}/pnpm-lock.yaml`)).slice(0, 16),
    node: process.version,
  };
}

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

function models(s) {
  const author = s
    .model({
      id: s.string().id(),
      name: s.string(),
      email: s.string(),
      posts: s.toMany(() => post),
    })
    .map("rd_authors");
  const post = s
    .model({
      id: s.string().id(),
      title: s.string(),
      content: s.string().nullable(),
      published: s.boolean(),
      views: s.int(),
      authorId: s.string(),
      author: s
        .toOne(() => author)
        .fields("authorId")
        .references("id"),
      comments: s.toMany(() => comment),
    })
    .map("rd_posts");
  const comment = s
    .model({
      id: s.string().id(),
      body: s.string(),
      postId: s.string(),
      post: s
        .toOne(() => post)
        .fields("postId")
        .references("id"),
    })
    .map("rd_comments");
  const pin = s
    .model({
      id: s.int().id(),
      note: s.string(),
      subject: s.toOne({ post: () => post, author: () => author }),
    })
    .map("rd_pins");
  const node = s
    .model({
      id: s.string().id(),
      label: s.string(),
      rank: s.int(),
      parentId: s.string().nullable(),
      parent: s
        .toOne(() => node)
        .fields("parentId")
        .references("id")
        .name("rdTree"),
      kids: s.toMany(() => node).name("rdTree"),
    })
    .map("rd_nodes");
  return { author, post, comment, pin, node };
}

/** The seeded rows, as (table, columns, rows) with booleans as JS booleans. */
function seedTables() {
  const authors = [];
  const posts = [];
  const comments = [];
  const pins = [];
  const nodes = [];
  for (let i = 0; i < SEED; i += 1) {
    authors.push([`a${pad(i)}`, `Author ${i}`, `author${i}@example.com`]);
  }
  for (let i = 0; i < SEED; i += 1) {
    posts.push([
      `p${pad(i)}`,
      `Post ${i}`,
      i % 3 === 0 ? null : `content ${i}`,
      i % 2 === 1,
      i,
      `a${pad(i % 100)}`,
    ]);
    for (let j = 0; j < 2; j += 1)
      comments.push([`c${pad(i)}_${j}`, `Comment ${j} on ${i}`, `p${pad(i)}`]);
    pins.push([
      i + 1,
      `pin ${i}`,
      i % 2 === 0 ? "post" : "author",
      i % 2 === 0 ? `p${pad(i)}` : `a${pad(i)}`,
    ]);
    nodes.push([`r${pad(i)}`, `root ${i}`, i, null]);
  }
  for (let i = 0; i < SEED; i += 1)
    for (let k = 0; k < 2; k += 1) {
      nodes.push([`r${pad(i)}_${k}`, `child ${i}.${k}`, k, `r${pad(i)}`]);
      nodes.push([
        `r${pad(i)}_${k}_0`,
        `grandchild ${i}.${k}`,
        0,
        `r${pad(i)}_${k}`,
      ]);
    }
  return [
    ["rd_authors", ["id", "name", "email"], authors],
    [
      "rd_posts",
      ["id", "title", "content", "published", "views", "authorId"],
      posts,
    ],
    ["rd_comments", ["id", "body", "postId"], comments],
    ["rd_pins", ["id", "note", "subject_type", "subject_id"], pins],
    ["rd_nodes", ["id", "label", "rank", "parentId"], nodes],
  ];
}

const DIALECTS = {
  sqlite: {
    quote: (name) => `"${name}"`,
    placeholder: () => "?",
    value: (v) => (typeof v === "boolean" ? Number(v) : v),
  },
  pg: {
    quote: (name) => `"${name}"`,
    placeholder: (index) => `$${index}`,
    value: (v) => v,
  },
  mysql: {
    quote: (name) => `\`${name}\``,
    placeholder: () => "?",
    value: (v) => v,
  },
};

async function seed(driver, provider) {
  const dialect = DIALECTS[provider];
  for (const [table, columns, rows] of seedTables()) {
    const chunk = Math.floor(900 / columns.length);
    for (let start = 0; start < rows.length; start += chunk) {
      const slice = rows.slice(start, start + chunk);
      const params = [];
      const tuples = slice.map((row) => {
        const marks = row.map((value) => {
          params.push(dialect.value(value));
          return dialect.placeholder(params.length);
        });
        return `(${marks.join(", ")})`;
      });
      await driver._executeRaw(
        `INSERT INTO ${dialect.quote(table)} (${columns.map(dialect.quote).join(", ")}) VALUES ${tuples.join(", ")}`,
        params
      );
    }
  }
}

/** The measured operation of one cell. */
function operation(client, shape, rows) {
  const none = rows === 0 ? { id: "none" } : {};
  const take = Math.max(rows, 1);
  const order = { orderBy: { id: "asc" }, take };
  switch (shape) {
    case "flat":
      return () => client.post.findMany({ where: none, ...order });
    case "nested":
      return () =>
        client.post.findMany({
          where: none,
          ...order,
          include: { author: true, comments: { orderBy: { id: "asc" } } },
        });
    case "variant":
      return () =>
        client.pin.findMany({
          where: rows === 0 ? { id: -1 } : {},
          ...order,
          include: { subject: true },
        });
    case "recursive":
      return () =>
        client.node.findMany({
          where: { parentId: null, ...none },
          ...order,
          include: {
            kids: { recurse: { depth: 2 }, orderBy: { id: "asc" } },
          },
        });
    default:
      throw new Error(`unknown shape ${shape}`);
  }
}

/** Canonical text of a public result: key order, bigint, Date and bytes kept. */
function digest(value) {
  const text = JSON.stringify(value, function replace(key, item) {
    const raw = this[key];
    if (typeof raw === "bigint") return `${raw}n`;
    if (raw instanceof Date) return `date:${raw.toISOString()}`;
    if (raw instanceof Uint8Array)
      return `bytes:${Buffer.from(raw).toString("hex")}`;
    return item;
  });
  return sha(text).slice(0, 16);
}

// ---------------------------------------------------------------------------
// Worker
// ---------------------------------------------------------------------------

async function openViborm(job) {
  const { tree, provider, databaseUrl } = job;
  const { createClient, s } = await import(`${tree}/dist/index.mjs`);
  const { createMigrationClient } = await import(`${tree}/dist/migrations.mjs`);
  let driver;
  if (provider === "sqlite") {
    const { SQLite3Driver } = await import(`${tree}/dist/sqlite3.mjs`);
    driver = new SQLite3Driver({ dataDir: ":memory:" });
  } else if (provider === "pg") {
    const { PgDriver } = await import(`${tree}/dist/pg.mjs`);
    driver = new PgDriver({ databaseUrl });
  } else {
    const { MySQL2Driver } = await import(`${tree}/dist/mysql2.mjs`);
    // A direct connection to a local server: nothing between the driver and
    // the database can redirect a qualified table name.
    driver = new MySQL2Driver({
      databaseUrl,
      migrationNamespaceAttestation: "non-redirecting",
    });
  }
  // The schema is pushed by a SEPARATE client over SEPARATE model objects, so
  // the measured client below has prepared nothing.
  const setup = createClient({ schema: models(s), driver });
  const migrations = createMigrationClient(setup);
  const preview = await migrations.push({ dryRun: true });
  await migrations.push({ consent: preview.consent });
  await seed(driver, provider);
  const client = createClient({ schema: models(s), driver });
  return { client, driver };
}

async function openDrizzle(job) {
  const require_ = createRequire(`${job.tree}/package.json`);
  const load = (specifier) =>
    import(pathToFileURL(require_.resolve(specifier)).href);
  const { default: Database } = await load("better-sqlite3");
  const { drizzle } = await load("drizzle-orm/better-sqlite3");
  const { asc, eq } = await load("drizzle-orm");
  const { integer, sqliteTable, text } = await load("drizzle-orm/sqlite-core");
  const database = new Database(":memory:");
  database.exec(
    'CREATE TABLE "rd_posts" ("id" TEXT NOT NULL PRIMARY KEY, "title" TEXT NOT NULL, "content" TEXT DEFAULT NULL, "published" INTEGER NOT NULL, "views" INTEGER NOT NULL, "authorId" TEXT NOT NULL)'
  );
  const insert = database.prepare(
    'INSERT INTO "rd_posts" ("id","title","content","published","views","authorId") VALUES (?,?,?,?,?,?)'
  );
  const posts = seedTables().find(([table]) => table === "rd_posts")[2];
  for (const row of posts) insert.run(...row.map(DIALECTS.sqlite.value));
  const table = sqliteTable("rd_posts", {
    id: text("id").primaryKey(),
    title: text("title").notNull(),
    content: text("content"),
    published: integer("published", { mode: "boolean" }).notNull(),
    views: integer("views").notNull(),
    authorId: text("authorId").notNull(),
  });
  const db = drizzle(database);
  const { rows } = job;
  const run =
    rows === 0
      ? () =>
          db
            .select()
            .from(table)
            .where(eq(table.id, "none"))
            .orderBy(asc(table.id))
            .limit(1)
            .all()
      : () => db.select().from(table).orderBy(asc(table.id)).limit(rows).all();
  return { run, close: () => database.close() };
}

function countStatements(driver) {
  const counter = { count: 0 };
  for (const method of ["execute", "executeRaw"]) {
    const original = driver[method];
    Object.defineProperty(driver, method, {
      configurable: true,
      value(...args) {
        counter.count += 1;
        return original.apply(this, args);
      },
    });
  }
  return counter;
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

async function measureTime(run, job) {
  const iterations = TIME_ITERATIONS[job.shape][job.rows];
  let checksum = 0;
  for (let i = 0; i < WARMUPS[job.rows]; i += 1)
    checksum += (await run()).length;
  const beforeCpu = process.cpuUsage();
  const beforeWall = performance.now();
  for (let i = 0; i < iterations; i += 1) checksum += (await run()).length;
  const wall = performance.now() - beforeWall;
  const cpu = process.cpuUsage(beforeCpu);
  return {
    iterations,
    wallMsPerOp: wall / iterations,
    cpuMsPerOp: (cpu.user + cpu.system) / 1000 / iterations,
    checksum,
  };
}

async function measureAllocation(run, job) {
  const samples = ALLOCATION_SAMPLES[job.rows];
  for (let i = 0; i < WARMUPS[job.rows]; i += 1) await run();
  const windows = [];
  const collections = [];
  const observer = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) collections.push(entry.startTime);
  });
  observer.observe({ entryTypes: ["gc"] });
  const growth = [];
  let checksum = 0;
  for (let i = 0; i < samples; i += 1) {
    globalThis.gc();
    const start = performance.now();
    const before = process.memoryUsage().heapUsed;
    checksum += (await run()).length;
    const after = process.memoryUsage().heapUsed;
    windows.push([start, performance.now()]);
    growth.push(after - before);
  }
  await new Promise((resolve) => setTimeout(resolve, 50));
  observer.disconnect();
  const gcInWindow = collections.filter((time) =>
    windows.some(([start, end]) => time > start && time < end)
  ).length;
  return {
    samples,
    heapGrowthBytesPerOp: median(growth),
    gcInWindow,
    checksum,
  };
}

async function measureCold(run) {
  const beforeCpu = process.cpuUsage();
  const beforeWall = performance.now();
  const first = await run();
  const firstWall = performance.now() - beforeWall;
  const firstCpu = process.cpuUsage(beforeCpu);
  const secondCpu0 = process.cpuUsage();
  const secondWall0 = performance.now();
  await run();
  const secondWall = performance.now() - secondWall0;
  const secondCpu = process.cpuUsage(secondCpu0);
  return {
    firstWallMs: firstWall,
    firstCpuMs: (firstCpu.user + firstCpu.system) / 1000,
    secondWallMs: secondWall,
    secondCpuMs: (secondCpu.user + secondCpu.system) / 1000,
    checksum: first.length,
  };
}

async function verify(client, driver) {
  const counter = countStatements(driver);
  const cells = [];
  for (const shape of SHAPES)
    for (const rows of ROWS) {
      const run = operation(client, shape, rows);
      counter.count = 0;
      const result = await run();
      cells.push({
        shape,
        rows,
        statements: counter.count,
        resultRows: result.length,
        digest: digest(result),
      });
    }
  return { cells };
}

async function worker(job) {
  const source = sourceIdentity(job.tree);
  if (job.variant === "drizzle") {
    const { run, close } = await openDrizzle(job);
    const measured =
      job.measure === "verify"
        ? { digest: digest(await run()) }
        : job.measure === "time"
          ? await measureTime(run, job)
          : await measureAllocation(run, job);
    close();
    return { ...job, source, ...measured };
  }
  const { client, driver } = await openViborm(job);
  let measured;
  if (job.measure === "verify") measured = await verify(client, driver);
  else {
    const run = operation(client, job.shape, job.rows);
    if (job.measure === "time") measured = await measureTime(run, job);
    else if (job.measure === "allocation")
      measured = await measureAllocation(run, job);
    else measured = await measureCold(run);
    const counter = countStatements(driver);
    await run();
    measured.statements = counter.count;
  }
  await driver.disconnect();
  return { ...job, source, ...measured };
}

// ---------------------------------------------------------------------------
// Controller
// ---------------------------------------------------------------------------

const NODE_FLAGS = {
  verify: [],
  time: ["--expose-gc"],
  cold: ["--expose-gc"],
  allocation: [
    "--expose-gc",
    "--min-semi-space-size=64",
    "--max-semi-space-size=64",
  ],
};

function spawnWorker(job, out) {
  const child = spawnSync(
    process.execPath,
    [
      ...NODE_FLAGS[job.measure],
      new URL(import.meta.url).pathname,
      "--worker",
      JSON.stringify(job),
    ],
    { encoding: "utf8", env: process.env, maxBuffer: 64 * 1024 * 1024 }
  );
  if (child.status !== 0)
    throw new Error(
      `worker failed (${JSON.stringify(job)}):\n${child.stderr}\n${child.stdout}`
    );
  const line = child.stdout.trim().split("\n").at(-1);
  if (out) appendFileSync(out, `${line}\n`);
  return JSON.parse(line);
}

async function providerDatabase(provider, tree, label) {
  const require_ = createRequire(`${tree}/package.json`);
  const name = `rd_bench_${label}_${process.pid}`;
  if (provider === "pg") {
    const url = process.env.PG_TEST_CONNECTION_STRING;
    if (!url) throw new Error("PG_TEST_CONNECTION_STRING is not set");
    const { default: pg } = await import(
      pathToFileURL(require_.resolve("pg")).href
    );
    const admin = new pg.Client({ connectionString: url });
    await admin.connect();
    await admin.query(`CREATE DATABASE "${name}"`);
    await admin.end();
    const target = new URL(url);
    target.pathname = `/${name}`;
    return {
      databaseUrl: target.href,
      drop: async () => {
        const again = new pg.Client({ connectionString: url });
        await again.connect();
        await again.query(`DROP DATABASE "${name}" WITH (FORCE)`);
        await again.end();
      },
    };
  }
  const url = process.env.MYSQL_TEST_CONNECTION_STRING;
  if (!url) throw new Error("MYSQL_TEST_CONNECTION_STRING is not set");
  const mysql = await import(
    pathToFileURL(require_.resolve("mysql2/promise")).href
  );
  const admin = await mysql.createConnection(url);
  await admin.query(`CREATE DATABASE \`${name}\``);
  await admin.end();
  const target = new URL(url);
  target.pathname = `/${name}`;
  return {
    databaseUrl: target.href,
    drop: async () => {
      const again = await mysql.createConnection(url);
      await again.query(`DROP DATABASE \`${name}\``);
      await again.end();
    },
  };
}

function compareVerify(label, base, candidate) {
  const rows = [];
  for (const [index, cell] of base.cells.entries()) {
    const other = candidate.cells[index];
    const same =
      other.shape === cell.shape &&
      other.rows === cell.rows &&
      other.statements === cell.statements &&
      other.resultRows === cell.resultRows &&
      other.digest === cell.digest;
    rows.push({ ...cell, candidateDigest: other.digest, same });
  }
  console.log(`\n[${label}] verify — statements and result digests`);
  console.log("shape      rows  stmts  resultRows  digest(base)      same");
  for (const row of rows)
    console.log(
      `${row.shape.padEnd(10)} ${String(row.rows).padStart(4)}  ${String(row.statements).padStart(5)}  ${String(row.resultRows).padStart(10)}  ${row.digest}  ${row.same}`
    );
  if (rows.some((row) => !row.same))
    throw new Error(`[${label}] base and candidate disagree`);
  return rows;
}

function summarize(runs, key) {
  const values = runs.map((run) => run[key]);
  const mid = median(values);
  return {
    median: mid,
    min: Math.min(...values),
    max: Math.max(...values),
    spread: (Math.max(...values) - Math.min(...values)) / mid,
    n: values.length,
  };
}

async function controller(options) {
  const trees = { base: options.base, candidate: options.candidate };
  const identity = {
    base: sourceIdentity(trees.base),
    candidate: sourceIdentity(trees.candidate),
  };
  console.log(JSON.stringify({ identity }, null, 2));
  if (identity.base.lockfile !== identity.candidate.lockfile)
    throw new Error("the two trees do not share one lockfile");
  if (options.provider) {
    const results = {};
    for (const label of ["base", "candidate"]) {
      const database = await providerDatabase(
        options.provider,
        trees[label],
        label
      );
      try {
        results[label] = spawnWorker(
          {
            tree: trees[label],
            label,
            variant: "viborm",
            provider: options.provider,
            databaseUrl: database.databaseUrl,
            measure: "verify",
          },
          options.out
        );
      } finally {
        await database.drop();
      }
    }
    compareVerify(options.provider, results.base, results.candidate);
    return;
  }
  const shapes = options.shapes.split(",");
  const rowCounts = options.rows.split(",").map(Number);
  const measures = options.measures.split(",");
  const job = (label, extra) => ({
    tree: trees[label],
    label,
    variant: "viborm",
    provider: "sqlite",
    ...extra,
  });
  if (measures.includes("verify")) {
    const base = spawnWorker(job("base", { measure: "verify" }), options.out);
    const candidate = spawnWorker(
      job("candidate", { measure: "verify" }),
      options.out
    );
    const rows = compareVerify("sqlite", base, candidate);
    if (options.drizzle)
      for (const rowCount of rowCounts) {
        const reference = spawnWorker(
          {
            tree: trees.base,
            label: "drizzle",
            variant: "drizzle",
            shape: "flat",
            rows: rowCount,
            measure: "verify",
          },
          options.out
        );
        const viborm = rows.find(
          (row) => row.shape === "flat" && row.rows === rowCount
        );
        console.log(
          `drizzle flat ${rowCount}: digest ${reference.digest} ${reference.digest === viborm.digest ? "equals" : "DIFFERS FROM"} VibORM's`
        );
      }
  }
  const all = [];
  const pass = (measure, rounds, cells) => {
    for (let round = 0; round < rounds; round += 1) {
      const order =
        round % 2 === 0 ? ["base", "candidate"] : ["candidate", "base"];
      for (const cell of cells)
        for (const label of order) {
          const run = spawnWorker(
            job(label, { ...cell, measure }),
            options.out
          );
          all.push({ ...run, round });
        }
      process.stderr.write(`${measure} round ${round + 1}/${rounds}\n`);
    }
  };
  const cells = shapes.flatMap((shape) =>
    rowCounts.map((rows) => ({ shape, rows }))
  );
  if (measures.includes("time")) pass("time", options.rounds, cells);
  if (measures.includes("allocation"))
    pass("allocation", options.allocationRounds, cells);
  if (measures.includes("cold"))
    pass(
      "cold",
      options.coldRounds,
      shapes.map((shape) => ({ shape, rows: 20 }))
    );
  if (options.drizzle)
    for (const measure of ["time", "allocation"].filter((m) =>
      measures.includes(m)
    ))
      for (
        let round = 0;
        round <
        (measure === "time" ? options.rounds : options.allocationRounds);
        round += 1
      )
        for (const rows of rowCounts)
          all.push({
            ...spawnWorker(
              {
                tree: trees.base,
                label: "drizzle",
                variant: "drizzle",
                shape: "flat",
                rows,
                measure,
              },
              options.out
            ),
            round,
          });
  report(all);
}

function report(all) {
  const keys = {
    time: ["cpuMsPerOp", "wallMsPerOp"],
    allocation: ["heapGrowthBytesPerOp"],
    cold: ["firstCpuMs", "firstWallMs", "secondCpuMs"],
  };
  const groups = new Map();
  for (const run of all) {
    const key = `${run.measure}|${run.shape}|${run.rows}`;
    if (!groups.has(key)) groups.set(key, {});
    const group = groups.get(key);
    (group[run.label] ??= []).push(run);
  }
  const summary = [];
  for (const [key, group] of groups) {
    const [measure, shape, rows] = key.split("|");
    for (const metric of keys[measure]) {
      const row = { measure, shape, rows: Number(rows), metric };
      for (const label of ["base", "candidate", "drizzle"])
        if (group[label]) row[label] = summarize(group[label], metric);
      if (row.base && row.candidate) {
        row.ratio = row.candidate.median / row.base.median;
        // Paired per round: each round ran base and candidate back to back.
        const paired = group.base.map((baseRun) => {
          const partner = group.candidate.find(
            (run) => run.round === baseRun.round
          );
          return partner[metric] / baseRun[metric];
        });
        row.pairedRatio = median(paired);
        row.pairedRange = [Math.min(...paired), Math.max(...paired)];
      }
      const statements = new Set(
        Object.values(group)
          .flat()
          .map((run) => run.statements)
          .filter((value) => value !== undefined)
      );
      row.statements = [...statements].join("/");
      const gc = Object.values(group)
        .flat()
        .reduce((sum, run) => sum + (run.gcInWindow ?? 0), 0);
      if (measure === "allocation") row.gcInWindow = gc;
      summary.push(row);
    }
  }
  const fmt = (value, metric) =>
    value === undefined
      ? "-"
      : metric.startsWith("heap")
        ? Math.round(value.median).toString()
        : value.median.toFixed(4);
  const spread = (value) =>
    value === undefined ? "-" : `${(value.spread * 100).toFixed(1)}%`;
  console.log(
    "\nmeasure    shape      rows  metric                base      (spread)    candidate (spread)    cand/base  paired [range]           drizzle   stmts"
  );
  for (const row of summary)
    console.log(
      [
        row.measure.padEnd(10),
        row.shape.padEnd(10),
        String(row.rows).padStart(4),
        row.metric.padEnd(20),
        fmt(row.base, row.metric).padStart(10),
        `(${spread(row.base)})`.padEnd(9),
        fmt(row.candidate, row.metric).padStart(10),
        `(${spread(row.candidate)})`.padEnd(9),
        row.ratio === undefined ? "-" : row.ratio.toFixed(3).padStart(9),
        row.pairedRatio === undefined
          ? "-"
          : `${row.pairedRatio.toFixed(3)} [${row.pairedRange.map((v) => v.toFixed(3)).join(", ")}]`.padEnd(
              24
            ),
        fmt(row.drizzle, row.metric).padStart(9),
        row.statements,
        row.gcInWindow === undefined ? "" : `gc:${row.gcInWindow}`,
      ].join(" ")
    );
  console.log(`\n${JSON.stringify({ summary })}`);
}

const { values } = parseArgs({
  options: {
    worker: { type: "string" },
    base: { type: "string" },
    candidate: { type: "string" },
    provider: { type: "string" },
    rounds: { type: "string", default: "8" },
    "allocation-rounds": { type: "string", default: "4" },
    "cold-rounds": { type: "string", default: "8" },
    shapes: { type: "string", default: SHAPES.join(",") },
    rows: { type: "string", default: ROWS.join(",") },
    measures: { type: "string", default: "verify,time,allocation,cold" },
    drizzle: { type: "boolean", default: false },
    out: { type: "string" },
  },
});

if (values.worker) {
  const result = await worker(JSON.parse(values.worker));
  console.log(JSON.stringify(result));
} else {
  if (!(values.base && values.candidate))
    throw new Error("--base and --candidate are required");
  await controller({
    base: values.base,
    candidate: values.candidate,
    provider: values.provider,
    rounds: Number(values.rounds),
    allocationRounds: Number(values["allocation-rounds"]),
    coldRounds: Number(values["cold-rounds"]),
    shapes: values.shapes,
    rows: values.rows,
    measures: values.measures,
    drizzle: values.drizzle,
    out: values.out,
  });
}
