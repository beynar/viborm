// biome-ignore-all lint/suspicious/noMisplacedAssertion: this standalone benchmark uses Node assertions to reject invalid evidence.
/**
 * Full-operation SQLite RELATIONAL-API comparison, including Prisma 7 and better-drizzle on
 * its declared Drizzle peer. Reads use db.query.findFirst/findMany; writes use the insert builder.
 * All limited reads explicitly match VibORM ordering, including the identity tie-break.
 * One library/workload/measurement per fresh process. The older
 * drizzle-memory-cpu.mjs remains a historical, same-process diagnostic.
 *
 * Build dist first. Install better-drizzle@0.2.0 + drizzle-orm@0.30.10 in an
 * isolated directory, then run this through scripts/run-node-safe.mjs:
 *   ... 768 600000 benchmarks/better-drizzle-compare.mjs
 *       --better-dir /absolute/dependency/directory --output /absolute/report.json
 * No dependency or production source changes are required.
 */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import inspector from "node:inspector";
import { createRequire } from "node:module";
import os from "node:os";
import { dirname, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    "better-dir": { type: "string" },
    "prisma-dir": { type: "string" },
    "drizzle-dir": { type: "string" },
    "build-dir": { type: "string" },
    libraries: {
      type: "string",
      default: "viborm,drizzle,drizzle-peer,better-drizzle",
    },
    workloads: {
      type: "string",
      default: "unique,filtered20,relation20,insert,rows1000",
    },
    modes: { type: "string", default: "time,memory" },
    "profile-dir": { type: "string" },
    "time-scale": { type: "string", default: "1" },
    round: { type: "string", default: "0" },
    output: { type: "string" },
    rounds: { type: "string", default: "4" },
    worker: { type: "string" },
    workload: { type: "string" },
    mode: { type: "string" },
  },
});
const libraries = values.libraries.split(",");
assert(
  !libraries.includes("prisma") || values["prisma-dir"],
  "--prisma-dir must name the isolated generated SQLite client directory"
);
const needsPeer = libraries.some((library) =>
  ["drizzle-peer", "better-drizzle"].includes(library)
);
assert(
  !needsPeer || values["better-dir"],
  "--better-dir must name the isolated dependency directory"
);
assert(libraries.length > 0 && new Set(libraries).size === libraries.length);
assert(
  libraries.every((library) =>
    ["viborm", "drizzle", "drizzle-peer", "better-drizzle", "prisma"].includes(
      library
    )
  )
);
const timeScale = Number(values["time-scale"]);
assert(Number.isFinite(timeScale) && timeScale >= 1 && timeScale <= 100);
const modes = values.modes.split(",");
assert(
  modes.every((mode) =>
    ["time", "memory", "alloc", "retained", "profile"].includes(mode)
  )
);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const buildDir = resolve(values["build-dir"] ?? `${root}/dist`);
const drizzleRoot = resolve(values["drizzle-dir"] ?? root);
const peerRoot = values["better-dir"]
  ? resolve(values["better-dir"])
  : undefined;
const prismaRoot = values["prisma-dir"]
  ? resolve(values["prisma-dir"])
  : undefined;
const iterations = {
  unique: 10_000,
  filtered20: 3000,
  relation20: 3000,
  insert: 5000,
  rows1000: 400,
  rows0: 10_000,
  rows1: 10_000,
  rows20: 3000,
  rows10000: 60,
};
const workloads = values.workloads.split(",");
assert(workloads.length > 0 && new Set(workloads).size === workloads.length);
assert(workloads.every((workload) => Object.hasOwn(iterations, workload)));
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const json = (path) => JSON.parse(readFileSync(path, "utf8"));
const median = (samples) => {
  const sorted = [...samples].sort((a, b) => a - b);
  return (
    (sorted[Math.floor((sorted.length - 1) / 2)] +
      sorted[Math.floor(sorted.length / 2)]) /
    2
  );
};
const canonical = (value) =>
  Array.isArray(value)
    ? value.map(canonical)
    : value && typeof value === "object"
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [key, canonical(value[key])])
        )
      : value;
