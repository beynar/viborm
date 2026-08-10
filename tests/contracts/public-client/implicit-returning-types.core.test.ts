/**
 * Type tests for IMPLICIT RETURNING on the bulk writes (maintainer decision
 * D-1). `createManyAndReturn` / `updateManyAndReturn` were REMOVED — no alias,
 * no deprecation shim. `createMany` / `updateMany` take an optional `select`,
 * and its presence is what flips the return type from `{ count }` to rows.
 *
 * The two halves of the contract this file pins:
 *  - the CONDITIONAL result: no `select` (or a `select` typed exactly
 *    `undefined`) -> `BatchPayload`; a `select` that cannot be `undefined` ->
 *    `T[]` projected by that select; a `select` that MAY be `undefined` -> the
 *    union of both, because only the runtime value decides;
 *  - the REMOVAL: the old names are not members of `Operations`, so
 *    `client.model.createManyAndReturn` cannot type-check (the runtime half of
 *    that removal is pinned in tests/contracts/engine/write/bulk-write.test.ts).
 *
 * Every claim here is about types the runtime must agree with, so the runtime
 * twin (`returnsRows` in @query-engine-v2/routing) is pinned behaviorally in
 * tests/contracts/engine/write/bulk-write.test.ts.
 */

import { createClient } from "@client/client";
import type {
  OperationPayload,
  OperationResult,
  Operations,
} from "@client/types";
import { PGliteDriver } from "@drivers/pglite";
import { s } from "@schema";
import type { testUser } from "@tests/fixtures/schema.js";
import { describe, expectTypeOf, test } from "vitest";

type UserModel = typeof testUser;

/** A minimal model for the call-site probes at the bottom of this file. */
const widget = s
  .model({ id: s.string().id(), name: s.string() })
  .map("implicit_returning_widgets");

describe("the removed *AndReturn operation names", () => {
  test("are not members of the client Operations union", () => {
    type Removed = "createManyAndReturn" | "updateManyAndReturn";
    expectTypeOf<Extract<Operations, Removed>>().toEqualTypeOf<never>();
  });

  test("the surviving bulk families are the single spelling", () => {
    expectTypeOf<
      Extract<Operations, "createMany">
    >().toEqualTypeOf<"createMany">();
    expectTypeOf<
      Extract<Operations, "updateMany">
    >().toEqualTypeOf<"updateMany">();
  });
});

describe("createMany implicit returning", () => {
  test("without select the result is { count }", () => {
    type Args = { data: { name: string; email: string }[] };
    type Result = OperationResult<"createMany", UserModel, Args>;

    expectTypeOf<Result>().toEqualTypeOf<{ count: number }>();
    expectTypeOf<Result>().not.toBeArray();
  });

  test("skipDuplicates alone does not make it return rows", () => {
    type Args = {
      data: { name: string; email: string }[];
      skipDuplicates: true;
    };
    type Result = OperationResult<"createMany", UserModel, Args>;

    expectTypeOf<Result>().toEqualTypeOf<{ count: number }>();
  });

  test("with select the result is the projected rows", () => {
    type Args = {
      data: { name: string; email: string }[];
      select: { name: true };
    };
    type Result = OperationResult<"createMany", UserModel, Args>;

    expectTypeOf<Result>().toBeArray();
    type Row = Result[number];
    expectTypeOf<Row>().toHaveProperty("name");
    expectTypeOf<keyof Row>().toEqualTypeOf<"name">();
  });

  test("an explicitly-absent select stays on the count arm (matches routing)", () => {
    // The runtime discriminant is `args.select !== undefined`; the type-level
    // rule must agree, or a `select: undefined` spread would be typed as rows
    // while returning `{ count }`. The RUNTIME half of this claim — that the
    // call really does return `{ count }` — is pinned in
    // tests/contracts/engine/write/bulk-write.test.ts; for a while it was not, and the
    // call actually threw.
    type Args = {
      data: { name: string; email: string }[];
      select: undefined;
    };
    type Result = OperationResult<"createMany", UserModel, Args>;

    expectTypeOf<Result>().toEqualTypeOf<{ count: number }>();
  });

  test("payload accepts data/skipDuplicates/select but not include", () => {
    type Payload = OperationPayload<"createMany", UserModel>;

    expectTypeOf<NonNullable<Payload>>().toHaveProperty("data");
    expectTypeOf<NonNullable<Payload>>().toHaveProperty("skipDuplicates");
    expectTypeOf<NonNullable<Payload>>().toHaveProperty("select");
    expectTypeOf<
      "include" extends keyof NonNullable<Payload> ? true : false
    >().toEqualTypeOf<false>();
  });
});

