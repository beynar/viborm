// D3: history storage bindings for a tenant on Workers. Two thin
// `ObjectStoreConditionalPut` implementations, over a Durable Object's
// `ctx.storage` and over an R2 bucket, ship as subpaths next to
// `viborm/migrations/storage/fs`, and both pass the exported conformance suite
// once it is extended with a create race, an absent read, list-after-publish
// and manifest-last. The probe checks the suite's size and adds its own create
// race, absent read and list-after-publish across writers that share one
// backing store; manifest-last is the suite's own case (a listed state's
// snapshot and SQL are already readable while the publisher writes them in
// order).
//
// The bindings are found through the installed export map (any
// `./migrations/storage/*` subpath naming a Durable Object or R2) and fed
// in-memory fakes that keep the platform's semantics where they matter:
// - Durable Object storage: async get/put/list that interleave across awaits
//   (a get-then-put outside a transaction races), a serialized
//   `transaction()`, and a SQL API (`sql.exec`) backed by SQLite;
// - R2: get, an atomic conditional put (`onlyIf` etag conditions or Headers;
//   null when the condition fails) and a `list` that pages with a cursor at 3
//   keys.
// Each fake exposes itself as `.storage` / `.bucket` as well, so a binding that
// takes `ctx` or `{ bucket }` reaches it too.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { VibORMErrorCode } from "viborm";
import {
  createStorageConformanceSuite,
  ObjectStoreEstateStorage,
} from "viborm/migrations";

export const meta = {
  id: "D3",
  title:
    "Durable Object and R2 history storage subpaths pass the extended conformance suite",
  plan: "phase-2/D3",
  needs: [],
  source:
    "docs/architecture/completion-plan-2026-10/code-check/migrations-sqlite.md (D3: src/migrations/storage/object-store.ts:19-116, storage/conformance.ts:11-69); docs/architecture/pg-migrations-from-durable-objects-2026-10-10.md §3.3",
};

const SHIPPED_CASES = 4;
const EXTENDED_CASES = SHIPPED_CASES + 4;
const R2_PAGE = 3;
const RACERS = 8;
const LISTED_STATES = 7;
const STORAGE_PREFIX = "./migrations/storage/";
const DO_NAME = /durable|(^|[-_/])do($|[-_/])/i;
const R2_NAME = /(^|[-_/])r2($|[-_/])/i;
const CLASS_SOURCE = /^class\b/;
const encoder = new TextEncoder();

const tick = () => new Promise((resolve) => setImmediate(resolve));
const toBytes = (value) => {
  if (value instanceof Uint8Array) return value.slice();
  if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(
      value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength)
    );
  }
  if (typeof value === "string") return encoder.encode(value);
  throw new TypeError(`fake storage cannot store ${typeof value}`);
};
const hex = (text) => createHash("sha256").update(text).digest("hex");

// ---------------------------------------------------------------- fakes

function fakeSql(tmpDatabases) {
  const db = new Database(":memory:");
  tmpDatabases.push(db);
  const bind = (value) =>
    value instanceof ArrayBuffer || ArrayBuffer.isView(value)
      ? Buffer.from(toBytes(value))
      : value;
  const unbind = (value) =>
    Buffer.isBuffer(value) ? new Uint8Array(value).slice().buffer : value;
  // A cursor with `toArray`, `rowsWritten` and iteration (`for … of`).
  const cursor = (rows, rowsWritten) => ({
    rowsWritten,
    toArray: () => rows,
    [Symbol.iterator]: () => rows[Symbol.iterator](),
  });
  return {
    exec(query, ...bindings) {
      const statement = db.prepare(query);
      const values = bindings.map(bind);
      if (!statement.reader)
        return cursor([], statement.run(...values).changes);
      const rows = statement
        .all(...values)
        .map((row) =>
          Object.fromEntries(
            Object.entries(row).map(([k, v]) => [k, unbind(v)])
          )
        );
      return cursor(rows, 0);
    },
  };
}

function fakeDurableObjectStorage(tmpDatabases) {
  const data = new Map();
  let queue = Promise.resolve();
  const direct = {
    get: async (key) => {
      await tick();
      return data.has(key) ? structuredClone(data.get(key)) : undefined;
    },
    put: async (key, value) => {
      await tick();
      data.set(key, structuredClone(value));
    },
    list: async ({ prefix = "" } = {}) => {
      await tick();
      const keys = [...data.keys()].filter((key) => key.startsWith(prefix));
      return new Map(
        keys.sort().map((key) => [key, structuredClone(data.get(key))])
      );
    },
  };
  const storage = {
    ...direct,
    sql: fakeSql(tmpDatabases),
    transaction(closure) {
      // Serialized; writes are staged and applied when the closure settles,
      // unless it throws or calls rollback().
      const staged = new Map();
      let rolledBack = false;
      const txn = {
        get: async (key) =>
          staged.has(key) ? structuredClone(staged.get(key)) : direct.get(key),
        put: async (key, value) => {
          staged.set(key, structuredClone(value));
        },
        list: direct.list,
        rollback: () => {
          rolledBack = true;
        },
      };
      const run = queue.then(async () => {
        const result = await closure(txn);
        if (!rolledBack)
          for (const [key, value] of staged) data.set(key, value);
        return result;
      });
      queue = run.catch(() => undefined);
      return run;
    },
  };
  storage.storage = storage;
  return storage;
}