const users = Array.from({ length: 100 }, (_, i) => ({
  id: `u${i}`,
  name: `User ${i}`,
  email: `u${i}@x.com`,
  age: 20 + (i % 50),
}));
const posts = Array.from({ length: 1000 }, (_, i) => ({
  id: `p${i}`,
  title: `Post ${i}`,
  content: `content ${i}`,
  published: Boolean(i % 2),
  views: i,
  authorId: `u${i % 100}`,
}));
const inserted = (i) => ({
  id: `new${i}`,
  name: "B",
  email: "b@x.com",
  age: 30,
});
const orderedPosts = [...posts].sort((a, b) =>
  a.id < b.id ? -1 : a.id > b.id ? 1 : 0
);
const expected = {
  unique: users[42],
  filtered20: posts
    .filter((p) => p.published)
    .reverse()
    .slice(0, 20)
    .map(({ id, title, views }) => ({ id, title, views })),
  relation20: orderedPosts.slice(0, 20).map(({ id, title, authorId }) => {
    const author = users.find((user) => user.id === authorId);
    return { id, title, author: { id: author.id, name: author.name } };
  }),
  insert: inserted(0),
  rows1000: orderedPosts,
};

const ROW_WORKLOAD = /^rows\d+$/;

async function fixture(library, workload) {
  const rowCount = ROW_WORKLOAD.test(workload)
    ? Number(workload.slice(4))
    : undefined;
  const fixturePosts =
    workload === "rows10000"
      ? Array.from({ length: 10_000 }, (_, i) => ({
          id: `p${i}`,
          title: `Post ${i}`,
          content: `content ${i}`,
          published: Boolean(i % 2),
          views: i,
          authorId: `u${i % 100}`,
        }))
      : posts;
  const expectedAnswer =
    rowCount === undefined
      ? expected[workload]
      : [...fixturePosts]
          .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
          .slice(0, rowCount);
  const require = createRequire(`${root}/package.json`);
  const Database = require("better-sqlite3");
  let database, client, driver, query;
  let nextId = 0;
  if (library === "prisma") {
    const prismaRequire = createRequire(`${prismaRoot}/package.json`);
    assert.equal(
      prismaRequire.resolve("better-sqlite3"),
      require.resolve("better-sqlite3"),
      "Prisma must use the same compiled native SQLite module"
    );
    const { PrismaBetterSqlite3 } = prismaRequire(
      "@prisma/adapter-better-sqlite3"
    );
    const { PrismaClient } = await import(
      pathToFileURL(`${prismaRoot}/client/client.js`)
    );
    client = new PrismaClient({
      adapter: new PrismaBetterSqlite3({ url: ":memory:" }),
    });
    // Discover the stock connection only during setup. Restore the exact native
    // method before seeding, witnessing, warmup or any measured operation.
    const prepare = Database.prototype.prepare;
    Database.prototype.prepare = function (statement) {
      database = this;
      return prepare.call(this, statement);
    };
    try {
      await client.$queryRawUnsafe("SELECT 1");
    } finally {
      Database.prototype.prepare = prepare;
    }
    assert(database instanceof Database);
    query = {
      unique: () => client.user.findUnique({ where: { id: "u42" } }),
      filtered20: () =>
        client.post.findMany({
          where: { published: true },
          select: { id: true, title: true, views: true },
          orderBy: { views: "desc" },
          take: 20,
        }),
      relation20: () =>
        client.post.findMany({
          select: {
            id: true,
            title: true,
            author: { select: { id: true, name: true } },
          },
          orderBy: { id: "asc" },
          take: 20,
        }),
      insert: () => client.user.create({ data: inserted(nextId++) }),
      rows1000: () =>
        client.post.findMany({ orderBy: { id: "asc" }, take: 1000 }),
    }[workload];
    if (rowCount !== undefined)
      query = () =>
        client.post.findMany({ orderBy: { id: "asc" }, take: rowCount });
  } else if (library === "viborm") {
    const { s } = await import(`${buildDir}/schema.mjs`);
    const { createClient } = await import(`${buildDir}/index.mjs`);
    const { SQLite3Driver } = await import(`${buildDir}/sqlite3.mjs`);
    const user = s
      .model({
        id: s.string().id(),
        name: s.string().nullable(),
        email: s.string(),
        age: s.int().nullable(),
        posts: s.toMany(() => post),
      })
      .map("users");
    const post = s
      .model({
        id: s.string().id(),
        title: s.string(),
        content: s.string().nullable(),
        published: s.boolean(),
        views: s.int(),
        authorId: s.string(),
        author: s
          .toOne(() => user)
          .fields("authorId")
          .references("id"),
      })
      .map("posts");
    // Use the stock driver lifecycle and typed execution path.
    driver = new SQLite3Driver({ dataDir: ":memory:" });
    client = createClient({ schema: { user, post }, driver });
    database = await driver.getClient();
    query = {
      unique: () => client.user.findUnique({ where: { id: "u42" } }),
      filtered20: () =>
        client.post.findMany({
          where: { published: true },
          select: { id: true, title: true, views: true },
          orderBy: { views: "desc" },
          take: 20,
        }),
      relation20: () =>
        client.post.findMany({
          select: {
            id: true,
            title: true,
            author: { select: { id: true, name: true } },
          },
          orderBy: { id: "asc" },
          take: 20,
        }),
      insert: () => client.user.create({ data: inserted(nextId++) }),
      rows1000: () =>
        client.post.findMany({ orderBy: { id: "asc" }, take: 1000 }),
    }[workload];
    if (rowCount !== undefined)
      query = () =>
        client.post.findMany({ orderBy: { id: "asc" }, take: rowCount });
  } else {
    const dependencyRoot = {
      drizzle: drizzleRoot,
      "drizzle-peer": peerRoot,
      "better-drizzle": peerRoot,
    }[library];
    const modules = `${dependencyRoot}/node_modules/drizzle-orm`;
    const { eq, desc, asc, relations, defineRelations } = await import(
      pathToFileURL(`${modules}/index.js`)
    );
    const { sqliteTable, text, integer } = await import(
      pathToFileURL(`${modules}/sqlite-core/index.js`)
    );
    const { drizzle } = await import(
      pathToFileURL(`${modules}/better-sqlite3/index.js`)
    );
    const user = sqliteTable("users", {
      id: text("id").primaryKey(),
      name: text("name"),
      email: text("email").notNull(),
      age: integer("age"),
    });
    const post = sqliteTable("posts", {
      id: text("id").primaryKey(),
      title: text("title").notNull(),
      content: text("content"),
      published: integer("published", { mode: "boolean" }).notNull(),
      views: integer("views").notNull(),
      authorId: text("authorId").notNull(),
    });
    const schema = {
      users: user,
      posts: post,
    };
    let relationConfig;
    const usesRelationsV2 = typeof defineRelations === "function";
    if (usesRelationsV2) {
      relationConfig = {
        relations: defineRelations(schema, (r) => ({
          users: { posts: r.many.posts() },
          posts: {
            author: r.one.users({
              from: r.posts.authorId,
              to: r.users.id,
            }),
          },
        })),
      };
    } else {
      schema.usersRelations = relations(user, ({ many }) => ({
        posts: many(post),
      }));
      schema.postsRelations = relations(post, ({ one }) => ({
        author: one(user, { fields: [post.authorId], references: [user.id] }),
      }));
      relationConfig = { schema };
    }
    database = new Database(":memory:");
    const db = usesRelationsV2
      ? drizzle({ client: database, ...relationConfig, jit: false })
      : drizzle(database, relationConfig);
    if (library === "better-drizzle") {
      const { better } = await import(
        pathToFileURL(`${peerRoot}/node_modules/better-drizzle/dist/index.js`)
      );
      client = better(db, { schema });
      query = {
        unique: () => client.users.findUnique({ where: { id: "u42" } }),
        filtered20: () =>
          client.posts.findMany({
            where: { published: true },
            select: { id: true, title: true, views: true },
            orderBy: [{ views: "desc" }],
            take: 20,
          }),
        relation20: () =>
          client.posts.findMany({
            select: {
              id: true,
              title: true,
              author: { select: { id: true, name: true } },
            },
            orderBy: [{ id: "asc" }],
            take: 20,
          }),
        insert: () => client.users.create({ data: inserted(nextId++) }),
        rows1000: () =>
          client.posts.findMany({ orderBy: [{ id: "asc" }], take: 1000 }),
      }[workload];
      if (rowCount !== undefined)
        query = () =>
          client.posts.findMany({ orderBy: [{ id: "asc" }], take: rowCount });
    } else {
      query = {
        unique: () =>
          db.query.users.findFirst({
            where: usesRelationsV2 ? { id: "u42" } : eq(user.id, "u42"),
            orderBy: usesRelationsV2 ? { id: "asc" } : [asc(user.id)],
          }),
        filtered20: () =>
          db.query.posts.findMany({
            where: usesRelationsV2
              ? { published: true }
              : eq(post.published, true),
            columns: { id: true, title: true, views: true },
            orderBy: usesRelationsV2
              ? { views: "desc", id: "asc" }
              : [desc(post.views), asc(post.id)],
            limit: 20,
          }),
        relation20: () =>
          db.query.posts.findMany({
            columns: { id: true, title: true },
            with: { author: { columns: { id: true, name: true } } },
            orderBy: usesRelationsV2 ? { id: "asc" } : [asc(post.id)],
            limit: 20,
          }),
        insert: () =>
          db.insert(user).values(inserted(nextId++)).returning().get(),
        rows1000: () =>
          db.query.posts.findMany({
            orderBy: usesRelationsV2 ? { id: "asc" } : [asc(post.id)],
            limit: 1000,
          }),
      }[workload];
      if (rowCount !== undefined)
        query = () =>
          db.query.posts.findMany({
            orderBy: usesRelationsV2 ? { id: "asc" } : [asc(post.id)],
            limit: rowCount,
          });
    }
  }
  database.exec(
    "CREATE TABLE users (id text primary key, name text, email text not null, age integer); CREATE TABLE posts (id text primary key, title text not null, content text, published integer not null, views integer not null, authorId text not null)"
  );
  database.transaction(() => {
    const u = database.prepare("INSERT INTO users VALUES (?,?,?,?)");
    const p = database.prepare("INSERT INTO posts VALUES (?,?,?,?,?,?)");
    for (const row of users) u.run(...Object.values(row));
    for (const row of fixturePosts)
      p.run(
        row.id,
        row.title,
        row.content,
        Number(row.published),
        row.views,
        row.authorId
      );
  })();
  return {
    query,
    expectedAnswer,
    database,
    close: () => {
      if (library === "prisma") return client.$disconnect();
      return driver ? driver.disconnect() : database.close();
    },
  };
}

