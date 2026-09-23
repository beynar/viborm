/**
 * RQ-05 — a recursive read through the shipped client and the OFFICIAL cache.
 *
 * The recursive relation adds a value codec to the live route; it adds nothing
 * to the cache lifecycle, and these cells hold it to exactly that. Every read
 * below goes through `createClient(…).$extends(cache(…))` on a real SQLite
 * database, so identity, storage, staleness, invalidation and bypass are the
 * official owners' own (features-docs/recursive-query.md §2.5, §3.4, RQ-05):
 *
 *  - canonical admitted arguments already own the cache identity: `true`, `{}`,
 *    `{ depth: 100 }` and an undefined depth are ONE entry, while another depth
 *    or cycle policy is another entry — no recursive key serializer;
 *  - hits are detached and answer without a statement; a stale entry is served
 *    and refreshed in the background, as for any other read;
 *  - the existing invalidation policy reaches a recursive entry exactly as it
 *    reaches an ordinary one, and claims nothing stronger;
 *  - array transactions, the pending operation's driver override, callback
 *    transactions and statement-transform chains bypass the cache for a
 *    recursive read exactly as for an ordinary relation read (mirroring
 *    `official-cache-reads.test.ts` "bypasses cache work …");
 *  - request extensions — chains of 0, 1 and 5 — cannot inject or replace
 *    `recurse`: the protected `select`/`include`/`omit` never reach them, and a
 *    top-level `recurse` is refused at admission before any cache work;
 *  - model, client-default and query `omit` apply at every repeated level and
 *    compose with `select`, before the entry is keyed;
 *  - a cached read the decoder refuses (a foreign-key cycle in the traversed
 *    window) rejects with the decoder's own error every time, storing nothing.
 *
 * Arguments are passed untyped (`Reflect.apply`): the cells vary the admitted
 * forms, and the public static surface is the type author's probe file.
 */

import assert from "node:assert/strict";
import type { CacheEntry } from "@cache/driver";
import { MemoryCache } from "@cache/drivers/memory";
import { cache } from "@cache/extension";
import { createClient } from "@client/client";
import { defaultOmit } from "@client/default-omit-extension";
import { QueryEngineError, ValidationError } from "@errors";
import { s } from "@schema";
import { ClockedMemoryCache } from "@tests/fixtures/clocked-memory-cache";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import { createTestClock } from "@tests/fixtures/test-clock";
import { readTestTransactionOperation } from "@tests/fixtures/transaction-operation";
import Database from "better-sqlite3";
import { afterEach, describe, it } from "vitest";
import { RecordingSQLiteDriver } from "../g4/unit02/world";
import { seedCacheWorld } from "./cache-world";

const node = s
  .model({
    id: s.string().id(),
    label: s.string(),
    secret: s.string(),
    note: s.string(),
    hidden: s.string().default("classified"),
    parentId: s.string().nullable(),
    parent: s
      .toOne(() => node)
      .fields("parentId")
      .references("id")
      .name("rqCacheLifecycleTree"),
    children: s.toMany(() => node).name("rqCacheLifecycleTree"),
    links: s
      .toMany(() => node)
      .name("rqCacheLifecycleGraph")
      .source("fromId")
      .target("toId"),
    linkedBy: s.toMany(() => node).name("rqCacheLifecycleGraph"),
  })
  .omit({ hidden: true })
  .map("rq_cache_lifecycle_nodes");

const schema = { node };

/** Records every backend call the official cache makes. */
class RecordingCache extends MemoryCache {
  readonly gets: string[] = [];
  readonly sets: string[] = [];
  readonly clears: string[] = [];
  readonly deletes: string[][] = [];

  protected override async get<T>(key: string): Promise<CacheEntry<T> | null> {
    this.gets.push(key);
    return super.get<T>(key);
  }

  protected override async set<T>(
    key: string,
    storageTtl: number,
    entry: CacheEntry<T>
  ): Promise<void> {
    this.sets.push(key);
    await super.set(key, storageTtl, entry);
  }

