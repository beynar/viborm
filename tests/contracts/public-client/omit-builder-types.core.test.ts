/**
 * `omit` THROUGH THE BUILDERS.
 *
 * Its sibling `omit-result-types.test.ts` pins the query layer by applying
 * `OperationResult` to a hand-written args type. That proves the inference but
 * not the SURFACE: it never asks whether `s.model(…).omit({ … })` refuses a
 * typo, and it never asks whether a client built with
 * `createClient({ omit: … })` carries its default into the types a caller
 * actually reads. Both are what the maintainer hits from an editor, so both
 * are exercised here through the real builders.
 *
 * The two claims:
 *
 *  1. MODEL LEVEL — `.omit()` is keyed to the model's own scalars. A typo, a
 *     relation name, or a `false` is a compile error — per KEY, next to valid
 *     keys, and whatever the argument's freshness — and the literal survives
 *     into the state (`{ secret: true }`, not a widened record).
 *  2. CLIENT LEVEL — `createClient({ omit: { user: { passwordHash: true } } })`
 *     removes the key from the DEFAULT result type, a query-level
 *     `omit: { passwordHash: false }` puts it back, an explicit `select`
 *     overrides the client default while local `omit` can subtract from it,
 *     another model is untouched, and a config the type cannot pin down
 *     degrades to an OPTIONAL key rather than claiming presence.
 *
 * The runtime twin of every client-level claim below already exists and runs on
 * every driver — `runOmitBehavior` in tests/drivers/omit-behavior.ts, sections
 * "Client-level": "client-level omit hides the field on every read of that
 * model", "a local omit: { field: false } re-includes a globally hidden field",
 * "an explicit select overrides the client default", "client-level omit does
 * not turn a bulk write into a row-returning one", "a client that configures
 * nothing is unaffected". This file is the type half of those same five rows.
 *
 * No function declared here is ever called and no query is ever built: only the
 * inferred return types matter, so no driver connects.
 */

import { MemoryCache } from "@cache/drivers/memory";
import { createClient } from "@client/client";
import {
  PGliteDriver,
  createClient as pgliteCreateClient,
} from "@drivers/pglite";
import { s } from "@schema";
import { describe, expectTypeOf, test } from "vitest";

// =============================================================================
// MODEL LEVEL
// =============================================================================

const vault = s
  .model({
    id: s.string().id(),
    label: s.string(),
    secret: s.string(),
    entries: s.oneToMany(() => entry).name("vault"),
  })
  .omit({ secret: true })
  .map("omit_builder_vaults");

const entry = s
  .model({
    id: s.string().id(),
    body: s.string(),
    vaultId: s.string(),
    vault: s
      .manyToOne(() => vault)
      .fields("vaultId")
      .references("id")
      .name("vault"),
  })
  .map("omit_builder_entries");

const modelOmitClient = () =>
  createClient({
    schema: { vault, entry },
    driver: new PGliteDriver(),
  });