describe("updateMany implicit returning", () => {
  test("without select the result is { count }", () => {
    type Args = { where: { name: string }; data: { name: string } };
    type Result = OperationResult<"updateMany", UserModel, Args>;

    expectTypeOf<Result>().toEqualTypeOf<{ count: number }>();
    expectTypeOf<Result>().not.toBeArray();
  });

  test("with select the result is the projected rows", () => {
    type Args = {
      where: { name: string };
      data: { name: string };
      select: { id: true; email: true };
    };
    type Result = OperationResult<"updateMany", UserModel, Args>;

    expectTypeOf<Result>().toBeArray();
    type Row = Result[number];
    expectTypeOf<keyof Row>().toEqualTypeOf<"id" | "email">();
  });

  test("payload has where, data, select but not include", () => {
    type Payload = OperationPayload<"updateMany", UserModel>;

    expectTypeOf<NonNullable<Payload>>().toHaveProperty("data");
    expectTypeOf<NonNullable<Payload>>().toHaveProperty("where");
    expectTypeOf<NonNullable<Payload>>().toHaveProperty("select");
    expectTypeOf<
      "include" extends keyof NonNullable<Payload> ? true : false
    >().toEqualTypeOf<false>();
  });

  test("data admits relation keys beside scalars, and IS the ordinary update data", () => {
    // PACKAGE K1 retarget. This test used to assert the opposite — that `posts`
    // and `profile` were NOT keys of `data` — because the root `updateMany` bound
    // its data to the scalar-only schema. It now binds to the SAME `core.update`
    // instance a single `update` binds, so the two surfaces cannot drift, and the
    // assertion below is what says so: the two data types are equal, not merely
    // both accepting of a relation name.
    type Payload = OperationPayload<"updateMany", UserModel>;
    type Data = NonNullable<NonNullable<Payload>["data"]>;
    type UpdateData = NonNullable<
      NonNullable<OperationPayload<"update", UserModel>>["data"]
    >;

    expectTypeOf<Data>().toHaveProperty("name");
    expectTypeOf<Data>().toHaveProperty("age");
    expectTypeOf<Data>().toEqualTypeOf<UpdateData>();
    expectTypeOf<
      "posts" extends keyof Data ? true : false
    >().toEqualTypeOf<true>();
    expectTypeOf<
      "profile" extends keyof Data ? true : false
    >().toEqualTypeOf<true>();
  });

  test("the returning PROJECTION stays scalar-only while data gains relations", () => {
    // The asymmetry K1 deliberately keeps: what a bulk write may WRITE and what it
    // may PROJECT are different questions. `select` still refuses a relation (a
    // relation subquery in a RETURNING list has no alias to correlate against), and
    // `include` is still absent from the surface entirely — asserted above.
    type Payload = NonNullable<OperationPayload<"updateMany", UserModel>>;
    type Select = NonNullable<Payload["select"]>;

    expectTypeOf<
      "posts" extends keyof Select ? true : false
    >().toEqualTypeOf<false>();
  });

  test("nested relation-level updateMany data admits relation keys (separate surface)", () => {
    // The nested relation-level updateMany (user.update -> posts.updateMany.data)
    // binds to the target model's full update schema and is a DIFFERENT surface
    // from the root one K1 widened: its engine path still refuses relation writes
    // loudly at runtime (the nested wall, ATOM §17 / Package L).
    type UpdatePayload = NonNullable<OperationPayload<"update", UserModel>>;
    type PostsWrite = NonNullable<UpdatePayload["data"]>["posts"];
    type NestedUpdateMany = Extract<
      NonNullable<PostsWrite>["updateMany"],
      { data?: unknown }
    >;
    type NestedData = NonNullable<NestedUpdateMany["data"]>;

    expectTypeOf<
      "author" extends keyof NestedData ? true : false
    >().toEqualTypeOf<true>();
  });
});

describe("deleteMany implicit returning (no Prisma counterpart)", () => {
  test("without select the result is { count }", () => {
    type Args = { where: { name: string } };
    type Result = OperationResult<"deleteMany", UserModel, Args>;

    expectTypeOf<Result>().toEqualTypeOf<{ count: number }>();
  });

  test("with select the result is the deleted rows", () => {
    type Args = { where: { name: string }; select: { id: true; email: true } };
    type Result = OperationResult<"deleteMany", UserModel, Args>;

    expectTypeOf<Result>().toBeArray();
    expectTypeOf<keyof Result[number]>().toEqualTypeOf<"id" | "email">();
  });

  test("payload has where and select but not include", () => {
    type Payload = OperationPayload<"deleteMany", UserModel>;

    expectTypeOf<NonNullable<Payload>>().toHaveProperty("where");
    expectTypeOf<NonNullable<Payload>>().toHaveProperty("select");
    expectTypeOf<
      "include" extends keyof NonNullable<Payload> ? true : false
    >().toEqualTypeOf<false>();
  });
});

