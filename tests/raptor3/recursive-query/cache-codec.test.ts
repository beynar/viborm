/**
 * RQ-05 — a recursive read through the cache, entered through the real client.
 *
 * The cache stores the rows the driver returned for the read's one statement
 * and answers a hit with what the engine's own decoder makes of them, exactly
 * as for a miss (`extensions/codec.ts`). A recursive relation travels in one
 * column, the carrier the decoder reads (a JSON text on SQLite), so the stored
 * form holds no occurrence: every fact below is the decoder's, asked again on
 * each hit.
 *
 * What the cells pin (features-docs/recursive-query.md §3.4 and RQ-05):
 *  - a hit is deep-equal to the miss and shares no object with it, nor with
 *    another hit, at any level — a second recursive slot inside the repeated
 *    node and a junction diamond whose shared row is two objects included —
 *    and a backend that keeps only JSON text serves the same answer;
 *  - a caller mutating a hit's scalar, Date, bytes or JSON leaf, or the miss
 *    after it was stored, does not reach the next hit;
 *  - the numeric cutoff occurrence comes back with the repeated key ABSENT, a
 *    natural end before it with the key PRESENT (`[]`, or `null` for a
 *    singular slot), and an exhaustive read with the key present on every
 *    occurrence;
 *  - a stored carrier the decoder refuses, or a stored value that holds
 *    itself, is refused at the cache boundary;
 *  - a chain at the public depth ceiling (1,000) and an exhaustive chain up to
 *    the occurrence budget (10,000) are stored and served whole.
 *
 * Deep values are compared by iterative walks: `assert.deepStrictEqual` is
 * itself recursive and would measure the assertion, not the cache.
 */

import assert from "node:assert/strict";
import { CacheDriver, type CacheEntry } from "@cache/driver";
import { MemoryCache } from "@cache/drivers/memory";
import { cache } from "@cache/extension";
import { createClient } from "@client/client";
import type { QueryResult } from "@drivers";
import { SQLite3Driver } from "@drivers/sqlite3";
import { CacheConfigurationError } from "@errors";
import { hydrateSchemaNames, s } from "@schema";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import Database from "better-sqlite3";
import { afterEach, describe, it } from "vitest";
import { seedCacheWorld } from "./cache-world";

const node = s
  .model({
    id: s.string().id(),
    label: s.string(),
    bornAt: s.dateTime(),
    meta: s.json(),
    bytes: s.blob(),
    parentId: s.string().nullable(),
    parent: s
      .toOne(() => node)
      .fields("parentId")
      .references("id")
      .name("rqCacheCodecTree"),
    children: s.toMany(() => node).name("rqCacheCodecTree"),
    links: s
      .toMany(() => node)
      .name("rqCacheCodecGraph")
      .source("fromId")
      .target("toId"),
    linkedBy: s.toMany(() => node).name("rqCacheCodecGraph"),
  })
  .map("rq_cache_codec_nodes");

const schema = { node };
hydrateSchemaNames(schema);

/** The public occurrence every read below publishes, as far as a cell asks. */
interface Occurrence {
  id: string;
  label: string;
  bornAt: Date;
  meta: { index: number; nested: { id: string } };
  bytes: Uint8Array;
  parent?: Occurrence | null;
  children?: Occurrence[];
  links?: Occurrence[];
}

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});

const day = (value: number) => new Date(Date.UTC(2026, 0, value, 8, 30));

const LEAVES = {
  id: true,
  label: true,
  bornAt: true,
  meta: true,
  bytes: true,
} as const;

/**
 * Every published form at once: scalar, Date, JSON and bytes leaves, an
 * ordinary relation and a SECOND recursive slot inside the repeated node, a
 * numeric cutoff, a natural end before it, and a default-policy junction walk
 * whose diamond publishes the shared row `d` as two objects.
 */
const RICH = {
  where: { id: "r" },
  select: {
    ...LEAVES,
    children: {
      recurse: { depth: 2 },
      orderBy: { id: "asc" },
      select: {
        ...LEAVES,
        parent: { select: { id: true } },
        links: {
          recurse: { depth: 2 },
          orderBy: { id: "asc" },
          select: { id: true },
        },
      },
    },
    links: {
      recurse: true,
      orderBy: { id: "asc" },
      select: { id: true, meta: true },
    },
  },
};