// R2 `onlyIf` as etag conditions or Headers.
function conditionHolds(existing, onlyIf) {
  if (!onlyIf) return true;
  const header = (name) =>
    onlyIf instanceof Headers ? onlyIf.get(name) : null;
  const noneMatch = onlyIf.etagDoesNotMatch ?? header("if-none-match");
  const match = onlyIf.etagMatches ?? header("if-match");
  const tags = (value) => String(value).replaceAll('"', "");
  if (
    noneMatch != null &&
    existing &&
    (tags(noneMatch) === "*" || tags(noneMatch) === existing.etag)
  )
    return false;
  if (
    match != null &&
    (!existing || (tags(match) !== "*" && tags(match) !== existing.etag))
  )
    return false;
  return true;
}

const r2Object = (key, { bytes, etag }) => ({
  key,
  size: bytes.byteLength,
  etag,
  httpEtag: `"${etag}"`,
  arrayBuffer: async () => bytes.slice().buffer,
  bytes: async () => bytes.slice(),
});

function fakeR2Bucket() {
  const objects = new Map();
  const bucket = {
    async get(key) {
      await tick();
      const entry = objects.get(key);
      return entry ? r2Object(key, entry) : null;
    },
    async put(key, value, options) {
      const bytes = toBytes(value);
      await tick();
      // The condition and the write are one atomic step, as on R2.
      if (!conditionHolds(objects.get(key), options?.onlyIf)) return null;
      const entry = {
        bytes,
        etag: createHash("md5").update(bytes).digest("hex"),
      };
      objects.set(key, entry);
      return r2Object(key, entry);
    },
    async list({ prefix = "", cursor, limit = 1000 } = {}) {
      await tick();
      const keys = [...objects.keys()]
        .filter(
          (key) =>
            key.startsWith(prefix) && (cursor === undefined || key > cursor)
        )
        .sort();
      // R2 may return fewer keys than `limit` and still be truncated.
      const page = keys.slice(0, Math.min(limit, R2_PAGE));
      const truncated = keys.length > page.length;
      return {
        objects: page.map((key) => r2Object(key, objects.get(key))),
        truncated,
        ...(truncated ? { cursor: page.at(-1) } : {}),
      };
    },
  };
  bucket.bucket = bucket;
  return bucket;
}

// ---------------------------------------------------------- discovery

async function bindingFactories(label, module, makeFake) {
  const asWriter = (store) =>
    typeof store?.publishState === "function"
      ? store
      : new ObjectStoreEstateStorage(store);
  for (const [name, value] of Object.entries(module)) {
    if (typeof value !== "function") continue;
    const isClass = CLASS_SOURCE.test(Function.prototype.toString.call(value));
    const construct = (fake) => (isClass ? new value(fake) : value(fake));
    let made;
    try {
      made = await construct(makeFake());
    } catch {
      continue;
    }
    if (
      typeof made?.publishState === "function" ||
      typeof made?.putIfAbsent === "function"
    ) {
      const isAsync = typeof construct(makeFake())?.then === "function";
      return {
        label: `${label}.${name}`,
        isAsync,
        // One writer over one backing fake; passing the same fake shares it.
        writer: async (fake) => asWriter(await construct(fake)),
        writerSync: (fake) => asWriter(construct(fake)),
      };
    }
  }
  return null;
}

// ------------------------------------------------------- extra checks

const stateBytes = (n) => encoder.encode(`{"state":${n}}`);
const isCorruption = (error) =>
  error?.code === VibORMErrorCode.MIGRATION_CORRUPTION;