describe("model-level .omit() is keyed to the model's scalars", () => {
  test("the literal survives into the state, unwidened", () => {
    type State = (typeof vault)["~"]["state"];
    expectTypeOf<State["omit"]>().toEqualTypeOf<{ secret: true }>();
  });

  test("naming no field is still legal and hides nothing", () => {
    const nothing = s.model({ id: s.string().id() }).omit({});
    expectTypeOf<keyof (typeof nothing)["~"]["state"]["omit"]>().toBeNever();
  });

  test("a typo is a compile error, not a key that hides nothing", () => {
    s.model({ id: s.string().id(), secret: s.string() }).omit({
      // @ts-expect-error 'scret' is not a scalar of this model
      scret: true,
    });
  });

  test("a relation name is a compile error", () => {
    s.model({
      id: s.string().id(),
      entries: s.oneToMany(() => entry).name("vault"),
      // @ts-expect-error a relation is not a projectable scalar
    }).omit({ entries: true });
  });

  /**
   * THE REALISTIC CASE, and the one a refusal built on excess-property
   * checking alone does NOT catch: two secrets, one misspelled. EPC needs a
   * fresh object literal, and TypeScript's weak-type check — the other thing
   * that refuses an all-optional target — only fires on ZERO overlap, so a
   * single valid key disarms it and the typo rides along. That is
   * accept-and-ignore in type space: the state would name a column that is
   * still selected, still returned, and still in the result type.
   *
   * Each case below names one REAL scalar alongside the bad key, so nothing
   * here can pass by way of "no key matched".
   */
  test("a typo NEXT TO a valid key is still a compile error", () => {
    s.model({
      id: s.string().id(),
      secret: s.string(),
      token: s.string(),
    }).omit({
      secret: true,
      // @ts-expect-error 'tokne' is not a scalar of this model
      tokne: true,
    });
  });

  test("a relation name NEXT TO a valid key is still a compile error", () => {
    s.model({
      id: s.string().id(),
      secret: s.string(),
      entries: s.oneToMany(() => entry).name("vault"),
    }).omit({
      secret: true,
      // @ts-expect-error a relation is not a projectable scalar
      entries: true,
    });
  });

  /**
   * And the refusal does not depend on the argument being a FRESH literal.
   * Every spelling below defeats excess-property checking; a constrained type
   * parameter would silently clamp to its constraint and accept them, so the
   * check is structural instead (`UnknownOmitKeys` in schema/model/model.ts).
   */
  test("a typo carried by an annotated variable is refused", () => {
    const annotated: { secret: true; tokne: true } = {
      secret: true,
      tokne: true,
    };
    // @ts-expect-error 'tokne' is not a scalar of this model
    s.model({ id: s.string().id(), secret: s.string() }).omit(annotated);
  });

  test("a typo carried by an `as const` is refused", () => {
    s.model({ id: s.string().id(), secret: s.string() }).omit({
      secret: true,
      // @ts-expect-error 'tokne' is not a scalar of this model
      tokne: true,
    } as const);
  });

  test("a typo carried by a spread is refused", () => {
    const spreadable = { secret: true as const, tokne: true as const };
    // @ts-expect-error 'tokne' is not a scalar of this model
    s.model({ id: s.string().id(), secret: s.string() }).omit({
      ...spreadable,
    });
  });

  test("a widened record is refused rather than read as every scalar", () => {
    const widened: Record<string, true> = { secret: true };
    // @ts-expect-error a widened record names nothing the model can check
    s.model({ id: s.string().id(), secret: s.string() }).omit(widened);
  });

  test("a false flag is a compile error — .omit() only ever hides", () => {
    s.model({ id: s.string().id(), secret: s.string() }).omit({
      // @ts-expect-error model-level omit has no re-include spelling
      secret: false,
    });
  });

  test("a false flag NEXT TO a valid key is still a compile error", () => {
    s.model({
      id: s.string().id(),
      email: s.string(),
      secret: s.string(),
    }).omit({
      secret: true,
      // @ts-expect-error model-level omit has no re-include spelling
      email: false,
    });
  });

  test("a flag that MAY be undefined is refused rather than assumed", () => {
    const maybe: { secret?: true } = {};
    // @ts-expect-error an undefined flag hides nothing at runtime
    s.model({ id: s.string().id(), secret: s.string() }).omit(maybe);
  });

  /**
   * The consequence the refusals above exist for, pinned on the result type
   * rather than on the builder: what `.omit()` accepted is exactly what leaves
   * the query. Written with TWO hidden scalars because one is the shape a
   * per-call refusal can fake.
   */
  test("what the state names is what the result type drops", () => {
    const acct = s
      .model({
        id: s.string().id(),
        email: s.string(),
        secret: s.string(),
        token: s.string(),
      })
      .omit({ secret: true, token: true })
      .map("omit_builder_accts");

    expectTypeOf<(typeof acct)["~"]["state"]["omit"]>().toEqualTypeOf<{
      secret: true;
      token: true;
    }>();

    const rows = () =>
      createClient({
        schema: { acct },
        driver: new PGliteDriver(),
      }).acct.findMany({});

    expectTypeOf<Awaited<ReturnType<typeof rows>>>().toEqualTypeOf<
      { id: string; email: string }[]
    >();
  });

  const selectModelOmittedRoot = () =>
    modelOmitClient().vault.findMany({
      select: {
        id: true,
        // @ts-expect-error a model-level omitted scalar cannot be selected
        secret: true,
      },
    });

  test("a public root query cannot select a model-level omitted scalar", () => {
    expectTypeOf(selectModelOmittedRoot).toBeFunction();
  });

  const reincludeModelOmittedRoot = () =>
    modelOmitClient().vault.findMany({
      omit: {
        id: false,
        // @ts-expect-error a query-level false cannot re-include a model omission
        secret: false,
      },
    });

  test("a public root query cannot re-include a model-level omission", () => {
    expectTypeOf(reincludeModelOmittedRoot).toBeFunction();
  });

  const entriesWithVault = () =>
    modelOmitClient().entry.findMany({ include: { vault: true } });

  test("an included model keeps its model-level omission in the public result", () => {
    expectTypeOf<Awaited<ReturnType<typeof entriesWithVault>>>().toEqualTypeOf<
      {
        id: string;
        body: string;
        vaultId: string;
        vault: { id: string; label: string };
      }[]
    >();
  });

  /**
   * The collapse check. `.omit()` now reads `State["scalars"]`, so it is the
   * first constraint on this builder that touches the model's own shape while
   * a mutually-recursive sibling is still being defined. If that resolution
   * were circular, both consts would silently become `any` and every assertion
   * above would pass vacuously — so pin it directly.
   */
  test("mutually-recursive model consts still infer precisely", () => {
    type IsAny<T> = 0 extends 1 & T ? true : false;
    expectTypeOf<IsAny<typeof vault>>().toEqualTypeOf<false>();
    expectTypeOf<IsAny<typeof entry>>().toEqualTypeOf<false>();
    expectTypeOf<
      IsAny<(typeof vault)["~"]["state"]["scalars"]>
    >().toEqualTypeOf<false>();
    expectTypeOf<keyof (typeof vault)["~"]["state"]["scalars"]>().toEqualTypeOf<
      "id" | "label" | "secret"
    >();
  });
});

