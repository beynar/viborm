#!/usr/bin/env node
/**
 * Raptor 3 list-valued columns — matched A/B of two immutable source trees
 * (`docs/architecture/raptor3-compiled-list-decoder-plan.md`, work unit 4).
 *
 * Each tree is imported from its OWN built `dist/` (build it in each tree
 * first). Every measured value comes from a fresh child process, and the two
 * trees alternate within every round (A B, then B A), so drift in the machine
 * lands on both sides. Every result line carries its source identity: git
 * HEAD, tracked-dirty flag, a digest of `dist/**.mjs`, the digest of
 * `src/query-engine/raptor3/shared/query.ts`, the lockfile digest and Node's
 * version. The controller refuses two trees with different lockfiles.
 *
 * Fixture (in-memory SQLite, the schema pushed by the product's own
 * migration, rows seeded by raw SQL): 1,000 `record` rows of four ordinary
 * columns (text id, text, boolean, integer) and two list columns, a string
 * list and an int list, each list holding `length` members (0, 4 or 32); 1,000
 * `shelf` rows, each owning two `record`s through a second table of the same
 * columns (`item`). The expected rows are the generator's own values; the
 * worker first checks that SQLite HOLDS exactly what was written (a raw
 * `SELECT` around every decoder), so no decoder's output is the oracle.
 *
 * Cells:
 *  - `root`: `record.findMany` ordered by id — PHYSICAL list slots, asked of
 *    the provider chain once per list. Rows 0 (the statement and the batch
 *    with nothing to decode), 1, 20 and 1,000.
 *  - `carried`: `shelf.findMany` including its two `items` — the lists are
 *    CARRIED by the to-many JSON document. Rows are ROOT rows (1, 20, 1,000).
 *  - NON-LIST CONTROLS on the same tables, the list columns left unselected:
 *    `scalar` (the `root` read selecting the four ordinary columns) and
 *    `nested` (the `carried` read selecting the items' ordinary columns).
 * Every cell runs in both stages:
 *  - `parse`: the prepared operation's `parseResult` over one frozen, borrowed
 *    raw result (decoding only);
 *  - `full`: the public client operation against SQLite.
 *
 * Measures, one per process:
 *  - `time`: warmups, then a fixed iteration count per cell; wall
 *    (`performance.now`) and CPU (`process.cpuUsage`, user + system) per op.
 *  - `allocation`: a HEAP-GROWTH PROXY, not an allocation profile, not
 *    retained memory and not RSS. After warmups, each sampled op runs between
 *    a forced full GC and a `heapUsed` read, with a 64 MB semi-space; the
 *    proxy is the median growth, and a sample during which the GC observer saw
 *    a collection is counted in `gcInWindow`.
 *  - `cold`: the FIRST full operation of a fresh client in a fresh process,
 *    then the second. Rows are seeded by raw SQL before the measured client
 *    is created, over a separate client's migration.
 *  - `verify`: no timing. Per cell, the provider statements of a full read,
 *    the provider result-chain callbacks (`parseField` asks, by type) of a
 *    full and of a parse-only read, and a digest of both public results. The
 *    controller requires both trees to agree.
 * Every time/allocation/cold worker also checks, before and after measuring,
 * that the parse-only and full answers equal the expected rows, that a
 * malformed list member is refused, and that a sparse provider list keeps its
 * holes (the recorded baseline, `result-decoder-lists.test.ts`; parity, not a
 * refusal contract).
 *
 * Run (after building `dist/` in both trees):
 *   node benchmarks/result-decoder-lists.mjs --base <tree> --candidate <tree> \
 *     [--rounds 8] [--allocation-rounds 4] [--cold-rounds 30] \
 *     [--measures verify,time,allocation,cold] [--cells <regex>] [--scale 1] \
 *     [--out runs.jsonl]
 * The decoder's broader non-list controls (flat, nested, variant and recursive
 * reads; empty and cold reads) are its own harness,
 * `benchmarks/result-decoder.mjs`.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, readdirSync, readFileSync } from "node:fs";
import { PerformanceObserver, performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual, parseArgs } from "node:util";

const SEED = 1000;
const LENGTHS = [0, 4, 32];
const CELLS = ["parse", "full"].flatMap((stage) => [
  { shape: "root", stage, rows: 0, length: 4 },
  ...["root", "carried"].flatMap((shape) =>
    [1, 20, 1000].flatMap((rows) =>
      LENGTHS.map((length) => ({ shape, stage, rows, length }))
    )
  ),
  // Non-list controls: the same tables, the list columns left unselected.
  ...["scalar", "nested"].flatMap((shape) =>
    [1, 20, 1000].map((rows) => ({ shape, stage, rows, length: 0 }))
  ),
]);
const COLD_CELLS = [
  { shape: "root", stage: "full", rows: 1, length: 4 },
  { shape: "root", stage: "full", rows: 20, length: 4 },
  { shape: "carried", stage: "full", rows: 20, length: 4 },
];
/**
 * Fixed per-cell iteration counts, identical for every tree, sized so each
 * measured window is roughly 0.3 s or more: a parse-only one-row op is about a
 * microsecond, and a shorter window is dominated by the code still tiering up.
 */