  protected override async delete(keys: string[]): Promise<void> {
    this.deletes.push([...keys]);
    await super.delete(keys);
  }

  protected override async clear(prefix: string): Promise<void> {
    this.clears.push(prefix);
    await super.clear(prefix);
  }

  get calls() {
    return {
      clears: [...this.clears],
      deletes: [...this.deletes],
      gets: [...this.gets],
      sets: [...this.sets],
    };
  }
}

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});

/** r → a → a1 → a1x and r → b by foreign key; r → a|b → d → r by junction. */
async function world() {
  const database = new Database(":memory:");
  const driver = new RecordingSQLiteDriver({ client: database });
  const client = createClient({ schema, driver });
  closers.push(async () => {
    await client.$disconnect();
    database.close();
  });
  const migration = await syncLiveSchema(client);
  if (!migration.applied)
    throw new Error("the recursive cache schema did not apply");
  await seedCacheWorld(client, (id) => ({
    secret: `s-${id}`,
    note: `n-${id}`,
  }));
  driver.reset();
  return { client, driver };
}

function officialCache(cacheDriver: MemoryCache | ClockedMemoryCache) {
  const background: Promise<unknown>[] = [];
  const extension = cache({
    driver: cacheDriver,
    version: "rq05",
    waitUntil(promise) {
      background.push(promise);
    },
  });
  return {
    extension,
    async settle(): Promise<void> {
      while (background.length > 0) await background.shift();
    },
  };
}

/**
 * A property of an object-like value, or `undefined`. Client surfaces are
 * callable proxies, so a function is object-like here too.
 */
const get = (value: unknown, key: PropertyKey): unknown =>
  (typeof value === "object" && value !== null) || typeof value === "function"
    ? Reflect.get(value, key)
    : undefined;

/** `target[method](...args)`, on a surface whose static type a cell ignores. */
function invoke(target: unknown, method: string, ...args: unknown[]): unknown {
  const member = get(target, method);
  if (typeof member !== "function") throw new Error(`no '${method}' here`);
  return Reflect.apply(member, target, args);
}

/** One public model call: the pending operation, lazily awaited by callers. */
const call = (
  delegate: unknown,
  operation: string,
  args: Record<string, unknown>
): Promise<unknown> => invoke(delegate, operation, args) as Promise<unknown>;

const RECURSIVE_READ = /WITH RECURSIVE/;

/** How many statements were the recursive read itself. */
const recursiveReads = (driver: RecordingSQLiteDriver): number =>
  driver.statements.filter(({ sql }) => RECURSIVE_READ.test(sql)).length;

/** The decoder's own refusal of a foreign-key cycle inside the window. */
const FK_CYCLE = /Recursive relation 'children' contains a cycle\./;

const tree = (recurse: unknown) => ({
  where: { id: "r" },
  select: {
    id: true,
    label: true,
    children: {
      recurse,
      orderBy: { id: "asc" },
      select: { id: true, label: true },
    },
  },
});

const graph = (recurse: unknown) => ({
  where: { id: "r" },
  select: {
    id: true,
    links: { recurse, orderBy: { id: "asc" }, select: { id: true } },
  },
});

/** The ordinary relation read beside which every bypass is measured. */
const ORDINARY = {
  where: { id: "r" },
  select: {
    id: true,
    children: { orderBy: { id: "asc" }, select: { id: true } },
  },
};
const ORDINARY_VALUE = [{ id: "r", children: [{ id: "a" }, { id: "b" }] }];

const SHALLOW = tree({ depth: 1 });
const SHALLOW_VALUE = [
  {
    id: "r",
    label: "Root",
    children: [
      { id: "a", label: "A" },
      { id: "b", label: "B" },
    ],
  },
];

