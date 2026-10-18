// biome-ignore-all lint/suspicious/noMisplacedAssertion: Standalone benchmark assertions.
/** Compare the public driver's SQL strategies on identical RBAC operations.
 * Build first, then run with scripts/run-node-safe.mjs (768 MiB, 180000 ms).
 * SHARED_BENCH_PG_URL must be loopback; all fixtures live in one rolled-back
 * transaction. SHARED_BENCH_OUTPUT is a new JSON file; no credentials recorded.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { cpus, release } from "node:os";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { createClient, s } from "../dist/index.mjs";
import { permissions } from "../dist/permissions.mjs";
import { PgDriver } from "../dist/pg.mjs";
import { v } from "../dist/validation.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const output = process.env.SHARED_BENCH_OUTPUT;
assert(
  output && !existsSync(output),
  "Supply an unused SHARED_BENCH_OUTPUT path"
);
const connectionString = process.env.SHARED_BENCH_PG_URL;
assert(connectionString, "SHARED_BENCH_PG_URL is required");
assert(
  ["localhost", "127.0.0.1", "[::1]"].includes(
    new URL(connectionString).hostname
  )
);
function integer(name, fallback, min, max) {
  const value = Number(process.env[name] ?? fallback);
  assert(Number.isSafeInteger(value) && value >= min && value <= max, name);
  return value;
}
const samples = integer("SHARED_BENCH_SAMPLES", 30, 2, 100);
const warmups = integer("SHARED_BENCH_WARMUPS", 5, 1, 20);
const rotation = integer("SHARED_BENCH_ROTATION", 0, 0, 9);
const jit = process.env.SHARED_BENCH_JIT ?? "off";
assert(["on", "off"].includes(jit));
const organizations = 100_000;
const invoices = 200_000;
const profiles = [
  { name: "narrow", member: (id) => id % 1000 === 1, count: 100 },
  { name: "medium", member: (id) => id % 100 === 1, count: 1000 },
  { name: "broad", member: (id) => id % 10 !== 0, count: 90_000 },
];
const sellerOf = (id) => ((id - 1) % organizations) + 1;
const buyerOf = (id) => ((id * 37 + 12_339) % organizations) + 1;
const organization = s.model({
  id: s.int().id(),
  members: s.toMany(() => membership),
  sales: s.toMany(() => invoice).name("seller"),
  purchases: s.toMany(() => invoice).name("buyer"),
});
const membership = s.model({
  id: s.int().id(),
  organizationId: s.int(),
  userId: s.string(),
  organization: s
    .toOne(() => organization)
    .fields("organizationId")
    .references("id"),
});
const invoice = s.model({
  id: s.int().id(),
  sellerId: s.int(),
  buyerId: s.int(),
  label: s.string(),
  seller: s
    .toOne(() => organization)
    .name("seller")
    .fields("sellerId")
    .references("id"),
  buyer: s
    .toOne(() => organization)
    .name("buyer")
    .fields("buyerId")
    .references("id"),
});
const schema = { organization, membership, invoice };
const memberRule = { members: { some: { userId: { actor: "userId" } } } };
const bothRule = {
  OR: [{ seller: { is: memberRule } }, { buyer: { is: memberRule } }],
};
const policy = (rule) =>
  permissions({
    actor: v.object({ userId: v.string() }),
    models: { invoice: { "read, update": rule } },
  });
const namespace = `shared_bench_${randomUUID().replaceAll("-", "")}`;
const table = (name) => `"${namespace}"."${name}"`;
// One connection, shared by both drivers; BEGIN and every ORM operation stay
// on that connection. This harness owns the pool, not either client view.
const pool = new Pool({
  connectionString,
  max: 1,
  connectionTimeoutMillis: 5000,
});
const clients = Object.fromEntries(
  [false, true].map((sharing) => {
    const base = createClient({
      schema,
      driver: new PgDriver({ pool, namespace, sharedRelationBodies: sharing }),
    });
    return [
      String(sharing),
      {
        both: base.$extends(policy(bothRule)),
        single: base.$extends(policy({ seller: { is: memberRule } })),
      },
    ];
  })
);
function summary(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const p50Ms = sorted[Math.ceil(sorted.length / 2) - 1];
  const deviations = values
    .map((value) => Math.abs(value - p50Ms))
    .sort((a, b) => a - b);
  return {
    p50Ms,
    p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1],
    madMs: deviations[Math.ceil(sorted.length / 2) - 1],
    minMs: sorted[0],
    maxMs: sorted.at(-1),
  };
}
const results = [];
let report;
try {
  await pool.query("BEGIN");
  await pool.query("SET LOCAL statement_timeout = '10s'");
  await pool.query(`SET LOCAL jit = ${jit}`);
  await pool.query(`CREATE SCHEMA "${namespace}"`);
  for (const ddl of [
    `CREATE TABLE ${table("organization")} (id INTEGER PRIMARY KEY)`,
    `CREATE TABLE ${table("membership")} (id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY, "organizationId" INTEGER NOT NULL REFERENCES ${table("organization")}(id), "userId" TEXT NOT NULL)`,
    `CREATE TABLE ${table("invoice")} (id INTEGER PRIMARY KEY, "sellerId" INTEGER NOT NULL REFERENCES ${table("organization")}(id), "buyerId" INTEGER NOT NULL REFERENCES ${table("organization")}(id), label TEXT NOT NULL)`,
    `CREATE UNIQUE INDEX membership_org_user ON ${table("membership")}("organizationId", "userId")`,
    `CREATE INDEX membership_user_org ON ${table("membership")}("userId", "organizationId")`,
    `CREATE INDEX invoice_seller ON ${table("invoice")}("sellerId")`,
    `CREATE INDEX invoice_buyer ON ${table("invoice")}("buyerId")`,
  ])
    await pool.query(ddl);
  await pool.query(
    `INSERT INTO ${table("organization")} SELECT g FROM generate_series(1, $1::int) g`,
    [organizations]
  );
  await pool.query(
    `INSERT INTO ${table("membership")} ("organizationId", "userId") SELECT g, 'other-' || (g % 1000) FROM generate_series(1, $1::int) g`,
    [organizations]
  );
  for (const [user, condition] of [
    ["narrow", "g % 1000 = 1"],
    ["medium", "g % 100 = 1"],
    ["broad", "g % 10 <> 0"],
  ]) {
    await pool.query(
      `INSERT INTO ${table("membership")} ("organizationId", "userId") SELECT g, $1 FROM generate_series(1, $2::int) g WHERE ${condition}`,
      [user, organizations]
    );
  }
  await pool.query(
    `INSERT INTO ${table("invoice")} SELECT g, ((g - 1) % $2::int) + 1, ((g * 37 + 12339) % $2::int) + 1, 'original' FROM generate_series(1, $1::int) g`,
    [invoices, organizations]
  );
  for (const name of Object.keys(schema))
    await pool.query(`ANALYZE ${table(name)}`);
  const runtime = {
    node: process.version,
    cpu: cpus()[0]?.model,
    arch: process.arch,
    os: release(),
    postgres: (await pool.query("SHOW server_version")).rows[0].server_version,
    settings: (
      await pool.query(
        "SELECT name, setting FROM pg_settings WHERE name IN ('jit', 'jit_above_cost', 'work_mem', 'random_page_cost', 'max_parallel_workers_per_gather', 'shared_buffers') ORDER BY name"
      )
    ).rows,
  };
  for (const profile of profiles) {
    const eligible = Array.from(
      { length: invoices },
      (_, index) => index + 1
    ).filter(
      (id) => profile.member(sellerOf(id)) || profile.member(buyerOf(id))
    );
    const sellerOnly = Array.from(
      { length: invoices },
      (_, index) => index + 1
    ).filter((id) => profile.member(sellerOf(id)));
    const deniedId = Array.from(
      { length: invoices },
      (_, index) => index + 1
    ).find(
      (id) => !(profile.member(sellerOf(id)) || profile.member(buyerOf(id)))
    );
    assert(eligible.length > 0 && deniedId !== undefined);
    assert.equal(
      Number(
        (
          await pool.query(
            `SELECT count(*) FROM ${table("membership")} WHERE "userId" = $1`,
            [profile.name]
          )
        ).rows[0].count
      ),
      profile.count
    );
    const views = Object.fromEntries(
      Object.entries(clients).map(([variant, value]) => [
        variant,
        {
          both: value.both.$as({ userId: profile.name }),
          single: value.single.$as({ userId: profile.name }),
        },
      ])
    );
    // Complete independently computed result sets, including denied rows.
    for (const variant of ["false", "true"]) {
      const full = await views[variant].both.invoice.findMany({
        select: { id: true },
        orderBy: { id: "asc" },
      });
      assert.deepEqual(
        full.map((row) => row.id),
        eligible
      );
      assert.equal(
        await clients[variant].both.$as({ userId: "absent" }).invoice.count(),
        0
      );
    }
    const page = { select: { id: true }, orderBy: { id: "asc" }, take: 50 };
    const skip = Math.min(1000, Math.floor(eligible.length / 2));
    const workloads = [
      {
        name: "unique-hit",
        method: "findUnique",
        args: {
          where: { id: eligible[Math.floor(eligible.length * 0.9)] },
          select: { id: true },
        },
        expected: { id: eligible[Math.floor(eligible.length * 0.9)] },
      },
      {
        name: "unique-denied",
        method: "findUnique",
        args: { where: { id: deniedId }, select: { id: true } },
        expected: null,
      },
      {
        name: "page-first",
        method: "findMany",
        args: page,
        expected: eligible.slice(0, 50).map((id) => ({ id })),
      },
      {
        name: "page-offset",
        method: "findMany",
        args: { ...page, skip },
        expected: eligible.slice(skip, skip + 50).map((id) => ({ id })),
      },
      {
        name: "count-all",
        method: "count",
        args: {},
        expected: eligible.length,
      },
      {
        name: "update-1000-candidates",
        method: "updateMany",
        args: { where: { id: { lte: 1000 } }, data: { label: "changed" } },
        expected: { count: eligible.filter((id) => id <= 1000).length },
        write: true,
      },
      {
        name: "single-body-control",
        method: "findMany",
        args: page,
        expected: sellerOnly.slice(0, 50).map((id) => ({ id })),
        single: true,
      },
    ];
    // Rotate case order in fresh-process repetitions; variant order alternates
    // inside each pair so a later case/variant does not always get warm caches.
    const ordered = [
      ...workloads.slice(rotation % workloads.length),
      ...workloads.slice(0, rotation % workloads.length),
    ];
    for (const workload of ordered) {
      const selected = (variant) =>
        views[variant][workload.single ? "single" : "both"];
      const invoke = (client) => client.invoice[workload.method](workload.args);
      const sql = {};
      const durations = { false: [], true: [] };
      const explain = { false: [], true: [] };
      async function isolated(fn) {
        if (!workload.write) return fn();
        await pool.query("SAVEPOINT measured_write");
        try {
          return await fn();
        } finally {
          await pool.query("ROLLBACK TO SAVEPOINT measured_write");
          await pool.query("RELEASE SAVEPOINT measured_write");
        }
      }
      for (const variant of ["false", "true"]) {
        const statements = [];
        const capture = selected(variant).$extends({
          name: "capture-shared-bodies-benchmark",
          statement: ({ statement }) => {
            statements.push({
              text: statement.toStatement("$n"),
              values: statement.values,
            });
            return statement;
          },
        });
        const returned = await isolated(() => invoke(capture));
        assert.deepEqual(returned, workload.expected);
        assert.equal(
          statements.length,
          1,
          `${workload.name} must have one statement`
        );
        sql[variant] = {
          ...statements[0],
          bytes: Buffer.byteLength(statements[0].text),
        };
      }
      // This scalar update path currently emits identical SQL under both
      // settings. Preserve it as an observed no-effect case, not a sharing win.
      const sharingApplied = /"__shared_\d+" AS \(/.test(sql.true.text);
      if (workload.single || workload.write) {
        assert.equal(
          sql.false.text,
          sql.true.text,
          "Control/update SQL is currently identical"
        );
        assert.equal(sharingApplied, false);
      } else
        assert(
          sharingApplied,
          "Sharing must actually activate for repeated read bodies"
        );
      for (let iteration = -warmups; iteration < samples; iteration++) {
        for (const variant of (iteration + rotation) % 2 === 0
          ? ["false", "true"]
          : ["true", "false"]) {
          const measurement = await isolated(async () => {
            const start = performance.now();
            const returned = await invoke(selected(variant));
            return { returned, ms: performance.now() - start };
          });
          assert.deepEqual(measurement.returned, workload.expected);
          if (iteration >= 0) durations[variant].push(measurement.ms);
        }
      }
      // Separate database-only observations: no statement capture in timing.
      for (let iteration = 0; iteration < 3; iteration++) {
        for (const variant of (iteration + rotation) % 2 === 0
          ? ["false", "true"]
          : ["true", "false"]) {
          const explained = await isolated(() =>
            pool.query(
              `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql[variant].text}`,
              sql[variant].values
            )
          );
          explain[variant].push(explained.rows[0]["QUERY PLAN"][0]);
        }
      }
      if (workload.write) {
        assert.equal(
          Number(
            (
              await pool.query(
                `SELECT count(*) FROM ${table("invoice")} WHERE label <> 'original'`
              )
            ).rows[0].count
          ),
          0
        );
      }
      const result = {
        profile: profile.name,
        memberships: profile.count,
        eligibleInvoices: eligible.length,
        workload: workload.name,
        sharingApplied,
        args: workload.args,
        expected: workload.expected,
        off: summary(durations.false),
        on: summary(durations.true),
        samplesMs: durations,
        sql,
        explain,
      };
      results.push(result);
      console.log(
        `${profile.name}/${workload.name}: off ${result.off.p50Ms.toFixed(3)} ms, on ${result.on.p50Ms.toFixed(3)} ms (${(result.on.p50Ms / result.off.p50Ms).toFixed(2)}x)`
      );
    }
  }
  const hash = createHash("sha256");
  for (const file of readdirSync(join(root, "dist"), { recursive: true })
    .filter((file) => file.endsWith(".mjs"))
    .sort()) {
    hash
      .update(file)
      .update("\0")
      .update(readFileSync(join(root, "dist", file)));
  }
  report = {
    format: "viborm-shared-relation-bodies-benchmark-v1",
    measuredAt: new Date().toISOString(),
    identity: {
      commit: execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: root,
        encoding: "utf8",
      }).trim(),
      status: execFileSync("git", ["status", "--short"], {
        cwd: root,
        encoding: "utf8",
      }).trim(),
      buildSha256: hash.digest("hex"),
      harnessSha256: createHash("sha256")
        .update(readFileSync(fileURLToPath(import.meta.url)))
        .digest("hex"),
    },
    runtime,
    configuration: { organizations, invoices, samples, warmups, rotation, jit },
    results,
  };
} finally {
  try {
    await pool.query("ROLLBACK");
    assert.equal(
      (
        await pool.query("SELECT 1 FROM pg_namespace WHERE nspname = $1", [
          namespace,
        ])
      ).rowCount,
      0
    );
  } finally {
    await pool.end();
  }
}
assert(report);
report.cleanupVerified = true;
writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
console.log(`Evidence: ${output}`);