const ITERATIONS = {
  root: {
    parse: { 0: 150_000, 1: 150_000, 20: 20_000, 1000: 400 },
    full: { 0: 8000, 1: 8000, 20: 4000, 1000: 300 },
  },
  scalar: {
    parse: { 1: 500_000, 20: 80_000, 1000: 2500 },
    full: { 1: 8000, 20: 4000, 1000: 300 },
  },
  carried: {
    parse: { 1: 200_000, 20: 15_000, 1000: 240 },
    full: { 1: 3000, 20: 1500, 1000: 60 },
  },
  nested: {
    parse: { 1: 200_000, 20: 15_000, 1000: 240 },
    full: { 1: 3000, 20: 1500, 1000: 60 },
  },
};
const WARMUPS = { 0: 300, 1: 300, 20: 60, 1000: 5 };
const ALLOCATION_SAMPLES = { 0: 40, 1: 40, 20: 20, 1000: 8 };

const pad = (n) => String(n).padStart(4, "0");

/** A harness precondition: a violated one voids the whole run. */
function ensure(condition, message) {
  if (!condition) throw new Error(message);
}
const same = (actual, expected, message) =>
  ensure(isDeepStrictEqual(actual, expected), message);
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");

// ---------------------------------------------------------------------------
// Source identity
// ---------------------------------------------------------------------------

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

const LIST_COLUMNS = (s) => ({
  title: s.string(),
  enabled: s.boolean(),
  count: s.int(),
  tags: s.string().array(),
  values: s.int().array(),
});

function models(s) {
  const record = s
    .model({ id: s.string().id(), ...LIST_COLUMNS(s) })
    .map("rdl_records");
  const shelf = s
    .model({
      id: s.string().id(),
      name: s.string(),
      items: s.toMany(() => item),
    })
    .map("rdl_shelves");
  const item = s
    .model({
      id: s.string().id(),
      shelfId: s.string(),
      ...LIST_COLUMNS(s),
      shelf: s
        .toOne(() => shelf)
        .fields("shelfId")
        .references("id"),
    })
    .map("rdl_items");
  return { record, shelf, item };
}

/** The generator: one record's values, derived from its index alone. */
function listRow(id, index, length) {
  return {
    id,
    title: `Title ${index}`,
    enabled: index % 2 === 0,
    count: index,
    tags: Array.from({ length }, (_, member) => `tag ${index}:${member}`),
    values: Array.from({ length }, (_, member) => index * 100 - member),
  };
}