const BOUNDED = {
  where: { id: "r" },
  select: {
    id: true,
    children: {
      recurse: { depth: 2 },
      orderBy: { id: "asc" },
      select: { id: true },
    },
  },
};

const EXHAUSTIVE = {
  where: { id: "r" },
  select: {
    id: true,
    children: {
      recurse: { depth: false },
      orderBy: { id: "asc" },
      select: { id: true },
    },
  },
};

/** A property of an object-like value, or `undefined`. */
const get = (value: unknown, key: PropertyKey): unknown =>
  typeof value === "object" && value !== null
    ? Reflect.get(value, key)
    : undefined;

/** The first object `left` shares with `right` at the same place, if any. */
function sharedObject(left: unknown, right: unknown): unknown {
  const pending: (readonly [unknown, unknown])[] = [[left, right]];
  while (pending.length > 0) {
    const [a, b] = pending.pop() as readonly [unknown, unknown];
    if (typeof a !== "object" || a === null) continue;
    if (a === b) return a;
    if (a instanceof Date || a instanceof Uint8Array) continue;
    for (const key of Object.keys(a)) pending.push([get(a, key), get(b, key)]);
  }
  return;
}

/** A stored array, as a mutable one; any other layout is a fixture error. */
function list(value: unknown): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error("the stored snapshot does not have the expected layout");
  }
  return value;
}

/** Answers the next read with `rows` in place of the database's. */
class ScriptedSQLiteDriver extends SQLite3Driver {
  next: Record<string, unknown>[] | undefined;
  protected override async execute<T>(
    client: Database.Database,
    statement: string,
    parameters: unknown[]
  ): Promise<QueryResult<T>> {
    const rows = this.next;
    this.next = undefined;
    return rows === undefined
      ? super.execute<T>(client, statement, parameters)
      : { rows: rows as T[], rowCount: rows.length };
  }
}

/** A backend that keeps only JSON text, and lets a cell rewrite what it reads. */
class JsonCache extends CacheDriver {
  readonly store = new Map<string, string>();
  rewrite: ((value: unknown) => unknown) | undefined;
  constructor() {
    super("json");
  }
  protected async get<T>(key: string): Promise<CacheEntry<T> | null> {
    const text = this.store.get(key);
    if (text === undefined) return null;
    const entry = JSON.parse(text);
    const rewrite = this.rewrite;
    this.rewrite = undefined;
    return rewrite ? { ...entry, value: rewrite(entry.value) } : entry;
  }
  protected async set<T>(
    key: string,
    _ttl: number,
    entry: CacheEntry<T>
  ): Promise<void> {
    this.store.set(key, JSON.stringify(entry));
  }
  protected async delete(keys: string[]): Promise<void> {
    for (const key of keys) this.store.delete(key);
  }
  protected async clear(prefix: string): Promise<void> {
    for (const key of [...this.store.keys()])
      if (key.startsWith(prefix)) this.store.delete(key);
  }
}

/** Lets the background set of a miss land before the next read. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 5));

type Operation = "findMany" | "findUnique";

/**
 * r → a → a1 → a1x and r → b by foreign key; r → a, r → b, a → d, b → d and
 * d → r by junction — a diamond at d and a cycle back to the root. `read`
 * reads without the cache; `cached` reads through a memory backend, `json`
 * through a backend that keeps JSON text only.
 */
async function world() {
  const database = new Database(":memory:");
  const driver = new ScriptedSQLiteDriver({ client: database });
  const client = createClient({ schema, driver });
  closers.push(async () => {
    await client.$disconnect();
    database.close();
  });
  const migration = await syncLiveSchema(client);
  if (!migration.applied)
    throw new Error("the recursive cache schema did not apply");
  await seedCacheWorld(client, (id, index) => ({
    bornAt: day(index + 1),
    meta: { index, nested: { id } },
    bytes: new Uint8Array([index, 255 - index]),
  }));
  const backend = new JsonCache();
  const through = (driverOf: CacheDriver) => {
    const reader = client.$extends(cache({ driver: driverOf })).$withCache();
    return async (
      args: Record<string, unknown>,
      operation: Operation = "findMany"
    ): Promise<unknown> => {
      const value: unknown = await Reflect.apply(
        reader.node[operation],
        reader.node,
        [args]
      );
      await settle();
      return value;
    };
  };
  return {
    driver,
    backend,
    read: (
      args: Record<string, unknown>,
      operation: Operation = "findMany"
    ): Promise<unknown> =>
      Reflect.apply(client.node[operation], client.node, [args]),
    cached: through(new MemoryCache()),
    json: through(backend),
  };
}