// =============================================================================
// CLIENT LEVEL
// =============================================================================

const user = s
  .model({
    id: s.string().id(),
    email: s.string(),
    passwordHash: s.string(),
    posts: s.oneToMany(() => post).name("author"),
  })
  .map("omit_builder_users");

const post = s
  .model({
    id: s.string().id(),
    title: s.string(),
    authorId: s.string(),
    author: s
      .manyToOne(() => user)
      .fields("authorId")
      .references("id")
      .name("author"),
  })
  .map("omit_builder_posts");

const schema = { user, post };

type FullUser = { id: string; email: string; passwordHash: string };
type HiddenUser = { id: string; email: string };
type FullPost = { id: string; title: string; authorId: string };
type HiddenPost = { id: string; title: string };

describe("client-level omit reaches the result types", () => {
  const client = () =>
    createClient({
      schema,
      driver: new PGliteDriver(),
      omit: { user: { passwordHash: true } },
    });

  const findUnique = () => client().user.findUnique({ where: { id: "u1" } });
  const findManyBare = () => client().user.findMany();
  const findManyEmpty = () => client().user.findMany({});
  const create = () =>
    client().user.create({ data: { email: "a@b.c", passwordHash: "h" } });

  test("the default result of a configured model lacks the key", () => {
    expectTypeOf<
      Awaited<ReturnType<typeof findUnique>>
    >().toEqualTypeOf<HiddenUser | null>();
    expectTypeOf<Awaited<ReturnType<typeof findManyBare>>>().toEqualTypeOf<
      HiddenUser[]
    >();
    expectTypeOf<Awaited<ReturnType<typeof findManyEmpty>>>().toEqualTypeOf<
      HiddenUser[]
    >();
    expectTypeOf<
      Awaited<ReturnType<typeof create>>
    >().toEqualTypeOf<HiddenUser>();
  });

  const reInclude = () =>
    client().user.findMany({ omit: { passwordHash: false } });
  const addToIt = () => client().user.findMany({ omit: { email: true } });

  test("a query-level false re-includes exactly that field", () => {
    expectTypeOf<Awaited<ReturnType<typeof reInclude>>>().toEqualTypeOf<
      FullUser[]
    >();
  });

  test("a query-level true adds to the default instead of replacing it", () => {
    expectTypeOf<Awaited<ReturnType<typeof addToIt>>>().toEqualTypeOf<
      { id: string }[]
    >();
  });

  const explicitSelect = () =>
    client().user.findMany({ select: { id: true, passwordHash: true } });

  test("an explicit select is untouched — naming a field is asking for it", () => {
    expectTypeOf<Awaited<ReturnType<typeof explicitSelect>>>().toEqualTypeOf<
      { id: string; passwordHash: string }[]
    >();
  });

  const selectWithDisjointOmit = () =>
    client().user.findMany({
      omit: { passwordHash: true },
      select: {
        email: true,
        posts: {
          omit: { authorId: true },
          include: { author: { select: { id: true } } },
        },
      },
    });

  test("a query-level omit composes with select and nested include", () => {
    expectTypeOf<
      Awaited<ReturnType<typeof selectWithDisjointOmit>>
    >().toEqualTypeOf<
      {
        email: string;
        posts: { id: string; title: string; author: { id: string } }[];
      }[]
    >();
  });

  const selectWithOverlappingOmit = () =>
    client().user.findMany({
      select: { id: true, email: true, passwordHash: true },
      omit: { email: true },
    });

  test("local omit subtracts from select after select overrides the client default", () => {
    expectTypeOf<
      Awaited<ReturnType<typeof selectWithOverlappingOmit>>
    >().toEqualTypeOf<{ id: string; passwordHash: string }[]>();
  });

  const createWithSelectAndOmit = () =>
    client().user.create({
      data: { email: "a@b.c", passwordHash: "h" },
      select: {
        id: true,
        email: true,
        passwordHash: true,
        posts: {
          select: { id: true, title: true, authorId: true },
          omit: { authorId: true },
        },
      },
      omit: { passwordHash: true },
    });

  test("create composes top-level and nested select + omit through the public client", () => {
    expectTypeOf<
      Awaited<ReturnType<typeof createWithSelectAndOmit>>
    >().toEqualTypeOf<{
      id: string;
      email: string;
      posts: { id: string; title: string }[];
    }>();
  });

  const sameNodeSelectIncludeOmit = () =>
    client().user.findMany({
      select: { id: true },
      include: { posts: true },
      omit: { email: true },
    });

  const nestedSameNodeSelectIncludeOmit = () =>
    client().user.findMany({
      select: {
        posts: {
          select: { id: true },
          include: { author: true },
          omit: { title: true },
        },
      },
    });

  test("omit does not make select and include compatible on the same node", () => {
    expectTypeOf<
      Awaited<ReturnType<typeof sameNodeSelectIncludeOmit>>
    >().toEqualTypeOf<never[]>();
    expectTypeOf<
      Awaited<ReturnType<typeof nestedSameNodeSelectIncludeOmit>>
    >().toEqualTypeOf<{ posts: never }[]>();
  });

  const cachedClient = () =>
    createClient({
      schema,
      driver: new PGliteDriver(),
      cache: new MemoryCache(),
      omit: { user: { passwordHash: true } },
    });
  const cachedSelectWithOmit = () =>
    cachedClient()
      .$withCache()
      .user.findMany({
        select: { id: true, email: true, passwordHash: true },
        omit: { email: true },
      });
  const cachedDefaultRows = () => cachedClient().$withCache().user.findMany({});

  test("the cached client preserves the configured default", () => {
    expectTypeOf<Awaited<ReturnType<typeof cachedDefaultRows>>>().toEqualTypeOf<
      HiddenUser[]
    >();
  });

  test("the cached client preserves select with local omit", () => {
    expectTypeOf<
      Awaited<ReturnType<typeof cachedSelectWithOmit>>
    >().toEqualTypeOf<{ id: string; passwordHash: string }[]>();
  });

  const optionalSelect = (
    select: { id: true; passwordHash: true } | undefined
  ) => client().user.findMany({ select });

  test("an optional select keeps client-default omission correlated to the unselected world", () => {
    expectTypeOf<Awaited<ReturnType<typeof optionalSelect>>>().toEqualTypeOf<
      ({ id: string; passwordHash: string } | HiddenUser)[]
    >();
  });

  const otherModel = () => client().post.findMany({});

  test("a model the config does not name is untouched", () => {
    expectTypeOf<Awaited<ReturnType<typeof otherModel>>>().toEqualTypeOf<
      FullPost[]
    >();
  });

  const bulkWithoutProjection = () =>
    client().user.updateMany({
      where: { id: "u1" },
      data: { email: "x@y.z" },
    });
  const bulkWithProjection = () =>
    client().user.updateMany({
      where: { id: "u1" },
      data: { email: "x@y.z" },
      omit: { email: true },
    });
  const bulkWithSelectAndOmit = () =>
    client().user.updateMany({
      data: { email: "x@y.z" },
      select: { id: true, email: true, passwordHash: true },
      omit: { email: true },
    });
  const bulkWithOptionalSelectAndOmit = (select: { id: true } | undefined) =>
    client().user.updateMany({
      data: { email: "x@y.z" },
      select,
      omit: { email: true },
    });

  test("the default never flips a bulk write's return shape", () => {
    expectTypeOf<
      Awaited<ReturnType<typeof bulkWithoutProjection>>
    >().toEqualTypeOf<{ count: number }>();
  });

  test("a bulk write that DID project sees the default merged in", () => {
    expectTypeOf<
      Awaited<ReturnType<typeof bulkWithProjection>>
    >().toEqualTypeOf<{ id: string }[]>();
  });

  test("bulk select + omit subtracts locally and bypasses the client default", () => {
    expectTypeOf<
      Awaited<ReturnType<typeof bulkWithSelectAndOmit>>
    >().toEqualTypeOf<{ id: string; passwordHash: string }[]>();
  });

  test("a definite bulk omit keeps an optional-select call on the row arm", () => {
    expectTypeOf<
      Awaited<ReturnType<typeof bulkWithOptionalSelectAndOmit>>
    >().toEqualTypeOf<{ id: string }[]>();
  });

  const nestedConfigured = () =>
    createClient({
      schema,
      driver: new PGliteDriver(),
      omit: { post: { authorId: true } },
    });
  const withInclude = () =>
    nestedConfigured().user.findMany({ include: { posts: true } });
  const withNestedRestore = () =>
    nestedConfigured().user.findMany({
      include: { posts: { omit: { authorId: false } } },
    });
  const withNestedExplicitSelect = () =>
    nestedConfigured().user.findMany({
      include: {
        posts: { select: { id: true, authorId: true } },
      },
    });

  test("the configured default narrows an included relation result", () => {
    expectTypeOf<Awaited<ReturnType<typeof withInclude>>>().toEqualTypeOf<
      { id: string; email: string; passwordHash: string; posts: HiddenPost[] }[]
    >();
  });

  test("a nested local false restores the client-omitted field", () => {
    expectTypeOf<Awaited<ReturnType<typeof withNestedRestore>>>().toEqualTypeOf<
      { id: string; email: string; passwordHash: string; posts: FullPost[] }[]
    >();
  });

  test("a nested explicit select overrides the client default", () => {
    expectTypeOf<
      Awaited<ReturnType<typeof withNestedExplicitSelect>>
    >().toEqualTypeOf<
      {
        id: string;
        email: string;
        passwordHash: string;
        posts: { id: string; authorId: string }[];
      }[]
    >();
  });

  const deeplyConfigured = () =>
    createClient({
      schema,
      driver: new PGliteDriver(),
      omit: {
        user: { passwordHash: true },
        post: { authorId: true },
      },
    });
  const withTwoNestedDefaults = () =>
    deeplyConfigured().user.findMany({
      include: { posts: { include: { author: true } } },
    });

  test("client defaults propagate through two ordinary relation levels", () => {
    expectTypeOf<
      Awaited<ReturnType<typeof withTwoNestedDefaults>>
    >().toEqualTypeOf<
      {
        id: string;
        email: string;
        posts: { id: string; title: string; author: HiddenUser }[];
      }[]
    >();
  });

  const nestedCachedClient = () =>
    createClient({
      schema,
      driver: new PGliteDriver(),
      cache: new MemoryCache(),
      omit: { post: { authorId: true } },
    });
  const cachedWithNestedInclude = () =>
    nestedCachedClient()
      .$withCache()
      .user.findMany({
        include: { posts: true },
      });

  test("the cached client narrows an unselected included relation", () => {
    expectTypeOf<
      Awaited<ReturnType<typeof cachedWithNestedInclude>>
    >().toEqualTypeOf<
      { id: string; email: string; passwordHash: string; posts: HiddenPost[] }[]
    >();
  });
});