function expectedWorld(length) {
  const records = [];
  const shelves = [];
  for (let i = 0; i < SEED; i += 1) {
    records.push(listRow(`r${pad(i)}`, i, length));
    shelves.push({
      id: `s${pad(i)}`,
      name: `Shelf ${i}`,
      items: [0, 1].map((k) => {
        const { id, ...rest } = listRow(`i${pad(i)}_${k}`, i * 2 + k, length);
        return { id, shelfId: `s${pad(i)}`, ...rest };
      }),
    });
  }
  return { records, shelves };
}

/** The stored spelling of one list row: booleans 0/1, lists as JSON text. */
const stored = (row) => ({
  ...row,
  enabled: Number(row.enabled),
  tags: JSON.stringify(row.tags),
  values: JSON.stringify(row.values),
});

async function insert(driver, table, rows) {
  const columns = Object.keys(rows[0]);
  const chunk = Math.floor(900 / columns.length);
  for (let start = 0; start < rows.length; start += chunk) {
    const slice = rows.slice(start, start + chunk);
    const params = [];
    const tuples = slice.map((row) => {
      for (const column of columns) params.push(row[column]);
      return `(${columns.map(() => "?").join(", ")})`;
    });
    await driver._executeRaw(
      `INSERT INTO "${table}" (${columns.map((c) => `"${c}"`).join(", ")}) VALUES ${tuples.join(", ")}`,
      params
    );
  }
}

async function seed(driver, world) {
  const records = world.records.map(stored);
  const items = world.shelves.flatMap((shelf) => shelf.items.map(stored));
  await insert(driver, "rdl_records", records);
  await insert(
    driver,
    "rdl_shelves",
    world.shelves.map(({ id, name }) => ({ id, name }))
  );
  await insert(driver, "rdl_items", items);
  // Independent anchor: SQLite holds exactly the rows written, read around
  // every decoder.
  const read = async (sql) => (await driver._executeRaw(sql, [])).rows;
  const byId = (rows) => [...rows].sort((a, b) => a.id.localeCompare(b.id));
  const columns = '"id", "title", "enabled", "count", "tags", "values"';
  same(
    await read(`SELECT ${columns} FROM "rdl_records" ORDER BY "id"`),
    byId(records),
    "SQLite must hold exactly the records written"
  );
  same(
    await read(
      `SELECT "id", "shelfId", "title", "enabled", "count", "tags", "values" FROM "rdl_items" ORDER BY "id"`
    ),
    byId(items).map(({ id, shelfId, ...rest }) => ({ id, shelfId, ...rest })),
    "SQLite must hold exactly the items written"
  );
}

const SCALAR_SELECT = { id: true, title: true, enabled: true, count: true };
const withoutLists = ({ tags, values, ...rest }) => rest;

