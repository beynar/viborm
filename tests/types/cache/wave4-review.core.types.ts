/**
 * Review of the fourth wave (2026-11-15, `dcc705544..3057e4595`): the cache
 * types `$withCache` and `$invalidate` through its own `methods` facts,
 * typed by `this` from the client they are called on, and "one cache per
 * chain" became the general rule that an extension cannot add a client
 * method under a name the client has.
 *
 * What must be refused, and what must compile, each as on `dcc705544`
 * except where the CHANGELOG says the view now types the chain's methods.
 */
import { MemoryCache } from "@src/cache/drivers/memory";
import { cache } from "@src/cache/exports";
import { PGliteDriver } from "@src/drivers/pglite";
import {
  args,
  bound,
  createClient,
  extension,
  methods,
  modelMethods,
  oneOf,
  s,
} from "@src/index";
import { permissions } from "@src/permissions";
import { softDelete } from "@src/soft-delete";
import { v } from "@src/validation";
import { expectTypeOf } from "vitest";

const post = s.model({
  id: s.string().id(),
  title: s.string(),
  deletedAt: s.dateTime().nullable(),
});
const schema = { post };
const base = createClient({ schema, driver: new PGliteDriver() });
const official = cache({ driver: new MemoryCache() });
const cached = base.$extends(official);

// What must be refused.

// @ts-expect-error - an option the cache does not take
cached.$withCache({ tll: 1000 });
// @ts-expect-error - `ttl` is a duration, not a boolean
cached.$withCache({ ttl: true });
// @ts-expect-error - a cached view serves reads: no create
cached.$withCache().post.create({ data: { id: "1", title: "t" } });
// @ts-expect-error - a cached view serves reads: no update
cached.$withCache().post.update({ where: { id: "1" }, data: { title: "u" } });
// @ts-expect-error - a cached view serves reads: no deleteMany
cached.$withCache().post.deleteMany({});
// @ts-expect-error - a cached view takes no transaction
cached.$withCache().$transaction(async () => undefined);
// @ts-expect-error - a cached view takes no $extends
cached.$withCache().$extends(extension("x"));
// @ts-expect-error - a key is a string
cached.$invalidate(5);
// @ts-expect-error - keys are strings, not a list of them
cached.$invalidate(["post:*"]);
// @ts-expect-error - a client without the cache has no $withCache
base.$withCache();
// @ts-expect-error - a client without the cache has no $invalidate
base.$invalidate("post:*");
// @ts-expect-error - a second cache on one chain
cached.$extends(cache({ driver: new MemoryCache() }));
cached.$extends(
  extension(
    "mine",
    // @ts-expect-error - a user method named as the cache's, after it
    methods(() => ({ $withCache: () => 1 }))
  )
);
cached.$extends(
  extension(
    "mine",
    // @ts-expect-error - a user method named $invalidate, after the cache
    methods(() => ({ $invalidate: () => 1 }))
  )
);
base.$extends(
  extension(
    "mine",
    // @ts-expect-error - a user method named as a client method: $transaction
    methods(() => ({ $transaction: () => 1 }))
  )
);
base.$extends(
  extension(
    "mine",
    // @ts-expect-error - a user method named as a client method: $extends
    methods(() => ({ $extends: () => 1 }))
  )
);
const withUserCacheName = base.$extends(
  extension(
    "mine",
    methods(() => ({ $withCache: () => 1 as const }))
  )
);
// @ts-expect-error - the cache after a user method that took its name
withUserCacheName.$extends(official);
cached.$transaction(async (tx) => {
  // @ts-expect-error - a transaction has no $withCache
  tx.$withCache();
});
// @ts-expect-error - a cached read is no member of an array transaction
cached.$transaction([cached.$withCache().post.findMany()]);

// What must compile.

const tooled = cached.$extends(
  extension(
    "tools",
    methods(() => ({ $ping: () => "pong" as const }))
  )
);
expectTypeOf(tooled.$withCache().$ping()).toEqualTypeOf<"pong">();
const toolsFirst = base
  .$extends(
    extension(
      "tools",
      methods(() => ({ $ping: () => "pong" as const }))
    )
  )
  .$extends(official);
expectTypeOf(toolsFirst.$withCache().$ping()).toEqualTypeOf<"pong">();
expectTypeOf(
  toolsFirst.$withCache({ ttl: 1000 }).post.findMany({ select: { id: true } })
).toEqualTypeOf<Promise<{ id: string }[]>>();
cached.$invalidate();
cached.$invalidate("post:*", "post:1");
cached.$withCache({ ttl: "1 hour", key: "k", bypass: true });

const tenantArgs = extension(
  "tenant",
  args({ tenant: bound(v.string()) }),
  methods((scope) => ({ $tenant: (tenant: string) => scope.$bind({ tenant }) }))
);
const boundClient = base.$extends(tenantArgs).$extends(official);
expectTypeOf(
  boundClient.$withCache().post.findMany({ select: { id: true } })
).toEqualTypeOf<Promise<{ id: string }[]>>();
// A view `scope.$bind` makes is typed `unknown` on both trees (the closing
// review's finding 8), so its cached view is not written here.
expectTypeOf(boundClient.$withCache().$tenant).toBeFunction();

const governed = base
  .$extends(
    permissions({
      actor: v.object({ id: v.string() }),
      models: { post: { read: true } },
    })
  )
  .$extends(official);
// A view `$as` made: the runtime serves it a cached view.
governed.$as({ id: "1" }).$withCache().post.count();

const soft = base
  .$extends(softDelete({ models: { post: { deletedAt: "deletedAt" } } }))
  .$extends(official);
soft.$withCache().post.findMany({ deleted: "only" });
soft.post.restore({ where: { id: "1" } });

const modeled = base
  .$extends(
    extension(
      "modeled",
      modelMethods(() => ({ post: { hello: () => "hi" as const } }))
    )
  )
  .$extends(official);
expectTypeOf(modeled.post.hello()).toEqualTypeOf<"hi">();
modeled.$withCache().post.findMany();

const moded = base.$extends(
  extension("mode", args({ mode: oneOf("a", "b").on(["findMany"]) }))
);
moded.$extends(official).$withCache().post.findMany({ mode: "a" });