/**
 * The THIRD case. The discriminant is the select's VALUE, and when its static
 * type admits `undefined` without being `undefined`, only the runtime value
 * decides — so the result type is the honest union of both arms.
 *
 * It used to collapse to `BatchPayload`, which was a silent lie: review W3
 * showed `updateMany({ where, data, select: maybeSelect })` type-checking as
 * `{ count: number }` and then returning `[{ id: … }]`, with `result.count`
 * `undefined` and no diagnostic anywhere. `Args extends { select: Record<…> }`
 * simply never matched a `Sel | undefined` member, while the runtime's
 * `args.select !== undefined` looked at the value.
 */
describe("a select that may be undefined is the union of both arms", () => {
  test("a union-typed select member", () => {
    type Args = {
      where: { name: string };
      data: { name: string };
      select: { id: true } | undefined;
    };
    type Result = OperationResult<"updateMany", UserModel, Args>;

    expectTypeOf<Result>().toEqualTypeOf<
      { count: number } | { id: string }[]
    >();
  });

  test("an optional select member (a pre-built args object)", () => {
    type Args = {
      where: { name: string };
      select?: { id: true };
    };
    type Result = OperationResult<"deleteMany", UserModel, Args>;

    expectTypeOf<Result>().toEqualTypeOf<
      { count: number } | { id: string }[]
    >();
  });

  test("the row arm still projects exactly the select, not an empty row", () => {
    // `keyof ({ id: true } | undefined)` is `never`, so a naive pass-through
    // would infer `{}[]` for the row arm and quietly accept any property.
    type Args = {
      data: { name: string; email: string }[];
      select: { name: true; email: true } | undefined;
    };
    type Rows = Extract<
      OperationResult<"createMany", UserModel, Args>,
      readonly unknown[]
    >;

    expectTypeOf<keyof Rows[number]>().toEqualTypeOf<"name" | "email">();
  });

  test("the two unambiguous cases are NOT widened into a union", () => {
    // The union is the price of ambiguity only. A literal select is still
    // exactly rows, and a literal `undefined` is still exactly `{ count }`.
    type Rows = OperationResult<
      "updateMany",
      UserModel,
      { where: { name: string }; data: { name: string }; select: { id: true } }
    >;
    type Count = OperationResult<
      "updateMany",
      UserModel,
      { where: { name: string }; data: { name: string }; select: undefined }
    >;

    expectTypeOf<Rows>().toEqualTypeOf<{ id: string }[]>();
    expectTypeOf<Count>().toEqualTypeOf<{ count: number }>();
  });
});

/**
 * The same three cases at a real CALL SITE, where `Args` is inferred rather
 * than written out. This is where review W3 found the defect, and it is the
 * part that is easy to get wrong twice: inference into an OPTIONAL pattern
 * property (`Args extends { select?: infer Sel }`) silently STRIPS `undefined`
 * from the source type, which would collapse the ambiguous case back to the
 * row arm. `BulkSelect` uses indexed access for exactly that reason.
 *
 * None of these functions is ever called — only their inferred return types
 * matter, so no driver ever connects.
 */