async function worker() {
  const { worker: library, workload, mode } = values;
  assert(
    libraries.includes(library) &&
      workload in iterations &&
      ["time", "memory", "alloc", "retained", "profile"].includes(mode)
  );
  const { query, database, close, expectedAnswer } = await fixture(
    library,
    workload
  );
  try {
    // Instrument only the untimed witness and restore the exact provider method.
    const sql = [];
    const executions = [];
    const prepare = database.prepare;
    const prepareDescriptor = Object.getOwnPropertyDescriptor(
      database,
      "prepare"
    );
    database.prepare = function (statement) {
      sql.push(statement);
      const prepared = prepare.call(this, statement);
      for (const method of ["all", "get", "run"]) {
        const execute = prepared[method];
        prepared[method] = function (...parameters) {
          executions.push({ sql: statement, parameters });
          return execute.apply(this, parameters);
        };
      }
      return prepared;
    };
    let answer;
    try {
      answer = await query();
    } finally {
      if (prepareDescriptor)
        Object.defineProperty(database, "prepare", prepareDescriptor);
      else assert(Reflect.deleteProperty(database, "prepare"));
    }
    assert.deepStrictEqual(
      Object.getOwnPropertyDescriptor(database, "prepare"),
      prepareDescriptor
    );
    assert(
      executions.length > 0,
      "Witness must capture SQL and bound parameters"
    );
    assert.deepStrictEqual(canonical(answer), canonical(expectedAnswer));
    // Verify the same stock surface used by the timed operation. Restoring
    // only the function would leave an own property on a native prototype API.
    let restoredAnswer = await query();
    assert.deepStrictEqual(
      canonical(restoredAnswer),
      canonical(workload === "insert" ? inserted(1) : expectedAnswer)
    );
    restoredAnswer = undefined;
    const resultDigest = digest(JSON.stringify(canonical(answer)));
    answer = undefined;
    let sink = 0;
    const run = async (count) => {
      for (let i = 0; i < count; i++) {
        const rows = await query();
        sink += Array.isArray(rows)
          ? rows.length + (rows[0]?.id.length ?? 0)
          : rows.age;
      }
    };
    const count = Math.ceil(
      iterations[workload] * (mode === "time" ? timeScale : 1)
    );
    await run(Math.max(100, Math.floor(count / 4)));
    global.gc();
    global.gc();
    const metrics = {};
    const rssBefore = process.memoryUsage().rss;
    if (mode === "time") {
      const cpu = process.cpuUsage();
      const start = performance.now();
      await run(count);
      const wall = performance.now() - start;
      const elapsed = process.cpuUsage(cpu);
      metrics.cpuUs = (elapsed.user + elapsed.system) / count;
      metrics.wallUs = (wall * 1000) / count;
      metrics.opsPerSecond = (count * 1000) / wall;
    } else if (mode !== "retained") {
      const session = new inspector.Session();
      session.connect();
      const post = (method, params = {}) =>
        new Promise((resolve, reject) =>
          session.post(method, params, (error, response) =>
            error ? reject(error) : resolve(response)
          )
        );
      try {
        if (mode === "profile") {
          assert(
            values["profile-dir"],
            "--profile-dir is required for profiles"
          );
          await post("Profiler.enable");
          await post("Profiler.setSamplingInterval", { interval: 100 });
          await post("Profiler.start");
          await run(count * 5);
          const { profile } = await post("Profiler.stop");
          const profilePath = resolve(
            values["profile-dir"],
            `${library}-${workload}-${values.round}.cpuprofile`
          );
          writeFileSync(profilePath, JSON.stringify(profile));
          metrics.profilePath = profilePath;
        } else {
          await post("HeapProfiler.startSampling", {
            samplingInterval: 4096,
            includeObjectsCollectedByMajorGC: true,
            includeObjectsCollectedByMinorGC: true,
          });
          await run(count);
          const { profile } = await post("HeapProfiler.stopSampling");
          const bytes = (node) =>
            node.selfSize +
            node.children.reduce((sum, child) => sum + bytes(child), 0);
          metrics.allocatedBytes = bytes(profile.head) / count;
          if (values["profile-dir"])
            writeFileSync(
              resolve(
                values["profile-dir"],
                `${library}-${workload}-${values.round}.heapprofile`
              ),
              JSON.stringify(profile)
            );
        }
      } finally {
        session.disconnect();
      }
    }
    if (mode === "memory" || mode === "retained") {
      // A separate retained-result window; this is not allocation or process RSS.
      const retainedCount =
        workload === "rows10000" ? 10 : workload === "rows1000" ? 30 : 200;
      const held = new Array(retainedCount);
      global.gc();
      global.gc();
      const before = process.memoryUsage().heapUsed;
      for (let i = 0; i < retainedCount; i++) held[i] = await query();
      global.gc();
      global.gc();
      const after = process.memoryUsage().heapUsed;
      metrics.retainedBytesPerResult = (after - before) / retainedCount;
      sink += held.length;
      held.fill(undefined);
      global.gc();
      global.gc();
      metrics.releasedWindowResidualBytes =
        process.memoryUsage().heapUsed - before;
    }
    return {
      runtime: process.version,
      v8: process.versions.v8,
      rssBefore,
      rssAfter: process.memoryUsage().rss,
      peakRssBytes: process.resourceUsage().maxRSS * 1024,
      library,
      workload,
      mode,
      count: mode === "profile" ? count * 5 : count,
      resultDigest,
      statements: sql,
      executions,
      drizzleReadApi: "relational",
      sink,
      ...metrics,
    };
  } finally {
    await close();
  }
}