describe("the driver wrapper preserves omit result inference", () => {
  const wrapped = () => pgliteCreateClient({ schema });
  const configured = () =>
    pgliteCreateClient({
      schema,
      omit: { user: { passwordHash: true } },
    });
  const nestedConfigured = () =>
    pgliteCreateClient({
      schema,
      omit: { post: { authorId: true } },
    });

  const createWithEveryLegalProjectionLayer = () =>
    wrapped().user.create({
      data: { email: "a@b.c", passwordHash: "h" },
      select: {
        id: true,
        email: true,
        passwordHash: true,
        posts: {
          omit: { authorId: true },
          include: { author: { select: { id: true } } },
        },
      },
      omit: { passwordHash: true },
    });

  test("create composes root select + omit with nested omit + include", () => {
    expectTypeOf<
      Awaited<ReturnType<typeof createWithEveryLegalProjectionLayer>>
    >().toEqualTypeOf<{
      id: string;
      email: string;
      posts: { id: string; title: string; author: { id: string } }[];
    }>();
  });

  const configuredRows = () => configured().user.findMany({});

  test("the wrapper return type retains its configured omit default", () => {
    expectTypeOf<Awaited<ReturnType<typeof configuredRows>>>().toEqualTypeOf<
      HiddenUser[]
    >();
  });

  const nestedConfiguredRows = () =>
    nestedConfigured().user.findMany({ include: { posts: true } });

  test("the wrapper carries its default into an included relation", () => {
    expectTypeOf<
      Awaited<ReturnType<typeof nestedConfiguredRows>>
    >().toEqualTypeOf<
      { id: string; email: string; passwordHash: string; posts: HiddenPost[] }[]
    >();
  });
});

