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
 *     relation name, or a `false` is a compile error, and the literal survives
 *     into the state (`{ secret: true }`, not a widened record).
 *  2. CLIENT LEVEL — `createClient({ omit: { user: { passwordHash: true } } })`
 *     removes the key from the DEFAULT result type, a query-level
 *     `omit: { passwordHash: false }` puts it back, an explicit `select` is
 *     untouched, another model is untouched, and a config the type cannot pin
 *     down degrades to an OPTIONAL key rather than claiming presence.
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

import { createClient } from "@client/client";
import { PGliteDriver } from "@drivers/pglite";
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

  test("a false flag is a compile error — .omit() only ever hides", () => {
    s.model({ id: s.string().id(), secret: s.string() }).omit({
      // @ts-expect-error model-level omit has no re-include spelling
      secret: false,
    });
  });

  test("a flag that MAY be undefined is refused rather than assumed", () => {
    const maybe: { secret?: true } = {};
    // @ts-expect-error an undefined flag hides nothing at runtime
    s.model({ id: s.string().id(), secret: s.string() }).omit(maybe);
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

describe("client-level omit reaches the result types", () => {
  const client = createClient({
    schema,
    driver: new PGliteDriver(),
    omit: { user: { passwordHash: true } },
  });

  const findUnique = () => client.user.findUnique({ where: { id: "u1" } });
  const findManyBare = () => client.user.findMany();
  const findManyEmpty = () => client.user.findMany({});
  const create = () =>
    client.user.create({ data: { email: "a@b.c", passwordHash: "h" } });

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
    client.user.findMany({ omit: { passwordHash: false } });
  const addToIt = () => client.user.findMany({ omit: { email: true } });

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
    client.user.findMany({ select: { id: true, passwordHash: true } });

  test("an explicit select is untouched — naming a field is asking for it", () => {
    expectTypeOf<Awaited<ReturnType<typeof explicitSelect>>>().toEqualTypeOf<
      { id: string; passwordHash: string }[]
    >();
  });

  const otherModel = () => client.post.findMany({});

  test("a model the config does not name is untouched", () => {
    expectTypeOf<Awaited<ReturnType<typeof otherModel>>>().toEqualTypeOf<
      FullPost[]
    >();
  });

  const bulkWithoutProjection = () =>
    client.user.updateMany({ where: { id: "u1" }, data: { email: "x@y.z" } });
  const bulkWithProjection = () =>
    client.user.updateMany({
      where: { id: "u1" },
      data: { email: "x@y.z" },
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

  /**
   * The runtime applies the default to relation payloads too; the type does
   * not, because a relation resolves to a target MODEL and recovering the
   * schema KEY the config is written against would mean comparing model types
   * structurally — the comparison that collapses recursive model consts to
   * `any`. Pinned as it IS, so the gap is a decision on record rather than a
   * surprise (docs/content/docs/client/omit.mdx, "What the types can and
   * cannot see").
   */
  const withInclude = () => client.user.findMany({ include: { posts: true } });

  test("the reduction covers the operation's own node, not included ones", () => {
    expectTypeOf<Awaited<ReturnType<typeof withInclude>>>().toEqualTypeOf<
      { id: string; email: string; posts: FullPost[] }[]
    >();
  });
});

describe("a client that configures nothing is unaffected", () => {
  const plain = createClient({ schema, driver: new PGliteDriver() });
  const rows = () => plain.user.findMany({});

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
});