/**
 * A synthetic provider row for `root → n1 → … → n<levels>`, carried the way
 * SQLite answers a recursive relation column: one JSON text document.
 */
function chainRow(levels: number, bounded: boolean): Record<string, unknown> {
  const nodes: unknown[] = [];
  const edges: unknown[] = [];
  let parent = "root";
  for (let level = 1; level <= levels; level += 1) {
    const child = `n${level}`;
    nodes.push({ __rq_key: [child], __rq_row: { id: child } });
    edges.push({
      __rq_parent: [parent],
      __rq_child: [child],
      ...(bounded ? { __rq_depth: level } : {}),
    });
    parent = child;
  }
  return {
    id: "root",
    children: JSON.stringify({
      __rq_root: ["root"],
      __rq_nodes: nodes,
      __rq_edges: edges,
    }),
  };
}

/**
 * `root → n1 → …` reduced iteratively: how many levels hold exactly the next
 * occurrence, and how the last one ends — its repeated key ABSENT (`cutoff`),
 * or PRESENT and empty (`empty`).
 */
function chainSummary(rows: unknown): {
  readonly levels: number;
  readonly end: string;
} {
  let occurrences = list(get(list(rows)[0], "children"));
  let levels = 0;
  while (
    occurrences.length === 1 &&
    get(occurrences[0], "id") === `n${levels + 1}`
  ) {
    levels += 1;
    const occurrence = occurrences[0] as object;
    if (!Object.hasOwn(occurrence, "children"))
      return { levels, end: "cutoff" };
    occurrences = list(get(occurrence, "children"));
  }
  return { levels, end: occurrences.length === 0 ? "empty" : "malformed" };
}

/** Where a read ends: answered, or refused by the cache at `method`. */
async function outcome(read: Promise<unknown>): Promise<string> {
  try {
    await read;
    return "answered";
  } catch (error) {
    return error instanceof CacheConfigurationError
      ? `refused by ${String(error.meta.method)} of ${String(error.meta.operation)}`
      : `failed with ${String(error)}`;
  }
}

/**
 * A deep chain through the cache: the driver answers the miss with the
 * synthetic carrier row, the hit is the stored rows decoded again. What each
 * published, and the wall time of each read (read back through the JSON
 * reporter's `meta`).
 */
async function deepChain(levels: number, depth: number | false) {
  const database = new Database(":memory:");
  const driver = new ScriptedSQLiteDriver({ client: database });
  const client = createClient({ schema, driver });
  closers.push(async () => {
    await client.$disconnect();
    database.close();
  });
  const reader = client.$extends(cache({ driver: new MemoryCache() }));
  const read = () =>
    reader.$withCache().node.findMany({
      where: { id: "root" },
      select: {
        id: true,
        children: { recurse: { depth }, select: { id: true } },
      },
    });
  driver.next = [chainRow(levels, depth !== false)];
  let started = performance.now();
  const miss = await read();
  const missMs = performance.now() - started;
  await settle();
  started = performance.now();
  const hit = await read();
  const hitMs = performance.now() - started;
  return {
    miss: chainSummary(miss),
    hit: chainSummary(hit),
    shared: sharedObject(miss, hit),
    phaseMs: { miss: missMs, hit: hitMs },
  };
}