if (values.worker) console.log(JSON.stringify(await worker()));
else {
  assert(values.output, "--output is required");
  const rounds = Number(values.rounds);
  assert(Number.isInteger(rounds) && rounds > 0);
  const git = (...args) =>
    execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  const buildHash = createHash("sha256");
  for (const filename of readdirSync(buildDir, { recursive: true })
    .filter((name) => name.endsWith(".mjs"))
    .sort())
    buildHash.update(filename).update(readFileSync(`${buildDir}/${filename}`));
  const prismaClientHash = createHash("sha256");
  if (prismaRoot) {
    for (const filename of readdirSync(`${prismaRoot}/client`, {
      recursive: true,
    })
      .filter((name) => name.endsWith(".js"))
      .sort()) {
      prismaClientHash
        .update(filename)
        .update(readFileSync(`${prismaRoot}/client/${filename}`));
    }
    assert.equal(
      json(`${prismaRoot}/node_modules/@prisma/client/package.json`).version,
      json(
        `${prismaRoot}/node_modules/@prisma/adapter-better-sqlite3/package.json`
      ).version
    );
  }
  const report = {
    metadata: {
      commit: git("rev-parse", "HEAD"),
      trackedChanges: git("diff", "--name-only", "HEAD"),
      runtime: process.version,
      v8: process.versions.v8,
      platform: process.platform,
      arch: process.arch,
      cpu: os.cpus()[0].model,
      loadAtStart: os.loadavg(),
      lockfileSha256: digest(readFileSync(`${root}/pnpm-lock.yaml`)),
      peerLockfileSha256: needsPeer
        ? digest(readFileSync(`${peerRoot}/package-lock.json`))
        : undefined,
      benchmarkSha256: digest(readFileSync(fileURLToPath(import.meta.url))),
      distSha256: buildHash.digest("hex"),
      buildDir,
      drizzle: json(`${drizzleRoot}/node_modules/drizzle-orm/package.json`)
        .version,
      drizzleRoot,
      drizzleReadApi:
        "relational findFirst/findMany; insert uses the write builder",
      drizzleMapperJit: false,
      ordering:
        "All limited reads order by id; filtered20 orders by views desc, id asc",
      drizzleLockfileSha256: values["drizzle-dir"]
        ? digest(readFileSync(`${drizzleRoot}/package-lock.json`))
        : undefined,
      drizzlePeer: needsPeer
        ? json(`${peerRoot}/node_modules/drizzle-orm/package.json`).version
        : undefined,
      betterDrizzle: libraries.includes("better-drizzle")
        ? json(`${peerRoot}/node_modules/better-drizzle/package.json`).version
        : undefined,
      betterSqlite3: json(`${root}/node_modules/better-sqlite3/package.json`)
        .version,
      prisma: prismaRoot
        ? json(`${prismaRoot}/node_modules/@prisma/client/package.json`).version
        : undefined,
      prismaAdapter: prismaRoot
        ? json(
            `${prismaRoot}/node_modules/@prisma/adapter-better-sqlite3/package.json`
          ).version
        : undefined,
      prismaLockfileSha256: prismaRoot
        ? digest(readFileSync(`${prismaRoot}/package-lock.json`))
        : undefined,
      prismaSchemaSha256: prismaRoot
        ? digest(readFileSync(`${prismaRoot}/schema.prisma`))
        : undefined,
      prismaClientSha256: prismaRoot
        ? prismaClientHash.digest("hex")
        : undefined,
      rounds,
      workloads,
      libraries,
      modes,
      timeScale,
      startedAt: new Date().toISOString(),
      protocol:
        "Fresh process per library/workload/mode/round; alternating order; full output checked independently; same awaited harness for sync and async APIs; no plugins or application cache. Exploratory comparison, not an operation-pipeline keep gate.",
    },
    samples: [],
  };
  for (let round = 0; round < rounds; round++) {
    const order = [
      ...libraries.slice(round % libraries.length),
      ...libraries.slice(0, round % libraries.length),
    ];
    for (const workload of workloads)
      for (const mode of modes)
        for (const library of order) {
          const child = spawnSync(
            process.execPath,
            [
              "--expose-gc",
              "--max-old-space-size=512",
              fileURLToPath(import.meta.url),
              ...(peerRoot ? ["--better-dir", peerRoot] : []),
              ...(prismaRoot ? ["--prisma-dir", prismaRoot] : []),
              ...(values["drizzle-dir"] ? ["--drizzle-dir", drizzleRoot] : []),
              "--libraries",
              libraries.join(","),
              "--build-dir",
              buildDir,
              "--time-scale",
              String(timeScale),
              ...(values["profile-dir"]
                ? ["--profile-dir", resolve(values["profile-dir"])]
                : []),
              "--round",
              String(round),
              "--worker",
              library,
              "--workload",
              workload,
              "--mode",
              mode,
            ],
            { encoding: "utf8", timeout: 60_000, maxBuffer: 2 ** 20 }
          );
          assert.equal(child.status, 0, child.error?.message ?? child.stderr);
          const sample = JSON.parse(child.stdout);
          assert.equal(sample.runtime, process.version);
          assert.equal(sample.v8, process.versions.v8);
          const prior = report.samples.find(
            (entry) => entry.workload === workload
          );
          if (prior)
            assert.equal(
              sample.resultDigest,
              prior.resultDigest,
              `${library}/${workload} output mismatch`
            );
          report.samples.push({ round, ...sample });
          writeFileSync(values.output, JSON.stringify(report, null, 2));
          console.error(
            `round ${round + 1}/${rounds}: ${workload}/${mode}/${library}`
          );
        }
  }
  report.summary = workloads.flatMap((workload) =>
    libraries.map((library) => {
      const samples = report.samples.filter(
        (sample) => sample.library === library && sample.workload === workload
      );
      return {
        workload,
        library,
        ...Object.fromEntries(
          [
            "cpuUs",
            "wallUs",
            "opsPerSecond",
            "allocatedBytes",
            "retainedBytesPerResult",
          ].map((metric) => {
            const series = samples
              .filter((sample) => metric in sample)
              .map((sample) => sample[metric]);
            if (!series.length) return [metric, undefined];
            const center = median(series);
            return [
              metric,
              {
                median: center,
                min: Math.min(...series),
                max: Math.max(...series),
                mad: median(series.map((x) => Math.abs(x - center))),
              },
            ];
          })
        ),
      };
    })
  );
  assert.equal(
    digest(readFileSync(fileURLToPath(import.meta.url))),
    report.metadata.benchmarkSha256
  );
  assert.equal(
    digest(readFileSync(`${root}/pnpm-lock.yaml`)),
    report.metadata.lockfileSha256
  );
  const finalBuildHash = createHash("sha256");
  for (const filename of readdirSync(buildDir, { recursive: true })
    .filter((name) => name.endsWith(".mjs"))
    .sort())
    finalBuildHash
      .update(filename)
      .update(readFileSync(`${buildDir}/${filename}`));
  assert.equal(finalBuildHash.digest("hex"), report.metadata.distSha256);
  report.metadata.finishedAt = new Date().toISOString();
  report.metadata.loadAtEnd = os.loadavg();
  writeFileSync(values.output, JSON.stringify(report, null, 2));
  console.table(
    report.summary.map((entry) => ({
      workload: entry.workload,
      library: entry.library,
      cpuUs: entry.cpuUs?.median.toFixed(2),
      wallUs: entry.wallUs?.median.toFixed(2),
      allocatedKB: entry.allocatedBytes
        ? (entry.allocatedBytes.median / 1024).toFixed(2)
        : undefined,
      retainedKB: entry.retainedBytesPerResult
        ? (entry.retainedBytesPerResult.median / 1024).toFixed(2)
        : undefined,
    }))
  );
}
