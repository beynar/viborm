/**
 * Type tests for createManyAndReturn / updateManyAndReturn
 * Verifies args and result inference.
 */

import type { OperationPayload, OperationResult } from "@client/types";
import { describe, expectTypeOf, test } from "vitest";
import type { testUser } from "../schema.js";

type UserModel = typeof testUser;

describe("createManyAndReturn types", () => {
  test("returns full rows without select", () => {
    type Args = { data: { name: string; email: string }[] };
    type Result = OperationResult<"createManyAndReturn", UserModel, Args>;

    expectTypeOf<Result>().toBeArray();
    type Row = Result[number];
    expectTypeOf<Row>().toHaveProperty("id");
    expectTypeOf<Row>().toHaveProperty("name");
    expectTypeOf<Row>().toHaveProperty("email");
  });

  test("returns only selected fields with select", () => {
    type Args = {
      data: { name: string; email: string }[];
      select: { name: true };
    };
    type Result = OperationResult<"createManyAndReturn", UserModel, Args>;

    type Row = Result[number];
    expectTypeOf<Row>().toHaveProperty("name");
    expectTypeOf<keyof Row>().toEqualTypeOf<"name">();
  });

  test("payload accepts skipDuplicates but not include", () => {
    type Payload = OperationPayload<"createManyAndReturn", UserModel>;

    expectTypeOf<NonNullable<Payload>>().toHaveProperty("data");
    expectTypeOf<NonNullable<Payload>>().toHaveProperty("skipDuplicates");
    expectTypeOf<NonNullable<Payload>>().toHaveProperty("select");
    expectTypeOf<
      "include" extends keyof NonNullable<Payload> ? true : false
    >().toEqualTypeOf<false>();
  });
});

describe("updateManyAndReturn types", () => {
  test("returns full rows without select", () => {
    type Args = { where: { name: string }; data: { name: string } };
    type Result = OperationResult<"updateManyAndReturn", UserModel, Args>;

    expectTypeOf<Result>().toBeArray();
    type Row = Result[number];
    expectTypeOf<Row>().toHaveProperty("id");
    expectTypeOf<Row>().toHaveProperty("email");
  });

  test("returns only selected fields with select", () => {
    type Args = {
      data: { name: string };
      select: { id: true; email: true };
    };
    type Result = OperationResult<"updateManyAndReturn", UserModel, Args>;

    type Row = Result[number];
    expectTypeOf<keyof Row>().toEqualTypeOf<"id" | "email">();
  });

  test("payload has where, data, select but not include", () => {
    type Payload = OperationPayload<"updateManyAndReturn", UserModel>;

    expectTypeOf<NonNullable<Payload>>().toHaveProperty("data");
    expectTypeOf<NonNullable<Payload>>().toHaveProperty("where");
    expectTypeOf<NonNullable<Payload>>().toHaveProperty("select");
    expectTypeOf<
      "include" extends keyof NonNullable<Payload> ? true : false
    >().toEqualTypeOf<false>();
  });
});