describe("RQ-05 a recursive read through the cache", () => {
  it("answers a hit deep-equal to the miss with no shared object at any level", async () => {
    const { cached, json } = await world();
    const miss = (await cached(RICH)) as Occurrence[];

    // The miss is the decoder's own value: the facts a hit must keep.
    const [root] = miss;
    assert(root?.children && root.links);
    const [a, b] = root.children;
    assert(a?.children && b);
    assert.deepEqual(b.children, []);
    assert.equal(Object.hasOwn(a.children[0] ?? {}, "children"), false);
    assert.deepEqual(a.links?.[0]?.links, [{ id: "r" }]);
    const viaA = root.links[0]?.links?.[0];
    const viaB = root.links[1]?.links?.[0];
    assert.equal(viaA?.id, "d");
    assert.equal(viaB?.id, "d");
    assert.notEqual(viaA, viaB);

    const first = await cached(RICH);
    const second = await cached(RICH);
    assert.deepStrictEqual(first, miss);
    assert.deepStrictEqual(second, miss);
    assert.equal(sharedObject(miss, first), undefined);
    assert.equal(sharedObject(first, second), undefined);
    // A repeated row in distinct objects stays two objects on every hit.
    const hit = first as Occurrence[];
    assert.notEqual(
      hit[0]?.links?.[0]?.links?.[0],
      hit[0]?.links?.[1]?.links?.[0]
    );
    // The stored form is plain detached data: a JSON backend round-trips it.
    assert.deepStrictEqual(await json(RICH), miss);
    assert.deepStrictEqual(await json(RICH), miss);
  });

  it("keeps a caller's mutation of a hit or of the miss out of the next hit", async () => {
    const { cached } = await world();
    const miss = (await cached(RICH)) as Occurrence[];
    const pristine = structuredClone(miss);

    const hit = (await cached(RICH)) as Occurrence[];
    const root = hit[0];
    const child = root?.children?.[0];
    const grandchild = child?.children?.[0];
    const shared = root?.links?.[0]?.links?.[0];
    assert(root && child && grandchild && shared);
    root.label = "caller";
    root.bornAt.setTime(0);
    root.bytes[0] = 42;
    root.meta.nested.id = "caller";
    child.bornAt.setUTCFullYear(1999);
    child.bytes.fill(7);
    child.meta.index = 99;
    child.children?.push(grandchild);
    grandchild.label = "caller";
    grandchild.meta.nested.id = "caller";
    shared.meta.nested.id = "caller";
    child.links?.splice(0);
    // The miss belongs to its caller too: storing it did not capture it.
    const missChild = miss[0]?.children?.[0];
    assert(missChild);
    missChild.meta.nested.id = "miss-caller";
    missChild.bornAt.setTime(0);

    assert.deepStrictEqual(await cached(RICH), pristine);
  });

  it("serves the cutoff key's absence and the natural end's presence", async () => {
    const { cached } = await world();
    const boundedExpected = [
      {
        id: "r",
        children: [
          { id: "a", children: [{ id: "a1" }] },
          { id: "b", children: [] },
        ],
      },
    ];
    assert.deepStrictEqual(await cached(BOUNDED), boundedExpected);
    const boundedHit = (await cached(BOUNDED)) as Occurrence[];
    assert.deepStrictEqual(boundedHit, boundedExpected);
    const [a, b] = boundedHit[0]?.children ?? [];
    assert(a?.children && b);
    // Level 2 is the cutoff: the repeated key is absent, not empty.
    assert.equal(Object.hasOwn(a.children[0] ?? {}, "children"), false);
    // Level 1 is before it: a node with no child states the empty end.
    assert.equal(Object.hasOwn(b, "children"), true);

    const exhaustiveExpected = [
      {
        id: "r",
        children: [
          {
            id: "a",
            children: [{ id: "a1", children: [{ id: "a1x", children: [] }] }],
          },
          { id: "b", children: [] },
        ],
      },
    ];
    assert.deepStrictEqual(await cached(EXHAUSTIVE), exhaustiveExpected);
    assert.deepStrictEqual(await cached(EXHAUSTIVE), exhaustiveExpected);
  });

  it("serves a singular slot's null at the outer slot and at a natural end", async () => {
    const { read, cached } = await world();
    const upward = (id: string, recurse: unknown) => ({
      where: { id },
      select: { id: true, parent: { recurse, select: { id: true } } },
    });
    const fromLeaf = {
      id: "a1x",
      parent: {
        id: "a1",
        parent: { id: "a", parent: { id: "r", parent: null } },
      },
    };
    const cases: readonly [Record<string, unknown>, unknown][] = [
      [upward("a1x", true), [fromLeaf]],
      [upward("r", true), [{ id: "r", parent: null }]],
      [upward("a1x", { depth: 1 }), [{ id: "a1x", parent: { id: "a1" } }]],
    ];
    for (const [args, expected] of cases) {
      assert.deepStrictEqual(await read(args), expected);
      assert.deepStrictEqual(await cached(args), expected);
      assert.deepStrictEqual(await cached(args), expected);
    }

    // The same slot under a single-row verb, whose own absence is `null` too.
    const unique = upward("a1x", true);
    assert.deepStrictEqual(await cached(unique, "findUnique"), fromLeaf);
    assert.deepStrictEqual(await cached(unique, "findUnique"), fromLeaf);
    const missing = upward("zz", true);
    assert.equal(await cached(missing, "findUnique"), null);
    assert.equal(await cached(missing, "findUnique"), null);
  });

  it("refuses a stored carrier the decoder refuses, at the cache boundary", async () => {
    const { json, backend } = await world();
    await json(BOUNDED);
    /** The stored root row's carrier, rewritten by `edit`. */
    const corrupt =
      (edit: (carrier: Record<string, unknown[]>) => void) =>
      (value: unknown): unknown => {
        const [row] = list(value);
        const carrier = JSON.parse(
          String(Reflect.get(new Object(row), "children"))
        );
        edit(carrier);
        return [{ ...new Object(row), children: JSON.stringify(carrier) }];
      };
    const refused = "refused by materialize of findMany";
    for (const edit of [
      // A key tuple of the wrong width.
      (carrier: Record<string, unknown[]>) => {
        carrier.__rq_root = ["r", "extra"];
      },
      // An edge deeper than the cutoff.
      (carrier: Record<string, unknown[]>) => {
        for (const edge of carrier.__rq_edges ?? [])
          Reflect.set(edge as object, "__rq_depth", 9);
      },
      // A node that is no document.
      (carrier: Record<string, unknown[]>) => {
        carrier.__rq_nodes = ["x"];
      },
    ]) {
      backend.rewrite = corrupt(edit);
      assert.equal(await outcome(json(BOUNDED)), refused);
    }
    // The rows themselves: a carrier that is not text, and no rows' list.
    backend.rewrite = () => [{ id: "r", children: 1 }];
    assert.equal(await outcome(json(BOUNDED)), refused);
    backend.rewrite = () => ({ id: "r" });
    assert.equal(await outcome(json(BOUNDED)), refused);
    // Left alone, the entry is served again.
    assert.equal(await outcome(json(BOUNDED)), "answered");
  });

  it("refuses a stored value that holds itself, promptly", async () => {
    const memory = new MemoryCache();
    const { driver } = await world();
    const client = createClient({ schema, driver });
    closers.push(() => client.$disconnect());
    const reader = client.$extends(cache({ driver: memory })).$withCache();
    const read = (): Promise<unknown> =>
      Reflect.apply(reader.node.findMany, reader.node, [BOUNDED]);
    await read();
    await settle();
    // A backend that hands back an object containing itself: no JSON text
    // can, an in-memory one can.
    const original = Reflect.get(memory, "get");
    Reflect.set(memory, "get", async (key: string) => {
      const entry = await Reflect.apply(original, memory, [key]);
      if (entry === null) return entry;
      const row: Record<string, unknown> = { id: "r" };
      row.children = row;
      return { ...entry, value: [row] };
    });
    const started = performance.now();
    assert.equal(await outcome(read()), "refused by materialize of findMany");
    assert.ok(performance.now() - started < 1000);
  });

  it("stores and serves a chain at the 1,000-level depth ceiling", async ({
    task,
  }) => {
    const chain = await deepChain(1000, 1000);
    Object.assign(task.meta, { phaseMs: chain.phaseMs });
    // Level 1,000 is the cutoff: its repeated key is absent on both reads.
    assert.deepEqual(chain.miss, { levels: 1000, end: "cutoff" });
    assert.deepEqual(chain.hit, { levels: 1000, end: "cutoff" });
    assert.equal(chain.shared, undefined);
  });

  it("stores and serves an exhaustive chain of 10,000 levels", async ({
    task,
  }) => {
    const chain = await deepChain(10_000, false);
    Object.assign(task.meta, { phaseMs: chain.phaseMs });
    // Exhaustive: the key is present to the natural end, which is empty.
    assert.deepEqual(chain.miss, { levels: 10_000, end: "empty" });
    assert.deepEqual(chain.hit, { levels: 10_000, end: "empty" });
    assert.equal(chain.shared, undefined);
  });
});
