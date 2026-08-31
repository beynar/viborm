/**
 * Provider-backed `select: undefined` spread-an-optional contract.
 *
 * `{ ...(sel && { select: sel }) }` becomes `{ select: undefined }` whenever the
 * condition is false, and the parse boundary is explicit that an
 * explicitly-`undefined` key is an ABSENT key
 * (src/validation/primitives/object.ts): the call returns the full default row,
 * on every driver. The bulk writes already typed it that way
 * (`[BulkSelect<Args>] extends [undefined] -> BatchPayload`); the row-returning
 * operations dispatched on KEY PRESENCE instead, so `InferSelectedFields` mapped
 * over `keyof undefined` and typed the result `{}` — `rows[0].id` refused to
 * compile on a call that returns `id`.
 *
 * Every `const … : Row = …` below is the assertion: it stops compiling if the
 * operation goes back to the empty-selection arm. The runtime half is probed
 * live on PGlite, because a type that agrees with a lie is not worth pinning.
 */

import type { OperationResult } from "@client/types";
import { createClient as PGliteCreateClient } from "@drivers/pglite";

import { s } from "@schema";
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  expectTypeOf,
  test,
} from "vitest";

import { syncLiveSchema } from "@tests/fixtures/sync-schema";
const post = s
  .model({
    id: s.string().id(),
    title: s.string(),
    views: s.int(),
    tags: s.toMany(() => tag),
  })
  .map("undefined_projection_posts");

const tag = s
  .model({
    id: s.string().id(),
    name: s.string(),
    postId: s.string(),
    post: s
      .toOne(() => post)
      .fields("postId")
      .references("id"),
  })
  .map("undefined_projection_tags");

type PostModel = typeof post;

const schema = { post, tag };

/** The full default row: what every call below must be typed as. */
type FullRow = { id: string; title: string; views: number };

type Result<
  O extends
    | "findMany"
    | "findFirst"
    | "findUnique"
    | "findUniqueOrThrow"
    | "findFirstOrThrow"
    | "create"
    | "update"
    | "upsert"
    | "delete"
    | "updateMany",
  Args,
> = OperationResult<O, PostModel, Args>;

// =============================================================================
// THE TYPE HALF — every row-returning operation
// =============================================================================

describe("select: undefined types the full default row", () => {
  test("findMany", () => {
    type Rows = Result<"findMany", { select: undefined }>;
    expectTypeOf<Rows[number]>().toEqualTypeOf<FullRow>();
  });

  test("findFirst / findUnique (nullable)", () => {
    expectTypeOf<
      Result<"findFirst", { where: { title: string }; select: undefined }>
    >().toEqualTypeOf<FullRow | null>();
    expectTypeOf<
      Result<"findUnique", { where: { id: string }; select: undefined }>
    >().toEqualTypeOf<FullRow | null>();
  });

  test("the OrThrow pair (non-nullable)", () => {
    expectTypeOf<
      Result<
        "findFirstOrThrow",
        { where: { title: string }; select: undefined }
      >
    >().toEqualTypeOf<FullRow>();
    expectTypeOf<
      Result<"findUniqueOrThrow", { where: { id: string }; select: undefined }>
    >().toEqualTypeOf<FullRow>();
  });

  test("the single-row writes", () => {
    expectTypeOf<
      Result<"create", { data: { id: string }; select: undefined }>
    >().toEqualTypeOf<FullRow>();
    expectTypeOf<
      Result<
        "update",
        { where: { id: string }; data: { title: string }; select: undefined }
      >
    >().toEqualTypeOf<FullRow>();
    expectTypeOf<
      Result<
        "upsert",
        {
          where: { id: string };
          create: { id: string };
          update: { title: string };
          select: undefined;
        }
      >
    >().toEqualTypeOf<FullRow>();
    expectTypeOf<
      Result<"delete", { where: { id: string }; select: undefined }>
    >().toEqualTypeOf<FullRow>();
  });

  test("a sibling key that is present but undefined is not a second projection", () => {
    // Spreading a false condition adds no key at all, so this payload comes
    // from the EXPLICIT spelling: a helper that forwards two optional props
    // (`{ select: args.select, include: args.include }`), which is how an app
    // threads projection options through. The runtime half below calls exactly
    // that helper — the type here is only honest because the parse boundary
    // accepts the payload.
    expectTypeOf<
      Result<"findMany", { select: undefined; include: undefined }>[number]
    >().toEqualTypeOf<FullRow>();
    expectTypeOf<
      Result<"findMany", { select: undefined; omit: undefined }>[number]
    >().toEqualTypeOf<FullRow>();
    expectTypeOf<
      Result<"findMany", { select: { id: true }; omit: undefined }>[number]
    >().toEqualTypeOf<{ id: string }>();
  });
});

describe("the arms that must NOT move", () => {
  test("a select that carries a value still projects", () => {
    expectTypeOf<
      Result<"findMany", { select: { id: true } }>[number]
    >().toEqualTypeOf<{ id: string }>();
  });

  test("select + include is still refused", () => {
    expectTypeOf<
      Result<"findMany", { select: { id: true }; include: { x: true } }>[number]
    >().toEqualTypeOf<never>();
  });

  test("select + omit keeps the selected shape minus overlaps", () => {
    expectTypeOf<
      Result<
        "findMany",
        { select: { id: true }; omit: { title: true } }
      >[number]
    >().toEqualTypeOf<{ id: string }>();
    expectTypeOf<
      Result<
        "findMany",
        { select: { id: true; title: true }; omit: { title: true } }
      >[number]
    >().toEqualTypeOf<{ id: string }>();
  });

  test("omit: undefined and include: undefined were already honest", () => {
    expectTypeOf<
      Result<"findMany", { omit: undefined }>[number]
    >().toEqualTypeOf<FullRow>();
    expectTypeOf<
      Result<"findMany", { include: undefined }>[number]
    >().toEqualTypeOf<FullRow>();
  });

  test("a bulk write keeps the { count } arm it already had", () => {
    expectTypeOf<
      Result<
        "updateMany",
        { where: { title: string }; data: { title: string }; select: undefined }
      >
    >().toEqualTypeOf<{ count: number }>();
  });
});

