import { MemoryCache } from "@src/cache/drivers/memory";
import { cache } from "@src/cache/exports";
import {
  clearEntries,
  clearRevalidating,
  deleteEntry,
  getEntry,
  invalidateEntries,
  markRevalidating,
  setEntry,
} from "@src/cache/storage";
import {
  createClient as createPGliteClient,
  PGliteDriver,
} from "@src/drivers/pglite";
import { call, createClient, extension, s, target } from "@src/index";
import { expectTypeOf } from "vitest";

const user = s.model({ id: s.string().id(), name: s.string() });
const schema = { user };
const cacheDriver = new MemoryCache();
const base = createClient({ schema, driver: new PGliteDriver() });

const _forgedScope = {
  namespace:
    "viborm:cache:r3:d:0070006f0073007400670072006500730071006c:k:007000750062006c00690063:u",
};
// @ts-expect-error - public cache reads accept no external scope
getEntry(cacheDriver, "key", undefined, _forgedScope);
// @ts-expect-error - public cache writes accept no external scope
setEntry(cacheDriver, "key", 1, { ttl: 1000 }, undefined, _forgedScope);
// @ts-expect-error - public cache deletes accept no external scope
deleteEntry(cacheDriver, "key", undefined, _forgedScope);
// @ts-expect-error - public cache clears accept no external scope
clearEntries(cacheDriver, "key", undefined, _forgedScope);
// @ts-expect-error - public invalidation accepts no external scope
invalidateEntries(cacheDriver, "user", undefined, undefined, _forgedScope);
// @ts-expect-error - public SWR admission accepts no external scope
markRevalidating(cacheDriver, "key", _forgedScope);
// @ts-expect-error - public SWR cleanup accepts no external scope
clearRevalidating(cacheDriver, "key", _forgedScope);

// @ts-expect-error - an unextended client has no cache-read surface
base.$withCache();
// @ts-expect-error - an unextended client has no manual invalidation surface
base.$invalidate("user:*");
base.user.create({
  data: { id: "base", name: "Base" },
  // @ts-expect-error - base mutation inputs have no extension-owned cache member
  cache: { autoInvalidate: true },
});

const official = cache({
  driver: cacheDriver,
  version: "v1",
  waitUntil: (_promise) => undefined,
});
const cached = base.$extends(official);
// @ts-expect-error - one cache per chain: a second one's $withCache would replace the first's
cached.$extends(official);
cached.$withCache({ ttl: 1000 });
cached.$invalidate("user:*");
const exactCachedRows = cached.$withCache().user.findMany({
  select: { id: true },
});
expectTypeOf(exactCachedRows).toEqualTypeOf<Promise<{ id: string }[]>>();
// @ts-expect-error - cached read promises expose no transaction admission seam
exactCachedRows.prepareArrayAdmission;
// @ts-expect-error - cached read promises expose no private executor wrapper seam
exactCachedRows.wrapPendingOperationExecutor;
cached.user.create({
  data: { id: "cached", name: "Cached" },
  cache: { autoInvalidate: true, invalidate: ["user:*"] },
});
cached.$extends(
  extension(
    "request-core-stays-cache-free",
    call(
      (c) => {
        // @ts-expect-error - mutation cache is client-owned, not a core request key
        c.args.cache;
        c.set({});
      },
      target("user", "create")
    )
  )
);
cached.user.findMany({
  // @ts-expect-error - cache options are mutation-only
  cache: { autoInvalidate: true },
});
cached.user.create({
  data: { id: "typo", name: "Typo" },
  cache: {
    autoInvalidate: true,
    // @ts-expect-error - cache keys are shallow-exact beside a real key
    autoInvalidat: true,
  },
});

const heldMutationTypo = {
  data: { id: "held", name: "Held" },
  cache: { autoInvalidate: true, autoInvalidat: true },
} as const;
// @ts-expect-error - held mutation cache typos are refused structurally
cached.user.create(heldMutationTypo);

cached.$transaction(async (tx) => {
  tx.user.create({
    data: { id: "tx", name: "Transaction" },
    cache: { autoInvalidate: true },
  });
  // @ts-expect-error - transaction views do not expose cache-read methods
  tx.$withCache();
  // @ts-expect-error - transaction views do not expose manual invalidation
  tx.$invalidate("user:*");
  await tx.$transaction(async (nested) => {
    nested.user.delete({
      where: { id: "tx" },
      cache: { invalidate: ["user:tx"] },
    });
    // @ts-expect-error - nested transaction views also have no cache methods
    nested.$withCache();
  });
});

const ordinary = extension("ordinary");
const chain2 = cached.$extends(ordinary);
const chain3 = chain2.$extends(extension("three"));
const chain4 = chain3.$extends(extension("four"));
const chain5 = chain4.$extends(extension("five"));
const chain6 = chain5.$extends(extension("six"));
const chain7 = chain6.$extends(extension("seven"));
const chain8 = chain7.$extends(extension("eight"));
const chain9 = chain8.$extends(extension("nine"));
const chain10 = chain9.$extends(extension("ten"));
chain2.$withCache();
chain5.$withCache();
chain10.$withCache();

cache({
  driver: cacheDriver,
  version: "v2",
  // @ts-expect-error - fresh cache config typos are refused beside real keys
  versoin: "typo",
});
const heldConfigTypo = {
  driver: cacheDriver,
  version: "v2",
  versoin: "typo",
} as const;
// @ts-expect-error - held cache config typos are refused structurally
cache(heldConfigTypo);

declare const heldConfigUnion:
  | { readonly driver: MemoryCache; readonly version: "clean" }
  | {
      readonly driver: MemoryCache;
      readonly version: "typo";
      readonly versoin: "misspelled";
    };
// @ts-expect-error - every member of a held config union is checked exactly
cache(heldConfigUnion);

const wrapped = createPGliteClient({ schema });
wrapped.$extends(cache({ driver: new MemoryCache() })).$withCache();

expectTypeOf(cached.user.findMany).toBeFunction();
expectTypeOf(chain10.user.findMany).toBeFunction();