describe("structurally ambiguous nested client defaults stay sound", () => {
  const left = s.model({
    id: s.string().id(),
    secret: s.string(),
    roots: s.oneToMany(() => root),
  });
  const right = s.model({
    id: s.string().id(),
    secret: s.string(),
    roots: s.oneToMany(() => root),
  });
  const root = s.model({
    id: s.string().id(),
    leftId: s.string(),
    rightId: s.string(),
    left: s
      .manyToOne(() => left)
      .fields("leftId")
      .references("id"),
    right: s
      .manyToOne(() => right)
      .fields("rightId")
      .references("id"),
  });

  const ambiguous = () =>
    createClient({
      schema: { left, right, root },
      driver: new PGliteDriver(),
      omit: { left: { secret: true } },
    });
  const rows = () =>
    ambiguous().root.findMany({ include: { left: true, right: true } });

  test("a shared shallow surface makes a possibly omitted field optional", () => {
    type Row = Awaited<ReturnType<typeof rows>>[number];
    expectTypeOf<Row["left"]>().toEqualTypeOf<{
      id: string;
      secret?: string;
    }>();
    expectTypeOf<Row["right"]>().toEqualTypeOf<{
      id: string;
      secret?: string;
    }>();
  });
});

describe("recursive models keep precise nested client defaults", () => {
  const node = s.model({
    id: s.string().id(),
    label: s.string(),
    parentId: s.string().nullable(),
    parent: s
      .manyToOne(() => node)
      .fields("parentId")
      .references("id")
      .name("parent")
      .optional(),
    children: s.oneToMany(() => node).name("parent"),
  });
  const recursive = () =>
    createClient({
      schema: { node },
      driver: new PGliteDriver(),
      omit: { node: { label: true } },
    });
  const rows = () => recursive().node.findMany({ include: { children: true } });

  test("the carrier neither widens to any nor loses the recursive default", () => {
    type Rows = Awaited<ReturnType<typeof rows>>;
    type IsAny<T> = 0 extends 1 & T ? true : false;
    expectTypeOf<IsAny<Rows>>().toEqualTypeOf<false>();
    expectTypeOf<Rows>().toEqualTypeOf<
      {
        id: string;
        parentId: string | null;
        children: { id: string; parentId: string | null }[];
      }[]
    >();
  });
});