// =============================================================================
// THE RUNTIME HALF — the same payloads, live
// =============================================================================

let client: Awaited<
  ReturnType<
    typeof PGliteCreateClient<typeof schema, { schema: typeof schema }>
  >
>;
let pglite: import("@electric-sql/pglite").PGlite;

beforeAll(async () => {
  const { PGlite } = await import("@electric-sql/pglite");
  pglite = new PGlite();
  client = await PGliteCreateClient({ schema, client: pglite });
  await syncLiveSchema(client);
});

afterAll(async () => {
  try {
    await client.$disconnect();
  } finally {
    await pglite.close();
  }
});

describe("the runtime returns the full row for the same payloads", () => {
  test("create / findMany / findUnique / update / delete", async () => {
    const created = await client.post.create({
      data: { id: "p1", title: "t", views: 1 },
      select: undefined,
    });
    // The declaration IS the assertion — `created.id` did not compile before.
    const createdRow: FullRow = created;
    expect(createdRow).toEqual({ id: "p1", title: "t", views: 1 });

    const rows = await client.post.findMany({ select: undefined });
    const firstRow: FullRow | undefined = rows[0];
    expect(firstRow?.id).toBe("p1");

    const found = await client.post.findUnique({
      where: { id: "p1" },
      select: undefined,
    });
    expect(found?.title).toBe("t");

    const updated = await client.post.update({
      where: { id: "p1" },
      data: { title: "u" },
      select: undefined,
    });
    const updatedRow: FullRow = updated;
    expect(updatedRow.title).toBe("u");

    const deleted = await client.post.delete({
      where: { id: "p1" },
      select: undefined,
    });
    const deletedRow: FullRow = deleted;
    expect(deletedRow.id).toBe("p1");
  });

  test("a bulk write with the same key still counts", async () => {
    await client.post.create({ data: { id: "p2", title: "t", views: 1 } });
    const result = await client.post.updateMany({
      where: { id: "p2" },
      data: { title: "v" },
      select: undefined,
    });
    expect(result).toEqual({ count: 1 });
  });
});

/**
 * The exclusivity refusals decide on the projection's VALUE, not its key.
 *
 * Reading key presence made `{ select: undefined, include: undefined }` — and
 * every payload where one of the pair is spelled and left undefined — throw
 * "Mutually exclusive fields cannot be used together", while the types above
 * promised a row. `select` + `omit` was already value-based; this is the same
 * rule, and the rule the parse boundary states for every other key.
 */
describe("an undefined sibling projection is not a second projection", () => {
  /** The ordinary way an app threads optional projection options through. */
  const findWith = (args: {
    select?: { title: true };
    include?: { tags: true };
  }) =>
    client.post.findMany({
      where: { id: "u1" },
      select: args.select,
      include: args.include,
    });

  beforeAll(async () => {
    await client.post.create({ data: { id: "u1", title: "un", views: 7 } });
  });

  test("both spelled undefined: the full default row, live", async () => {
    const rows = await client.post.findMany({
      where: { id: "u1" },
      select: undefined,
      include: undefined,
    });
    // The declaration IS the type half of this pair, and the call is the
    // runtime half: before, one of the two was always a lie.
    const first: FullRow | undefined = rows[0];
    expect(first).toEqual({ id: "u1", title: "un", views: 7 });
  });

  test("the helper spelling: both options absent", async () => {
    const rows = await findWith({});
    // Optional at the call site, so the type is the honest union of both
    // worlds — `title` is the field both arms carry.
    expect(rows[0]?.title).toBe("un");
    expect(rows[0]).toEqual({ id: "u1", title: "un", views: 7 });
  });

  test("a real select beside an undefined include still projects", async () => {
    const rows = await findWith({ select: { title: true } });
    expect(rows[0]).toEqual({ title: "un" });
  });

  test("a real include beside an undefined select still includes", async () => {
    const rows = await findWith({ include: { tags: true } });
    expect(rows[0]).toEqual({ id: "u1", title: "un", views: 7, tags: [] });
  });

  test("the same on findUnique and on a single-row write", async () => {
    const found = await client.post.findUnique({
      where: { id: "u1" },
      select: undefined,
      include: undefined,
    });
    expect(found).toEqual({ id: "u1", title: "un", views: 7 });

    const created = await client.post.create({
      data: { id: "u2", title: "two", views: 2 },
      select: undefined,
      include: undefined,
    });
    expect(created).toEqual({ id: "u2", title: "two", views: 2 });
  });

  test("a nested relation node reads its own pair the same way", async () => {
    const rows = await client.post.findMany({
      where: { id: "u1" },
      include: {
        tags: { select: undefined, include: undefined } as never,
      },
    });
    expect(rows[0]).toEqual({ id: "u1", title: "un", views: 7, tags: [] });
  });

  test("two projections that BOTH carry a value are still refused", async () => {
    await expect(
      client.post.findMany({
        select: { title: true },
        include: { tags: true },
      } as never)
    ).rejects.toThrow(
      "Mutually exclusive fields cannot be used together: select, include"
    );
  });
});
