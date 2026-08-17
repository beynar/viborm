/**
 * Allocation and retained-heap measurement for the relation-read benchmark.
 *
 * This script uses the built public package so V8 samples production-shaped
 * JavaScript rather than the Vitest transform layer.
 *
 * Run:
 *   pnpm package:build
 *   node --expose-gc benchmarks/relation-read-memory.mjs
 */
import inspector from "node:inspector";
import { createClient } from "../dist/index.mjs";
import { push } from "../dist/migrations.mjs";
import { s } from "../dist/schema.mjs";
import { SQLite3Driver } from "../dist/sqlite3.mjs";

if (typeof globalThis.gc !== "function") {
  throw new Error("Run this script with node --expose-gc");
}

const user = s
  .model({
    id: s.string().id(),
    name: s.string().nullable(),
    email: s.string(),
    age: s.int().nullable(),
    posts: s.oneToMany(() => post),
  })
  .map("users");

const post = s
  .model({
    id: s.string().id(),
    title: s.string(),
    content: s.string().nullable(),
    published: s.boolean().default(false),
    views: s.int().default(0),
    authorId: s.string(),
    author: s
      .manyToOne(() => user)
      .fields("authorId")
      .references("id"),
  })
  .map("posts");

const schema = { user, post };
const driver = new SQLite3Driver({ dataDir: ":memory:" });
const client = createClient({ schema, driver });
await push(client, { force: true });

const ROWS_PER_OPERATION = Number(
  process.env.VIBORM_RELATION_ROWS ?? 20
);
if (!Number.isSafeInteger(ROWS_PER_OPERATION) || ROWS_PER_OPERATION < 1) {
  throw new Error("VIBORM_RELATION_ROWS must be a positive safe integer");
}
const USERS = 100;
const POSTS = Math.max(1_000, ROWS_PER_OPERATION);
for (let i = 0; i < USERS; i++) {
  await driver._executeRaw(
    'INSERT INTO "users" ("id", "name", "email", "age") VALUES (?, ?, ?, ?)',
    [`user_${i}`, `User ${i}`, `user${i}@example.com`, 20 + (i % 50)]
  );
}
for (let i = 0; i < POSTS; i++) {
  await driver._executeRaw(
    'INSERT INTO "posts" ("id", "title", "content", "published", "views", "authorId") VALUES (?, ?, ?, ?, ?, ?)',
    [`post_${i}`, `Post ${i}`, `Content ${i}`, i % 2, i, `user_${i % USERS}`]
  );
}

const args = {
  select: {
    id: true,
    title: true,
    author: { select: { id: true, name: true } },
  },
  take: ROWS_PER_OPERATION,
};

if (process.env.VIBORM_COLD_RETAINED_ONLY === "1") {
  const workload =
    process.env.VIBORM_COLD_RETAINED_WORKLOAD === "raw" ? "raw" : "full";
  globalThis.gc();
  globalThis.gc();
  const before = process.memoryUsage().heapUsed;
  let value;
  let rowCount;
  if (workload === "raw") {
    let operation = client.post.findMany(args);
    let query = operation.prepare();
    if (!query) {
      throw new Error("The cold raw read did not produce a prepared statement");
    }
    value = await driver._executeRaw(query.sql, query.params);
    rowCount = value.rows.length;
    operation = undefined;
    query = undefined;
  } else {
    value = await client.post.findMany(args);
    rowCount = value.length;
  }
  value = undefined;
  globalThis.gc();
  globalThis.gc();
  console.log(
    JSON.stringify({
      workload,
      rowCount,
      retainedBytes: process.memoryUsage().heapUsed - before,
    })
  );
  await driver.disconnect();
  process.exit(0);
}

const coldProfilerBaseline = await measureAllocatedBytes(
  async () => undefined,
  1,
  128
);
globalThis.gc();
globalThis.gc();
const coldHeapBefore = process.memoryUsage().heapUsed;
const coldFull = await measureAllocatedBytes(async () => {
  const rows = await client.post.findMany(args);
  if (rows.length !== ROWS_PER_OPERATION) {
    throw new Error(
      `The cold relation read did not return ${ROWS_PER_OPERATION} rows`
    );
  }
}, 1, 128);
coldFull.profilerBaselineBytes =
  coldProfilerBaseline.allocatedBytesPerOperation;
coldFull.netAllocatedBytesPerOperation =
  coldFull.allocatedBytesPerOperation -
  coldProfilerBaseline.allocatedBytesPerOperation;
globalThis.gc();
globalThis.gc();
coldFull.retainedBytes = process.memoryUsage().heapUsed - coldHeapBefore;

const preparedOperation = client.post.findMany(args);
const prepared = preparedOperation.prepare();
if (!prepared) {
  throw new Error("The relation read did not produce one prepared statement");
}
const rawFixture = await driver._executeRaw(prepared.sql, prepared.params);
const expected = preparedOperation.parseResult(rawFixture);
if (!Array.isArray(expected) || expected.length !== ROWS_PER_OPERATION) {
  throw new Error(
    `The relation-read fixture did not return ${ROWS_PER_OPERATION} parsed rows`
  );
}

let sink = 0;

