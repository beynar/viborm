// biome-ignore-all lint/suspicious/noMisplacedAssertion: benchmark evidence must reject incorrect answers.
/**
 * Node/SQLite fresh-client proxy, not Cloudflare isolate evidence.
 * Build artifacts first; this harness never builds or changes dependencies.
 * Worker and coordinator share one file so fixtures, timing boundaries and
 * cross-build witnesses are bound to one protocol hash.
 *
 * node scripts/run-node-safe.mjs 768 600000 benchmarks/first-operation.mjs \
 *   --base-build-dir /absolute/base/dist \
 *   --candidate-build-dir /absolute/candidate/dist --output /absolute/report.json
 *
 * --build-dir selects a single artifact instead. fresh-process measures one
 * first operation per child. fresh-client warms code, then creates a new schema,
 * client, stock driver and native database for every measured first operation.
 * Native fixture seeding is outside all ORM timers. Connection initialization
 * and package imports have separate timers. No public query runs before the
 * timed first query; no application or prepared-query cache is enabled.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  closeSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import {
  formatBoundedResourceLine,
  startBoundedProcess,
} from "../scripts/bounded-process.mjs";

const { values } = parseArgs({
  options: {
    "build-dir": { type: "string" },
    "base-build-dir": { type: "string" },
    "candidate-build-dir": { type: "string" },
    workloads: {
      type: "string",
      default: "unique,filtered20,relation20,insert,rows20,rows1000",
    },
    modes: { type: "string", default: "fresh-process,fresh-client" },
    rounds: { type: "string", default: "5" },
    samples: { type: "string", default: "200" },
    warmup: { type: "string", default: "50" },
    output: { type: "string" },
    worker: { type: "boolean", default: false },
    workload: { type: "string" },
    mode: { type: "string" },
  },
});
const entry = fileURLToPath(import.meta.url);
const root = resolve(dirname(entry), "..");
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const json = (path) => JSON.parse(readFileSync(path, "utf8"));
const boundedInteger = (name, maximum, minimum = 1) => {
  const count = Number(values[name]);
  assert(
    Number.isSafeInteger(count) && count >= minimum && count <= maximum,
    `--${name} must be an integer from ${minimum} through ${maximum}`
  );
  return count;
};
const rounds = boundedInteger("rounds", 30);
const sampleCount = boundedInteger("samples", 10_000);
const warmupCount = boundedInteger("warmup", 1000, 0);
const workloads = values.workloads.split(",");
const modes = values.modes.split(",");
const allowedWorkloads = [
  "unique",
  "filtered20",
  "relation20",
  "insert",
  "rows20",
  "rows1000",
];
assert(
  workloads.length > 0 &&
    new Set(workloads).size === workloads.length &&
    workloads.every((workload) => allowedWorkloads.includes(workload))
);
assert(
  modes.length > 0 &&
    new Set(modes).size === modes.length &&
    modes.every((mode) => ["fresh-process", "fresh-client"].includes(mode))
);

const users = Array.from({ length: 100 }, (_, index) => ({
  id: `u${index}`,
  name: `User ${index}`,
  email: `u${index}@x.com`,
  age: 20 + (index % 50),
}));
const posts = Array.from({ length: 1000 }, (_, index) => ({
  id: `p${index}`,
  title: `Post ${index}`,
  content: `content ${index}`,
  published: Boolean(index % 2),
  views: index,
  authorId: `u${index % 100}`,
}));
const orderedPosts = [...posts].sort((left, right) => {
  if (left.id === right.id) return 0;
  return left.id < right.id ? -1 : 1;
});
const inserted = (index = 0) => ({
  id: `new${index}`,
  name: "B",
  email: "b@x.com",
  age: 30,
});
const expected = {
  unique: users[42],
  filtered20: posts
    .filter((post) => post.published)
    .reverse()
    .slice(0, 20)
    .map(({ id, title, views }) => ({ id, title, views })),
  relation20: orderedPosts.slice(0, 20).map(({ id, title, authorId }) => {
    const author = users.find((user) => user.id === authorId);
    return { id, title, author: { id: author.id, name: author.name } };
  }),
  insert: inserted(),
  rows20: orderedPosts.slice(0, 20),
  rows1000: orderedPosts,
};
const canonical = (value) => {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key])])
    );
  return value;
};
const expectedDigests = Object.fromEntries(
  allowedWorkloads.map((workload) => [
    workload,
    digest(JSON.stringify(canonical(expected[workload]))),
  ])
);
const startClock = () => ({
  cpu: process.cpuUsage(),
  wall: performance.now(),
});
const stopClock = (start) => {
  const wallUs = (performance.now() - start.wall) * 1000;
  const cpu = process.cpuUsage(start.cpu);
  return { wallUs, cpuUs: cpu.user + cpu.system };
};
const median = (series) => {
  const sorted = [...series].sort((left, right) => left - right);
  return (
    (sorted[Math.floor((sorted.length - 1) / 2)] +
      sorted[Math.floor(sorted.length / 2)]) /
    2
  );
};
const statistics = (series) => {
  const center = median(series);
  return {
    mean: series.reduce((sum, value) => sum + value, 0) / series.length,
    median: center,
    mad: median(series.map((value) => Math.abs(value - center))),
    min: Math.min(...series),
    max: Math.max(...series),
  };
};
const phases = ["schemaClient", "connection", "firstQuery"];
const summarize = (samples) =>
  Object.fromEntries(
    phases.map((phase) => [
      phase,
      Object.fromEntries(
        ["wallUs", "cpuUs"].map((metric) => [
          metric,
          statistics(samples.map((sample) => sample[phase][metric])),
        ])
      ),
    ])
  );

function artifactIdentity(buildDir) {
  const hash = createHash("sha256");
  for (const filename of readdirSync(buildDir, { recursive: true })
    .filter((filename) => filename.endsWith(".mjs"))
    .sort())
    hash.update(filename).update(readFileSync(join(buildDir, filename)));
  const require = createRequire(join(buildDir, "sqlite3.mjs"));
  const nativePackage = require.resolve("better-sqlite3/package.json");
  return {
    buildDir,
    distSha256: hash.digest("hex"),
    betterSqlite3: json(nativePackage).version,
    nativePackage,
  };
}

function createFreshClient({ s, createClient, SQLite3Driver }) {
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
  const driver = new SQLite3Driver({ dataDir: ":memory:" });
  return { client: createClient({ schema: { user, post }, driver }), driver };
}

function seedNativeDatabase(database) {
  database.exec(
    "CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT, email TEXT NOT NULL, age INTEGER); CREATE TABLE posts (id TEXT PRIMARY KEY, title TEXT NOT NULL, content TEXT, published INTEGER NOT NULL, views INTEGER NOT NULL, authorId TEXT NOT NULL)"
  );
  database.transaction(() => {
    const writeUser = database.prepare("INSERT INTO users VALUES (?,?,?,?)");
    const writePost = database.prepare(
      "INSERT INTO posts VALUES (?,?,?,?,?,?)"
    );
    for (const user of users)
      writeUser.run(user.id, user.name, user.email, user.age);
    for (const post of posts)
      writePost.run(
        post.id,
        post.title,
        post.content,
        Number(post.published),
        post.views,
        post.authorId
      );
  })();
}

function runFirstQuery(client, workload, insertIndex = 0) {
  switch (workload) {
    case "unique":
      return client.user.findUnique({ where: { id: "u42" } });
    case "filtered20":
      return client.post.findMany({
        where: { published: true },
        select: { id: true, title: true, views: true },
        orderBy: { views: "desc" },
        take: 20,
      });
    case "relation20":
      return client.post.findMany({
        select: {
          id: true,
          title: true,
          author: { select: { id: true, name: true } },
        },
        orderBy: { id: "asc" },
        take: 20,
      });
    case "insert":
      return client.user.create({ data: inserted(insertIndex) });
    case "rows20":
    case "rows1000":
      return client.post.findMany({
        orderBy: { id: "asc" },
        take: Number(workload.slice(4)),
      });
    default:
      assert.fail(`Unknown workload ${workload}`);
  }
}

async function sampleFirstOperation(api, workload) {
  const setupStart = startClock();
  const { client, driver } = createFreshClient(api);
  const schemaClient = stopClock(setupStart);
  try {
    const connectionStart = startClock();
    const database = await driver.getClient();
    const connection = stopClock(connectionStart);
    seedNativeDatabase(database);
    const queryStart = startClock();
    const answer = await runFirstQuery(client, workload);
    const firstQuery = stopClock(queryStart);
    assert.deepStrictEqual(canonical(answer), canonical(expected[workload]));
    return { schemaClient, connection, firstQuery };
  } finally {
    await driver.disconnect();
  }
}

async function witnessFirstOperation(api, workload) {
  const { client, driver } = createFreshClient(api);
  try {
    const database = await driver.getClient();
    seedNativeDatabase(database);
    const statements = [];
    const descriptor = Object.getOwnPropertyDescriptor(database, "prepare");
    const prepare = database.prepare;
    database.prepare = function (sql) {
      const statement = prepare.call(this, sql);
      for (const method of ["all", "get", "run"]) {
        const execute = statement[method];
        statement[method] = function (...parameters) {
          statements.push({ sql, parameters });
          return execute.apply(this, parameters);
        };
      }
      return statement;
    };
    try {
      const answer = await runFirstQuery(client, workload);
      assert.deepStrictEqual(canonical(answer), canonical(expected[workload]));
    } finally {
      if (descriptor) Object.defineProperty(database, "prepare", descriptor);
      else assert(Reflect.deleteProperty(database, "prepare"));
    }
    // Verify the original native descriptor and stock path after recording.
    assert.deepStrictEqual(
      Object.getOwnPropertyDescriptor(database, "prepare"),
      descriptor
    );
    const restoredAnswer = await runFirstQuery(client, workload, 1);
    assert.deepStrictEqual(
      canonical(restoredAnswer),
      canonical(workload === "insert" ? inserted(1) : expected[workload])
    );
    assert(statements.length > 0, "The SQL witness captured no execution");
    return {
      statements,
      statementDigest: digest(JSON.stringify(statements)),
      resultDigest: expectedDigests[workload],
      recordingSurface:
        "Separate untimed client; native prepare/execution recorder; keyed transport while intercepted; descriptor restored and stock result checked",
    };
  } finally {
    await driver.disconnect();
  }
}

async function worker() {
  assert(values["build-dir"], "Worker requires --build-dir");
  assert(allowedWorkloads.includes(values.workload));
  assert(["fresh-process", "fresh-client"].includes(values.mode));
  const buildDir = resolve(values["build-dir"]);
  const importStart = startClock();
  const { s } = await import(pathToFileURL(join(buildDir, "schema.mjs")));
  const { createClient } = await import(
    pathToFileURL(join(buildDir, "index.mjs"))
  );
  const { SQLite3Driver } = await import(
    pathToFileURL(join(buildDir, "sqlite3.mjs"))
  );
  const moduleImport = stopClock(importStart);
  const api = { s, createClient, SQLite3Driver };
  const freshProcess = values.mode === "fresh-process";
  const warmup = freshProcess ? 0 : warmupCount;
  for (let index = 0; index < warmup; index++)
    await sampleFirstOperation(api, values.workload);
  const samples = [];
  const count = freshProcess ? 1 : sampleCount;
  for (let index = 0; index < count; index++)
    samples.push(await sampleFirstOperation(api, values.workload));
  // A witness must not turn the measured client's first operation into its second.
  const witness = await witnessFirstOperation(api, values.workload);
  return {
    runtime: process.version,
    v8: process.versions.v8,
    execPath: process.execPath,
    artifact: artifactIdentity(buildDir),
    workload: values.workload,
    mode: values.mode,
    warmup,
    count,
    moduleImport,
    samples,
    summary: summarize(samples),
    witness,
    peakRssBytes: process.resourceUsage().maxRSS * 1024,
  };
}

async function coordinate() {
  assert(values.output, "--output is required");
  const paired = values["base-build-dir"] || values["candidate-build-dir"];
  assert(
    !paired ||
      (values["base-build-dir"] &&
        values["candidate-build-dir"] &&
        !values["build-dir"]),
    "Use --build-dir OR both --base-build-dir and --candidate-build-dir"
  );
  const builds = paired
    ? [
        { label: "baseline", buildDir: resolve(values["base-build-dir"]) },
        {
          label: "candidate",
          buildDir: resolve(values["candidate-build-dir"]),
        },
      ]
    : [
        {
          label: "build",
          buildDir: resolve(values["build-dir"] ?? join(root, "dist")),
        },
      ];
  const identities = builds.map(({ label, buildDir }) => ({
    label,
    ...artifactIdentity(buildDir),
  }));
  if (paired)
    assert.equal(
      identities[0].nativePackage,
      identities[1].nativePackage,
      "Both builds must resolve the same native SQLite module"
    );
  const report = {
    metadata: {
      startedAt: new Date().toISOString(),
      runtime: process.version,
      v8: process.versions.v8,
      execPath: process.execPath,
      platform: process.platform,
      arch: process.arch,
      cpu: os.cpus()[0].model,
      loadAtStart: os.loadavg(),
      benchmarkSha256: digest(readFileSync(entry)),
      lockfileSha256: digest(readFileSync(join(root, "pnpm-lock.yaml"))),
      builds: identities,
      rounds,
      workloads,
      modes,
      samplesPerFreshClientWorker: sampleCount,
      warmupClientsPerFreshClientWorker: warmupCount,
      evidenceBoundary:
        "Node/SQLite fresh-client proxy; no Cloudflare isolate, Workers runtime, network or hosted-provider evidence",
      protocol: {
        schemaClient:
          "Fresh model/scalar/relation declarations, fresh stock driver and createClient; no reused schema or client",
        connection:
          "getClient initializes a fresh owned in-memory native database; included separately, no shared connection",
        firstQuery:
          "Exactly the first public operation from call through awaited full public result; no prior public query or preparation",
        excluded:
          "Native DDL/fixture seeding, full-result verification, SQL witnessing and disconnect; no timings include these stages",
        freshProcess:
          "One measured schema/client and first query per fresh child; no ORM warmup; package imports separately measured; harness/process startup excluded",
        freshClient:
          "Code and module cache warmed by disposable fresh clients; every measured schema, client, driver and database is new; this is not cold-process evidence",
        fixture:
          "100 users and 1000 posts freshly seeded through native SQLite per sample; insert always starts from the same fixture",
        caches:
          "No extensions, application cache, prepared-query reuse, shared schema, shared client or shared connection; only fresh-client mode reuses code/module/JIT state",
        execution:
          "Sequential children pinned to parent process.execPath; alternate paired build order per round; each child has a 512 MiB heap, 1536 MiB sampled RSS ceiling and 60 s deadline with verified teardown",
        statistics:
          "Per-worker sample statistics; report summary is across round means, not pooled pseudo-independent samples; CPU includes V8/background work inside each timed interval",
        witnesses:
          "Full values checked independently after every timed query; SQL text and bound native parameters recorded only after timing on a separate client; recorder disables positional transport while active",
      },
    },
    runs: [],
  };
  const temporary = mkdtempSync(join(os.tmpdir(), "viborm-first-operation-"));
  const stdoutFile = join(temporary, "worker.json");
  const stderrFile = join(temporary, "worker-errors.txt");
  let active;
  const terminate = () => active?.terminate("SIGTERM", "interrupted");
  process.on("SIGINT", terminate);
  process.on("SIGTERM", terminate);
  try {
    for (let round = 0; round < rounds; round++) {
      const order = round % 2 ? [...builds].reverse() : builds;
      for (const workload of workloads)
        for (const mode of modes)
          for (const build of order) {
            const label = `${round + 1}/${rounds} ${build.label}/${workload}/${mode}`;
            const stdout = openSync(stdoutFile, "w");
            const stderr = openSync(stderrFile, "w");
            let outcome;
            try {
              active = startBoundedProcess({
                command: process.execPath,
                arguments: [
                  entry,
                  "--worker",
                  "--build-dir",
                  build.buildDir,
                  "--workload",
                  workload,
                  "--mode",
                  mode,
                  "--samples",
                  String(sampleCount),
                  "--warmup",
                  String(warmupCount),
                ],
                heapLimitMb: 512,
                wallLimitMs: 60_000,
                label,
                stdio: ["ignore", stdout, stderr],
              });
              outcome = await active.completion;
            } finally {
              active = undefined;
              closeSync(stdout);
              closeSync(stderr);
            }
            process.stderr.write(
              `${formatBoundedResourceLine(label, outcome)}\n`
            );
            assert(
              !(outcome.error || outcome.stopReason) && outcome.code === 0,
              `${label} failed: ${outcome.error?.message ?? outcome.stopReason ?? readFileSync(stderrFile, "utf8")}`
            );
            const run = JSON.parse(readFileSync(stdoutFile, "utf8"));
            assert.equal(run.execPath, process.execPath);
            assert.equal(run.runtime, process.version);
            assert.equal(run.v8, process.versions.v8);
            assert.deepStrictEqual(
              { label: build.label, ...run.artifact },
              identities.find((identity) => identity.label === build.label),
              "The worker artifact differs from the initially captured build"
            );
            assert.equal(run.witness.resultDigest, expectedDigests[workload]);
            const previous = report.runs.find(
              (prior) => prior.workload === workload
            );
            if (previous)
              assert.equal(
                previous.witness.statementDigest,
                run.witness.statementDigest,
                "Generated SQL/parameters differ across builds or runs"
              );
            report.runs.push({ round, build: build.label, ...run });
            writeFileSync(
              resolve(values.output),
              JSON.stringify(report, null, 2)
            );
          }
    }
    report.summary = workloads.flatMap((workload) =>
      modes.flatMap((mode) =>
        builds.map(({ label }) => {
          const runs = report.runs.filter(
            (run) =>
              run.workload === workload &&
              run.mode === mode &&
              run.build === label
          );
          return {
            workload,
            mode,
            build: label,
            rounds: runs.length,
            measuredClients: runs.reduce((count, run) => count + run.count, 0),
            ...Object.fromEntries(
              phases.map((phase) => [
                phase,
                Object.fromEntries(
                  ["wallUs", "cpuUs"].map((metric) => [
                    metric,
                    statistics(
                      runs.map((run) => run.summary[phase][metric].mean)
                    ),
                  ])
                ),
              ])
            ),
            moduleImport: Object.fromEntries(
              ["wallUs", "cpuUs"].map((metric) => [
                metric,
                statistics(runs.map((run) => run.moduleImport[metric])),
              ])
            ),
          };
        })
      )
    );
    assert.deepStrictEqual(
      builds.map(({ label, buildDir }) => ({
        label,
        ...artifactIdentity(buildDir),
      })),
      identities,
      "A build artifact changed during the comparison"
    );
    assert.equal(
      digest(readFileSync(entry)),
      report.metadata.benchmarkSha256,
      "The harness changed during the comparison"
    );
    assert.equal(
      digest(readFileSync(join(root, "pnpm-lock.yaml"))),
      report.metadata.lockfileSha256,
      "The lockfile changed during the comparison"
    );
    report.metadata.loadAtEnd = os.loadavg();
    report.metadata.crossBuildStatementMatches = paired
      ? Object.fromEntries(
          workloads.map((workload) => [
            workload,
            report.runs.find(
              (run) => run.build === "baseline" && run.workload === workload
            ).witness.statementDigest ===
              report.runs.find(
                (run) => run.build === "candidate" && run.workload === workload
              ).witness.statementDigest,
          ])
        )
      : undefined;
    report.metadata.finishedAt = new Date().toISOString();
    writeFileSync(resolve(values.output), JSON.stringify(report, null, 2));
    console.table(
      report.summary.map((summary) => ({
        build: summary.build,
        workload: summary.workload,
        mode: summary.mode,
        clients: summary.measuredClients,
        setupWallUs: summary.schemaClient.wallUs.median.toFixed(2),
        setupCpuUs: summary.schemaClient.cpuUs.median.toFixed(2),
        connectionWallUs: summary.connection.wallUs.median.toFixed(2),
        firstQueryWallUs: summary.firstQuery.wallUs.median.toFixed(2),
        firstQueryCpuUs: summary.firstQuery.cpuUs.median.toFixed(2),
      }))
    );
  } finally {
    process.off("SIGINT", terminate);
    process.off("SIGTERM", terminate);
    rmSync(temporary, { recursive: true, force: true });
  }
}

if (values.worker) console.log(JSON.stringify(await worker()));
else await coordinate();