describe("vector distance selection composes with omit through the public client", () => {
  const document = s.model({
    id: s.string().id(),
    title: s.string(),
    embedding: s.vector().dimension(3),
  });
  const vectorClient = () =>
    createClient({
      schema: { document },
      driver: new PGliteDriver(),
    });

  const rows = () =>
    vectorClient().document.findMany({
      select: {
        id: true,
        embedding: {
          _distance: { to: [1, 0, 0], metric: "cosine" },
        },
      },
      omit: { embedding: true },
    });

  test("omitting the selected vector source also removes its distance alias", () => {
    expectTypeOf<Awaited<ReturnType<typeof rows>>>().toEqualTypeOf<
      { id: string }[]
    >();
  });
});

describe("a client that configures nothing is unaffected", () => {
  const plain = () => createClient({ schema, driver: new PGliteDriver() });
  const rows = () => plain().user.findMany({});

  test("every scalar is still present and required", () => {
    expectTypeOf<Awaited<ReturnType<typeof rows>>>().toEqualTypeOf<
      FullUser[]
    >();
  });
});

describe("a config the type cannot pin down degrades to optional", () => {
  /**
   * `omit?:` — the flag is written, but the type cannot say whether the value
   * is there. The honest answer is the same one a widened query-level `boolean`
   * gets: the key becomes OPTIONAL. Claiming it present would be a lie in
   * exactly the case the config exists for.
   */
  type MaybeConfigured = {
    schema: typeof schema;
    driver: PGliteDriver;
    omit?: { user: { passwordHash: true } };
  };

  // Built inside a function nobody calls: the point is the SIGNATURE, and the
  // cast config has no driver to hand a real client.
  const buildMaybe = () => createClient({} as MaybeConfigured);
  const rows = () => buildMaybe().user.findMany({});

  test("the key is present-or-absent, never silently present", () => {
    expectTypeOf<Awaited<ReturnType<typeof rows>>>().toEqualTypeOf<
      { id: string; email: string; passwordHash?: string }[]
    >();
  });

  /**
   * The other half: a client typed from the CONFIG INTERFACE rather than from
   * a config literal carries `omit?: { [model: string]: { [field: string]:
   * true } }`, which names nothing at all. Reading that as "every field of
   * every model might be hidden" would make every key of every result optional
   * — noise, not honesty — so it is read as no default stated.
   */
  const buildBare = () =>
    createClient({} as { schema: typeof schema; driver: PGliteDriver });
  const bareRows = () => buildBare().user.findMany({});

  test("a config that names nothing makes no claim", () => {
    expectTypeOf<Awaited<ReturnType<typeof bareRows>>>().toEqualTypeOf<
      FullUser[]
    >();
  });

  type EitherModelConfigured =
    | {
        schema: typeof schema;
        driver: PGliteDriver;
        omit: { user: { passwordHash: true } };
      }
    | {
        schema: typeof schema;
        driver: PGliteDriver;
        omit: { post: { authorId: true } };
      };
  const buildEitherModel = () => createClient({} as EitherModelConfigured);
  const eitherModelRows = () =>
    buildEitherModel().user.findMany({ include: { posts: true } });

  test("disjoint model keys in a config union remain visible", () => {
    expectTypeOf<Awaited<ReturnType<typeof eitherModelRows>>>().toEqualTypeOf<
      {
        id: string;
        email: string;
        passwordHash?: string;
        posts: { id: string; title: string; authorId?: string }[];
      }[]
    >();
  });

  type EitherUserFieldConfigured = {
    schema: typeof schema;
    driver: PGliteDriver;
    omit: {
      user: { passwordHash: true } | { email: true };
    };
  };
  const buildEitherUserField = () =>
    createClient({} as EitherUserFieldConfigured);
  const eitherUserFieldRows = () => buildEitherUserField().user.findMany({});

  test("disjoint field keys in one omit union become optional", () => {
    expectTypeOf<
      Awaited<ReturnType<typeof eitherUserFieldRows>>
    >().toEqualTypeOf<
      { id: string; email?: string; passwordHash?: string }[]
    >();
  });

  const userA = s.model({
    id: s.string().id(),
    secret: s.string(),
    alpha: s.string(),
  });
  const userB = s.model({
    id: s.string().id(),
    secret: s.string(),
    beta: s.string(),
  });
  const rootA = s.model({
    id: s.string().id(),
    userId: s.string(),
    user: s
      .manyToOne(() => userA)
      .fields("userId")
      .references("id"),
  });
  const rootB = s.model({
    id: s.string().id(),
    userId: s.string(),
    user: s
      .manyToOne(() => userB)
      .fields("userId")
      .references("id"),
  });

  type EitherSchemaConfigured =
    | {
        schema: { root: typeof rootA; user: typeof userA };
        driver: PGliteDriver;
        omit: { user: { secret: true } };
      }
    | {
        schema: { root: typeof rootB; user: typeof userB };
        driver: PGliteDriver;
        omit: { user: { secret: true } };
      };
  const buildEitherSchema = () =>
    createClient<EitherSchemaConfigured["schema"], EitherSchemaConfigured>(
      {} as EitherSchemaConfigured
    );
  const eitherSchemaRows = () =>
    buildEitherSchema().root.findMany({ include: { user: true } });

  test("a schema union keeps nested omissions visible", () => {
    type NestedUser = Awaited<
      ReturnType<typeof eitherSchemaRows>
    >[number]["user"];
    expectTypeOf<NestedUser>().toEqualTypeOf<
      | { id: string; secret?: string; alpha: string }
      | { id: string; secret?: string; beta: string }
    >();
  });
});
