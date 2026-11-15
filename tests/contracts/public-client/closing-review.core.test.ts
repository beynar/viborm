/**
 * Closing review of the extension host (2026-11-15): the two passes "write
 * less" (`c41f3aff3..dcc705544`) rewrote the cache's drop (`[DELETE]` and
 * `[CLEAR]` made one `[DROP]`), its revalidation unit and failure record, its
 * scope (no memo), the methods (a chain of views), the computed fields (one
 * planning pass, an `omit` always copied) and `on()` (`reachable`
 * breadth-first). Each answer pinned here is the one `c41f3aff3` gives; the
 * differential probes of the review compared them in full across the two
 * trees (`extension-closing-review.md`).
 *
 * In-memory SQLite, through the public API.
 */

import { CacheDriver, type CacheEntry } from "@cache/driver";
import { cache, staleWhileRevalidate } from "@cache/exports";
import { createClient } from "@drivers/sqlite3";
import { s } from "@schema";
import { defaultOmit } from "@src/client/default-omit-extension";
import {
  arg,
  args,
  bound,
  extension,
  fields,
  methods,
  modelMethods,
  rule,
} from "@src/index";
import { instrumentation } from "@src/instrumentation/exports";
import { on } from "@src/on";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import v from "@validation/primitives/v";
import { describe, expect, test } from "vitest";

const REVALIDATING = /:reval$/;
const NAMESPACED_POST = /^.*:(post:)/;

/** A backend on a virtual clock whose steps can fail by predicate. */
class Backend extends CacheDriver {
  readonly store = new Map<string, CacheEntry>();
  fails: (step: string, key: string) => boolean = () => false;
  time = 1_000_000;
  constructor() {
    super("test", {
      now: () => this.time,
      setTimeout: () => ({ cancel: () => undefined }),
    });
  }
  #check(step: string, key: string): void {
    if (this.fails(step, key)) throw new Error(`backend ${step} failed`);
  }
  protected async get<T>(key: string): Promise<CacheEntry<T> | null> {
    this.#check("get", key);
    return (this.store.get(key) as CacheEntry<T> | undefined) ?? null;
  }
  protected async set<T>(
    key: string,
    _ttl: number,
    entry: CacheEntry<T>
  ): Promise<void> {
    this.#check("set", key);
    this.store.set(key, entry);
  }
  protected async delete(keys: string[]): Promise<void> {
    for (const key of keys) this.#check("delete", key);
    for (const key of keys) this.store.delete(key);
  }
  protected async clear(prefix: string): Promise<void> {
    this.#check("clear", prefix);
    for (const key of [...this.store.keys()])
      if (key.startsWith(prefix)) this.store.delete(key);
  }
  /** The entries' keys, each cut to what follows the namespace. */
  entries(): string[] {
    return [...this.store.keys()]
      .filter((key) => !REVALIDATING.test(key))
      .map((key) => key.replace(NAMESPACED_POST, "$1"))
      .sort();
  }
}

const post = s.model({ id: s.int().id(), title: s.string() });