async function extendedChecks(binding, makeFake) {
  const failures = [];
  const check = async (name, run) => {
    try {
      await run();
    } catch (error) {
      failures.push(
        `${name}: ${String(error?.message ?? error).slice(0, 120)}`
      );
    }
  };

  await check("absent read", async () => {
    const writer = await binding.writer(makeFake());
    const id = hex("absent");
    const reads = await Promise.all([
      writer.readEstate(),
      writer.readState(id),
      writer.readSql(id),
      writer.readSnapshot(id),
    ]);
    if (reads.some((read) => read !== null)) {
      throw new Error(
        `absent reads returned ${reads.map((r) => (r === null ? "null" : typeof r))}`
      );
    }
  });

  await check("create race (identical bytes)", async () => {
    const fake = makeFake();
    const id = hex("race-identical");
    const writers = await Promise.all(
      Array.from({ length: RACERS }, () => binding.writer(fake))
    );
    const outcomes = await Promise.all(
      writers.map((w) => w.publishState(id, stateBytes(1)))
    );
    const created = outcomes.filter((o) => o.outcome === "created").length;
    if (created !== 1)
      throw new Error(`${created} of ${RACERS} racers saw "created"`);
  });

  await check("create race (different bytes)", async () => {
    const fake = makeFake();
    const id = hex("race-different");
    const writers = await Promise.all(
      Array.from({ length: RACERS }, () => binding.writer(fake))
    );
    const settled = await Promise.allSettled(
      writers.map((w, n) => w.publishState(id, stateBytes(n)))
    );
    const winners = settled.filter(
      (s) => s.status === "fulfilled" && s.value.outcome === "created"
    );
    const corrupt = settled.filter(
      (s) => s.status === "rejected" && isCorruption(s.reason)
    );
    if (winners.length !== 1 || corrupt.length !== RACERS - 1) {
      throw new Error(
        `${winners.length} created, ${corrupt.length} refused as corruption of ${RACERS}`
      );
    }
    const stored = new TextDecoder().decode(await writers[0].readState(id));
    const winner = settled.indexOf(winners[0]);
    if (stored !== `{"state":${winner}}`)
      throw new Error(`stored ${stored}, winner wrote state ${winner}`);
  });

  await check("list-after-publish", async () => {
    const fake = makeFake();
    const writer = await binding.writer(fake);
    const reader = await binding.writer(fake);
    const ids = Array.from({ length: LISTED_STATES }, (_, n) =>
      hex(`listed-${n}`)
    );
    for (const [n, id] of ids.entries())
      await writer.publishState(id, stateBytes(n));
    const listed = await reader.listStates();
    const missing = ids.filter((id) => !listed.includes(id));
    if (missing.length > 0 || listed.length !== ids.length) {
      throw new Error(
        `listed ${listed.length} of ${ids.length} published states right after publish`
      );
    }
  });

  return failures;
}

async function runSuite(binding, makeFake) {
  const failures = [];
  // The suite's factory is synchronous: hand a synchronous binding's writer
  // straight through; resolve an async binding's writers, one per case, first.
  const pending = [];
  const factory = binding.isAsync
    ? () => {
        if (pending.length === 0) {
          throw new Error("suite called the factory more than once per case");
        }
        return pending.shift();
      }
    : () => binding.writerSync(makeFake());
  const suite = createStorageConformanceSuite(factory);
  if (binding.isAsync) {
    for (const _testCase of suite)
      pending.push(await binding.writer(makeFake()));
  }
  for (const testCase of suite) {
    try {
      await testCase.run();
    } catch (error) {
      failures.push(
        `${testCase.name}: ${String(error?.message ?? error).slice(0, 120)}`
      );
    }
  }
  return failures;
}

// ---------------------------------------------------------------- probe

export default async function probe() {
  const problems = [];
  const facts = [];
  const tmpDatabases = [];
  try {
    const suiteSize = createStorageConformanceSuite(() => null).length;
    if (suiteSize < EXTENDED_CASES) {
      problems.push(
        `createStorageConformanceSuite has ${suiteSize} cases (no create race, absent read, list-after-publish or manifest-last; expected >= ${EXTENDED_CASES})`
      );
    } else {
      facts.push(`conformance suite: ${suiteSize} cases`);
    }

    const packageJsonUrl = new URL(
      "../package.json",
      import.meta.resolve("viborm")
    );
    const exportsMap = JSON.parse(
      readFileSync(fileURLToPath(packageJsonUrl), "utf8")
    ).exports;
    const storageSubpaths = Object.keys(exportsMap).filter(
      (key) => key.startsWith(STORAGE_PREFIX) && key !== `${STORAGE_PREFIX}fs`
    );
    facts.push(
      `storage subpaths: ${Object.keys(exportsMap)
        .filter((k) => k.startsWith(STORAGE_PREFIX))
        .join(", ")}`
    );

    const kinds = [
      {
        kind: "Durable Object",
        pattern: DO_NAME,
        makeFake: () => fakeDurableObjectStorage(tmpDatabases),
      },
      { kind: "R2", pattern: R2_NAME, makeFake: fakeR2Bucket },
    ];
    for (const { kind, pattern, makeFake } of kinds) {
      const subpath = storageSubpaths.find((key) =>
        pattern.test(key.slice(STORAGE_PREFIX.length))
      );
      if (!subpath) {
        problems.push(
          `missing ${kind} subpath next to viborm/migrations/storage/fs`
        );
        continue;
      }
      const specifier = `viborm${subpath.slice(1)}`;
      const module = await import(specifier);
      const binding = await bindingFactories(specifier, module, makeFake);
      if (!binding) {
        problems.push(
          `${specifier} exports nothing that turns a fake ${kind} into an object store or estate writer (exports: ${Object.keys(module).join(", ")})`
        );
        continue;
      }
      const failures = [
        ...(await runSuite(binding, makeFake)),
        ...(await extendedChecks(binding, makeFake)),
      ];
      if (failures.length > 0) {
        problems.push(`${binding.label}: ${failures.join("; ")}`);
      } else {
        facts.push(
          `${binding.label}: suite + race/absent/list-after-publish green`
        );
      }
    }
  } finally {
    for (const db of tmpDatabases) db.close();
  }
  return {
    status: problems.length === 0 ? "pass" : "fail",
    evidence: [...problems, ...facts].join(" | "),
  };
}