const workloads = {
  raw: async () => {
    const raw = await driver._executeRaw(prepared.sql, prepared.params);
    sink += raw.rows.length;
  },
  rawAndParse: async () => {
    const raw = await driver._executeRaw(prepared.sql, prepared.params);
    const rows = preparedOperation.parseResult(raw);
    sink += rows.length;
  },
  full: async () => {
    const rows = await client.post.findMany(args);
    sink += rows.length;
  },
  prepare: () => {
    const query = client.post.findMany(args).prepare();
    sink += query?.params.length ?? 0;
  },
  parse: () => {
    const rows = preparedOperation.parseResult(rawFixture);
    sink += rows.length;
  },
};

async function warm(workload, iterations) {
  for (let i = 0; i < iterations; i++) await workload();
}

function postSession(session, method, params = {}) {
  return new Promise((resolve, reject) => {
    session.post(method, params, (error, result) => {
      if (error) reject(error);
      else resolve(result);
    });
  });
}

function sampledBytes(node) {
  let bytes = node.selfSize ?? 0;
  for (const child of node.children ?? []) bytes += sampledBytes(child);
  return bytes;
}

function topAllocationFrames(node) {
  const frames = new Map();
  const visit = (current) => {
    const selfSize = current.selfSize ?? 0;
    if (selfSize > 0) {
      const frame = current.callFrame;
      const location = frame?.url
        ? `${frame.url}:${(frame.lineNumber ?? 0) + 1}:${(frame.columnNumber ?? 0) + 1}`
        : "unknown";
      const name = frame?.functionName || "(anonymous)";
      const key = `${name} at ${location}`;
      frames.set(key, (frames.get(key) ?? 0) + selfSize);
    }
    for (const child of current.children ?? []) visit(child);
  };
  visit(node);
  return [...frames]
    .sort((left, right) => right[1] - left[1])
    .slice(0, 8)
    .map(([frame, bytes]) => ({ frame, bytes }));
}

async function measureAllocatedBytes(
  workload,
  iterations,
  samplingInterval = 8_192
) {
  const session = new inspector.Session();
  session.connect();
  try {
    await postSession(session, "HeapProfiler.enable");
    await postSession(session, "HeapProfiler.startSampling", {
      samplingInterval,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
    for (let i = 0; i < iterations; i++) await workload();
    const { profile } = await postSession(
      session,
      "HeapProfiler.stopSampling"
    );
    return {
      allocatedBytesPerOperation: sampledBytes(profile.head) / iterations,
      topFrames: topAllocationFrames(profile.head),
    };
  } finally {
    session.disconnect();
  }
}

async function measureRetainedBytes(workload, iterations) {
  globalThis.gc();
  globalThis.gc();
  const before = process.memoryUsage().heapUsed;
  for (let i = 0; i < iterations; i++) await workload();
  globalThis.gc();
  globalThis.gc();
  return process.memoryUsage().heapUsed - before;
}

async function measureResultHeapStages() {
  globalThis.gc();
  globalThis.gc();
  const before = process.memoryUsage().heapUsed;
  let raw = await driver._executeRaw(prepared.sql, prepared.params);
  const rawBytes = process.memoryUsage().heapUsed - before;
  let parsed = preparedOperation.parseResult(raw);
  const rawAndParsedBytes = process.memoryUsage().heapUsed - before;
  const rowCount = parsed.length;
  raw = undefined;
  globalThis.gc();
  globalThis.gc();
  const parsedBytes = process.memoryUsage().heapUsed - before;
  parsed = undefined;
  globalThis.gc();
  globalThis.gc();
  return {
    rowCount,
    rawBytes,
    rawAndParsedBytes,
    parsedBytes,
    retainedAfterReleaseBytes: process.memoryUsage().heapUsed - before,
  };
}

const rowIterationDivisor = Math.max(1, ROWS_PER_OPERATION / 20);
for (const [name, workload] of Object.entries(workloads)) {
  const iterations =
    name === "prepare" ? 2_000 : Math.max(20, Math.floor(2_000 / rowIterationDivisor));
  await warm(workload, iterations);
}
const heapStages = await measureResultHeapStages();

const allocationIterations = {
  raw: Math.max(20, Math.floor(20_000 / rowIterationDivisor)),
  rawAndParse: Math.max(20, Math.floor(20_000 / rowIterationDivisor)),
  full: Math.max(20, Math.floor(20_000 / rowIterationDivisor)),
  prepare: 50_000,
  parse: Math.max(50, Math.floor(50_000 / rowIterationDivisor)),
};
const retainedIterations = {
  raw: Math.max(50, Math.floor(50_000 / rowIterationDivisor)),
  rawAndParse: Math.max(50, Math.floor(50_000 / rowIterationDivisor)),
  full: Math.max(50, Math.floor(50_000 / rowIterationDivisor)),
  prepare: 100_000,
  parse: Math.max(100, Math.floor(100_000 / rowIterationDivisor)),
};

const measurements = {};
for (const [name, workload] of Object.entries(workloads)) {
  const allocation = await measureAllocatedBytes(
    workload,
    allocationIterations[name]
  );
  const retainedBytes = await measureRetainedBytes(
    workload,
    retainedIterations[name]
  );
  measurements[name] = {
    ...allocation,
    retainedBytes,
    retainedIterations: retainedIterations[name],
  };
}

console.log(
  JSON.stringify(
    {
      rowsPerOperation: expected.length,
      allocationSamplingInterval: 8_192,
      coldFull,
      heapStages,
      measurements,
      sink,
    },
    null,
    2
  )
);

await driver.disconnect();