describe("the discriminant at a real call site", () => {
  const client = createClient({
    schema: { widget },
    driver: new PGliteDriver(),
  });

  const withUnionSelect = (select: { id: true } | undefined) =>
    client.widget.updateMany({
      where: { name: "a" },
      data: { name: "b" },
      select,
    });

  const withPrebuiltArgs = (args: {
    where: { name: string };
    select?: { id: true };
  }) => client.widget.deleteMany(args);

  const withLiteralSelect = () =>
    client.widget.updateMany({
      where: { name: "a" },
      data: { name: "b" },
      select: { id: true },
    });

  const withoutSelect = () =>
    client.widget.updateMany({ where: { name: "a" }, data: { name: "b" } });

  const withUndefinedSelect = () =>
    client.widget.updateMany({
      where: { name: "a" },
      data: { name: "b" },
      select: undefined,
    });

  test("a select that may be undefined infers the union", () => {
    expectTypeOf<Awaited<ReturnType<typeof withUnionSelect>>>().toEqualTypeOf<
      { count: number } | { id: string }[]
    >();
    expectTypeOf<Awaited<ReturnType<typeof withPrebuiltArgs>>>().toEqualTypeOf<
      { count: number } | { id: string }[]
    >();
  });

  test("a literal select infers exactly the rows", () => {
    expectTypeOf<Awaited<ReturnType<typeof withLiteralSelect>>>().toEqualTypeOf<
      { id: string }[]
    >();
  });

  test("no select and a literal undefined select both infer { count }", () => {
    expectTypeOf<Awaited<ReturnType<typeof withoutSelect>>>().toEqualTypeOf<{
      count: number;
    }>();
    expectTypeOf<
      Awaited<ReturnType<typeof withUndefinedSelect>>
    >().toEqualTypeOf<{ count: number }>();
  });
});

/**
 * The bulk-write `select` is SCALAR-ONLY: it binds to `core.scalarSelect`, not
 * `core.select`. Relations — and the relation-derived `_count` — are not keys of
 * it on any of the three families. The runtime half of this contract (a
 * ValidationError naming the offending key, in place of the wrong data the
 * projection used to return) lives in
 * tests/drivers/implicit-returning-behavior.ts.
 */
describe("a bulk write's select is scalar-only", () => {
  type BulkSelectKeys<O extends "createMany" | "updateMany" | "deleteMany"> =
    keyof NonNullable<NonNullable<OperationPayload<O, UserModel>>["select"]>;

  test("createMany select carries no relation key and no _count", () => {
    expectTypeOf<
      Extract<BulkSelectKeys<"createMany">, "posts" | "profile" | "_count">
    >().toEqualTypeOf<never>();
    // …and the scalars really are there, so the assertion above is a narrowing
    // rather than a vacuous claim about an empty key set.
    expectTypeOf<
      Extract<BulkSelectKeys<"createMany">, "name">
    >().toEqualTypeOf<"name">();
  });

  test("updateMany and deleteMany agree", () => {
    expectTypeOf<
      Extract<BulkSelectKeys<"updateMany">, "posts" | "profile" | "_count">
    >().toEqualTypeOf<never>();
    expectTypeOf<
      Extract<BulkSelectKeys<"deleteMany">, "posts" | "profile" | "_count">
    >().toEqualTypeOf<never>();
    expectTypeOf<
      Extract<BulkSelectKeys<"deleteMany">, "name">
    >().toEqualTypeOf<"name">();
  });

  test("a read still projects relations — the restriction is bulk-write-only", () => {
    type FindSelectKeys = keyof NonNullable<
      NonNullable<OperationPayload<"findMany", UserModel>>["select"]
    >;
    expectTypeOf<Extract<FindSelectKeys, "posts">>().toEqualTypeOf<"posts">();
    expectTypeOf<Extract<FindSelectKeys, "_count">>().toEqualTypeOf<"_count">();
  });
});

/**
 * `limit` (Prisma 6.x, W4-U2) reaches the typed surface with no separate type
 * work: the client's payload types are inferred from the same arg schemas the
 * runtime parses with, so adding the key to `getUpdateManyArgs` /
 * `getDeleteManyArgs` is the whole change. It is optional, numeric, and belongs
 * to the bulk families ONLY — the targeted `update`/`delete` cap nothing,
 * because they already address exactly one row.
 */
describe("the bulk-write limit on the typed surface", () => {
  type PayloadOf<O extends Operations> = NonNullable<
    OperationPayload<O, UserModel>
  >;
  type HasLimit<O extends Operations> = "limit" extends keyof PayloadOf<O>
    ? true
    : false;

  test("updateMany and deleteMany take an optional number", () => {
    expectTypeOf<PayloadOf<"updateMany">["limit"]>().toEqualTypeOf<
      number | undefined
    >();
    expectTypeOf<PayloadOf<"deleteMany">["limit"]>().toEqualTypeOf<
      number | undefined
    >();
  });

  test("it is not a key of the single-row or create families", () => {
    expectTypeOf<HasLimit<"update">>().toEqualTypeOf<false>();
    expectTypeOf<HasLimit<"delete">>().toEqualTypeOf<false>();
    expectTypeOf<HasLimit<"createMany">>().toEqualTypeOf<false>();
    // …and the probe is not vacuous: it reports true where the key exists.
    expectTypeOf<HasLimit<"updateMany">>().toEqualTypeOf<true>();
  });
});
