// biome-ignore-all lint/suspicious/noMisplacedAssertion: Standalone benchmark correctness gates use node:assert, not a test runner.
/**
 * End-to-end policy cost over equivalent filtered reads. Build the package first.
 * node scripts/run-node-safe.mjs 768 180000 benchmarks/rbac-policies.mjs
 * See rbac-policies.md for controls, interpretation and isolation guarantees.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { cpus, release } from "node:os";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { createClient, s } from "../dist/index.mjs";
import { rbac } from "../dist/rbac.mjs";
import { SQLite3Driver } from "../dist/sqlite3.mjs";
import { v } from "../dist/validation.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
function integer(name, fallback, min, max) {
  const value = Number(process.env[name] ?? fallback);
  assert(
    Number.isSafeInteger(value) && value >= min && value <= max,
    `${name} must be an integer in ${min}..${max}`
  );
  return value;
}
const rows = integer("RBAC_BENCH_ROWS", 10_000, 1000, 100_000);
const samples = integer("RBAC_BENCH_SAMPLES", 100, 10, 1000);
const warmups = integer("RBAC_BENCH_WARMUPS", 10, 1, 100);
const pageSize = 50;
const organizationCount = 100;
const actor = { userId: "user-0" };
const id = (index) => `doc-${String(index).padStart(6, "0")}`;
const owner = (index) =>
  `user-${(Math.floor(index / organizationCount) + (index % organizationCount) * 7) % 100}`;
const parentIndex = (index) =>
  Math.floor(index / organizationCount) % 16 === 0
    ? null
    : index - organizationCount;
const organizationMembers = (organizationIndex) =>
  Array.from(
    { length: 10 },
    (_, offset) => `user-${(organizationIndex * 7 + offset) % 100}`
  );

const organization = s.model({
  id: s.string().id(),
  members: s.toMany(() => member),
  documents: s.toMany(() => document),
});
const member = s.model({
  id: s.string().id(),
  organizationId: s.string(),
  userId: s.string(),
  organization: s
    .toOne(() => organization)
    .fields("organizationId")
    .references("id"),
});
const document = s.model({
  id: s.string().id(),
  title: s.string(),
  ownerId: s.string(),
  organizationId: s.string(),
  parentId: s.string().nullable(),
  organization: s
    .toOne(() => organization)
    .fields("organizationId")
    .references("id"),
  parent: s
    .toOne(() => document)
    .fields("parentId")
    .references("id"),
  children: s.toMany(() => document),
  shares: s.toMany(() => share),
});
const share = s.model({
  id: s.string().id(),
  documentId: s.string(),
  userId: s.string(),
  document: s
    .toOne(() => document)
    .fields("documentId")
    .references("id"),
});
const schema = { organization, member, document, share };

// SQLite owns a memory database. PostgreSQL owns one connection and creates
// its entire random namespace inside a transaction that is always rolled back.
const provider = process.env.RBAC_BENCH_PROVIDER ?? "sqlite3";
assert(
  ["sqlite3", "pg"].includes(provider),
  "RBAC_BENCH_PROVIDER must be sqlite3 or pg"
);
const jit = process.env.RBAC_BENCH_JIT ?? "default";
assert(
  ["default", "on", "off"].includes(jit),
  "RBAC_BENCH_JIT must be default, on or off"
);
assert(
  provider === "pg" || jit === "default",
  "JIT selection is only meaningful for PostgreSQL"
);
let transport;
let driver;
let namespace;
let databaseVersion;
let jitSettings;
if (provider === "sqlite3") {
  transport = new Database(":memory:");
  transport.pragma("foreign_keys = ON");
  driver = new SQLite3Driver({ client: transport });
  databaseVersion = transport
    .prepare("SELECT sqlite_version() AS version")
    .get().version;
} else {
  const connectionString = process.env.RBAC_BENCH_PG_URL;
  assert(
    connectionString,
    "RBAC_BENCH_PG_URL must identify a local PostgreSQL database"
  );
  const url = new URL(connectionString);
  assert(
    ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname),
    "PostgreSQL benchmarks are restricted to loopback hosts"
  );
  const [{ Pool }, { PgDriver }] = await Promise.all([
    import("pg"),
    import("../dist/pg.mjs"),
  ]);
  // A one-connection pool ensures every setup and ORM query shares this BEGIN.
  transport = new Pool({
    connectionString,
    max: 1,
    connectionTimeoutMillis: 5000,
  });
  namespace = `rbac_bench_${randomUUID().replaceAll("-", "")}`;
  driver = new PgDriver({ pool: transport, namespace });
}
const base = createClient({ schema, driver });
const table = (name) => (namespace ? `"${namespace}"."${name}"` : `"${name}"`);
const execute = (sql, parameters = []) =>
  provider === "sqlite3"
    ? Promise.resolve(transport.prepare(sql).run(...parameters))
    : transport.query(sql, parameters);
try {
  if (provider === "pg") {
    await transport.query("BEGIN");
    await transport.query("SET LOCAL statement_timeout = '15s'");
    if (jit !== "default") await transport.query(`SET LOCAL jit = ${jit}`);
    await transport.query(`CREATE SCHEMA "${namespace}"`);
    databaseVersion = (await transport.query("SHOW server_version")).rows[0]
      .server_version;
    jitSettings = (
      await transport.query(
        "SELECT name, setting FROM pg_settings WHERE name IN ('jit', 'jit_above_cost', 'jit_inline_above_cost', 'jit_optimize_above_cost') ORDER BY name"
      )
    ).rows;
  } else {
    transport.exec("PRAGMA foreign_keys = ON; BEGIN");
  }
  for (const ddl of [
    `CREATE TABLE ${table("organization")} (id TEXT PRIMARY KEY)`,
    `CREATE TABLE ${table("member")} (id TEXT PRIMARY KEY, "organizationId" TEXT NOT NULL
      REFERENCES ${table("organization")}(id), "userId" TEXT NOT NULL)`,
    `CREATE TABLE ${table("document")} (id TEXT PRIMARY KEY, title TEXT NOT NULL,
      "ownerId" TEXT NOT NULL, "organizationId" TEXT NOT NULL REFERENCES ${table("organization")}(id),
      "parentId" TEXT REFERENCES ${table("document")}(id))`,
    `CREATE TABLE ${table("share")} (id TEXT PRIMARY KEY, "documentId" TEXT NOT NULL
      REFERENCES ${table("document")}(id), "userId" TEXT NOT NULL)`,
    `CREATE INDEX member_org_user ON ${table("member")}("organizationId", "userId")`,
    `CREATE INDEX document_owner ON ${table("document")}("ownerId")`,
    `CREATE INDEX document_org ON ${table("document")}("organizationId")`,
    `CREATE INDEX document_parent ON ${table("document")}("parentId")`,
    `CREATE INDEX share_document_user ON ${table("share")}("documentId", "userId")`,
  ])
    await execute(ddl);
  async function insert(name, records) {
    for (let start = 0; start < records.length; start += 100) {
      const parameters = [];
      const tuples = records.slice(start, start + 100).map(
        (record) =>
          `(${record
            .map((value) => {
              parameters.push(value);
              return provider === "sqlite3" ? "?" : `$${parameters.length}`;
            })
            .join(",")})`
      );
      await execute(
        `INSERT INTO ${table(name)} VALUES ${tuples.join(",")}`,
        parameters
      );
    }
  }
  await insert(
    "organization",
    Array.from({ length: organizationCount }, (_, index) => [`org-${index}`])
  );
  await insert(
    "member",
    Array.from({ length: organizationCount }, (_, index) =>
      organizationMembers(index).map((user) => [
        `${index}-${user}`,
        `org-${index}`,
        user,
      ])
    ).flat()
  );
  await insert(
    "document",
    Array.from({ length: rows }, (_, index) => {
      const parent = parentIndex(index);
      return [
        id(index),
        `Document ${index}`,
        owner(index),
        `org-${index % organizationCount}`,
        parent === null ? null : id(parent),
      ];
    })
  );
  await insert(
    "share",
    Array.from({ length: rows }, (_, index) => index)
      .filter((index) => index % 3 === 0)
      .map((index) => [
        `share-${index}`,
        id(index),
        `user-${(index * 13) % 100}`,
      ])
  );
  for (const name of Object.keys(schema))
    await execute(`ANALYZE ${table(name)}`);
  if (provider === "sqlite3") transport.exec("COMMIT");

  // The same application rule is expressed once with a literal for the plain
  // ORM and once with a bound actor reference for RBAC. Expected IDs below are
  // computed from the generated graph, not from either query implementation.
  const cases = [
    {
      name: "ownership",
      rule: (user) => ({ ownerId: user }),
      allowed: (index) => owner(index) === actor.userId,
    },
    {
      name: "organization-membership",
      rule: (user) => ({
        organization: { members: { some: { userId: user } } },
      }),
      allowed: (index) =>
        organizationMembers(index % organizationCount).includes(actor.userId),
    },
    {
      name: "direct-sharing",
      rule: (user) => ({
        OR: [{ ownerId: user }, { shares: { some: { userId: user } } }],
      }),
      allowed: (index) =>
        owner(index) === actor.userId ||
        (index % 3 === 0 && (index * 13) % 100 === 0),
    },
    {
      name: "recursive-folder-ownership",
      rule: (user) => ({
        parent: {
          recurse: { depth: false },
          self: true,
          some: { ownerId: user },
        },
      }),
      allowed: (index) => {
        for (
          let current = index;
          current !== null;
          current = parentIndex(current)
        ) {
          if (owner(current) === actor.userId) return true;
        }
        return false;
      },
    },
  ];
  const results = [];
  for (const workload of cases) {
    const guarded = base
      .$extends(
        rbac({
          actor: v.object({ userId: v.string() }),
          models: {
            document: {
              actions: { read: [], update: [], delete: [] },
              operations: { read: "read", update: "update", delete: "delete" },
              update: { OR: [] },
              delete: { OR: [] },
              read: workload.rule({ actor: "userId" }),
            },
          },
        })
      )
      .$as(actor);
    const baselineArgs = {
      where: workload.rule(actor.userId),
      select: { id: true, title: true },
      orderBy: { id: "asc" },
    };
    const protectedArgs = {
      select: { id: true, title: true },
      orderBy: { id: "asc" },
    };
    const expected = Array.from({ length: rows }, (_, index) => index)
      .filter(workload.allowed)
      .map(id);
    assert(
      expected.length > 0 && expected.length < rows,
      `${workload.name}: seed must contain permitted and denied rows`
    );
    const baselineFull = await base.document.findMany(baselineArgs);
    const protectedFull = await guarded.document.findMany(protectedArgs);
    assert.deepEqual(
      baselineFull.map((row) => row.id),
      expected
    );
    assert.deepEqual(protectedFull, baselineFull);
    baselineArgs.take = pageSize;
    protectedArgs.take = pageSize;

    async function sqlMetrics(client, args) {
      const statements = [];
      let captured;
      await client
        .$extends({
          name: "benchmark-statement-capture",
          statement: ({ statement }) => {
            const sql = statement.toStatement(
              provider === "sqlite3" ? "?" : "$n"
            );
            captured = { sql, parameters: statement.values };
            statements.push({
              bytes: Buffer.byteLength(sql),
              parameters: statement.values.length,
              sha256: createHash("sha256").update(sql).digest("hex"),
            });
            return statement;
          },
        })
        .document.findMany(args);
      assert.equal(
        statements.length,
        1,
        "Each measured read must execute one statement"
      );
      if (provider === "pg") {
        const explained = await transport.query(
          `EXPLAIN (ANALYZE, FORMAT JSON) ${captured.sql}`,
          captured.parameters
        );
        const plan = explained.rows[0]["QUERY PLAN"][0];
        function countNodes(node) {
          return (
            1 +
            (node.Plans ?? []).reduce(
              (count, child) => count + countNodes(child),
              0
            )
          );
        }
        statements[0].explain = {
          totalCost: plan.Plan["Total Cost"],
          nodes: countNodes(plan.Plan),
          planningMs: plan["Planning Time"],
          executionMs: plan["Execution Time"],
          jit: plan.JIT ?? null,
        };
      }
      return statements[0];
    }
    const sql = {
      baseline: await sqlMetrics(base, baselineArgs),
      protected: await sqlMetrics(guarded, protectedArgs),
    };
    const run = {
      baseline: () => base.document.findMany(baselineArgs),
      protected: () => guarded.document.findMany(protectedArgs),
    };
    const durations = { baseline: [], protected: [] };
    for (let iteration = -warmups; iteration < samples; iteration++) {
      // Alternate first mover; both sides execute independently, sequentially.
      for (const variant of iteration % 2 === 0
        ? ["baseline", "protected"]
        : ["protected", "baseline"]) {
        const start = performance.now();
        const returned = await run[variant]();
        const elapsed = performance.now() - start;
        assert.deepEqual(
          returned.map((row) => row.id),
          expected.slice(0, pageSize)
        );
        if (iteration >= 0) durations[variant].push(elapsed);
      }
    }
    function summary(values) {
      const sorted = [...values].sort((left, right) => left - right);
      const percentile = (fraction) =>
        sorted[Math.ceil(sorted.length * fraction) - 1];
      return {
        p50Ms: percentile(0.5),
        p95Ms: percentile(0.95),
        minMs: sorted[0],
        maxMs: sorted.at(-1),
      };
    }
    results.push({
      name: workload.name,
      permittedRows: expected.length,
      returnedRows: Math.min(pageSize, expected.length),
      sql,
      baseline: summary(durations.baseline),
      protected: summary(durations.protected),
      samplesMs: durations,
    });
  }

  // Fingerprint the measured build and harness: a dirty HEAD alone is not an
  // identity for the code actually loaded from dist.
  const files = readdirSync(join(root, "dist"), { recursive: true })
    .filter((file) => file.endsWith(".mjs"))
    .sort();
  const hash = createHash("sha256");
  for (const file of files)
    hash
      .update(file)
      .update("\0")
      .update(readFileSync(join(root, "dist", file)));
  const report = {
    format: "viborm-rbac-policy-benchmark-v1",
    measuredAt: new Date().toISOString(),
    identity: {
      commit: execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: root,
        encoding: "utf8",
      }).trim(),
      dirty:
        execFileSync("git", ["status", "--porcelain"], {
          cwd: root,
          encoding: "utf8",
        }).trim().length > 0,
      buildSha256: hash.digest("hex"),
      harnessSha256: createHash("sha256")
        .update(readFileSync(fileURLToPath(import.meta.url)))
        .digest("hex"),
    },
    runtime: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      osRelease: release(),
      cpu: cpus()[0]?.model,
      databaseVersion,
    },
    configuration: {
      provider,
      jit,
      jitSettings,
      documents: rows,
      organizations: organizationCount,
      memberships: organizationCount * 10,
      shares: Math.ceil(rows / 3),
      maxTreeNodes: 16,
      pageSize,
      samples,
      warmups,
      actor,
    },
    metric:
      "Warm end-to-end findMany latency, including ORM preparation and result parsing; setup and correctness assertions excluded",
    limitations: [
      "One process and one database connection; no contention or production network",
      "Read workloads only; no mutation, revocation or concurrency performance claim",
      ...(provider === "sqlite3"
        ? ["No PostgreSQL planner/JIT measurement"]
        : [
            "PostgreSQL reads share a setup transaction; no connection-pool or transaction-boundary cost",
          ]),
      "No cross-provider or competitor speed claim",
      "Baseline manually supplies an equivalent predicate; it is not an unrestricted scan",
    ],
    results,
  };
  const json = `${JSON.stringify(report, null, 2)}\n`;
  if (process.env.RBAC_BENCH_OUTPUT)
    writeFileSync(process.env.RBAC_BENCH_OUTPUT, json, { flag: "wx" });
  process.stdout.write(json);
} finally {
  try {
    await base.$disconnect();
  } finally {
    if (provider === "sqlite3") transport.close();
    else {
      try {
        await transport.query("ROLLBACK");
      } finally {
        await transport.end();
      }
    }
  }
}
