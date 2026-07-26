/**
 * Type tests for IMPLICIT RETURNING on the bulk writes (maintainer decision
 * D-1). `createManyAndReturn` / `updateManyAndReturn` were REMOVED — no alias,
 * no deprecation shim. `createMany` / `updateMany` take an optional `select`,
 * and its presence is what flips the return type from `{ count }` to rows.
 *
 * The two halves of the contract this file pins:
 *  - the CONDITIONAL result: no `select` -> `BatchPayload`; `select` -> `T[]`
 *    projected by that select;
 *  - the REMOVAL: the old names are not members of `Operations`, so
 *    `client.model.createManyAndReturn` cannot type-check (the runtime half of
 *    that removal is pinned in tests/query-engine-v2/bulk-write.test.ts).
 */

import type {
  OperationPayload,
  OperationResult,
  Operations,
} from "@client/types";
import { describe, expectTypeOf, test } from "vitest";
import type { testUser } from "../schema.js";

type UserModel = typeof testUser;

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
    // while returning `{ count }`.
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

  test("data is scalar-only: relation keys are not admitted", () => {
    type Payload = OperationPayload<"updateMany", UserModel>;
    type Data = NonNullable<NonNullable<Payload>["data"]>;

    expectTypeOf<Data>().toHaveProperty("name");
    expectTypeOf<Data>().toHaveProperty("age");
    expectTypeOf<
      "posts" extends keyof Data ? true : false
    >().toEqualTypeOf<false>();
    expectTypeOf<
      "profile" extends keyof Data ? true : false
    >().toEqualTypeOf<false>();
  });

  test("nested relation-level updateMany data still admits relation keys (separate surface)", () => {
    // The root updateMany restriction must NOT leak into the nested
    // relation-level updateMany (user.update -> posts.updateMany.data), whose
    // data binds to the target model's full update schema and whose engine
    // path fails loudly at runtime.
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

describe("deleteMany keeps its count-only surface", () => {
  test("no select on the payload, always { count }", () => {
    type Args = { where: { name: string } };
    type Result = OperationResult<"deleteMany", UserModel, Args>;

    expectTypeOf<Result>().toEqualTypeOf<{ count: number }>();

    type Payload = OperationPayload<"deleteMany", UserModel>;
    expectTypeOf<
      "select" extends keyof NonNullable<Payload> ? true : false
    >().toEqualTypeOf<false>();
  });
});