/** Every key of every occurrence the recursive slot `key` publishes. */
function repeatedKeys(rows: unknown, key: string): string[][] {
  const seen: string[][] = [];
  const pending: unknown[] = [];
  for (const row of Array.isArray(rows) ? rows : [])
    pending.push(get(row, key));
  while (pending.length > 0) {
    const slot = pending.pop();
    for (const occurrence of Array.isArray(slot) ? slot : []) {
      seen.push(Object.keys(occurrence).sort());
      if (Object.hasOwn(occurrence, key)) pending.push(occurrence[key]);
    }
  }
  return seen;
}

describe("RQ-05 recursive reads through the official cache", () => {
  it("keys equivalent recursion defaults once and every other policy apart", async () => {
    const { client, driver } = await world();
    const cacheDriver = new RecordingCache();
    const state = officialCache(cacheDriver);
    const cached = client.$extends(state.extension).$withCache();

    const first = await call(cached.node, "findMany", tree(true));
    await state.settle();
    assert.equal(cacheDriver.sets.length, 1);
    const [entry] = cacheDriver.sets;
    // A change the stored entry must hide from every equivalent read.
    await client.node.update({
      where: { id: "a1x" },
      data: { label: "moved" },
    });
    const statements = driver.statements.length;
    for (const recurse of [{}, { depth: 100 }, { depth: undefined }, true]) {
      assert.deepStrictEqual(
        await call(cached.node, "findMany", tree(recurse)),
        first
      );
    }
    await state.settle();
    assert.equal(driver.statements.length, statements, "a hit runs no SQL");
    assert.deepEqual(cacheDriver.sets, [entry]);
    assert.deepEqual([...new Set(cacheDriver.gets)], [entry]);

    // Another depth is another entry, answered from the database.
    for (const recurse of [{ depth: 3 }, { depth: 99 }, { depth: false }]) {
      const value = await call(cached.node, "findMany", tree(recurse));
      assert.equal(
        JSON.stringify(value).includes("moved"),
        true,
        "a different depth was served another depth's entry"
      );
    }
    await state.settle();
    assert.equal(cacheDriver.sets.length, 4);
    assert.equal(new Set(cacheDriver.sets).size, 4);

    // A graph's cycle policy: the default IS prevention; allowing is not.
    const prevented = await call(cached.node, "findMany", graph({ depth: 3 }));
    await state.settle();
    assert.deepStrictEqual(
      await call(
        cached.node,
        "findMany",
        graph({ depth: 3, preventCycles: true })
      ),
      prevented
    );
    await state.settle();
    assert.equal(cacheDriver.sets.length, 5);
    const allowed = await call(
      cached.node,
      "findMany",
      graph({ depth: 3, preventCycles: false })
    );
    await state.settle();
    assert.equal(cacheDriver.sets.length, 6);
    assert.equal(new Set(cacheDriver.sets).size, 6);
    // Unfolding repeats the root along ONE path: stored and restored as
    // distinct occurrences, not refused as a cycle.
    assert.deepStrictEqual(
      await call(
        cached.node,
        "findMany",
        graph({ depth: 3, preventCycles: false })
      ),
      allowed
    );
    assert.equal(cacheDriver.sets.length, 6);
    assert.deepStrictEqual(prevented, [
      {
        id: "r",
        links: [
          { id: "a", links: [{ id: "d", links: [] }] },
          { id: "b", links: [{ id: "d", links: [] }] },
        ],
      },
    ]);
    assert.deepStrictEqual(allowed, [
      {
        id: "r",
        links: [
          { id: "a", links: [{ id: "d", links: [{ id: "r" }] }] },
          { id: "b", links: [{ id: "d", links: [{ id: "r" }] }] },
        ],
      },
    ]);
  });

  it("serves detached hits and refreshes a stale recursive entry in the background", async () => {
    const { client, driver } = await world();
    const clock = createTestClock();
    const state = officialCache(new ClockedMemoryCache(clock));
    const cached = client
      .$extends(state.extension)
      .$withCache({ ttl: 10, swr: 100 });
    const args = tree({ depth: false });

    const miss = await call(cached.node, "findMany", args);
    await state.settle();
    const pristine = structuredClone(miss);
    assert.equal(recursiveReads(driver), 1);
    // The caller owns what it was handed: the stored entry is detached.
    const reach = (rows: unknown, ...path: number[]): object => {
      let value: unknown = get(rows, 0);
      for (const index of path) value = get(get(value, "children"), index);
      if (typeof value !== "object" || value === null) {
        throw new Error("the published tree does not have the seeded shape");
      }
      return value;
    };
    Reflect.set(reach(miss, 0, 0, 0), "label", "caller");
    Reflect.get(reach(miss, 1), "children").push({ id: "caller" });

    const hit = await call(cached.node, "findMany", args);
    assert.deepStrictEqual(hit, pristine);
    Reflect.set(reach(hit, 0, 0), "label", "caller");
    Reflect.get(reach(hit, 0), "children").splice(0);
    assert.deepStrictEqual(await call(cached.node, "findMany", args), pristine);
    assert.equal(recursiveReads(driver), 1, "hits run no SQL");

    await client.node.update({
      where: { id: "a1x" },
      data: { label: "moved" },
    });
    assert.deepStrictEqual(await call(cached.node, "findMany", args), pristine);

    // Stale: the old entry answers, and one background read refreshes it.
    clock.advance(11);
    assert.deepStrictEqual(await call(cached.node, "findMany", args), pristine);
    await state.settle();
    assert.equal(recursiveReads(driver), 2);
    const refreshed = await call(cached.node, "findMany", args);
    assert.equal(Reflect.get(reach(refreshed, 0, 0, 0), "label"), "moved");
    assert.equal(recursiveReads(driver), 2);
  });

  it("reaches a recursive entry with the existing invalidation policy only", async () => {
    const { client, driver } = await world();
    const cacheDriver = new RecordingCache();
    const state = officialCache(cacheDriver);
    const extended = client.$extends(state.extension);
    const cached = extended.$withCache();
    const args = tree({ depth: false });
    const before = await call(cached.node, "findMany", args);
    await state.settle();

    // A mutation that asks for nothing invalidates nothing: no stronger
    // freshness is claimed for a recursive entry than for any other.
    await call(extended.node, "update", {
      where: { id: "a1x" },
      data: { label: "moved" },
    });
    await state.settle();
    assert.deepEqual(cacheDriver.clears, []);
    assert.deepStrictEqual(await call(cached.node, "findMany", args), before);

    // The model's automatic invalidation clears it like any other entry.
    await call(extended.node, "update", {
      where: { id: "b" },
      data: { label: "B2" },
      cache: { autoInvalidate: true },
    });
    await state.settle();
    assert.equal(cacheDriver.clears.length, 1);
    const reads = recursiveReads(driver);
    const after = await call(cached.node, "findMany", args);
    assert.equal(recursiveReads(driver), reads + 1);
    const text = JSON.stringify(after);
    assert.equal(text.includes("moved") && text.includes("B2"), true);
  });

  it("bypasses the cache for transactions and statement transforms like an ordinary read", async () => {
    const { client, driver } = await world();
    for (const [args, value] of [
      [SHALLOW, SHALLOW_VALUE],
      [ORDINARY, ORDINARY_VALUE],
    ] as const) {
      const arrayCache = new RecordingCache();
      const arrayClient = client.$extends(officialCache(arrayCache).extension);
      const pending = call(arrayClient.$withCache().node, "findMany", args);
      assert.deepStrictEqual(
        await invoke(arrayClient, "$transaction", [pending]),
        [value]
      );
      const overridden = readTestTransactionOperation(
        call(arrayClient.$withCache().node, "findMany", args)
      );
      assert(overridden, "a cached read is a pending operation");
      assert.deepStrictEqual(await overridden.executeWith(driver), value);
      await arrayClient.$transaction(async (tx) => {
        assert.equal(Reflect.get(tx, "$withCache"), undefined);
        assert.deepStrictEqual(await call(tx.node, "findMany", args), value);
      });
      assert.deepEqual(arrayCache.calls, {
        clears: [],
        deletes: [],
        gets: [],
        sets: [],
      });

      const statementCache = new RecordingCache();
      let statements = 0;
      const statementClient = client
        .$extends(officialCache(statementCache).extension)
        .$extends({
          name: "rq05-statement-bypass",
          statement({ statement }) {
            statements += 1;
            return statement;
          },
        });
      for (let round = 0; round < 2; round += 1) {
        assert.deepStrictEqual(
          await call(statementClient.$withCache().node, "findMany", args),
          value
        );
      }
      assert.equal(statements, 2);
      assert.deepEqual(statementCache.calls, {
        clears: [],
        deletes: [],
        gets: [],
        sets: [],
      });
    }
  });

  it("keeps recurse out of reach of request extension chains of 0, 1 and 5", async () => {
    const { client, driver } = await world();
    const cacheDriver = new RecordingCache();
    const state = officialCache(cacheDriver);
    const handled: string[] = [];
    /**
     * A request handler that tries every way a patch could reach `recurse`:
     * a deeper `select`, an `include`, an `omit` — all protected result-shape
     * keys, which it is never shown and whose patch is never read.
     */
    const attacker = (name: string) => ({
      name,
      request({
        operation,
        input,
      }: {
        readonly operation: string;
        readonly input: object;
      }): Readonly<Record<never, never>> {
        if (operation !== "findMany") return {};
        handled.push(name);
        for (const key of ["select", "include", "omit"])
          assert.equal(Object.hasOwn(input, key), false, `${name} saw ${key}`);
        return {
          select: {
            id: true,
            label: true,
            children: { recurse: { depth: false }, select: { id: true } },
          },
          include: { children: { recurse: true } },
          omit: { label: true },
        };
      },
    });
    const extend = (chain: unknown, extension: unknown): unknown =>
      invoke(chain, "$extends", extension);
    const chains: readonly unknown[] = [
      client,
      extend(client, attacker("one")),
      [1, 2, 3, 4, 5].reduce<unknown>(
        (chain, position) => extend(chain, attacker(`five-${position}`)),
        client
      ),
    ];
    for (const [index, chain] of chains.entries()) {
      // The caller's own recursion is what runs, uncached …
      assert.deepStrictEqual(
        await call(get(chain, "node"), "findMany", SHALLOW),
        SHALLOW_VALUE
      );
      // … and what is keyed: every chain reaches the ONE entry chain 0 wrote.
      const cached = invoke(extend(chain, state.extension), "$withCache");
      assert.deepStrictEqual(
        await call(get(cached, "node"), "findMany", SHALLOW),
        SHALLOW_VALUE
      );
      await state.settle();
      assert.equal(cacheDriver.sets.length, 1, `chain ${index} keyed apart`);
    }
    assert.deepEqual(handled, [
      "one",
      "one",
      "five-1",
      "five-2",
      "five-3",
      "five-4",
      "five-5",
      "five-1",
      "five-2",
      "five-3",
      "five-4",
      "five-5",
    ]);
    assert.equal(new Set(cacheDriver.gets).size, 1);

    // A top-level `recurse` is no operation key: admission refuses the patch
    // before the cache is asked or a statement is sent.
    const injected = client
      .$extends({
        name: "rq05-top-level-recurse",
        request: (): Readonly<Record<never, never>> => ({
          recurse: { depth: 3 },
        }),
      })
      .$extends(state.extension)
      .$withCache();
    const calls = cacheDriver.calls;
    const statements = driver.statements.length;
    await assert.rejects(
      call(injected.node, "findMany", SHALLOW),
      ValidationError
    );
    assert.deepEqual(cacheDriver.calls, calls);
    assert.equal(driver.statements.length, statements);
  });

  it("applies model, client-default and query omit at every repeated level", async () => {
    const { client } = await world();
    const cacheDriver = new RecordingCache();
    const state = officialCache(cacheDriver);
    const omitting = client
      .$extends(defaultOmit<typeof schema>()({ node: { secret: true } }))
      .$extends(state.extension)
      .$withCache();
    const included = {
      where: { id: "r" },
      include: {
        children: {
          recurse: { depth: false },
          orderBy: { id: "asc" },
          omit: { note: true },
        },
      },
    };
    const miss = await call(omitting.node, "findMany", included);
    await state.settle();
    const hit = await call(omitting.node, "findMany", included);
    assert.deepStrictEqual(hit, miss);
    for (const value of [miss, hit]) {
      // The outer row keeps its note; `secret` (client default) and `hidden`
      // (model) are gone from it and from every occurrence, and `note`
      // (query) from every occurrence of the repeated node.
      assert.deepEqual(Object.keys(get(value, 0) ?? {}).sort(), [
        "children",
        "id",
        "label",
        "note",
        "parentId",
      ]);
      const levels = repeatedKeys(value, "children");
      assert.equal(levels.length, 4);
      for (const keys of levels)
        assert.deepEqual(keys, ["children", "id", "label", "parentId"]);
    }
    // The default omit was applied before keying: the same projection spelled
    // with query omits on a plain client is the SAME entry.
    const plain = client.$extends(state.extension).$withCache();
    const spelled = {
      where: { id: "r" },
      omit: { secret: true },
      include: {
        children: {
          recurse: { depth: false },
          orderBy: { id: "asc" },
          omit: { secret: true, note: true },
        },
      },
    };
    assert.deepStrictEqual(await call(plain.node, "findMany", spelled), miss);
    await state.settle();
    assert.equal(cacheDriver.sets.length, 1);

    // An explicit select overrides the client default at every level, and a
    // query omit still subtracts from it.
    const selected = {
      where: { id: "r" },
      select: {
        id: true,
        children: {
          recurse: { depth: 2 },
          orderBy: { id: "asc" },
          select: { id: true, secret: true, note: true },
          omit: { note: true },
        },
      },
    };
    const expected = [
      {
        id: "r",
        children: [
          { id: "a", secret: "s-a", children: [{ id: "a1", secret: "s-a1" }] },
          { id: "b", secret: "s-b", children: [] },
        ],
      },
    ];
    assert.deepStrictEqual(
      await call(omitting.node, "findMany", selected),
      expected
    );
    await state.settle();
    assert.deepStrictEqual(
      await call(omitting.node, "findMany", selected),
      expected
    );

    // The model's own omit is schema truth at every level: no key to name.
    const sets = cacheDriver.sets.length;
    await assert.rejects(
      call(omitting.node, "findMany", {
        where: { id: "r" },
        select: {
          id: true,
          children: { recurse: true, select: { id: true, hidden: true } },
        },
      }),
      ValidationError
    );
    assert.equal(cacheDriver.sets.length, sets);
  });

  it("rejects a cached read with the decoder's own cycle error and stores nothing", async () => {
    const { client } = await world();
    // A foreign-key cycle inside the traversed window: r's parent is a1.
    await client.node.update({ where: { id: "r" }, data: { parentId: "a1" } });
    const recording = new RecordingCache();
    const state = officialCache(recording);
    const cached = client.$extends(state.extension).$withCache();
    // Execution runs inside the cache, so the decoder's refusal reaches it:
    // it must leave unchanged, with no entry written, on every attempt.
    for (let round = 0; round < 2; round += 1) {
      await assert.rejects(
        call(cached.node, "findMany", tree(true)),
        (error: unknown) =>
          error instanceof QueryEngineError && FK_CYCLE.test(error.message)
      );
      await state.settle();
    }
    assert.deepEqual(recording.sets, []);
  });
});
