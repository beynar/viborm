/**
 * A projection key only the RUNTIME decides: `{ ...(cond && { select: … }) }`.
 *
 * TypeScript types that spread as `{ select?: Sel }` — an OPTIONAL property, not
 * `Sel | undefined` — and a conditional matches only a REQUIRED property, so the
 * whole dispatch used to walk past it and hand back the full model row. That is
 * the UNSOUND direction: `row.title` compiled, and the call returned `{ id }`.
 *
 * Both spellings — the optional key and an explicit `Sel | undefined` — now type
 * as the honest UNION of the two worlds, the same ambiguous arm
 * `BulkWriteResult` already took for `updateMany({ select: maybeSelect })`.
 * A caller narrows on a key one arm does not have; that narrowing is spelled out
 * below, because a union nobody can narrow is not an improvement.
 *
 * `omit` gets the matching treatment in its own idiom: a maybe-`omit` softens
 * every key it names to OPTIONAL rather than promising a column the runtime may
 * have dropped. `include` deliberately does NOT split — see the comment on
 * `InferUnselectedRow`: it only ADDS keys, so the common ground promises nothing
 * that is missing at runtime.
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
  })
  .map("optional_projection_posts");

type PostModel = typeof post;

const schema = { post };

type FullRow = { id: string; title: string; views: number };
type IdOnlyRow = { id: string };

// =============================================================================
// THE TYPE HALF
// =============================================================================

describe("a select only the runtime decides types as both worlds", () => {
  test("the optional-key spelling (what the spread idiom produces)", () => {
    type Result = OperationResult<
      "findMany",
      PostModel,
      { select?: { id: true } }
    >;

    expectTypeOf<Result[number]>().toEqualTypeOf<FullRow | IdOnlyRow>();
  });

  test("the explicit `Sel | undefined` spelling", () => {
    type Result = OperationResult<
      "findMany",
      PostModel,
      { select: { id: true } | undefined }
    >;

    expectTypeOf<Result[number]>().toEqualTypeOf<FullRow | IdOnlyRow>();
  });

  test("the single-row writes and the nullable reads carry it too", () => {
    expectTypeOf<
      OperationResult<
        "update",
        PostModel,
        {
          where: { id: string };
          data: { title: string };
          select?: { id: true };
        }
      >
    >().toEqualTypeOf<FullRow | IdOnlyRow>();

    expectTypeOf<
      OperationResult<
        "findUnique",
        PostModel,
        { where: { id: string }; select?: { id: true } }
      >
    >().toEqualTypeOf<FullRow | IdOnlyRow | null>();
  });

  test("a caller narrows on a key the projection does not have", () => {
    type Row = OperationResult<
      "findMany",
      PostModel,
      { select?: { id: true } }
    >[number];

    // This is the documented narrowing: `in` picks the arm that declares the
    // key, which is exactly the runtime question the caller deferred.
    type Narrowed = Extract<Row, { title: string }>;
    expectTypeOf<Narrowed>().toEqualTypeOf<FullRow>();
    expectTypeOf<Exclude<Row, { title: string }>>().toEqualTypeOf<IdOnlyRow>();
  });
});

describe("a maybe-omit softens instead of promising", () => {
  test("the named key becomes optional, never promised outright", () => {
    type Result = OperationResult<
      "findMany",
      PostModel,
      { omit?: { title: true } }
    >;

    expectTypeOf<Result[number]>().toEqualTypeOf<{
      id: string;
      views: number;
      title?: string;
    }>();
  });

  test("the definite spelling still removes the key outright", () => {
    type Result = OperationResult<
      "findMany",
      PostModel,
      { omit: { title: true } }
    >;

    expectTypeOf<Result[number]>().toEqualTypeOf<{
      id: string;
      views: number;
    }>();
  });
});

describe("the arms that must NOT move", () => {
  test("a definite select still projects, alone", () => {
    expectTypeOf<
      OperationResult<"findMany", PostModel, { select: { id: true } }>[number]
    >().toEqualTypeOf<IdOnlyRow>();
  });

  test("an index-signature payload states no projection at all", () => {
    // A dynamically-built payload (`Record<string, unknown>`) declares no
    // spelled key, so reading its `select` as "maybe a projection" would push
    // every such call onto the ambiguous arm and break `row.id`. Same rule
    // `NoExtraClauseKeys` follows for the clause level.
    expectTypeOf<
      OperationResult<"findMany", PostModel, Record<string, unknown>>[number]
    >().toEqualTypeOf<FullRow>();
  });

  test("a maybe-include still promises the common ground", () => {
    // `include` only ADDS keys, so the smaller row promises nothing that is
    // missing at runtime. Pinned so a future change to that decision is loud.
    expectTypeOf<
      OperationResult<"findMany", PostModel, { include?: object }>[number]
    >().toEqualTypeOf<FullRow>();
  });
});

// =============================================================================
// THE RUNTIME HALF — the real spread idiom, at a real call site
// =============================================================================

let client: Awaited<
  ReturnType<
    typeof PGliteCreateClient<typeof schema, { schema: typeof schema }>
  >
>;

/** Opaque to the checker on purpose: this is the case the union exists for. */
const runtimeFlag = (value: boolean): boolean => value;

beforeAll(async () => {
  const { PGlite } = await import("@electric-sql/pglite");
  client = await PGliteCreateClient({ schema, client: new PGlite() });
  await syncLiveSchema(client);
  await client.post.create({ data: { id: "p1", title: "t", views: 1 } });
});

afterAll(async () => {
  await client.$disconnect();
});

describe("the spread idiom, live", () => {
  test("the projection world returns only the selected key", async () => {
    const projecting = runtimeFlag(true);
    const rows = await client.post.findMany({
      ...(projecting && { select: { id: true } }),
    });

    // The call site itself, not a hand-written Args type: this is what the
    // spread idiom infers.
    expectTypeOf(rows).toEqualTypeOf<(FullRow | IdOnlyRow)[]>();

    const row = rows[0];
    expect(row).toEqual({ id: "p1" });

    // The type is the union, so the full-row key is reachable only after
    // narrowing — and here the narrowing correctly fails.
    if (row && "title" in row) {
      throw new Error("the projection world must not carry `title`");
    }
    expect(row?.id).toBe("p1");
  });

  test("the absent world returns the full row", async () => {
    const projecting = runtimeFlag(false);
    const rows = await client.post.findMany({
      ...(projecting && { select: { id: true } }),
    });

    const row = rows[0];
    expect(row).toEqual({ id: "p1", title: "t", views: 1 });

    if (!(row && "title" in row)) {
      throw new Error("the absent world must carry `title`");
    }
    // Narrowed: `title` is a string here, and the value agrees.
    const title: string = row.title;
    expect(title).toBe("t");
  });

  test("a maybe-omit drops the column in exactly one of the two worlds", async () => {
    const hiding = runtimeFlag(true);
    const [hidden] = await client.post.findMany({
      ...(hiding && { omit: { title: true } }),
    });
    expect(hidden).toEqual({ id: "p1", views: 1 });
    // `title` is OPTIONAL in the type, which is why reading it is legal and
    // undefined here rather than a compile error or a broken promise.
    expect(hidden?.title).toBeUndefined();

    const [shown] = await client.post.findMany({
      ...(runtimeFlag(false) && { omit: { title: true } }),
    });
    expect(shown?.title).toBe("t");
  });
});