async function cached(options: { swr?: boolean } = {}) {
  const base = createClient({ schema: { post }, dataDir: ":memory:" });
  await syncLiveSchema(base as never);
  await base.post.createMany({
    data: [
      { id: 1, title: "one" },
      { id: 2, title: "two" },
    ],
  });
  const backend = new Backend();
  const logs: string[] = [];
  const db = base
    .$extends(
      cache({
        driver: backend,
        ...(options.swr ? { swr: staleWhileRevalidate } : {}),
      })
    )
    .$extends(
      instrumentation({
        logging: {
          cache: (event) => {
            logs.push(`${event.meta?.event}/${event.meta?.status}`);
          },
        },
      })
    );
  return { base, db, backend, logs };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

describe("[DROP]: a backend that fails one step of an invalidation", () => {
  test("a failing delete rejects $invalidate, and the prefix it was handed beside it is cleared", async () => {
    const { db, backend } = await cached();
    const view = db.$withCache({ ttl: "1h" });
    await view.post.findMany({ where: { id: 1 } });
    await view.post.findMany({ where: { id: 2 } });
    expect(backend.entries()).toHaveLength(2);
    backend.fails = (step) => step === "delete";
    const refused = await db.$invalidate("one", "post:*").then(
      () => undefined,
      (error: unknown) => error
    );
    expect(refused).toMatchObject({
      name: "CacheConfigurationError",
      message: "Cache invalidation failed.",
      // The backend's own message is a provider detail: redacted.
      cause: { message: "Underlying error details redacted" },
      meta: { method: "invalidate" },
    });
    expect(backend.entries()).toEqual([]);
  });

  test("a failing clear rejects $invalidate, and the key handed beside it is deleted", async () => {
    const { db, backend } = await cached();
    const view = db.$withCache({ ttl: "1h", key: "mine" });
    await view.post.findMany({ where: { id: 1 } });
    const [stored] = backend.entries();
    backend.fails = (step) => step === "clear";
    await expect(db.$invalidate(stored!, "post:*")).rejects.toMatchObject({
      message: "Cache invalidation failed.",
      cause: { message: "Underlying error details redacted" },
    });
    expect(backend.entries()).toEqual([]);
  });

  test("a write whose invalidation fails is refused once it committed, and its entry stays", async () => {
    const { base, db, backend } = await cached();
    const view = db.$withCache({ ttl: "1h" });
    expect(await view.post.findMany({ where: { id: 1 } })).toEqual([
      { id: 1, title: "one" },
    ]);
    backend.fails = (step) => step === "clear";
    await expect(
      db.post.update({ where: { id: 1 }, data: { title: "uno" } })
    ).rejects.toMatchObject({
      name: "CacheConfigurationError",
      message:
        "Cache invalidation failed after mutation 'update' on model 'post'.",
      meta: { method: "invalidate", commitCertainty: "committed" },
    });
    expect(await base.post.findUnique({ where: { id: 1 } })).toEqual({
      id: 1,
      title: "uno",
    });
    backend.fails = () => false;
    // The entry the failed clear left is served until it expires.
    expect(await view.post.findMany({ where: { id: 1 } })).toEqual([
      { id: 1, title: "one" },
    ]);
  });
});

describe("a revalidation that fails serves the stale rows and keeps the entry", () => {
  const stale = async (
    fails: (step: string, key: string) => boolean,
    breakTable: boolean
  ) => {
    const { base, db, backend, logs } = await cached({ swr: true });
    const view = db.$withCache({ ttl: 1000, swr: "1h" });
    await view.post.findMany({ where: { id: 1 } });
    await base.post.update({ where: { id: 1 }, data: { title: "uno" } });
    if (breakTable)
      await base.$executeRawUnsafe('ALTER TABLE "post" RENAME TO "gone"');
    backend.time += 5000;
    backend.fails = fails;
    logs.length = 0;
    const served = await view.post.findMany({ where: { id: 1 } });
    await settle();
    return { served, logs, backend };
  };

  test("in the replay", async () => {
    const { served, logs, backend } = await stale(() => false, true);
    expect(served).toEqual([{ id: 1, title: "one" }]);
    expect(logs).toEqual(["revalidate/start", "hit/stale", "revalidate/error"]);
    expect(backend.entries()).toHaveLength(1);
    expect(
      [...backend.store.keys()].filter((key) => REVALIDATING.test(key))
    ).toEqual([]);
  });

  test("in the store write", async () => {
    const { served, logs } = await stale(
      (step, key) => step === "set" && !REVALIDATING.test(key),
      false
    );
    expect(served).toEqual([{ id: 1, title: "one" }]);
    expect(logs).toEqual(["revalidate/start", "hit/stale", "revalidate/error"]);
  });

  test("in both", async () => {
    const { served, logs } = await stale(
      (step, key) => step === "set" && !REVALIDATING.test(key),
      true
    );
    expect(served).toEqual([{ id: 1, title: "one" }]);
    expect(logs).toEqual(["revalidate/start", "hit/stale", "revalidate/error"]);
  });

  test("in the replay and in the marker's cleanup: the stale rows are still served", async () => {
    const { served, logs } = await stale(
      (step, key) => step === "delete" && REVALIDATING.test(key),
      true
    );
    expect(served).toEqual([{ id: 1, title: "one" }]);
    expect(logs).toEqual(["revalidate/start", "hit/stale", "revalidate/error"]);
  });
});

describe("the cache's scope, computed on every read", () => {
  test("two versions on one backend never serve each other's entries", async () => {
    const { base } = await cached();
    const backend = new Backend();
    const first = base
      .$extends(cache({ driver: backend, version: "1" }))
      .$withCache({ ttl: "1h" });
    const second = base
      .$extends(cache({ driver: backend, version: 1 }))
      .$withCache({ ttl: "1h" });
    expect(await first.post.findMany({ where: { id: 1 } })).toEqual([
      { id: 1, title: "one" },
    ]);
    await base.post.update({ where: { id: 1 }, data: { title: "uno" } });
    expect(await second.post.findMany({ where: { id: 1 } })).toEqual([
      { id: 1, title: "uno" },
    ]);
    expect(backend.store.size).toBe(2);
  });

  test("a cached view of a bound view, and a bound view of a cached one, key each binding apart", async () => {
    const { base } = await cached();
    const backend = new Backend();
    const db = base
      .$extends(
        extension(
          "tenancy",
          args({ tenant: bound(v.string()) }),
          rule({ post: { read: { where: { title: arg("tenant") } } } }),
          methods((scope) => ({
            $tenant: (tenant: string) => scope.$bind({ tenant }),
          }))
        )
      )
      .$extends(cache({ driver: backend }));
    expect(
      await db.$tenant("one").$withCache({ ttl: "1h" }).post.findMany()
    ).toEqual([{ id: 1, title: "one" }]);
    expect(
      await db.$withCache({ ttl: "1h" }).$tenant("two").post.findMany()
    ).toEqual([{ id: 2, title: "two" }]);
    expect(
      await db.$withCache({ ttl: "1h" }).$tenant("one").post.findMany()
    ).toEqual([{ id: 1, title: "one" }]);
    expect(backend.store.size).toBe(2);
  });
});

describe("methods: a chain of views", () => {
  const author = s.model({ id: s.int().id(), name: s.string() });
  const open = async () => {
    const base = createClient({ schema: { author }, dataDir: ":memory:" });
    await syncLiveSchema(base as never);
    await base.author.create({ data: { id: 1, name: "ada" } });
    return base
      .$extends(
        extension(
          "first",
          methods(() => ({
            $first: () => "first",
            $later(this: { $third?: () => string }) {
              return this.$third?.() ?? "none";
            },
          })),
          modelMethods(() => ({
            author: { named: () => "first" },
          }))
        )
      )
      .$extends(
        extension(
          "second",
          methods((scope) => ({
            $second: () => `${scope.$first()}+second`,
            $sees: () => typeof Reflect.get(scope, "$third"),
          })),
          modelMethods((scope) => ({
            author: (delegate) => ({
              counted: async () =>
                `${scope.author.named()}:${await delegate.count()}`,
            }),
          }))
        )
      )
      .$extends(
        extension(
          "third",
          methods(() => ({ $third: () => "third" }))
        )
      );
  };

  test("an extension's scope answers the methods before it, `this` the view's", async () => {
    const db = await open();
    const answers = async (view: typeof db) => [
      view.$second(),
      view.$sees(),
      view.$later(),
      await view.author.counted(),
    ];
    const expected = ["first+second", "undefined", "third", "first:1"];
    expect(await answers(db)).toEqual(expected);
    expect(await db.$transaction((tx) => answers(tx as typeof db))).toEqual(
      expected
    );
  });
});

describe("computed fields: the caller's projection is read, never changed", () => {
  const author = s.model({
    id: s.int().id(),
    name: s.string(),
    secret: s.string(),
  });
  const open = async () => {
    const base = createClient({ schema: { author }, dataDir: ":memory:" });
    await syncLiveSchema(base as never);
    await base.author.create({ data: { id: 1, name: "ada", secret: "s" } });
    return base.$extends(defaultOmit({ author: { secret: true } })).$extends(
      extension(
        "label",
        fields({
          author: {
            label: {
              needs: { name: true, secret: true },
              compute: (row) => `${row.name}:${row.secret}`,
            },
          },
        })
      )
    );
  };

  test("a frozen omit or select is honoured and left as it was given", async () => {
    const db = await open();
    const omit = Object.freeze({ name: true });
    const select = Object.freeze({ label: true });
    const keep = Object.freeze({ secret: false });
    expect(await db.author.findMany({ omit })).toEqual([
      { id: 1, label: "ada:s" },
    ]);
    expect(await db.author.findMany({ select })).toEqual([{ label: "ada:s" }]);
    expect(await db.author.findMany({ omit: keep })).toEqual([
      { id: 1, name: "ada", secret: "s", label: "ada:s" },
    ]);
    expect([omit, select, keep]).toEqual([
      { name: true },
      { label: true },
      { secret: false },
    ]);
  });
});

describe("on(): hooks of a nested write, in the order the write reached them", () => {
  const org = s.model({
    id: s.int().id(),
    teams: s.toMany(() => team),
  });
  const team = s.model({
    id: s.int().id(),
    orgId: s.int(),
    org: s
      .toOne(() => org)
      .fields("orgId")
      .references("id"),
    members: s.toMany(() => member),
  });
  const member = s.model({
    id: s.int().id(),
    teamId: s.int(),
    team: s
      .toOne(() => team)
      .fields("teamId")
      .references("id"),
    tags: s.toMany(() => tag).through("member_tag"),
  });
  const tag = s.model({ id: s.int().id(), members: s.toMany(() => member) });
  const alpha = s.model({ id: s.int().id() });
  const beta = s.model({ id: s.int().id() });
  const holder = s.model({
    id: s.int().id(),
    items: s.toMany({ alpha: () => alpha, beta: () => beta }),
  });

  test("three levels, a junction, and a polymorphic relation", async () => {
    const base = createClient({
      schema: { org, team, member, tag, alpha, beta, holder },
      dataDir: ":memory:",
    });
    await syncLiveSchema(base as never);
    const told: string[] = [];
    const hook =
      (label: string) => (rows: readonly { readonly id: unknown }[]) => {
        told.push(`${label} ${rows.map((row) => row.id).join(",")}`);
      };
    const db = base.$extends(
      on({
        tag: { create: hook("tag") },
        member: { create: hook("member") },
        beta: { create: hook("beta") },
      })
    );
    await db.org.create({
      data: {
        id: 1,
        teams: {
          create: [
            {
              id: 1,
              members: {
                create: [{ id: 1, tags: { create: [{ id: 1 }] } }, { id: 2 }],
              },
            },
            { id: 2, members: { create: [{ id: 3 }] } },
          ],
        },
      },
    });
    await db.holder.create({
      data: {
        id: 1,
        items: {
          create: [
            { type: "alpha", data: { id: 1 } },
            { type: "beta", data: { id: 1 } },
            { type: "beta", data: { id: 2 } },
          ],
        },
      },
    });
    await settle();
    expect(told).toEqual(["member 1,2,3", "tag 1", "beta 1,2"]);
  });
});