/** The measured operation of one cell, and the rows it must answer. */
function operation(client, world, { shape, rows }) {
  const take = Math.max(rows, 1);
  if (shape === "root")
    return {
      run: () =>
        client.record.findMany({
          where: rows === 0 ? { id: "none" } : {},
          orderBy: { id: "asc" },
          take,
        }),
      expected: world.records.slice(0, rows),
    };
  if (shape === "scalar")
    return {
      run: () =>
        client.record.findMany({
          select: SCALAR_SELECT,
          orderBy: { id: "asc" },
          take,
        }),
      expected: world.records.slice(0, rows).map(withoutLists),
    };
  if (shape === "nested")
    return {
      run: () =>
        client.shelf.findMany({
          orderBy: { id: "asc" },
          take,
          include: {
            items: {
              select: { ...SCALAR_SELECT, shelfId: true },
              orderBy: { id: "asc" },
            },
          },
        }),
      expected: world.shelves
        .slice(0, rows)
        .map((shelf) => ({ ...shelf, items: shelf.items.map(withoutLists) })),
    };
  return {
    run: () =>
      client.shelf.findMany({
        orderBy: { id: "asc" },
        take,
        include: { items: { orderBy: { id: "asc" } } },
      }),
    expected: world.shelves.slice(0, rows),
  };
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

function freeze(value) {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

// ---------------------------------------------------------------------------
// Worker
// ---------------------------------------------------------------------------

async function open(tree, length) {
  const load = (file) => import(pathToFileURL(`${tree}/dist/${file}.mjs`).href);
  const [
    { createClient, s },
    { createMigrationClient },
    { SQLite3Driver },
    { readBenchmarkOperation },
  ] = await Promise.all([
    load("index"),
    load("migrations"),
    load("sqlite3"),
    load("internal/benchmark-operation"),
  ]);
  const driver = new SQLite3Driver({ dataDir: ":memory:" });
  // The schema is pushed by a SEPARATE client over SEPARATE model objects, so
  // the measured client below has prepared nothing.
  const migrations = createMigrationClient(
    createClient({ schema: models(s), driver })
  );
  const preview = await migrations.push({ dryRun: true });
  await migrations.push({ consent: preview.consent });
  const world = expectedWorld(length);
  await seed(driver, world);
  const client = createClient({ schema: models(s), driver });
  return { client, driver, world, readBenchmarkOperation };
}

/** The parse-only stage: one prepared statement, one frozen raw result. */
async function parseStage(driver, run, readBenchmarkOperation) {
  const capability = readBenchmarkOperation(run());
  ensure(capability, "missing benchmark operation capability");
  const prepared = capability.prepare();
  ensure(prepared, "the read must prepare one statement");
  const raw = freeze(await driver._executeRaw(prepared.sql, prepared.params));
  return {
    capability,
    raw,
    statement: sha(JSON.stringify([prepared.sql, prepared.params])).slice(
      0,
      16
    ),
  };
}

/** The cell's semantic checks, run before and after measuring. */
async function check(cell, run, parse, expected) {
  same(await run(), expected, "the full read must answer the expected rows");
  same(
    parse.capability.parseResult(parse.raw),
    expected,
    "the parse-only read must answer the expected rows"
  );
  if (cell.shape !== "root" || cell.rows === 0) return;
  const [first] = parse.raw.rows;
  let refusal;
  try {
    parse.capability.parseResult({
      ...parse.raw,
      rows: [{ ...first, tags: '["valid",42]' }],
    });
  } catch (error) {
    refusal = error;
  }
  // The internal refusal: the operation turns it into the public sentence.
  ensure(
    refusal?.scalarType === "string" &&
      refusal.reason === "the value is not a string",
    "a malformed list member must be refused"
  );
  // Recorded baseline: `map` never visits holes, so a sparse provider list is
  // published with its holes. Parity, not a refusal contract.
  same(
    parse.capability.parseResult({
      ...parse.raw,
      rows: [{ ...first, tags: new Array(2) }],
    })[0].tags,
    new Array(2),
    "a sparse provider list keeps its holes (recorded baseline)"
  );
}

function consumer(cell) {
  let sink = 0;
  const consume = (rows) => {
    sink += rows.length;
    const row =
      cell.shape === "root" || cell.shape === "scalar"
        ? rows[0]
        : rows[0]?.items[1];
    if (row === undefined) return;
    sink += row.count;
    if (row.tags === undefined) return;
    sink += row.tags.length;
    if (cell.length) sink += row.values[cell.length - 1];
  };
  return { consume, sink: () => sink };
}

async function measureTime(cell, step) {
  const iterations = ITERATIONS[cell.shape][cell.stage][cell.rows] * cell.scale;
  for (let i = 0; i < WARMUPS[cell.rows]; i += 1) await step();
  globalThis.gc?.();
  const beforeCpu = process.cpuUsage();
  const beforeWall = performance.now();
  for (let i = 0; i < iterations; i += 1) await step();
  const wall = performance.now() - beforeWall;
  const cpu = process.cpuUsage(beforeCpu);
  return {
    iterations,
    wallUsPerOp: (wall * 1000) / iterations,
    cpuUsPerOp: (cpu.user + cpu.system) / iterations,
  };
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

async function measureAllocation(cell, step) {
  const samples = ALLOCATION_SAMPLES[cell.rows];
  for (let i = 0; i < WARMUPS[cell.rows]; i += 1) await step();
  const windows = [];
  const collections = [];
  const observer = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) collections.push(entry.startTime);
  });
  observer.observe({ entryTypes: ["gc"] });
  const growth = [];
  for (let i = 0; i < samples; i += 1) {
    globalThis.gc();
    const start = performance.now();
    const before = process.memoryUsage().heapUsed;
    await step();
    const after = process.memoryUsage().heapUsed;
    windows.push([start, performance.now()]);
    growth.push(after - before);
  }
  await new Promise((resolve) => setTimeout(resolve, 50));
  observer.disconnect();
  return {
    samples,
    heapGrowthBytesPerOp: median(growth),
    gcInWindow: collections.filter((time) =>
      windows.some(([start, end]) => time > start && time < end)
    ).length,
  };
}

async function measureCold(run) {
  const firstCpu0 = process.cpuUsage();
  const firstWall0 = performance.now();
  await run();
  const firstWall = performance.now() - firstWall0;
  const firstCpu = process.cpuUsage(firstCpu0);
  const secondCpu0 = process.cpuUsage();
  const secondWall0 = performance.now();
  await run();
  const secondWall = performance.now() - secondWall0;
  const secondCpu = process.cpuUsage(secondCpu0);
  return {
    firstCpuUs: firstCpu.user + firstCpu.system,
    firstWallUs: firstWall * 1000,
    secondCpuUs: secondCpu.user + secondCpu.system,
    secondWallUs: secondWall * 1000,
  };
}

/** A provider result chain that counts each ask by type, then continues. */
function recordAsks(driver) {
  const asks = new Map();
  const previous = driver.result;
  Object.defineProperty(driver, "result", {
    configurable: true,
    value: {
      parseField: (value, type, next) => {
        asks.set(type, (asks.get(type) ?? 0) + 1);
        return previous?.parseField
          ? previous.parseField(value, type, next)
          : next(value, type);
      },
    },
  });
  return {
    take: () => {
      const counted = Object.fromEntries(
        [...asks].sort(([a], [b]) => a.localeCompare(b))
      );
      asks.clear();
      return counted;
    },
  };
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

async function verify(tree) {
  const cells = [];
  for (const length of LENGTHS) {
    const { client, driver, world, readBenchmarkOperation } = await open(
      tree,
      length
    );
    const asks = recordAsks(driver);
    const statements = countStatements(driver);
    for (const cell of CELLS.filter((c) => c.length === length)) {
      if (cell.stage !== "full") continue;
      const { run, expected } = operation(client, world, cell);
      statements.count = 0;
      asks.take();
      const full = await run();
      const fullStatements = statements.count;
      const fullAsks = asks.take();
      const parse = await parseStage(driver, run, readBenchmarkOperation);
      asks.take();
      const parsed = parse.capability.parseResult(parse.raw);
      const parseAsks = asks.take();
      same(full, expected, "the full read must answer the expected rows");
      same(
        parsed,
        expected,
        "the parse-only read must answer the expected rows"
      );
      cells.push({
        shape: cell.shape,
        rows: cell.rows,
        length,
        statements: fullStatements,
        statement: parse.statement,
        fullAsks,
        parseAsks,
        resultRows: full.length,
        digest: digest(full),
        parseDigest: digest(parsed),
      });
    }
    await driver.disconnect();
  }
  return { cells };
}

async function worker(job) {
  const source = sourceIdentity(job.tree);
  if (job.measure === "verify")
    return { ...job, source, ...(await verify(job.tree)) };
  const { client, driver, world, readBenchmarkOperation } = await open(
    job.tree,
    job.length
  );
  const { run, expected } = operation(client, world, job);
  if (job.measure === "cold") {
    // The measured client has prepared nothing: time its first operation
    // before any check runs, then check the answer.
    const measured = await measureCold(run);
    const parse = await parseStage(driver, run, readBenchmarkOperation);
    await check(job, run, parse, expected);
    await driver.disconnect();
    return { ...job, source, statement: parse.statement, ...measured };
  }
  const parse = await parseStage(driver, run, readBenchmarkOperation);
  await check(job, run, parse, expected);
  const { consume, sink } = consumer(job);
  const step =
    job.stage === "parse"
      ? async () => consume(parse.capability.parseResult(parse.raw))
      : async () => consume(await run());
  const measured =
    job.measure === "time"
      ? await measureTime(job, step)
      : await measureAllocation(job, step);
  await check(job, run, parse, expected);
  await driver.disconnect();
  return {
    ...job,
    source,
    statement: parse.statement,
    digest: digest(expected),
    sink: sink(),
    ...measured,
  };
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

const cellKey = (c) => `${c.shape}|${c.stage}|${c.rows}|${c.length}`;

function compareVerify(base, candidate) {
  console.log("\nverify — statements, provider asks and result digests");
  let same = true;
  for (const [index, cell] of base.cells.entries()) {
    const other = candidate.cells[index];
    const agree = JSON.stringify(cell) === JSON.stringify(other);
    same &&= agree;
    console.log(
      `${cell.shape.padEnd(8)} rows ${String(cell.rows).padStart(4)} len ${String(cell.length).padStart(2)}  stmts ${cell.statements}  asks full ${JSON.stringify(cell.fullAsks)} parse ${JSON.stringify(cell.parseAsks)}  ${cell.digest}  ${agree ? "same" : "DIFFERENT"}`
    );
  }
  if (!same) throw new Error("base and candidate disagree");
}

function controller(options) {
  const trees = { base: options.base, candidate: options.candidate };
  const identity = {
    base: sourceIdentity(trees.base),
    candidate: sourceIdentity(trees.candidate),
  };
  console.log(JSON.stringify({ identity }, null, 2));
  if (identity.base.lockfile !== identity.candidate.lockfile)
    throw new Error("the two trees do not share one lockfile");
  const measures = options.measures.split(",");
  if (measures.includes("verify"))
    compareVerify(
      spawnWorker(
        { tree: trees.base, label: "base", measure: "verify" },
        options.out
      ),
      spawnWorker(
        { tree: trees.candidate, label: "candidate", measure: "verify" },
        options.out
      )
    );
  const all = [];
  const pass = (measure, rounds, cells) => {
    for (let round = 0; round < rounds; round += 1) {
      const order =
        round % 2 === 0 ? ["base", "candidate"] : ["candidate", "base"];
      for (const cell of cells) {
        const pair = order.map((label) => {
          const run = spawnWorker(
            { tree: trees[label], label, measure, ...cell },
            options.out
          );
          all.push({ ...run, round });
          return run;
        });
        ensure(
          pair[0].statement === pair[1].statement,
          "A/B statements differ"
        );
        ensure(pair[0].digest === pair[1].digest, "A/B results differ");
      }
      process.stderr.write(`${measure} round ${round + 1}/${rounds}\n`);
    }
  };
  // `--cells` narrows a run to the cells whose `shape|stage|rows|length` key
  // matches; `--scale` multiplies every time cell's iteration count.
  const chosen = (cells) =>
    cells
      .filter((cell) => options.cells.test(cellKey(cell)))
      .map((cell) => ({ ...cell, scale: options.scale }));
  if (measures.includes("time")) pass("time", options.rounds, chosen(CELLS));
  if (measures.includes("allocation"))
    pass("allocation", options.allocationRounds, chosen(CELLS));
  if (measures.includes("cold"))
    pass("cold", options.coldRounds, chosen(COLD_CELLS));
  report(all);
}

function report(all) {
  const metrics = {
    time: ["cpuUsPerOp", "wallUsPerOp"],
    allocation: ["heapGrowthBytesPerOp"],
    cold: ["firstCpuUs", "firstWallUs", "secondCpuUs", "secondWallUs"],
  };
  const groups = new Map();
  for (const run of all) {
    const key = `${run.measure}|${cellKey(run)}`;
    if (!groups.has(key)) groups.set(key, { base: [], candidate: [] });
    groups.get(key)[run.label].push(run);
  }
  const summary = [];
  for (const [key, group] of groups) {
    const [measure, shape, stage, rows, length] = key.split("|");
    for (const metric of metrics[measure]) {
      const paired = group.base.map((baseRun) => {
        const partner = group.candidate.find((r) => r.round === baseRun.round);
        return partner[metric] / baseRun[metric];
      });
      const side = (runs) => {
        const values = runs.map((run) => run[metric]);
        const mid = median(values);
        return {
          median: mid,
          spread: (Math.max(...values) - Math.min(...values)) / mid,
        };
      };
      summary.push({
        measure,
        shape,
        stage,
        rows: Number(rows),
        length: Number(length),
        metric,
        base: side(group.base),
        candidate: side(group.candidate),
        paired: {
          median: median(paired),
          min: Math.min(...paired),
          max: Math.max(...paired),
          belowOne: paired.filter((ratio) => ratio < 1).length,
          n: paired.length,
          ratios: paired,
        },
        gcInWindow:
          measure === "allocation"
            ? [...group.base, ...group.candidate].reduce(
                (sum, run) => sum + run.gcInWindow,
                0
              )
            : undefined,
      });
    }
  }
  console.log(
    "\nmeasure    shape    stage  rows len metric                base (spread)        candidate (spread)   paired [min, max] (<1 of n)"
  );
  for (const row of summary) {
    const value = (v) =>
      row.metric.startsWith("heap")
        ? Math.round(v.median).toString()
        : v.median.toFixed(2);
    console.log(
      [
        row.measure.padEnd(10),
        row.shape.padEnd(8),
        row.stage.padEnd(6),
        String(row.rows).padStart(4),
        String(row.length).padStart(3),
        row.metric.padEnd(20),
        `${value(row.base).padStart(10)} (${(row.base.spread * 100).toFixed(1)}%)`.padEnd(
          20
        ),
        `${value(row.candidate).padStart(10)} (${(row.candidate.spread * 100).toFixed(1)}%)`.padEnd(
          20
        ),
        `${row.paired.median.toFixed(3)} [${row.paired.min.toFixed(3)}, ${row.paired.max.toFixed(3)}] (${row.paired.belowOne}/${row.paired.n})`,
        row.gcInWindow === undefined ? "" : `gc:${row.gcInWindow}`,
      ].join(" ")
    );
  }
  console.log(`\n${JSON.stringify({ summary })}`);
}

const { values } = parseArgs({
  options: {
    worker: { type: "string" },
    base: { type: "string" },
    candidate: { type: "string" },
    rounds: { type: "string", default: "8" },
    "allocation-rounds": { type: "string", default: "4" },
    "cold-rounds": { type: "string", default: "30" },
    measures: { type: "string", default: "verify,time,allocation,cold" },
    cells: { type: "string", default: "" },
    scale: { type: "string", default: "1" },
    out: { type: "string" },
  },
});

if (values.worker) {
  const result = await worker(JSON.parse(values.worker));
  console.log(JSON.stringify(result));
} else {
  if (!(values.base && values.candidate))
    throw new Error("--base and --candidate are required");
  controller({
    base: values.base,
    candidate: values.candidate,
    rounds: Number(values.rounds),
    allocationRounds: Number(values["allocation-rounds"]),
    coldRounds: Number(values["cold-rounds"]),
    measures: values.measures,
    cells: new RegExp(values.cells),
    scale: Number(values.scale),
    out: values.out,
  });
}
